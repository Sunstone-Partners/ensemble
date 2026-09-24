defmodule Ensemble.Behavior.PolicyDecision do
  @moduledoc """
  Explicit policy verdict (TRD §1.7 lines 229-232; REQ-008 AC-029..032, AC-004).

  `verdict` is the TRD vocabulary — never a boolean:

  | verdict             | meaning                                              |
  |---------------------|------------------------------------------------------|
  | `:activate`         | every gate passed; safe to dispatch                  |
  | `:defer`            | not allowed *now* — queue FIFO, lossless (AC-029)    |
  | `:suppress`         | redundant or already spent — drop, don't queue       |
  | `:block`            | unsafe, unresolved, or denied — never dispatch       |
  | `:require_approval` | constitution approval outstanding (REQ-017/018)      |

  `reasons` records **every** gate that stopped the activation, in gate
  order; the head is the first failing gate, and that ordering is the
  contract callers assert on. Each reason is a bare map:

      %{gate: :concurrency, code: :limit_reached, detail: "1 of 1 activations active"}

  * `gate` — one of `Ensemble.Behavior.Policy.gates/0`.
  * `code` — stable atom for machine handling: `:disabled`,
    `:duplicate_suppressed`, `:cooldown_active`, `:limit_reached`,
    `:depth_exceeded`, `:fan_out_exceeded`, `:token_budget_exhausted`,
    `:wall_clock_exhausted`, `:approval_required`, `:constitution_denied`,
    `:policy_unresolved`.
  * `detail` — human-readable evidence, or `nil` when the code suffices.

  `decide/1` derives the verdict from the reasons, so gate order and verdict
  vocabulary cannot drift apart.
  """

  @enforce_keys [:verdict]
  defstruct [:verdict, reasons: []]

  @type reason :: %{gate: atom(), code: atom(), detail: String.t() | nil}
  @type verdict :: :activate | :defer | :suppress | :block | :require_approval
  @type t :: %__MODULE__{verdict: verdict(), reasons: [reason()]}
  @doc """
  Wrap collected reasons (gate order) into the matching verdict.

  Precedence, highest first: an unresolved store blocks (TRD lines 540-542),
  then a constitution denial or a hard safety stop blocks, then approval is
  required, then concurrency defers, and anything left suppresses.
  """
  @spec decide([reason()]) :: t()
  def decide(reasons) when is_list(reasons) do
    %__MODULE__{verdict: verdict_of(reasons), reasons: reasons}
  end

  # The first failing gate decides, except that fail-closed evidence always
  # outranks it.
  defp verdict_of([]), do: :activate

  defp verdict_of(reasons) do
    terminal = Enum.find(reasons, &(&1.code == :policy_unresolved)) || hd(reasons)

    cond do
      terminal.code == :policy_unresolved -> :block
      terminal.code == :constitution_denied -> :block
      terminal.code in [:disabled, :depth_exceeded, :fan_out_exceeded] -> :block
      terminal.code == :approval_required -> :require_approval
      terminal.code == :limit_reached -> :defer
      true -> :suppress
    end
  end
end

