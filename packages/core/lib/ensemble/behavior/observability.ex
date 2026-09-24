defmodule Ensemble.Behavior.Observability do
  @moduledoc """
  Activation observability + shadow mode (TRD-033, TRD §5.4;
  AC-097, AC-098, AC-099; plan REQ-COMP-004 shadow bead br-srn).

  ## Parallel activations (AC-097/AC-099)

  `Ensemble.Behavior.ActivationSupervisor` (a DynamicSupervisor) runs
  each activation as an independent child `Ensemble.Behavior.
  ActivationTask`. Children correlate every log line they emit through
  Logger metadata `causal_root` (the activation id) plus `behavior`, so
  N concurrent activations interleave in the stream yet stay separable
  — `correlation_index/1` proves it.

  `start_activation/3` is the seam that honors **shadow mode**: a
  behavior registered with `Registry.register/3, shadow: true`
  (per-registration flag, default false; the caller passes it when the
  project is registered with Foreman — this module has zero Foreman
  coupling) records matcher proposals and audits `:match_recorded`, but
  NEVER invokes an agent and NEVER starts a dispatch child.
  `dispatch?/1` exposes the gate.

  ## Ledger tail + diagnose (AC-097, AC-098)

  `tail/1` follows the audit ledger (the `<dir>/*.jsonl` layout
  `Audit.query/1` scans) from a byte cursor — the `ensemble behavior
  events tail` surface. Under `ENSEMBLE_BEHAVIORS_DEBUG=1` yielded
  records mirror to stderr via Logger; nothing here replaces the
  existing test-failure observer's channel — the mirror only *adds*
  ledger lines while that env contract is set.

  `diagnose/2` replays the ledger for one activation into an ordered
  trail with governing decisions and `last_completed_step` — "where did
  this run actually stop?" without a debugger.
  """
  use GenServer

  alias Ensemble.Behavior.{
    ActivationSupervisor,
    ActivationTask,
    Audit,
    Definition,
    Event,
    MatchResult,
    Matcher,
    Registry
  }

  require Logger

  # --- activations -------------------------------------------------------

  @doc """
  Start a supervised activation for `event` (optionally pre-matched
  against `defn`). Options: `:fun` (0-arity work run under the frozen
  grant list), `:definitions` (match set when `defn` is nil),
  `:audit_opts`, `:telemetry_opts`, `:registry`.

  Returns `{:ok, %{activation_id:, shadow:, proposals:, pid:}}`; in
  shadow mode `pid` is nil and no invocation seam is touched.
  """
  def start_activation(%Event{} = event, defn \\ nil, opts \\ []) do
    activation_id = ActivationTask.generate_id("act")
    audit_opts = Keyword.get(opts, :audit_opts, [])
    server = Keyword.get(opts, :registry, Registry)
    shadow? = shadow_for(defn, server)

    proposals =
      Matcher.propose(event, defs_for(defn, opts, server), %{audit: :none})

    matched = Enum.filter(proposals, &match?(%MatchResult{status: :matched}, &1))

    {:ok, _} =
      Audit.append_kind(
        :match_recorded,
        Keyword.merge(audit_opts,
          subject: to_string(event.event_id || "event"),
          activation_id: activation_id,
          causal_root: activation_id,
          defn: defn,
          payload: %{
            event_type: event.event_type,
            matched: Enum.map(matched, & &1.definition.name),
            shadow: shadow?
          }
        )
      )

    child =
      if matched != [] and not shadow? do
        spec =
          ActivationTask.child_spec(%{
            activation_id: activation_id,
            event: event,
            defn: hd(matched).definition,
            fun: Keyword.get(opts, :fun),
            telemetry_opts: Keyword.get(opts, :telemetry_opts, []),
            audit_opts: audit_opts
          })

        case DynamicSupervisor.start_child(ActivationSupervisor, spec) do
          {:ok, pid} -> pid
          {:error, {:already_started, pid}} -> pid
          {:error, reason} -> {:error, reason}
        end
      end

    case child do
      {:error, reason} ->
        {:error, reason}

      _ ->
        {:ok,
         %{activation_id: activation_id, shadow: shadow?, proposals: proposals, pid: child}}
    end
  end

  defp defs_for(%Definition{} = d, _opts, _server), do: [d]
  defp defs_for(nil, opts, server), do: Keyword.get_lazy(opts, :definitions, fn -> Registry.all(server) end)

  @doc "Shadow decision for a registration (true ⇒ record-only)."
  @spec shadow_for(Definition.t() | nil, GenServer.server()) :: boolean()
  def shadow_for(%Definition{name: n, version: v}, server), do: Registry.shadow?({n, v}, server)
  def shadow_for(nil, _server), do: false

  @doc "Would `defn` actually dispatch right now (non-shadow)?"
  def dispatch?(defn, server \\ Registry), do: not shadow_for(defn, server)

  @doc """
  Group `{root, line}` log tuples per root (AC-099): distinct
  causal_roots ⇒ no cross-talk. Accepts `{causal_root, line}` tuples or
  plain strings (the latter are grouped by an `act-<hex>` token found in
  the line; untagged lines land under `"untagged"`).
  """
  def correlation_index(logs) when is_list(logs) do
    logs
    |> Enum.reduce(%{}, fn
      {cr, line}, acc ->
        key =
          cond do
            is_binary(cr) -> cr
            cr == nil -> tag_of(line) || "untagged"
            true -> inspect(cr)
          end

        Map.update(acc, key, [{key, line}], fn xs -> xs ++ [{key, line}] end)

      line, acc when is_binary(line) ->
        key = tag_of(line) || "untagged"
        Map.update(acc, key, [{key, line}], fn xs -> xs ++ [{key, line}] end)
    end)
  end

  defp tag_of(line) when is_binary(line) do
    case Regex.run(~r/\bact-[A-Za-z0-9]+\b/, line) do
      [id | _] -> id
      _ -> nil
    end
  end

  # --- ledger tail (AC-097) ------------------------------------------------

  @doc """
  `ensemble behavior events tail`: audit records appended after the byte
  cursor. Options: `:dir` (default `Audit.audit_dir/0`), `:after`
  cursor (nil = from start), `:limit`, `:mirror`
  (`:log` | `:stderr` | `:off`; default: stderr mirror iff
  `ENSEMBLE_BEHAVIORS_DEBUG=1`). Returns `{records, cursor}`; feed the
  cursor back for the next tick.
  """
  @spec tail(keyword()) :: {[map()], cursor() | nil}

  def tail(opts \\ []) do
    limit = Keyword.get(opts, :limit, :infinity)
    dir = Keyword.get(opts, :dir) || Audit.audit_dir()
    files = ledger_files(dir)
    start = Keyword.get(opts, :after) || {0, 0}

    {records, cursor} = drain(files, start, limit, [])

    mirror =
      case Keyword.get(opts, :mirror) do
        nil -> if(debug_env?(), do: :log, else: :off)
        m -> m
      end

    if mirror != :off, do: Enum.each(records, &mirror_line(&1, mirror))

    {records, cursor}
  end

  @doc "Poll `tail/1` every `:poll_ms` (default 50) until `fun.(records)` or `:tries` (default 100)."
  @spec tail_until(keyword(), (list() -> boolean())) :: {:ok, list()} | :timeout
  def tail_until(opts, fun) when is_function(fun, 1) do
    poll_ms = Keyword.get(opts, :poll_ms, 50)
    tries = Keyword.get(opts, :tries, 100)
    do_tail_until(opts, fun, {0, 0}, poll_ms, tries)
  end

  defp do_tail_until(_opts, _fun, _cur, _pm, 0), do: :timeout

  defp do_tail_until(opts, fun, cur, pm, left) do
    {recs, cur} = tail(Keyword.put(opts, :after, cur))

    if fun.(recs) do
      {:ok, recs}
    else
      Process.sleep(pm)
      do_tail_until(opts, fun, cur, pm, left - 1)
    end
  end

  @typep cursor :: {non_neg_integer(), non_neg_integer()}
  defp ledger_files(dir) do
    case File.ls(dir) do
      {:ok, names} ->
        names
        |> Enum.filter(&(String.ends_with?(&1, ".jsonl") && !String.contains?(&1, "index.db")))
        |> Enum.sort()
        |> Enum.map(&Path.join(dir, &1))

      _ ->
        []
    end
  end

  defp drain(_files, cur, 0, acc), do: {Enum.reverse(acc), cur}

  defp drain([f | rest], cur, limit, acc) do
    case File.read(f) do
      {:ok, body} ->
        {lines, consumed} = take_lines(body, elem(cur, 1))

        if lines == [] do
          drain(rest, {elem(cur, 0), consumed}, limit, acc)
        else
          drain(rest, {elem(cur, 0) + 1, consumed}, dec(limit), acc ++ lines)
        end

      _ ->
        drain(rest, {elem(cur, 0) + 1, 0}, limit, acc)
    end
  end

  defp drain([], cur, _limit, acc), do: {Enum.reverse(acc), cur}

  defp dec(:infinity), do: :infinity
  defp dec(n) when is_integer(n), do: n - 1

  # Complete lines only: returns {decoded_records, new_offset}.
  defp take_lines(body, off) when is_binary(body) do
    rest = binary_part(body, min(off, byte_size(body)), byte_size(body) - min(off, byte_size(body)))
    full = byte_size(rest) - trailing_partial_size(rest)
    complete = binary_part(rest, 0, max(full, 0))

    lines =
      complete
      |> String.split("\n", trim: true)
      |> Enum.map(&decode_line/1)
      |> Enum.reject(&is_nil/1)

    {lines, off + full}
  end

  defp trailing_partial_size(rest) do
    case String.split(rest, "\n") |> List.last() do
      nil -> 0
      "" -> 0
      last -> if String.ends_with?(rest, "\n"), do: 0, else: byte_size(last)
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

  defp debug_env?, do: System.get_env("ENSEMBLE_BEHAVIORS_DEBUG") == "1"

  defp mirror_line(record, sink) do
    line =
      "[behavior-events] " <>
        "#{record["ts"] || record["occurred_at"]} #{record["kind"]} " <>
        "subject=#{record["subject"]} activation=#{record["activation_id"] || "-"}"

    case sink do
      :log -> Logger.info(line)
      :stderr -> IO.puts(:stderr, line)
      _ -> :ok
    end
  end

  # --- diagnose (AC-098) ---------------------------------------------------

  @doc """
  Rebuild the trail for `activation_id` from the audit ledger: ordered
  steps, governing decisions (`policy_rejection`/`proposal_link`/
  `match_recorded.shadow`), and `last_completed_step` = latest non-
  terminal step. Extra options pass through to `Audit.query/1`
  (`:dir`, `:kind`, …).
  """
  @spec diagnose(String.t(), keyword()) :: map()
  def diagnose(activation_id, opts \\ []) do
    base = Keyword.merge([activation_id: activation_id], opts)

    records =
      (Audit.query(Keyword.put(base, :kind, :activation)) ++
         Audit.query(base) ++
         Audit.query(Keyword.put(base, :causal_root, activation_id)))
      |> Enum.uniq_by(& &1["audit_id"])
      |> Enum.sort_by(&(&1["occurred_at"] || &1["ts"]))

    steps = Enum.map(records, &step_of/1)

    terminal? =
      Enum.any?(steps, fn s ->
        s.kind in ["run_failed", "policy_rejection", "tool_violation"] or s.decision == :denied
      end)

    %{
      found: steps != [],
      activation_id: activation_id,
      steps: steps,
      decisions: Enum.reject(steps, &is_nil(&1.decision)),
      last_completed_step:
        steps
        |> Enum.reverse()
        |> Enum.find(fn s ->
          s.kind not in ["run_failed", "policy_rejection", "tool_violation"] and s.decision != :denied
        end)
        |> then(fn
          nil -> nil
          s -> %{ts: s.ts, kind: s.kind, subject: s.subject}
        end),
      terminated?: terminal?
    }
  end

  defp step_of(r) do
    p = r["payload"] || %{}

    decision =
      cond do
        r["kind"] == "policy_rejection" -> :denied
        r["kind"] == "proposal_link" -> :proposed
        r["kind"] == "match_recorded" and p["shadow"] == true -> :shadow
        r["kind"] == "skill_invocation" -> :invoked
        true -> nil
      end

    %{
      ts: r["occurred_at"] || r["ts"],
      kind: r["kind"],
      subject: r["subject"],
      decision: decision,
      audit_id: r["audit_id"]
    }
  end

  # --- bookkeeping server --------------------------------------------------

  @doc false
  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, :ok, Keyword.put_new(opts, :name, __MODULE__))

  @impl true
  def init(:ok), do: {:ok, %{}}

  @doc "Reset bookkeeping (test helper)."
  def reset, do: GenServer.call(__MODULE__, :reset)

  @impl true
  def handle_call(:reset, _from, _state), do: {:reply, :ok, %{}}
end
