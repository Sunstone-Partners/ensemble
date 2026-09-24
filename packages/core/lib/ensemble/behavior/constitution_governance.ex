defmodule Ensemble.Behavior.ConstitutionProposal do
  @moduledoc """
  One constitution change, proposed through the governance gate (TRD-025).

  A proposal is the ONLY way a behavior's execution can affect the
  constitution (REQ-018, AC-069/AC-071): `ConstitutionGovernance.propose/4`
  creates it with `status: :pending`, and nothing in the runtime applies
  `change` from a proposal the rule's roster has not approved.

  | field             | meaning                                              |
  |-------------------|------------------------------------------------------|
  | `id`              | `"prop-" <> 16hex`, generated at propose time        |
  | `rule_id`         | constitution rule the change targets (`"rule:x"`)    |
  | `change`          | proposed rule delta; inert data until activated      |
  | `status`          | `:pending`, `:approved`, `:rejected` or `:revised`   |
  | `approvals`       | distinct approving actors recorded so far            |
  | `approvers`       | roster derived from the rule (AC-067)                |
  | `threshold`       | approvals needed to approve (AC-068 / AC-072)        |
  | `trust_escalated` | true when a low-trust behavior raised the threshold  |
  | `activation_id`   | the activation that proposed it                      |
  | `parent_id`       | set only on a revision child (AC-070)                |
  | `events`          | attributable accept/reject/revise trail (AC-070)     |
  """

  @enforce_keys [:id, :rule_id]
  defstruct [
    :id,
    :rule_id,
    :activation_id,
    :parent_id,
    :decided_by,
    :decided_at,
    :created_at,
    change: %{},
    status: :pending,
    approvals: [],
    approvers: [],
    threshold: 1,
    trust_escalated: false,
    events: []
  ]

  @type status :: :pending | :approved | :rejected | :revised
  @type event :: %{
          required(:actor) => term(),
          required(:action) => String.t(),
          required(:ts) => non_neg_integer() | nil,
          required(:approvals) => [term()]
        }
  @type t :: %__MODULE__{
          id: String.t(),
          rule_id: String.t(),
          change: map(),
          status: status(),
          approvals: [term()],
          approvers: [term()],
          threshold: pos_integer(),
          trust_escalated: boolean(),
          created_at: non_neg_integer() | nil,
          activation_id: String.t() | nil,
          parent_id: String.t() | nil,
          decided_by: term(),
          decided_at: non_neg_integer() | nil,
          events: [event()]
        }