defmodule Ensemble.Behavior.Policy do
  @moduledoc """
  Deterministic policy gate chain (TRD-020, TRD §4.1 gates 1–7).

      Policy.evaluate(defn, event, opts \\ %{}) :: PolicyDecision.t()

  Gates run in fixed order and the first failing gate decides the verdict
  (TRD §4.1: "first failing gate wins"), but *every* gate is evaluated so
  `PolicyDecision.reasons` is complete — a suppressed activation that would
  also have blown its concurrency limit says so.

  | gate | check | stop code |
  |---|---|---|
  | 1 `:enabled` | `ctx[:enabled]` kill-switch (REQ-026 AC-095) | `:disabled` → `:block` |
  | 2 `:dedup` | dedup key seen inside `policy.dedup_window` (AC-019) | `:duplicate_suppressed` → `:suppress` |
  | 3 `:cooldown` | last fire inside `policy.cooldown` (AC-030) | `:cooldown_active` → `:suppress` |
  | 4 `:concurrency` | `ctx[:active] >= policy.max_concurrent` (AC-029/AC-089) | `:limit_reached` → `:defer` |
  | 5 `:recursion` | `depth + 1 > max_causal_depth` **or** `children >= max_children` (AC-032, REQ-SAFE-005) | `:depth_exceeded` / `:fan_out_exceeded` → `:block` |
  | 6 `:budget` | token / wall-clock ledger (AC-090) — inert here, see below | `:token_budget_exhausted` → `:suppress` |
  | 7 `:constitution` | approval outstanding or denied (REQ-017/018) | `:approval_required` / `:constitution_denied` |

  No stop → `:activate`.

  ## PolicyContext (TRD §1.7 lines 233-234)

  Runtime evidence arrives in `opts[:ctx]` (`opts[:policy_context]` is an
  alias); it mirrors the TRD shape:

      %{
        enabled: boolean(),                                   # gate 1 — see note
        dedup: %{{event_key(), behavior_name()} => fired_ms}, # gate 2
        cooldowns: %{behavior_name() => last_fired_ms},       # gate 3 — §12 Q2
        active: non_neg_integer(),                            # gate 4 — running activations
        causal_depth: non_neg_integer(),                      # gate 5 — defaults to event.depth
        children: non_neg_integer(),                          # gate 5 — active children
        budget: %{limit: %{...}, used: %{...}}                # gate 6 — absent → inert
      }

  Anything a live gate needs that is absent, `nil` where a count is
  mandatory, `:unknown`, or the wrong type produces code
  `:policy_unresolved`, which verdicts `:block` (TRD lines 540-542;
  Article IV, REQ-SAFE-006). Policy never defaults open.

  ## Fields derived, not declared

  `PolicySpec` is digest-covered — `Digest.canonical_map/1` enumerates its
  fields literally, so one new field silently rewrites every digest. The
  gates read the context instead of growing the struct:

  * **enabled** — neither `Definition` nor `PolicySpec` has a
    `status`/`enabled` field; the AC-095 kill-switch (`ensemble behavior
    disable`) is runtime state, so it is `ctx[:enabled]`. An *absent* key is
    not a failure — definitions reach Policy through the registry, which is
    already the enable/disable surface — so absence means "nothing revoked
    this behavior"; `false`, `nil` and `:unknown` all block.
  * **budget** — `PolicySpec` has no `budget` field (grep-confirmed), so gate
    6 is a present-only hook: it fires only when `ctx[:budget]` carries a
    limit it can compare against. Absence yields no reason at all — the
    budget ledger is Phase 4 (TRD-031 / Telemetry), and a policy must never
    manufacture a deny out of an unimplemented feature.
  * **mode** — `policy.mode` (`:observe | :propose | :active`) is consumed by
    `AgentInvoker` (Phase 3b) to decide what to *do* with an `:activate`,
    not by Policy. Observe and propose behaviors still verdict `:activate`;
    the invoker downgrades them. Keeping mode out of the verdict stops two
    components from owning one knob.
  * **dedup** — delegates to `Matcher.dedup_suppressed?/4`, so the matcher
    and the policy can never disagree about what a duplicate is.
  * **cooldown** — keyed by `behavior_name`, per TRD lines 543-544 (§12 Q2:
    scope `:event_type`, which is per-behavior for a single-event_type
    behavior).

  ## Purity

  Time enters only via `opts[:now_ms]`, resolved once at the top. No files,
  no audit writes, no `Logger`, no process state: identical inputs always
  yield an identical decision, which is what makes the gate order testable
  by construction.
  """

  alias Ensemble.Behavior.{Definition, Event, Matcher, PolicyDecision}

  @type reason :: PolicyDecision.reason()

  @gates [:enabled, :dedup, :cooldown, :concurrency, :recursion, :budget, :constitution]

  @doc "The fixed gate order, earliest first (TRD §4.1)."
  @spec gates() :: [atom()]
  def gates, do: @gates

  @doc """
  Evaluate `defn` against `event`.

  `opts`:

  * `:ctx` / `:policy_context` — the PolicyContext map above
  * `:now_ms` — injected clock, default `System.system_time(:millisecond)`
  * `:constitution_verdict` — `:allow | :deny | :pending`, overrides the
    rules-derived gate-7 result
  * `:approval_state` — `:satisfied | :pending | :granted | :denied | :unknown`,
    consulted when `ctx` carries no approval evidence
  """
  @spec evaluate(Definition.t(), Event.t() | map(), map()) :: PolicyDecision.t()
  def evaluate(defn, event, opts \\ %{})

  def evaluate(%Definition{} = defn, event, opts) when is_map(opts) do
    now = Map.get(opts, :now_ms, System.system_time(:millisecond))
    ctx = Map.get(opts, :ctx) || Map.get(opts, :policy_context) || %{}

    unless is_map(ctx) do
      raise ArgumentError, "Policy context must be a map, got #{inspect(ctx)}"
    end

    @gates
    |> Enum.flat_map(&apply(__MODULE__, &1, [&1, defn, event, ctx, opts, now]))
    |> PolicyDecision.decide()
  end

  def evaluate(%Definition{} = defn, event, opts) do
    raise ArgumentError,
          "Policy opts must be a map, got #{inspect(opts)} for behavior #{defn.name} " <>
            "event #{inspect(event_id(event))}"
  end

  @doc false
  @spec enabled(atom(), Definition.t(), term(), map(), map(), integer()) :: [reason()]
  def enabled(_gate, _defn, _event, ctx, _opts, _now) do
    case Map.fetch(ctx, :enabled) do
      :error -> []
      {:ok, true} -> []
      {:ok, false} -> [reason!(:enabled, :disabled, "behavior disabled or revoked (AC-095)")]
      {:ok, nil} -> [reason!(:enabled, :disabled, "enabled state is nil; fail closed (AC-095)")]
      {:ok, :unknown} -> [unresolved(:enabled, :unknown)]
      {:ok, other} -> [unresolved(:enabled, other)]
    end
  end

  @doc false
  @spec dedup(atom(), Definition.t(), term(), map(), map(), integer()) :: [reason()]
  def dedup(_gate, %Definition{policy: %{dedup_window: w}} = _d, _event, _ctx, _opts, _now)
      when w <= 0,
      do: []

  def dedup(_gate, %Definition{policy: %{dedup_window: w}} = d, event, ctx, _opts, now) do
    case Map.fetch(ctx, :dedup) do
      {:ok, store} when is_map(store) ->
        if Matcher.dedup_suppressed?(event, d, store, now) do
          [reason!(:dedup, :duplicate_suppressed, "duplicate within #{w}ms dedup_window")]
        else
          []
        end

      {:ok, other} ->
        [unresolved(:dedup, other)]

      :error ->
        [unresolved(:dedup, :dedup)]
    end
  end

  @doc false
  @spec cooldown(atom(), Definition.t(), term(), map(), map(), integer()) :: [reason()]
  def cooldown(_gate, %Definition{policy: %{cooldown: c}} = _d, _event, _ctx, _opts, _now)
      when c <= 0,
      do: []

  def cooldown(_gate, %Definition{policy: %{cooldown: c}} = d, _event, ctx, _opts, now) do
    cooldown_lookup(ctx, d.name, c, now)
  end

  defp cooldown_lookup(ctx, name, c, now) do
    case Map.fetch(ctx, :cooldowns) do
      :error ->
        [unresolved(:cooldown, :cooldowns)]

      {:ok, table} when is_map(table) ->
        case Map.fetch(table, name) do
          :error ->
            []

          {:ok, nil} ->
            []

          {:ok, last} when is_integer(last) ->
            if now - last < c,
              do: [reason!(:cooldown, :cooldown_active, "#{c - (now - last)}ms of #{c}ms left")],
              else: []

          {:ok, other} ->
            [unresolved(:cooldown, other)]
        end

      other ->
        [unresolved(:cooldown, other)]
    end
  end

  @doc false
  @spec concurrency(atom(), Definition.t(), term(), map(), map(), integer()) :: [reason()]
  def concurrency(_gate, %Definition{policy: %{max_concurrent: max}} = _d, _event, ctx, _opts, _now) do
    case Map.fetch(ctx, :active) do
      :error ->
        [unresolved(:concurrency, :active)]

      {:ok, n} when is_integer(n) and n >= 0 ->
        if n >= max,
          do: [reason!(:concurrency, :limit_reached, "#{n} of #{max} activations active")],
          else: []

      {:ok, other} ->
        [unresolved(:concurrency, other)]
    end
  end

  @doc false
  @spec recursion(atom(), Definition.t(), term(), map(), map(), integer()) :: [reason()]
  def recursion(_gate, %Definition{policy: p} = _d, event, ctx, _opts, _now) do
    depth = Map.get(ctx, :causal_depth) || causal_depth(event)

    depth_reason =
      cond do
        not is_integer(p.max_causal_depth) ->
          unresolved(:recursion, p.max_causal_depth)

        not is_integer(depth) or depth < 0 ->
          unresolved(:recursion, depth)

        depth + 1 > p.max_causal_depth ->
          reason!(:recursion, :depth_exceeded,
            "depth #{depth} + 1 exceeds max_causal_depth #{p.max_causal_depth}")

        true ->
          nil
      end

    fan_reason =
      cond do
        not is_integer(p.max_children) ->
          unresolved(:recursion, p.max_children)

        p.max_children <= 0 ->
          reason!(:recursion, :fan_out_exceeded, "max_children is #{p.max_children}")

        true ->
          children_reason(ctx, p.max_children)
      end

    Enum.flat_map([depth_reason, fan_reason], &List.wrap/1)
  end

  defp children_reason(ctx, max) do
    case Map.fetch(ctx, :children) do
      # A behavior that cannot fan out needs no child counter resolved.
      :error -> unresolved(:recursion, :children)
      {:ok, nil} -> unresolved(:recursion, nil)

      {:ok, n} when is_integer(n) and n >= 0 ->
        if n >= max,
          do: reason!(:recursion, :fan_out_exceeded, "#{n} of #{max} children active"),
          else: nil

      {:ok, other} ->
        unresolved(:recursion, other)
    end
  end

  @doc """
  Gate 6 — budget hook (AC-090). Inert unless `ctx[:budget]` supplies a
  limit; `@moduledoc` explains why absence is never a deny.

  Shapes: `%{limit: %{tokens: n, wall_clock_ms: n}, used: %{...}}`, or a
  flat map read as *used*, whose wall-clock axis falls back to
  `policy.timeout`.
  """
  @spec budget(atom(), Definition.t(), term(), map(), map(), integer()) :: [reason()]
  def budget(_gate, %Definition{policy: p}, _event, ctx, _opts, _now) do
    case Map.get(ctx, :budget) do
      nil ->
        []

      table when is_map(table) ->
        structured? = Map.has_key?(table, :limit) or Map.has_key?(table, :used)

        limit = if structured?, do: Map.get(table, :limit) || %{}, else: table

        used =
          if structured? do
            case Map.fetch(table, :used) do
              {:ok, u} -> u
              :error -> %{}
            end
          else
            table
          end

        cond do
          not is_map(limit) -> [unresolved(:budget, limit)]
          not is_map(used) -> [unresolved(:budget, used)]
          true -> token_reason(limit, used, structured?) ++ wall_reason(limit, used, structured?, p)
        end

      other ->
        [unresolved(:budget, other)]
    end
  end

  defp token_reason(limit, used, nested?) do
    ceiling = if nested?, do: limit, else: %{}

    with true <- is_map(ceiling),
         max when is_integer(max) <- Map.get(ceiling, :tokens),
         n when is_integer(n) <- Map.get(used, :tokens),
         true <- n >= max do
      [reason!(:budget, :token_budget_exhausted, "#{n} of #{max} tokens spent")]
    else
      _ -> []
    end
  end

  @doc false
  defp wall_reason(limit, used, nested?, p) do
    explicit = if is_map(limit), do: Map.get(limit, :wall_clock_ms), else: nil
    spent = if is_map(used), do: Map.get(used, :wall_clock_ms), else: nil

    max =
      cond do
        is_integer(explicit) -> explicit
        not nested? and is_integer(spent) -> spent
        true -> p.timeout
      end

    if is_integer(max) and is_integer(spent) and spent >= max do
      [reason!(:budget, :wall_clock_exhausted, "#{spent} of #{max}ms spent")]
    else
      []
    end
  end

  @doc false
  @spec constitution(atom(), Definition.t(), term(), map(), map(), integer()) :: [reason()]
  def constitution(_gate, %Definition{constitution_rules: rules}, _event, ctx, opts, _now) do
    case Map.get(opts, :constitution_verdict) do
      :allow ->
        []

      :deny ->
        [reason!(:constitution, :constitution_denied, "constitution verdict denied (AC-070)")]

      :pending ->
        [reason!(:constitution, :approval_required, "constitution approval pending (AC-069)")]

      nil ->
        rules |> List.wrap() |> Enum.flat_map(&rule_reason(&1, ctx, opts))

      other ->
        [unresolved(:constitution, other)]
    end
  end

  defp rule_reason(rule, ctx, opts) do
    {id, required} = rule_fields(rule)

    if required do
      case approval_state(ctx, opts) do
        s when s in [:satisfied, :granted] -> []
        :pending -> [reason!(:constitution, :approval_required, "rule #{inspect(id)} pending (AC-069)")]
        :required -> [reason!(:constitution, :approval_required, "rule #{inspect(id)} needs approval (AC-067)")]
        :denied -> [reason!(:constitution, :constitution_denied, "rule #{inspect(id)} approval denied")]
        nil -> [unresolved(:constitution, :approval_state)]
        other -> [unresolved(:constitution, other)]
      end
    else
      []
    end
  end

  defp rule_fields(%{id: id, approval_required: r}), do: {id, r == true}
  defp rule_fields(%{"id" => id, "approval_required" => r}), do: {id, r == true}
  defp rule_fields(_), do: {nil, false}

  defp approval_state(ctx, opts) do
    cond do
      Map.has_key?(ctx, :pending_approval) -> if ctx[:pending_approval], do: :pending, else: :satisfied
      Map.has_key?(ctx, :approval_state) -> Map.get(ctx, :approval_state)
      Map.has_key?(opts, :approval_state) -> Map.get(opts, :approval_state)
      true -> :required
    end
  end

  defp reason!(gate, code, detail), do: %{gate: gate, code: code, detail: detail}

  defp unresolved(gate, evidence),
    do: reason!(gate, :policy_unresolved, "unresolved policy evidence: #{inspect(evidence)}")

  defp event_id(%Event{event_id: id}), do: id
  defp event_id(event), do: event[:event_id] || event["event_id"]

  defp causal_depth(%Event{depth: d}) when is_integer(d), do: d

  defp causal_depth(event) do
    case event[:causal_depth] || event["causal_depth"] || event[:depth] || event["depth"] do
      n when is_integer(n) -> n
      _ -> 0
    end
  end
end
