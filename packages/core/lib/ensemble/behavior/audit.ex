defmodule Ensemble.Behavior.Audit do
  @moduledoc """
  Append-only audit sink (TRD §1.7 / §5.1, REQ-011/REQ-012/REQ-021,
  TRD-016/TRD-026/TRD-027).

  ## Entry kinds (exactly six, TRD §5.1)

  See `Ensemble.Behavior.Audit.Kind`. Every record carries the common
  fields (AC-020, AC-081, AC-094):

  * `audit_id` — UUIDv7-shaped, time-sortable
  * `ts` / `occurred_at` — wall clock, ISO-8601 UTC milliseconds
  * `kind` — canonical kind name; `type` — legacy dotted string, kept on
    every write so pre-TRD-026 readers keep working (identical mapping,
    see `Kind`)
  * `subject` — behavior name when known
  * `behavior` — identity map `%{"name", "version", "digest"}` (nil parts
    allowed)
  * `actor` — normalized `%{"id", "type"}` (AC-020: never a bare string,
    never dropped)
  * `git_sha` — from `Definition.source[:git_sha]` (AC-094)
  * correlation ids — `event_id`, `activation_id`, `proposal_id`,
    `causal_root`, `correlation_id`, `invocation_id` when known
  * `payload` — kind-specific detail, secret-redacted (AC-096)

  ## Storage

  Monthly partitioned JSONL under `ENSEMBLE_AUDIT_DIR` (default
  `.ensemble/audit`) — see `Ensemble.Behavior.Audit.Retention`. Queries
  may be accelerated by an index (`Ensemble.Behavior.Audit.Index`), but
  the index is an accelerator only: every query path falls back to a
  full partition scan and revalidates candidates against decoded
  records, so no entry is ever omitted (AC-084).

  Writes are synchronous on the decision path (never dropped); records
  compose through `canonical_json/1` (sorted keys, escaped strings) so
  `replay/1` proves byte-equivalence (AC-017).
  """

  import Bitwise

  alias Ensemble.Behavior.MatchResult
  alias Ensemble.Behavior.Audit.{Index, Kind, Redact, Retention}

  @typedoc "A decoded ledger record: string-keyed map with the common fields."
  @type ledger_record :: map()

  @doc """
  Log every Matcher proposal (match or reject) synchronously, **before**
  `Policy.evaluate` sees the event (AC-026/AC-027). Returns `{:ok, count}`.
  Sink errors are surfaced, not swallowed.

  The record is a `match_recorded` entry carrying `event_id`, `dedup_key`,
  the candidate list (`name@version` + status + digest) and a per-candidate
  `trace_ref` (TRD §5.1 required fields).
  """
  @spec log_match(term(), [MatchResult.t()]) :: {:ok, non_neg_integer()} | {:error, term()}
  def log_match(event, results) when is_list(results) do
    ev = event || %{}

    payload = fn ->
      %{
        "event_type" => event_type_of(ev),
        "event_id" => event_id_of(ev),
        "dedup_key" => dedup_key_of(ev),
        "candidates" =>
          Enum.map(results, fn %MatchResult{} = r ->
            %{
              "behavior" => r.definition.name,
              "name" => r.definition.name,
              "version" => to_string(r.definition.version),
              "status" => Atom.to_string(r.status),
              "digest" => digest_hex(r.definition.digest),
              "trace_ref" => trace_ref(r)
            }
          end)
      }
    end

    append_kind(:match_recorded,
      subject: event_subject(ev) || first_candidate(results),
      payload: payload,
      actor: Map.get(ev, :actor),
      event_id: event_id_of(ev),
      correlation_id: field(ev, :correlation_id),
      causal_root: field(ev, :causal_parent) || field(ev, :causation_id)
    )
    |> case do
      {:ok, _id} -> {:ok, length(results)}
      {:error, _} = e -> e
    end
  end

  @doc """
  Append a `tool_violation` record (TRD §5.1; AC-038, AC-040, AC-082).
  Additive entry point used by `AgentInvoker.authorize/2`; reuses the same
  append primitive as `log_match/2`. Sink errors are surfaced to the
  caller, which logs them without letting the write failure change the
  deny/allow decision.

  The entry carries behavior identity, `invocation_id`, `attempted_tool`,
  `declared_tools`, timestamp and actor — what was attempted and when is
  reconstructable from the entry alone (AC-082).
  """
  def log_violation(invocation, tool, declared) do
    inv = invocation || %{}
    defn = Map.get(inv, :behavior) || %{}

    payload = fn ->
      %{
        "behavior" => Map.get(inv, :name) || Map.get(defn, :name),
        "version" =>
          Map.get(inv, :version) || to_string_or_nil(Map.get(defn, :version)),
        "digest" => Map.get(inv, :digest) || digest_field(Map.get(defn, :digest)),
        "activation_id" => Map.get(inv, :activation_id),
        "invocation_id" => Map.get(inv, :invocation_id),
        "attempted_tool" => normalize_tool(tool),
        "declared" => Enum.map(List.wrap(declared), &normalize_tool/1),
        "declared_tools" => Enum.map(List.wrap(declared), &normalize_tool/1),
        "actor" => Map.get(inv, :actor),
        "timestamp" => timestamp()
      }
      |> filter_nils()
    end

    case append_kind(:tool_violation,
           defn: if(is_struct(defn), do: defn, else: nil),
           payload: payload,
           actor: Map.get(inv, :actor),
           event_id: field(inv, :event_id),
           invocation_id: field(inv, :invocation_id),
           activation_id: field(inv, :activation_id),
           attempted_tool: normalize_tool(tool),
           legacy_file: "violations.jsonl",
           digest: Map.get(inv, :digest) || digest_hex(Map.get(defn, :digest)),
           dir: Map.get(inv, :dir) || Keyword.get(Map.get(inv, :opts) || [], :dir) || audit_dir()
         ) do
      {:ok, _} -> :ok
      {:error, _} = e -> e
    end
  end

  @doc """
  Append an `activation` record reconstructing what happened for one
  policy verdict (TRD §5.1; AC-020, AC-081).

  Carries behavior name/version/digest, event_id, activation_id, verdict,
  actor, causal_root, plus the terminal `final_status`
  (`completed|failed|timeout`) and start/completion timestamps when the
  execution identity is known. Options:

  * `:decision` — `%PolicyDecision{}` (verdict + gate reasons inlined)
  * `:actor` — overrides `event.actor` (AC-020)
  * `:activation_id` / `:invocation` — execution identity
  * `:final_status` / `:status` / `:started_at` / `:completed_at`
  * `:causal_root`, `:correlation_id`, `:occurred_at`, `:verdict`
  """
  @spec log_activation(struct() | nil, term(), struct() | nil, keyword() | map()) ::
          {:ok, String.t()} | {:error, term()}
  def log_activation(defn \\ nil, event \\ nil, decision \\ nil, opts \\ [])

  def log_activation(defn, event, decision, opts) do
    opts = normalize_opts(opts)
    ev = event || %{}
    dec = decision || Keyword.get(opts, :decision)
    verdict = verdict_of(dec) || Keyword.get(opts, :verdict)
    invocation = Keyword.get(opts, :invocation) || %{}

    payload = fn ->
      base = %{
        "verdict" => verdict && to_string(verdict),
        "reasons" => reasons_of(dec),
        "event_type" => event_type_of(ev)
      }

      extras = %{
        "final_status" => Keyword.get(opts, :final_status) || Keyword.get(opts, :status),
        "started_at" => opts[:started_at] && to_iso(opts[:started_at]),
        "completed_at" => opts[:completed_at] && to_iso(opts[:completed_at]),
        "invocation_id" => string_or_nil(field(invocation, :invocation_id)),
        "execution" => execution_identity(invocation)
      }

      Map.merge(base, filter_nils(extras))
    end

    append_kind(:activation,
      subject: subject_of(defn) || Map.get(ev, :subject_id),
      defn: defn,
      payload: payload,
      actor: Keyword.get(opts, :actor) || Map.get(ev, :actor) || field(invocation, :actor),
      event_id: Keyword.get(opts, :event_id) || event_id_of(ev),
      activation_id: Keyword.get(opts, :activation_id) || field(invocation, :activation_id),
      correlation_id: Keyword.get(opts, :correlation_id) || field(ev, :correlation_id),
      causal_root:
        Keyword.get(opts, :causal_root) || field(ev, :causal_parent) || field(ev, :causation_id),
      occurred_at: Keyword.get(opts, :occurred_at),
      verdict: verdict,
      dir: Keyword.get(opts, :dir)
    )
  end

  @doc """
  Write a `proposal_link` entry connecting a proposal to the activation
  that emitted it (TRD §5.1; AC-083). Append-only: calling it twice for
  the same pair produces two ledger entries; `query/1` results are
  deduped by `audit_id`.
  """
  @spec link_proposal(String.t() | nil, String.t() | nil, keyword()) ::
          {:ok, String.t()} | {:error, term()}
  def link_proposal(activation_id, proposal_id, opts \\ []) do
    opts = normalize_opts(opts)

    payload = fn ->
      %{
        "activation_id" => activation_id,
        "proposal_id" => proposal_id,
        "mutation_class" => Keyword.get(opts, :mutation_class)
      }
    end

    append_kind(:proposal_link,
      subject: Keyword.get(opts, :behavior) || subject_of(Keyword.get(opts, :defn)),
      defn: Keyword.get(opts, :defn),
      payload: payload,
      activation_id: activation_id,
      proposal_id: proposal_id,
      event_id: Keyword.get(opts, :event_id),
      actor: Keyword.get(opts, :actor),
      mutation_class: Keyword.get(opts, :mutation_class),
      occurred_at: Keyword.get(opts, :occurred_at),
      dir: Keyword.get(opts, :dir)
    )
  end

  @doc """
  Log a policy outcome for a candidate that did (or did not) proceed.

  AC-095: non-activating verdicts must not vanish silently.
  `:block`/`:deny`/`:reject` write a `policy_rejection` entry with the
  behavior id and the failing gate reasons (TRD §5.1 "disabled/revoked/
  blocked"); every other verdict writes an `activation` entry whose
  verdict + `final_status` records the suppression, since `defer`,
  `suppress` and `require_approval` are lifecycle outcomes of a
  considered activation, not rejections.
  """
  @spec log_policy(struct() | nil, term(), struct() | map() | nil, keyword()) ::
          {:ok, String.t()} | {:error, term()}
  def log_policy(defn \\ nil, event \\ nil, decision \\ nil, opts \\ []) do
    opts = normalize_opts(opts)
    dec = decision || Keyword.get(opts, :decision)
    verdict = verdict_of(dec) || Keyword.get(opts, :verdict)

    if verdict in [:block, :deny, :reject] do
      ev = event || %{}

      payload = fn ->
        %{
          "reason" => reason_text(dec, opts),
          "reasons" => reasons_of(dec)
        }
      end

      append_kind(:policy_rejection,
        subject: subject_of(defn),
        defn: defn,
        payload: payload,
        actor: Keyword.get(opts, :actor) || Map.get(ev, :actor),
        event_id: Keyword.get(opts, :event_id) || event_id_of(ev),
        correlation_id: Keyword.get(opts, :correlation_id) || field(ev, :correlation_id),
        causal_root: field(ev, :causal_parent) || field(ev, :causation_id),
        dir: Keyword.get(opts, :dir)
      )
    else
      log_activation(defn, event, dec,
        Keyword.put_new_lazy(opts, :final_status, fn -> verdict && to_string(verdict) end)
      )
    end
  end

  @doc """
  Append a `skill_invocation` entry for one composed skill step (TRD §5.1;
  AC-046): activation_id, `skill@digest`, monotonic `seq` within the
  activation. Tool-call arguments ride as structural digests, never
  verbatim (REQ-SAFE-004).
  """
  @spec log_skill(String.t() | nil, struct() | String.t() | nil, String.t(), integer(), keyword()) ::
          {:ok, String.t()} | {:error, term()}
  def log_skill(activation_id, defn \\ nil, skill, seq, opts \\ []) when is_integer(seq) do
    opts = normalize_opts(opts)

    payload = fn ->
      %{
        "skill" => skill,
        "skill_digest" => Keyword.get(opts, :skill_digest),
        "skill_ref" => digest_ref(skill, Keyword.get(opts, :skill_digest)),
        "seq" => seq,
        "args_digest" => args_digest(Keyword.get(opts, :args)),
        "event_id" => Keyword.get(opts, :event_id)
      }
    end

    append_kind(:skill_invocation,
      subject: name_of(defn),
      defn: if(is_struct(defn), do: defn, else: nil),
      payload: payload,
      activation_id: activation_id,
      actor: Keyword.get(opts, :actor),
      event_id: Keyword.get(opts, :event_id),
      dir: Keyword.get(opts, :dir)
    )
  end

  defp digest_ref(skill, nil), do: skill
  defp digest_ref(skill, digest), do: "#{skill}@#{digest}"

  @doc """
  Structural digest of tool-call arguments (REQ-SAFE-004): stable hash of
  the canonical form, no verbatim values in the ledger.
  """
  @spec args_digest(term()) :: String.t() | nil
  def args_digest(nil), do: nil

  def args_digest(args) do
    "sha256:" <>
      (:sha256 |> :crypto.hash(canonical_json(redact(args))) |> Base.encode16(case: :lower))
  end

  # --- querying (TRD-027, AC-084/088/090) ---------------------------------

  @doc """
  Chronological query over the ledger.

  Filters: `:behavior_id`, `:kind`, `:event_id`, `:mutation`, `:since`,
  `:until`, `:limit` (applied after ordering), `:dir` (override),
  `:index` (index module, default from `ENSEMBLE_AUDIT_INDEX_MODULE` or
  `Ensemble.Behavior.Audit.Index.Sqlite; `nil`/`:none` disable it).

  The index is an accelerator: any index failure transparently performs
  the full partition scan, and candidate ids from the index are always
  revalidated against decoded records — the result set is identical with
  and without an index (AC-084: "no entries omitted").
  """
  @spec query(keyword() | map()) :: [record()]
  def query(filter \\ []) do
    filter = normalize_opts(filter)
    dir = Keyword.get(filter, :dir, audit_dir())

    indexed =
      case Keyword.get(filter, :index, index_module()) do
        nil -> :error
        :none -> :error
        mod when is_atom(mod) -> index_lookup(mod, dir, filter)
      end

    records =
      case indexed do
        {:ok, ids} when is_list(ids) ->
          fetched = fetch_by_ids(ids, dir, filter)
          # An index that knows nothing (fresh DB over a pre-existing
          # ledger) must not answer "no matches". With no date bound the
          # index claims to cover the whole ledger, so an empty answer
          # there means "unbuilt" → full scan. With a date bound, an
          # empty answer is legitimate (that window really had nothing)
          # and the scan would defeat the accelerator.
          cond do
            fetched != [] -> fetched
            ids != [] -> fetched
            bounded?(filter) -> fetched
            partitions_present?(dir) -> scan(dir, filter)
            true -> []
          end

        _ ->
          scan(dir, filter)
      end

    records
    |> Enum.uniq_by(& &1["audit_id"])
    |> Enum.sort_by(&sort_key/1)
    |> apply_limit(Keyword.get(filter, :limit))
  end

  @doc "Convenience: `kind: :activation` over the last `minutes` (AC-088)."
  @spec recent_activations(non_neg_integer(), keyword()) :: [record()]
  def recent_activations(minutes \\ 60, opts \\ []) do
    since = DateTime.add(DateTime.utc_now(), -minutes, :minute)
    query(Keyword.merge([kind: :activation, since: since], opts))
  end

  @doc "Stream all audit records, sorted by audit_id (legacy contract preserved)."
  def stream do
    audit_dir()
    |> Path.join("*.jsonl")
    |> Path.wildcard()
    |> Enum.flat_map(fn f ->
      f
      |> File.stream!(:line, [])
      |> Stream.map(&decode_line/1)
      |> Stream.reject(&is_nil/1)
    end)
    |> Enum.sort_by(& &1["audit_id"])
  end

  @doc "True when `record` matches `filter` (same semantics as `query/1`)."
  @spec matches?(record(), keyword()) :: boolean()
  def matches?(record, filter) do
    filter
    |> Keyword.drop([:dir, :index, :limit])
    |> Enum.all?(fn
      {:behavior_id, v} -> behavior_id_of(record) == v |> String.split("@") |> hd()
      {:kind, v} -> kind_of(record) == v
      {:event_id, v} -> event_id_of(record) == v
      {:mutation, v} -> mutation_of(record) == v
      {:since, v} -> after_or_at?(record, v)
      {:until, v} -> before_or_at?(record, v)
      _ -> true
    end)
  end

  @doc "Canonical kind of a decoded record (legacy `type` strings normalize)."
  @spec kind_of(record() | String.t() | atom()) :: atom()
  def kind_of(%{"kind" => k}), do: Kind.normalize(k)
  def kind_of(%{"type" => t}), do: Kind.normalize(t)
  def kind_of(k) when is_atom(k) or is_binary(k), do: Kind.normalize(k)
  def kind_of(_), do: :unknown

  @doc "Behavior identity for indexing (`name@version` when both known, else `name`)."
  @spec behavior_id_of(record()) :: String.t() | nil
  def behavior_id_of(record) do
    case Map.get(record, "behavior") do
      %{"name" => n} when is_binary(n) and n != "" ->
        n

      b when is_binary(b) and b != "" ->
        b |> String.split("@") |> hd()

      _ ->
        case Map.get(record, "subject") do
          s when is_binary(s) and s != "" -> s |> String.split("@") |> hd()
          _ -> nil
        end
    end
  end

  @doc "Event correlation id for indexing (nil when absent)."
  @spec event_id_of(record() | struct() | map()) :: String.t() | nil
  def event_id_of(%{"event_id" => id}) when is_binary(id), do: id
  def event_id_of(%{event_id: id}) when is_binary(id), do: id
  def event_id_of(%{event_id: id}) when not is_nil(id), do: to_string(id)
  def event_id_of(_), do: nil

  @doc "Indexable timestamp (occurred_at || ts) as ISO-8601."
  @spec occurred_at_of(record()) :: String.t() | nil
  def occurred_at_of(record) do
    case Map.get(record, "occurred_at") || Map.get(record, "ts") do
      nil -> nil
      v -> to_iso(v)
    end
  end

  @doc "Milliseconds for the record time (nil when absent or unparseable)."
  @spec occurred_at_ms(record()) :: integer() | nil
  def occurred_at_ms(record) do
    case occurred_at_of(record) do
      nil -> nil
      iso -> iso_ms(iso)
    end
  end

  @doc "Mutation class for indexing (proposal links and activation payloads)."
  @spec mutation_of(record()) :: String.t() | nil
  def mutation_of(%{"mutation_class" => m}) when is_binary(m), do: m

  def mutation_of(%{"payload" => p}) when is_map(p) do
    case p["mutation_class"] do
      m when is_binary(m) -> m
      _ -> nil
    end
  end

  def mutation_of(_), do: nil

  @doc "Decode one JSONL line to a map (nil when unparseable)."
  @spec decode_record(String.t()) :: map() | nil
  def decode_record(line) when is_binary(line), do: decode_line(line)
  def decode_record(_), do: nil

  @doc """
  Redact secrets in any value before it enters the ledger (TRD §5.3,
  AC-096). Public so the telemetry exporter reuses the exact same pass.
  """
  @spec redact(term()) :: term()
  defdelegate redact(value), to: Redact

  @doc "Canonical JSON bytes for a payload (AC-017 byte-equivalent replay)."
  def replay(payload) when is_map(payload), do: payload |> canonical_json() |> IO.iodata_to_binary()

  @doc false
  def audit_dir, do: System.get_env("ENSEMBLE_AUDIT_DIR") || ".ensemble/audit"

  @doc false
  def to_iso(v), do: to_iso_s(v)

  @doc false
  def iso_ge(%DateTime{} = a, b), do: DateTime.to_unix(a, :millisecond) >= iso_ms(b)
  def iso_ge(a, b) when is_binary(a), do: iso_ms(a) >= iso_ms(b)
  @doc "Inclusive upper comparison; see `iso_ge/2`."
  def iso_le(%DateTime{} = a, b), do: DateTime.to_unix(a, :millisecond) <= iso_ms(b)
  @doc false
  def scan_all(dir \\ audit_dir()) do
    dir
    |> Path.join("*.jsonl")
    |> Path.wildcard()
    |> Enum.flat_map(&read_records([&1], dir))
    |> Enum.sort_by(&sort_key/1)
  end


  # --- append core --------------------------------------------------------

  @doc """
  Build and write a record of `kind`; options overlay the common fields,
  `:payload` may be a zero-arity function for lazy construction. Returns
  `{:ok, audit_id}` or `{:error, reason}` (surfaced, never swallowed).
  """
  @spec append_kind(atom(), keyword()) :: {:ok, String.t()} | {:error, term()}
  def append_kind(kind, opts \\ []) when is_atom(kind) do
    dir = Keyword.get(opts, :dir) || audit_dir()
    ts = Keyword.get(opts, :occurred_at) || timestamp()
    iso = to_iso(ts)
    defn = Keyword.get(opts, :defn)

    payload =
      case Keyword.get(opts, :payload, fn -> %{} end) do
        f when is_function(f, 0) -> f.()
        p when is_map(p) -> p
        _ -> %{}
      end

    overlay =
      for k <- ~w(activation_id proposal_id invocation_id attempted_tool mutation_class
                  causal_root correlation_id run_id event_id),
          into: %{},
          do: {k, string_or_nil(Keyword.get(opts, String.to_atom(k)))}

    base =
      %{
        "audit_id" => audit_id(),
        "ts" => iso,
        "occurred_at" => iso,
        "kind" => Atom.to_string(kind),
        "type" => Kind.legacy_type(kind),
        "subject" => to_string(Keyword.get(opts, :subject) || "unknown"),
        "behavior" => behavior_identity(defn, opts),
        "actor" => actor_field(Keyword.get(opts, :actor)),
        "git_sha" => string_or_nil(Keyword.get(opts, :git_sha) || source_git_sha(defn)),
        "payload" => redact(payload)
      }
      |> Map.merge(filter_nils(overlay))
      |> then(fn m ->
        case Keyword.get(opts, :verdict) do
          nil -> m
          v -> Map.put(m, "verdict", to_string(v))
        end
      end)

    file =
      case Keyword.get(opts, :legacy_file) do
        nil -> Path.join(dir, Retention.partition_name(kind, ts))
        name when is_binary(name) -> Path.join(dir, name)
      end

    try do
      File.mkdir_p!(dir)
      File.write!(file, [canonical_json(base), "\n"], [:append])
      index_insert(dir, base, file)
      {:ok, base["audit_id"]}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp filter_nils(map), do: :maps.filter(fn _k, v -> v != nil end, map)

  defp normalize_opts(%{__struct__: _} = s), do: s |> Map.from_struct() |> Enum.into([])
  defp normalize_opts(%{} = m), do: Enum.into(m, [])
  defp normalize_opts(kw) when is_list(kw), do: kw

  defp behavior_identity(defn, opts) do
    name = Keyword.get(opts, :behavior_name) || get_field(defn, :name)
    version = Keyword.get(opts, :behavior_version) || get_field(defn, :version) && to_string(get_field(defn, :version))
    digest = Keyword.get(opts, :digest) || (is_struct(defn) && digest_hex(Map.get(defn, :digest)))

    %{"name" => string_or_nil(name), "version" => string_or_nil(version), "digest" => string_or_nil(digest)}
  end

  defp get_field(%_{} = s, k), do: Map.get(s, k)
  defp get_field(m, k) when is_map(m), do: Map.get(m, k) || Map.get(m, Atom.to_string(k))
  defp get_field(_, _), do: nil

  defp source_git_sha(%{source: src}) when is_map(src), do: src[:git_sha] || src["git_sha"]
  defp source_git_sha(%{git_sha: sha}), do: sha
  defp source_git_sha(_), do: nil

  defp actor_field(%{__struct__: _} = a), do: a |> Map.from_struct() |> actor_field()

  defp actor_field(%{} = a) do
    id = a[:id] || a["id"] || a[:email] || a["email"] || a[:handle] || a["handle"]
    type = a[:type] || a["type"] || a[:kind] || a["kind"] || infer_actor_type(id)
    %{"id" => string_or_nil(id), "type" => string_or_nil(type)}
  end

  defp actor_field(a) when is_binary(a), do: %{"id" => a, "type" => "user"}
  defp actor_field(a) when is_atom(a) and not is_nil(a), do: %{"id" => Atom.to_string(a), "type" => Atom.to_string(a)}
  defp actor_field(_), do: %{"id" => nil, "type" => "system"}

  defp infer_actor_type(id) when is_binary(id) do
    cond do
      String.contains?(id, "@") -> "user"
      String.starts_with?(id, "svc:") -> "service"
      String.length(id) == 36 -> "system"
      true -> "user"
    end
  end

  defp infer_actor_type(_), do: "system"

  defp to_string_or_nil(nil), do: nil
  defp to_string_or_nil(v), do: to_string(v)

  # An `%Invocation{}` stores the digest hex-encoded; only a raw
  # `%Definition{}` (32-byte binary) needs encoding.
  defp digest_field(<<_::256>> = raw), do: Base.encode16(raw, case: :lower)
  defp digest_field(other), do: other

  defp subject_of(%{name: n, version: v}) when not is_nil(n), do: "#{n}@#{v}"
  defp subject_of(%{name: n}) when is_binary(n), do: n
  defp subject_of(n) when is_binary(n), do: n
  defp subject_of(_), do: nil

  defp name_of(%{name: n}) when is_binary(n), do: n
  defp name_of(n) when is_binary(n), do: n
  defp name_of(_), do: nil

  defp first_candidate([%MatchResult{definition: %{name: n}} | _]) when is_binary(n), do: n
  defp first_candidate(_), do: nil

  defp verdict_of(%{verdict: v}) when not is_nil(v), do: v
  defp verdict_of(%{decision: %{verdict: v}}), do: v
  defp verdict_of(%{"verdict" => v}) when is_binary(v), do: v |> String.to_atom()
  defp verdict_of(v) when is_atom(v), do: v
  defp verdict_of(_), do: nil

  defp reasons_of(%{reasons: rs}) when is_list(rs) do
    Enum.map(rs, fn r ->
      %{
        "gate" => to_string_or_nil(get_field(r, :gate)),
        "code" => to_string_or_nil(get_field(r, :code)),
        "detail" => get_field(r, :detail)
      }
    end)
  end

  defp reasons_of(_), do: []

  defp reason_text(dec, opts) do
    Keyword.get(opts, :reason) ||
      case reasons_of(dec) do
        [%{"code" => code} | _] when is_binary(code) -> code
        _ -> nil
      end
  end

  defp event_subject(%{subject_id: s}) when is_binary(s), do: s
  defp event_subject(%{subject: s}) when is_binary(s), do: s
  defp event_subject(%{"subject_id" => s}) when is_binary(s), do: s
  defp event_subject(_), do: nil

  defp execution_identity(inv) when map_size(inv) == 0, do: nil

  defp execution_identity(inv) do
    filter_nils(%{
      "invocation_id" => string_or_nil(field(inv, :invocation_id)),
      "name" => string_or_nil(field(inv, :name)),
      "status" => string_or_nil(field(inv, :status)),
      "started_at" => field(inv, :started_at) && to_iso(field(inv, :started_at)),
      "ended_at" => field(inv, :ended_at) && to_iso(field(inv, :ended_at))
    })
  end

  defp field(map, key) when is_map(map) do
    case map do
      %{^key => v} -> v
      _ -> Map.get(map, Atom.to_string(key))
    end
  rescue
    _ -> nil
  end

  defp field(_map, _key), do: nil

  defp digest_hex(<<_::256>> = raw), do: Base.encode16(raw, case: :lower)
  defp digest_hex(other), do: other

  defp normalize_tool(t) when is_binary(t), do: t
  defp normalize_tool(t) when is_atom(t) and not is_nil(t), do: Atom.to_string(t)
  defp normalize_tool(t) when is_integer(t), do: Integer.to_string(t)
  defp normalize_tool(_), do: nil

  defp trace_ref(%MatchResult{match_reason: nil}), do: nil

  defp trace_ref(%MatchResult{match_reason: mr}),
    do: "sha256:" <> (:sha256 |> :crypto.hash(canonical_json(mr)) |> Base.encode16(case: :lower))

  defp timestamp do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp to_iso_s(%DateTime{} = dt), do: dt |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  defp to_iso_s(%NaiveDateTime{} = ndt), do: ndt |> DateTime.from_naive!("Etc/UTC") |> to_iso_s()
  defp to_iso_s(ms) when is_integer(ms), do: ms |> DateTime.from_unix!(:millisecond) |> to_iso_s()
  defp to_iso_s(iso) when is_binary(iso), do: iso
  defp to_iso_s(_), do: timestamp()

  @doc """
  Parse an ISO-8601 string (or pass through an integer millisecond value)
  to epoch milliseconds; 0 when unparseable.
  """
  @spec iso_ms_public(String.t() | integer()) :: integer()
  def iso_ms_public(iso) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> String.to_integer(iso)
    end
  rescue
    _ -> 0
  end

  def iso_ms_public(v) when is_integer(v), do: v
  def iso_ms_public(other), do: other |> to_iso_s() |> iso_ms_public()

  defp iso_ms(iso) when is_binary(iso), do: iso_ms_public(iso)
  defp iso_ms(other), do: other |> to_iso_s() |> iso_ms_public()

  defp sort_key(record) do
    {occurred_at_ms(record) || 0, record["audit_id"] || ""}
  end

  defp apply_limit(records, nil), do: records
  defp apply_limit(records, n) when is_integer(n) and n > 0, do: Enum.take(records, n)

  defp after_or_at?(record, v) do
    case occurred_at_ms(record) do
      nil -> true
      ms -> ms >= iso_ms(v)
    end
  end

  defp before_or_at?(record, v) do
    case occurred_at_ms(record) do
      nil -> true
      ms -> ms <= iso_ms(v)
    end
  end

  defp partitions_present?(dir) do
    case dir |> Path.join("*.jsonl") |> Path.wildcard() do
      [] -> false
      _ -> true
    end
  end

  defp bounded?(filter) do
    Keyword.has_key?(filter, :since) or Keyword.has_key?(filter, :until)
  end

  defp read_records(files, dir) do
    Enum.flat_map(files, fn f ->
      case File.read(f) do
        {:ok, content} ->
          content
          |> String.split("\n", trim: true)
          |> Enum.map(&decode_line/1)
          |> Enum.reject(&is_nil/1)
          |> Enum.map(&Map.put(&1, "__partition__", Path.relative_to(f, dir)))

        _ ->
          []
      end
    end)
  end

  defp scan(dir, filter) do
    filter
    |> Retention.partitions_for(dir)
    |> read_records(dir)
    |> Enum.filter(&matches?(&1, filter))
  end

  defp fetch_by_ids(ids, dir, filter) do
    idset = MapSet.new(ids)
    bounds = Keyword.take(filter, [:since, :until])

    Retention.partitions_for(bounds, dir)
    |> read_records(dir)
    |> Enum.filter(&MapSet.member?(idset, &1["audit_id"]))
  end

  defp index_lookup(mod, dir, filter) do
    try do
      st = ensure_index_state(mod, dir, nil)

      if Map.get(st, :failed) do
        {:error, :index_unavailable}
      else
        keys = ~w(behavior_id kind event_id mutation since until)a

        case mod.lookup(st, Keyword.take(filter, keys)) do
          {:ok, ids} -> {:ok, ids}
          {:error, _} = e -> e
        end
      end
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  # --- index adapter (stateful; fail-open; accelerator only) ----------

  @index_key :"$audit_index_state"

  @doc """
  Reset the cached index state for this process (test isolation; the
  generation stamp auto-rotates on ledger change anyway).
  """
  def reset_index_state do
    case Process.get(@index_key) do
      nil -> :ok
      m -> Enum.each(m, fn {_k, st} -> close_index_state(st) end)
    end

    Process.delete(@index_key)
    :ok
  end

  @doc false
  def index_enabled? do
    System.get_env("ENSEMBLE_AUDIT_INDEX") != "off" and index_module() != nil
  end

  defp index_insert(dir, record, file) do
    mod = index_module()
    partition = Path.relative_to(file, dir)

    if is_nil(mod) or System.get_env("ENSEMBLE_AUDIT_INDEX") == "off" do
      :ok
    else
      try do
        st = ensure_index_state(mod, dir, partition)
        {:ok, st2} = mod.insert(st, Map.put(record, "__partition__", partition))
        put_index_state(st2)
      catch
        _, _ -> :ok
      end
    end
  rescue
    _ -> :ok
  end

  defp ensure_index_state(mod, dir, _partition) do
    gen = index_generation(mod, dir)
    map = Process.get(@index_key, %{})
    key = {mod, dir}

    case Map.fetch(map, key) do
      {:ok, %{mod: ^mod, dir: ^dir, generation: ^gen} = st} ->
        st

      _ ->
        close_index_state(Map.get(map, key))

        case mod.open(dir, []) do
          {:ok, st} ->
            st = %{st | mod: mod, dir: dir, generation: gen}
            put_index_state(st)
            st

          {:error, _} ->
            %{mod: mod, dir: dir, generation: gen, failed: true}
        end
    end
  end

  defp put_index_state(st) when is_map(st), do: Process.put(@index_key, Map.put(Process.get(@index_key, %{}), {st.mod, st.dir}, st))

  defp close_index_state(nil), do: :ok

  defp close_index_state(%{failed: true}), do: :ok

  defp close_index_state(%{mod: mod} = st) do
    try do
      mod.close(st)
    catch
      _, _ -> :ok
    end
  end

  defp index_generation(mod, dir) do
    try do
      cond do
        function_exported?(mod, :generation, 1) -> mod.generation(dir)
        function_exported?(mod, :generation, 2) -> mod.generation(dir, [])
        true -> 0
      end
    catch
      _, _ -> 0
    end
  end
  defp index_module do
    case System.get_env("ENSEMBLE_AUDIT_INDEX_MODULE") do
      nil -> Index.Sqlite
      "" -> Index.Sqlite
      "none" -> nil
      name -> String.to_atom("Elixir." <> name)
    end
  end

  defp decode_line(line) do
    case :json.decode(line) do
      m when is_map(m) -> m
      _ -> nil
    end
  rescue
    _ -> nil
  end

  @doc false
  def canonical_json(v), do: v |> encode_value() |> IO.iodata_to_binary()

  defp encode_value(%_{} = struct), do: struct |> Map.from_struct() |> encode_value()

  defp encode_value(v) when is_map(v) do
    inner =
      v
      |> Map.to_list()
      |> Enum.sort_by(fn {k, _} -> to_string(k) end)
      |> Enum.map(fn {k, val} -> [~s("), escape(to_string(k)), ~s(":), encode_value(val)] end)
      |> Enum.intersperse(",")

    ["{", inner, "}"]
  end

  defp encode_value(v) when is_list(v) do
    if Keyword.keyword?(v) and v != [] do
      encode_value(Map.new(v))
    else
      ["[", v |> Enum.map(&encode_value/1) |> Enum.intersperse(","), "]"]
    end
  end

  defp encode_value(v) when is_binary(v), do: [~S("), escape(v), ~S(")]
  defp encode_value(nil), do: "null"
  defp encode_value(true), do: "true"
  defp encode_value(false), do: "false"
  defp encode_value(v) when is_atom(v), do: [~S("), Atom.to_string(v), ~S(")]
  defp encode_value(v) when is_integer(v), do: Integer.to_string(v)
  defp encode_value(v) when is_float(v), do: Float.to_string(v)
  defp encode_value(v) when is_tuple(v), do: encode_value(Tuple.to_list(v))
  defp encode_value(v), do: raise(ArgumentError, "cannot audit-encode: #{inspect(v)}")

  defp escape(s) do
    s
    |> String.replace("\\", "\\\\")
    |> String.replace(~s("), ~s(\\"))
    |> String.replace("\n", "\\n")
    |> String.replace("\r", "\\r")
    |> String.replace("\t", "\\t")
  end

  @doc false
  def audit_id, do: uuid_v7()

  defp uuid_v7 do
    ms = System.system_time(:millisecond)
    <<rand_a::12, rand_b::14, rand_c::16, rand_d::48, _::6>> = :crypto.strong_rand_bytes(12)

    [
      hex(ms, 12),
      "-",
      hex(0x7000 ||| rand_a, 4),
      "-",
      hex(0x8000 ||| rand_b, 4),
      "-",
      hex(rand_c, 4),
      "-",
      hex(rand_d, 12)
    ]
    |> IO.iodata_to_binary()
  end

  defp hex(n, width),
    do: n |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(width, "0")

  defp event_type_of(%{event_type: t}), do: to_string_or_nil(t)
  defp event_type_of(t) when is_binary(t), do: t
  defp event_type_of(_), do: nil

  defp dedup_key_of(%{dedup_key: dk}), do: dk
  defp dedup_key_of(e), do: field(e, :idempotency_key) || field(e, "dedup_key")

  defp string_or_nil(nil), do: nil
  defp string_or_nil(v) when is_binary(v), do: v
  defp string_or_nil(v) when is_atom(v) and not is_nil(v), do: Atom.to_string(v)
  defp string_or_nil(v) when is_integer(v), do: Integer.to_string(v)
  defp string_or_nil(v), do: inspect(v)
end