end
defmodule Ensemble.Behavior.ConstitutionGovernance do
  @moduledoc """
  Propose-only governance for constitution mutations (TRD-025, TRD §4.2
  constitution path; REQ-017/REQ-018, AC-066..AC-072).

  ## The constitution is never written by a behavior

  A behavior affects the constitution by emitting a *proposal*, and a
  proposal is only admissible when the behavior actually holds the
  constitution capability (AC-069). Two independent declarations are
  required, both read off the individual `Definition` — ToolGuard's
  tool-grant / mutation-authority split, unchanged:

    * `capabilities.tools` contains a tool that canonically enforces
      `"constitution.propose"`, and
    * `capabilities.mutation_classes` declares the `"constitution.propose"`
      class.

  A `propose/4` from a behavior missing either half returns
  `{:error, :direct_write_blocked}` and records nothing. The proposal is
  created `:pending`; `change` is inert data and is never merged into a
  ruleset unless it arrives here already `:approved` (AC-069/AC-071).

  ## Reviewers come from the rule, not the caller (AC-066 / AC-067)

  The approver roster is read off `defn.constitution_rules` for the
  targeted rule id — the merged `%{id:, approval_required:, approvers: []}`
  record produced by `Constitution.merge/2`. A rule declaring "only the
  security team can approve" therefore sets the pending proposal's roster;
  a caller cannot substitute its own.

  ## Who must sign (AC-068 / AC-072)

  The approval threshold is derived at propose time:

  | roster                          | threshold                   |
  |---------------------------------|-----------------------------|
  | n named approvers               | `ceil(n / 2)`, floored at 1 |
  | empty roster, approval required | `2` (a two-reviewers rule)  |
  | empty roster, no approval gate  | `1`                         |

  A behavior not named in the trust allowlist is *low trust*: its proposals
  carry `trust_escalated: true` and a threshold one level higher. For a
  named roster escalation is capped at the roster size — it tightens the
  quorum, it never invents reviewers.

  ## Gate 7 agrees with the ledger (AC-070)

  `verdict_for/3` renders the gate-7 result a proposal implies as Policy
  opts — `:constitution_verdict` is the exact key Policy reads
  (`Map.get(opts, :constitution_verdict)`):

      Policy.evaluate(defn, event, Map.merge(ctx, ConstitutionGovernance.verdict_for(defn, prop)))

  * approved  → `:allow`   → verdict `:activate`
  * pending   → `:pending` → verdict `:require_approval`
  * rejected  → `:deny`    → verdict `:block`

  ## Durability

  Every mutation appends one record to

      Path.join(System.get_env("ENSEMBLE_STATE_DIR") || ".ensemble/state",
                "proposals.jsonl")

  mirroring `Ensemble.Behavior.PolicyContext`: the append happens
  **before** the in-memory table takes the change, so a refused write
  leaves both sides untouched; `init/1` replays the file, newest record per
  id wins, and a corrupt line is skipped with a warning rather than read as
  absence. `now_ms` enters only through the API.
  """

  use GenServer

  require Logger

  alias Ensemble.Behavior.{Audit, ConstitutionProposal, Definition, Event, ToolGuard}

  @propose "propose"
  @approve "approve"
  @reject "reject"
  @revise "revise"

  @constitution_tool "constitution.propose"
  @constitution_class "constitution.propose"
  @constitution_outcome "constitution.change.proposed"

  @type actor :: String.t() | atom()
  @type ledger :: GenServer.server()

  # ------------------------------------------------------------------- API

  @doc """
  Start a proposal ledger.

  `opts`: `:name` (also names the ETS table, so ledgers can coexist) and
  `:dir` (state-directory override — tests pass this rather than mutating
  the environment).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc "The JSONL mirror path a ledger — or the configured default — reads and appends."
  @spec file(ledger() | nil) :: Path.t()
  def file(ledger \\ nil) do
    case ledger do
      nil -> Path.join(default_dir(), "proposals.jsonl")
      server -> Path.join(GenServer.call(server, :dir), "proposals.jsonl")
    end
  end

  @doc """
  Propose a constitution change on behalf of `defn`, for `activation_id`.

  `change` is a map that MUST name its target rule under `"rule_id"` or
  `"id"`.

  * `{:ok, %ConstitutionProposal{status: :pending}}` — capability present
    and rule declared;
  * `{:error, :direct_write_blocked}` — the behavior lacks the tool or the
    mutation-class authority (AC-069);
  * `{:error, :missing_rule_id}` — the change cites no rule;
  * `{:error, {:unknown_rule, id}}` — the rule is absent from
    `defn.constitution_rules`; fail-closed, id cited (AC-068's analogue).

  `opts`: `:ledger` (absent, mutations append straight to the mirror and
  reads go to disk), `:dir`, `:actor`, `:now_ms`, `:registries`,
  `:trust_allowlist`, `:parent_id`.
  """
  @spec propose(Definition.t(), String.t() | nil, map(), keyword()) ::
          {:ok, ConstitutionProposal.t()} | {:error, term()}
  def propose(%Definition{} = defn, activation_id, change, opts \\ []) when is_map(change) do
    cond do
      not capability_granted?(defn, opts) ->
        {:error, :direct_write_blocked}

      is_nil(rule_id_of(change)) ->
        {:error, :missing_rule_id}

      true ->
        case find_rule(defn, rule_id_of(change)) do
          :error -> {:error, {:unknown_rule, rule_id_of(change)}}
          {:ok, rule} -> persist(opts, build_proposal(defn, activation_id, change, rule, opts))
        end
    end
  end

  @doc """
  The immutable proposal `propose/4` would create, without recording it.

  Exposed so the derivation — roster, threshold, escalation — is reusable
  and directly testable.
  """
  @spec build_proposal(Definition.t(), String.t() | nil, map(), map(), keyword()) ::
          ConstitutionProposal.t()
  def build_proposal(%Definition{} = defn, activation_id, change, rule, opts) do
    now = now_ms(opts)
    roster = List.wrap(rule.approvers)
    escalated = low_trust?(defn, opts)

    %ConstitutionProposal{
      id: generate_id(),
      rule_id: rule.id,
      change: change,
      status: :pending,
      approvers: roster,
      threshold: threshold(roster, rule.approval_required, escalated),
      trust_escalated: escalated,
      created_at: now,
      activation_id: activation_id,
      parent_id: Keyword.get(opts, :parent_id),
      events: [
        %{
          actor: Keyword.get(opts, :actor, actor_of(defn)),
          action: @propose,
          ts: now,
          approvals: []
        }
      ]
    }
  end

  @doc """
  Record an approval from `approver` (AC-067/AC-070).

  Only a name already on the derived roster may approve; a stranger gets
  `{:error, :not_approver}` and the ledger is unchanged. Once the distinct
  approvals reach `threshold` the proposal moves to `:approved`; until then
  it stays `:pending` and gate 7 still answers `:require_approval`.
  """
  @spec approve(ConstitutionProposal.t(), actor(), keyword()) ::
          {:ok, ConstitutionProposal.t()} | {:error, :not_approver | {:not_pending, term()}}
  def approve(%ConstitutionProposal{} = p, approver, opts \\ []),
    do: decide(p, approver, @approve, :approved, opts)

  @doc "Reject `p` (AC-070): terminal, attributable, and still never applied."
  @spec reject(ConstitutionProposal.t(), actor(), keyword()) ::
          {:ok, ConstitutionProposal.t()} | {:error, :not_approver | {:not_pending, term()}}
  def reject(%ConstitutionProposal{} = p, approver, opts \\ []),
    do: decide(p, approver, @reject, :rejected, opts)

  @doc """
  Send `p` back for revision (AC-070).

  The original moves to `:revised` and a fresh `:pending` child is proposed
  for `change` with `parent_id` pointing at the original, so both the
  transition and its lineage stay attributable.
  """
  @spec revise(ConstitutionProposal.t(), Definition.t(), map(), keyword()) ::
          {:ok, ConstitutionProposal.t()} | {:error, term()}
  def revise(%ConstitutionProposal{} = p, %Definition{} = defn, change, opts \\ []) do
    now = now_ms(opts)
    actor = Keyword.get(opts, :actor, actor_of(defn))

    {:ok, revised} = transition(p, actor, @revise, :revised, now, p.approvals)

    with :ok <- require_pending(p),
         {:ok, _} <- persist(opts, revised) do
      propose(defn, p.activation_id, change, Keyword.merge(opts, parent_id: p.id, actor: actor))
    end
  end

  @doc "Fetch one proposal by id (from `ledger`, or the mirror when it is nil)."
  @spec fetch(ledger() | nil, String.t(), keyword()) :: {:ok, ConstitutionProposal.t()} | :error
  def fetch(ledger, id, opts \\ []) do
    case ledger do
      nil -> disk_fetch(opts, id)
      server -> GenServer.call(server, {:fetch, id})
    end
  end

  @doc "Every proposal, oldest `created_at` first (newest row per id wins)."
  @spec list(ledger() | nil, keyword()) :: [ConstitutionProposal.t()]
  def list(ledger, opts \\ []) do
    rows =
      case ledger do
        nil -> disk_list(opts)
        server -> GenServer.call(server, :list)
      end

    rows
    |> Enum.map(&to_struct/1)
    |> newest_wins()
    |> Enum.sort_by(&{&1.created_at || 0, &1.id})
  end

  @doc "Pending proposals only — the operator's review queue (AC-070)."
  @spec pending(ledger() | nil, keyword()) :: [ConstitutionProposal.t()]
  def pending(ledger, opts \\ []) do
    ledger |> list(opts) |> Enum.filter(&(&1.status == :pending))
  end

  @doc """
  True when `defn` provably holds the constitution capability: the canonical
  `constitution.propose` tool AND the matching mutation-class authority
  (AC-069). Pure — reads only the individual `Definition`.
  """
  @spec capability_granted?(Definition.t(), keyword()) :: boolean()
  def capability_granted?(%Definition{capabilities: caps}, opts \\ []) do
    snapshot = Keyword.get(opts, :registries)
    tools = (caps && caps.tools) || []
    classes = (caps && caps.mutation_classes) || []

    granted_tool?(tools, snapshot) &&
      ToolGuard.mutation_allowed?(@constitution_class, classes, snapshot)
  end

  defp granted_tool?(tools, snapshot) when is_list(tools) do
    Enum.any?(tools, fn tool ->
      ToolGuard.check_mutation(tool, tools, snapshot) == {:ok, @constitution_tool}
    end)
  end

  defp granted_tool?(_, _), do: false

  @doc """
  True when `outcome` is a *direct* constitution write (AC-071).

  The execution boundary asks this before honouring an outcome, so the only
  thing that survives is the proposal. `"constitution.propose"` — the
  capability's own name used as an outcome — is a write request;
  `"constitution.change.proposed"`, the lawful proposal outcome, is not.
  """
  @spec direct_write?(term()) :: boolean()
  def direct_write?(outcome) when is_binary(outcome),
    do: ToolGuard.canonical_tool(outcome) == @constitution_class

  def direct_write?(outcome) when is_atom(outcome) and not is_nil(outcome),
    do: direct_write?(outcome |> Atom.to_string() |> String.replace("_", "."))

  def direct_write?(_), do: false

  @doc "The lawful proposal outcome a constitution-capable behavior emits (AC-069)."
  @spec proposal_outcome() :: String.t()
  def proposal_outcome, do: @constitution_outcome
  @doc """
  Apply `change` to `ruleset` — only from an `:approved` proposal.

  This is the one place allowed to touch a ruleset, and it is allowed
  precisely because it can prove approval. Any other status returns
  `{:error, :direct_write_blocked}` (AC-069/AC-071); a rule missing from
  the ruleset returns `{:error, {:unknown_rule, id}}`.
  """
  @spec apply_to_ruleset(ConstitutionProposal.t(), map()) ::
          {:ok, map()} | {:error, :direct_write_blocked | {:unknown_rule, term()}}
  def apply_to_ruleset(%ConstitutionProposal{status: :approved, rule_id: id, change: change}, ruleset)
      when is_map(ruleset) do
    case Map.fetch(ruleset, id) do
      {:ok, rule} -> {:ok, Map.put(ruleset, id, merge_change(rule, strip_rule_id(change)))}
      :error -> {:error, {:unknown_rule, id}}
    end
  end

  def apply_to_ruleset(%ConstitutionProposal{}, ruleset) when is_map(ruleset),
    do: {:error, :direct_write_blocked}

  @doc """
  Gate-7 opts for `Policy.evaluate/3` (AC-070): `ctx` passthrough under
  `:ctx`, plus the `:constitution_verdict` override Policy reads.

  A proposal that has collected its quorum reads `:allow`; anything still
  outstanding — including a `:revised` original whose replacement is in
  flight — reads `:pending`. The ledger, not the caller, decides. An
  escalated (low-trust) proposal needs the whole named roster, so partial
  approvals stay `:pending` (AC-072).
  """
  @spec verdict_for(Definition.t(), ConstitutionProposal.t() | nil, map()) :: map()
  def verdict_for(defn, proposal, ctx \\ %{})

  def verdict_for(%Definition{}, %ConstitutionProposal{status: :approved}, ctx),
    do: verdict_opts(ctx, :allow)

  def verdict_for(%Definition{}, %ConstitutionProposal{status: :rejected}, ctx),
    do: verdict_opts(ctx, :deny)

  def verdict_for(%Definition{constitution_rules: rules}, %ConstitutionProposal{} = p, ctx) do
    if satisfied?(p, rules), do: verdict_opts(ctx, :allow), else: verdict_opts(ctx, :pending)
  end

  def verdict_for(%Definition{}, nil, ctx), do: verdict_opts(ctx, :pending)

  defp satisfied?(%ConstitutionProposal{status: :pending} = p, rules) do
    approvals_met?(p) and (not p.trust_escalated or full_quorum?(p)) and
      (p.approvers != [] or not requires_approval?(rules, p.rule_id) or approvals_met?(p))
  end

  defp satisfied?(_p, _rules), do: false

  defp full_quorum?(%ConstitutionProposal{approvals: a, approvers: roster}) when roster != [],
    do: length(Enum.uniq(a)) >= length(roster)

  defp full_quorum?(%ConstitutionProposal{}), do: false

  defp verdict_opts(ctx, verdict), do: %{ctx: ctx, constitution_verdict: verdict}

  @doc """
  Approval threshold for a derived roster (AC-068 / AC-072).

  * named roster of n → `ceil(n / 2)`, floored at 1;
  * empty roster with an approval requirement → `2`: the two-reviewers
    shape, the constitution asking for two reviews rather than two people;
  * empty roster with no approval gate → `1`.

  Escalation adds one level. A named roster caps it at the roster size so a
  quorum stays reachable; an empty roster is uncapped, so escalation really
  does demand a third reviewer.
  """
  @spec threshold([actor()], term(), boolean()) :: pos_integer()
  def threshold(roster, approval_required \\ [], escalated \\ false)

  def threshold([], approval_required, escalated) do
    base = if approval_required?(approval_required), do: 2, else: 1
    base + escalation(escalated)
  end

  def threshold(roster, _approval_required, escalated) when is_list(roster) do
    base = max(1, ceil(length(roster) / 2))
    min(base + escalation(escalated), length(roster))
  end

  defp escalation(true), do: 1
  defp escalation(_), do: 0

  defp approval_required?(r) when is_list(r), do: r != []
  defp approval_required?(true), do: true
  defp approval_required?(_), do: false

  @doc """
  True when `defn` is low trust — not named in the trust allowlist (AC-072).

  Order: an explicit `:trust_allowlist` opt, then `ENSEMBLE_TRUST_ALLOWLIST`
  (comma- or JSON-array separated), then the empty allowlist. Absent
  evidence is low trust: no behavior earns escalation-free review from a
  missing configuration.
  """
  @spec low_trust?(Definition.t(), keyword()) :: boolean()
  def low_trust?(%Definition{name: name}, opts \\ []) do
    not Enum.member?(trust_allowlist(opts), to_string(name))
  end

  @doc "The trust allowlist currently in force (see `low_trust?/2`)."
  @spec trust_allowlist(keyword()) :: [String.t()]
  def trust_allowlist(opts \\ []) do
    case Keyword.get(opts, :trust_allowlist) do
      list when is_list(list) -> Enum.map(list, &to_string/1)
      binary when is_binary(binary) -> split_allowlist(binary)
      nil -> System.get_env("ENSEMBLE_TRUST_ALLOWLIST", "") |> split_allowlist()
    end
  end

  defp split_allowlist(raw) when is_binary(raw) do
    raw
    |> String.trim()
    |> String.replace_prefix("[", "")
    |> String.replace_suffix("]", "")
    |> String.split(",")
    |> Enum.map(&(&1 |> String.trim() |> String.trim("\"") |> String.trim("'")))
    |> Enum.reject(&(&1 == ""))
  end

  defp split_allowlist(_), do: []

  @doc "True when `p` has at least `threshold` distinct approvals."
  @spec approvals_met?(ConstitutionProposal.t()) :: boolean()
  def approvals_met?(%ConstitutionProposal{approvals: a, threshold: t}),
    do: length(Enum.uniq(a)) >= t

  defp requires_approval?(rules, id) do
    rules
    |> List.wrap()
    |> Enum.any?(fn r ->
      rr = rule_record(r)
      rr.id == id and approval_required?(rr.approval_required)
    end)
  end

  # ---------------------------------------------------------------- decide

  defp decide(%ConstitutionProposal{} = p, approver, action, status, opts) do
    with :ok <- require_pending(p),
         :ok <- require_approver(p, approver) do
      now = now_ms(opts)
      approvals = Enum.uniq(p.approvals ++ [approver])
      final = if status == :approved and length(approvals) < p.threshold, do: :pending, else: status
      {:ok, next} = transition(p, approver, action, final, now, approvals)
      persist(opts, next)
    end
  end

  defp require_pending(%ConstitutionProposal{status: :pending}), do: :ok
  defp require_pending(%ConstitutionProposal{status: s}), do: {:error, {:not_pending, s}}

  # A rule that names nobody cannot veto a reviewer: any attributable actor
  # stands in for the missing roster. A named roster is an allowlist.
  defp require_approver(%ConstitutionProposal{approvers: []}, approver),
    do: if(blank_actor?(approver), do: {:error, :not_approver}, else: :ok)

  defp require_approver(%ConstitutionProposal{approvers: roster}, approver) do
    if Enum.any?(roster, &actor_equals?(&1, approver)), do: :ok, else: {:error, :not_approver}
  end

  defp blank_actor?(a) when is_binary(a), do: String.trim(a) == ""
  defp blank_actor?(nil), do: true
  defp blank_actor?(_), do: false

  defp actor_equals?(a, b), do: to_string(a) == to_string(b)

  defp transition(%ConstitutionProposal{} = p, actor, action, status, ts, approvals) do
    deciding = status in [:approved, :rejected]
    approving = action == @approve
    event = %{actor: actor, action: to_string(action), ts: ts, approvals: approvals}

    {:ok,
     %ConstitutionProposal{
       p
       | status: status,
         approvals: if(approving, do: approvals, else: p.approvals),
         decided_by: if(deciding, do: actor, else: p.decided_by),
         decided_at: if(deciding, do: ts, else: p.decided_at),
         events: p.events ++ [event]
     }}
  end

  defp persist(opts, %ConstitutionProposal{} = p) do
    case mutate(opts, {:put, p}) do
      :ok -> {:ok, p}
      {:ok, _} -> {:ok, p}
      {:error, reason} -> {:error, reason}
      other -> {:error, {:ledger_response_unexpected, other}}
    end
  end

  defp actor_of(%Definition{} = defn), do: "behavior:" <> to_string(defn.name)

  defp now_ms(opts), do: Keyword.get(opts, :now_ms, Event.now())

  defp generate_id, do: "prop-" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)

  # ---------------------------------------------------------------- ledger

  defp mutate(opts, what) do
    case Keyword.get(opts, :ledger) do
      nil -> mutate_file(dir_of(opts), what)
      ledger -> GenServer.call(ledger, what)
    end
  end

  # Process-free path, still append-first: a failed write changes nothing.
  defp mutate_file(dir, {:put, %ConstitutionProposal{} = p}), do: record(dir, p)

  defp record(dir, %ConstitutionProposal{} = p) do
    path = Path.join(dir, "proposals.jsonl")

    with :ok <- File.mkdir_p(dir) do
      case File.write(path, [Audit.canonical_json(to_record(p)), "\n"], [:append]) do
        :ok -> :ok
        {:error, reason} -> {:error, {:policy_unresolved, reason}}
      end
    end
  rescue
    e -> {:error, {:policy_unresolved, Exception.message(e)}}
  end

  defp disk_fetch(opts, id) do
    case disk_list(opts) |> Enum.find(&(&1.id == id)) do
      nil -> :error
      p -> {:ok, p}
    end
  end

  defp disk_list(opts) do
    path = Path.join(dir_of(opts), "proposals.jsonl")

    case File.read(path) do
      {:error, :enoent} ->
        []

      {:ok, body} ->
        body
        |> String.split("\n")
        |> Enum.flat_map(fn line ->
          case decode_record(line) do
            {:ok, p} -> [p]
            :skip -> []
          end
        end)

      {:error, _} ->
        []
    end
  end

  defp dir_of(opts), do: Keyword.get(opts, :dir) || default_dir()

  defp newest_wins(rows),
    do: rows |> Enum.reduce(%{}, fn r, acc -> Map.put(acc, r.id, r) end) |> Map.values()

  defp default_dir, do: System.get_env("ENSEMBLE_STATE_DIR") || ".ensemble/state"

  # ------------------------------------------------------------- GenServer

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    dir = Keyword.get(opts, :dir) || default_dir()
    table = :ets.new(ets_name(name), [:set, :public, :named_table, read_concurrency: true])

    state = %{dir: dir, name: name, table: table}
    replay(state)
    {:ok, state}
  end

  @impl true
  # Durable first: a refused append touches no row (Article IV).
  def handle_call({:put, %ConstitutionProposal{} = p}, _from, state) do
    case record(state.dir, p) do
      :ok ->
        :ets.insert(state.table, {p.id, p})
        {:reply, :ok, state}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:fetch, id}, _from, state) do
    reply =
      case :ets.lookup(state.table, id) do
        [{^id, p}] -> {:ok, p}
        _ -> :error
      end

    {:reply, reply, state}
  end

  def handle_call(:list, _from, state) do
    {:reply, state.table |> :ets.tab2list() |> Enum.map(&elem(&1, 1)), state}
  end

  def handle_call(:dir, _from, state), do: {:reply, state.dir, state}

  @doc false
  def ets_name(base),
    do: :"Elixir.Ensemble.Behavior.ConstitutionGovernance.#{:erlang.phash2(base)}"

  # Replay the mirror into the table; file order means the newest row wins.
  defp replay(state) do
    path = Path.join(state.dir, "proposals.jsonl")

    case File.read(path) do
      {:error, :enoent} ->
        :ok

      {:ok, body} ->
        body
        |> String.split("\n")
        |> Enum.with_index(1)
        |> Enum.each(fn {line, idx} ->
          case decode_record(line) do
            {:ok, p} -> :ets.insert(state.table, {p.id, p})
            :skip -> if blank?(line), do: :ok, else: corrupt(path, idx)
          end
        end)

        :ok

      {:error, reason} ->
        raise "ConstitutionGovernance replay unresolved: #{inspect(reason)} — fail closed (:policy_unresolved)"
    end
  end

  defp blank?(line), do: String.trim(line) == ""

  defp corrupt(path, idx) do
    Logger.warning("ConstitutionGovernance: skipping corrupt mirror line #{idx} in #{path}")
  end

  defp decode_record(line) do
    try do
      case :json.decode(line) do
        m when is_map(m) -> from_record(m)
        _ -> :skip
      end
    rescue
      _ -> :skip
    catch
      _, _ -> :skip
    end
  end

  # ----------------------------------------------------------- rule access

  defp find_rule(%Definition{constitution_rules: rules}, id) do
    case rules |> List.wrap() |> Enum.find(fn r -> rule_ref(r) == id end) do
      nil -> :error
      rule -> {:ok, rule_record(rule)}
    end
  end

  defp rule_ref(%{id: id}) when is_binary(id), do: id
  defp rule_ref(%{"id" => id}) when is_binary(id), do: id
  defp rule_ref(%{id: id}) when is_atom(id) and not is_nil(id), do: Atom.to_string(id)
  defp rule_ref(_), do: nil

  defp rule_id_of(%{"rule_id" => id}) when is_binary(id), do: id
  defp rule_id_of(%{rule_id: id}) when is_binary(id), do: id
  defp rule_id_of(%{"id" => id}) when is_binary(id), do: id
  defp rule_id_of(%{id: id}) when is_binary(id), do: id
  defp rule_id_of(%{rule_id: id}) when is_atom(id) and not is_nil(id), do: Atom.to_string(id)
  defp rule_id_of(%{id: id}) when is_atom(id) and not is_nil(id), do: Atom.to_string(id)
  defp rule_id_of(_), do: nil

  # Normalise anything rule-shaped — a merged record or a raw YAML map — into
  # `%{id:, approval_required:, approvers: []}`.
  @doc false
  def rule_record(%{} = m) do
    %{
      id: rule_ref(m),
      approval_required: fetch_key(m, :approval_required, []),
      approvers: List.wrap(fetch_key(m, :approvers, []))
    }
  end

  defp fetch_key(map, key, default) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, v} -> v
      :error -> Map.get(map, Atom.to_string(key), default)
    end
  end

  # The rule id routes the proposal; it is not itself a rule attribute.
  defp strip_rule_id(change) do
    change
    |> Map.drop(["rule_id", "id"])
    |> Enum.reject(fn {k, _} -> k == :rule_id or k == :id end)
    |> Map.new()
  end

  defp merge_change(rule, change) do
    Enum.reduce(change, rule_record(rule), fn {k, v}, acc -> Map.put(acc, to_key(k), v) end)
  end

  defp to_key(k) when is_atom(k), do: k
  defp to_key(k) when is_binary(k), do: String.to_atom(k)

  defp to_struct(%ConstitutionProposal{} = p), do: p

  defp to_struct(m) when is_map(m) do
    case from_record(m) do
      {:ok, p} -> p
      {:error, _} -> %ConstitutionProposal{id: inspect(m), rule_id: ""}
    end
  end

  # ---------------------------------------------------------------- codec

  @doc false
  def to_record(%ConstitutionProposal{} = p) do
    %{
      "id" => p.id,
      "rule_id" => p.rule_id,
      "change" => p.change,
      "status" => Atom.to_string(p.status),
      "approvals" => Enum.map(p.approvals, &encode_actor/1),
      "approvers" => Enum.map(p.approvers, &encode_actor/1),
      "threshold" => p.threshold,
      "trust_escalated" => p.trust_escalated,
      "created_at" => p.created_at,
      "activation_id" => p.activation_id,
      "parent_id" => p.parent_id,
      "decided_by" => encode_actor(p.decided_by),
      "decided_at" => p.decided_at,
      "events" =>
        Enum.map(p.events, fn e ->
          %{
            "actor" => encode_actor(e.actor),
            "action" => to_string(e.action),
            "ts" => e.ts,
            "approvals" => Enum.map(List.wrap(e.approvals), &encode_actor/1)
          }
        end)
    }
  end

  defp encode_actor(a) when is_binary(a) or is_integer(a) or is_boolean(a) or is_nil(a), do: a
  defp encode_actor(a) when is_atom(a), do: Atom.to_string(a)
  defp encode_actor(a), do: inspect(a)

  @doc false
  def from_record(m) when is_map(m) do
    if is_binary(m["id"]) and is_binary(m["rule_id"]) and known_status?(m["status"]) do
      {:ok, proposal_from(m, status_of(m["status"]))}
    else
      {:error, {:invalid_proposal_record, m}}
    end
  end

  defp known_status?(s), do: s in ["pending", "approved", "rejected", "revised", nil]

  defp proposal_from(m, status) do
    %ConstitutionProposal{
      id: m["id"],
      rule_id: m["rule_id"],
      change: m["change"] || %{},
      status: status,
      approvals: List.wrap(m["approvals"] || []),
      approvers: List.wrap(m["approvers"] || []),
      threshold: m["threshold"] || 1,
      trust_escalated: m["trust_escalated"] || false,
      created_at: m["created_at"],
      activation_id: m["activation_id"],
      parent_id: m["parent_id"],
      decided_by: m["decided_by"],
      decided_at: m["decided_at"],
      events: Enum.map(List.wrap(m["events"] || []), &event_from_record/1)
    }
  end

  defp event_from_record(e) when is_map(e) do
    %{actor: e["actor"], action: e["action"], ts: e["ts"], approvals: List.wrap(e["approvals"] || [])}
  end

  defp status_of("pending"), do: :pending
  defp status_of("approved"), do: :approved
  defp status_of("rejected"), do: :rejected
  defp status_of("revised"), do: :revised
  defp status_of(nil), do: :pending
  defp status_of(_), do: nil
end
