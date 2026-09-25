defmodule Ensemble.Behavior.Telemetry do
  @moduledoc """
  Opt-in run telemetry + redaction pipeline (TRD §5.3, REQ-013;
  TRD-031; AC-049, AC-050, AC-052, AC-096, Article IV).

  ## What is stored

  One JSONL record per completed activation in
  `.ensemble/telemetry/runs.jsonl` (dir override: `:dir` option, else
  `telemetry.dir` config, else default):

      %{
        "schema"          => 1,
        "behavior_id"      => "name@version#digest12",
        "event_id"         => triggering event id,
        "activation_id"    => ..., "causal_root" => ...,
        "started_at"       => iso8601, "completed_at" => iso8601,
        "duration_ms"      => integer,
        "tool_calls"       => [%{"tool" => t, "digest" => "sha256:..", "seq" => n}],
        "outcome_kind"     => atom|string,
        "metrics"          => flushed error-bucket counts (TRD-034),
        "redaction"        => %{applied: true, fields: [allowlisted keys]}
      }

  ## What is never stored (AC-052 / AC-096 / Article IV)

  Prompt **bodies** never land in a telemetry record. A `:prompt` is
  reduced to `%{digest: "sha256:<hex>", length: bytes}` by
  `prompt_digest/1`; the raw text is not written anywhere on this path.
  Tool-call *arguments* are likewise reduced to structural digests.
  Every stored string additionally passes the §5.3 default regex pass —
  reused from `Ensemble.Behavior.Audit.Redact` (single implementation,
  no duplicated patterns) so `[REDACTED:<kind>]` markers survive a second
  pass unchanged.

  ## Opt-in (AC-049)

  Collection is OFF by default. Enable per call (`enabled: true`), per
  config (`config :ensemble, :telemetry, enabled: true`), or node-wide via
  `set_enabled/1`. When disabled, `record_run/2` returns `:disabled` and
  writes nothing.
  """

  alias Ensemble.Behavior.Audit
  alias Ensemble.Behavior.Audit.Redact

  @schema 1

  # --- configuration ------------------------------------------------------

  @doc "Where telemetry records live; `:dir` option always wins."
  def dir(opts \\ []) do
    Keyword.get(opts, :dir) ||
      telemetry_env(:dir) ||
      Path.join(".ensemble", "telemetry")
  end

  @doc """
  Node-wide default for collection. Starts `false`; `set_enabled/1` is
  process-tree inheritable (persistent_term).
  """
  def enabled? do
    case telemetry_env(:enabled) do
      nil -> persistent_enabled?()
      v -> v
    end
  end

  @doc "Turn collection on/off for the whole node (opt-in contract, AC-049)."
  def set_enabled(flag) when flag in [true, false] do
    :persistent_term.put({__MODULE__, :enabled}, flag)
  end

  defp persistent_enabled?, do: :persistent_term.get({__MODULE__, :enabled}, false)

  defp telemetry_env(key) do
    case Application.get_env(:ensemble, :telemetry, []) do
      kw when is_list(kw) -> Keyword.get(kw, key)
      m when is_map(m) -> Map.get(m, key)
      _ -> nil
    end
  end

  @doc """
  Field allowlist (AC-052 "project allowlist"). When `telemetry.fields`
  (config) or `:fields` (option) is a list, `record_run/2` keeps only
  those keys from the caller-supplied `extra` map; anything else is
  dropped before redaction.
  """
  def fields(opts \\ []) do
    Keyword.get(opts, :fields) || telemetry_env(:fields)
  end

  # --- public API ---------------------------------------------------------

  @doc """
  Record one completed run.

  `run` is a map (atom or string keys) with any of:
  `behavior_id` | `definition`, `event_id`, `activation_id`, `causal_root`,
  `started_at`, `completed_at`, `duration_ms`, `tool_calls`, `outcome_kind`,
  `prompt`, `extra`, `metrics`.

  Options: `:dir`, `:enabled`, `:fields`. Returns
  `{:ok, record}` when written, `:disabled` when collection is off, or
  `{:error, reason}` on an I/O failure (surfaced, never swallowed).
  """
  @spec record_run(map(), keyword()) :: {:ok, map()} | :disabled | {:error, term()}
  def record_run(run, opts \\ []) do
    if Keyword.get(opts, :enabled, enabled?()) do
      do_record_run(run, opts)
    else
      :disabled
    end
  end

  @doc """
  Read stored runs. Filters: `:behavior_id`, `:event_id`, `:since`
  (iso8601, ms or DateTime), `:dir`, `:limit`. Chronological,
  deterministic. Accepts a bare behavior-id string as the first argument.
  """
  @spec replay_for(keyword() | String.t(), keyword()) :: [map()]
  def replay_for(opts \\ [], extra \\ [])

  def replay_for(behavior_id, extra) when is_binary(behavior_id),
    do: replay_for(Keyword.put(extra, :behavior_id, behavior_id))

  def replay_for(opts, extra) when is_list(opts) do
    opts = opts ++ extra
    file = Path.join(dir(opts), "runs.jsonl")

    case File.read(file) do
      {:ok, body} ->
        body
        |> String.split("\n", trim: true)
        |> Enum.map(&decode_line/1)
        |> Enum.reject(&is_nil/1)
        |> Enum.filter(&keep?(&1, opts))
        |> Enum.sort_by(&sort_key/1)
        |> then(&limit(&1, opts[:limit]))

      _ ->
        []
    end
  end

  @doc "Convenience: every run recorded for `behavior_id` (AC-050 replay)."
  def replay_for_behavior(behavior_id, opts \\ []) do
    replay_for(behavior_id, opts)
  end

  @doc """
  Prompt bodies are never stored: reduce to digest + length (AC-052,
  Article IV / plan REQ-SAFE-004).
  """
  @spec prompt_digest(String.t() | binary() | map() | nil) :: map() | nil
  def prompt_digest(nil), do: nil

  def prompt_digest(prompt) when is_binary(prompt) do
    %{
      "digest" => "sha256:" <> (:sha256 |> :crypto.hash(prompt) |> Base.encode16(case: :lower)),
      "length" => byte_size(prompt)
    }
  end

  def prompt_digest(other) do
    other |> Audit.canonical_json() |> IO.iodata_to_binary() |> prompt_digest()
  end

  @doc """
  The §5.3 redaction pipeline: default regex pass (shared with the audit
  ledger). Exposed so discovery/observability write paths use the one
  true pass instead of duplicating patterns.
  """
  defdelegate redact(value), to: Redact

  # --- internals ----------------------------------------------------------

  defp do_record_run(run, opts) do
    started = time_ms(fetch(run, :started_at))
    completed = time_ms(fetch(run, :completed_at)) || System.system_time(:millisecond)
    duration = fetch(run, :duration_ms) || (started && completed - started) || 0

    tool_calls =
      run
      |> fetch(:tool_calls)
      |> List.wrap()
      |> Enum.map(&tool_call/1)

    allowed = fields(opts)
    supplied_extra = fetch(run, :extra) || %{}

    extra =
      case allowed do
        nil when is_map(supplied_extra) ->
          stringify_keys(supplied_extra)

        nil ->
          %{"value" => supplied_extra}

        list when is_map(supplied_extra) ->
          Map.take(stringify_keys(supplied_extra), Enum.map(List.wrap(list), &to_string/1))

        _ ->
          %{}
      end

    base =
      %{
        "schema" => @schema,
        "behavior_id" => behavior_id(run),
        "event_id" => string_or_nil(fetch(run, :event_id)),
        "event_type" => string_or_nil(fetch(run, :event_type)),
        "activation_id" => string_or_nil(fetch(run, :activation_id)),
        "causal_root" => string_or_nil(fetch(run, :causal_root)),
        "started_at" => iso(started),
        "duration_ms" => duration,
        "completed_at" => iso(completed),
        "tool_calls" => tool_calls,
        "outcome_kind" => outcome_kind(fetch(run, :outcome_kind) || fetch(run, :status)),
        "prompt" => prompt_digest(fetch(run, :prompt)),
        "metrics" => flush_metrics(run),
        "extra" => if(extra == %{}, do: nil, else: extra)
      }
      |> filter_nils()

    record =
      base
      |> Redact.redact()
      |> Map.put("redaction", %{
        "applied" => true,
        "fields" => allowed && Enum.map(List.wrap(allowed), &to_string/1)
      })

    file = Path.join(dir(opts), "runs.jsonl")

    try do
      File.mkdir_p!(Path.dirname(file))
      File.write!(file, [Audit.canonical_json(record), "\n"], [:append])
      {:ok, record}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp fetch(run, key) when is_atom(key) do
    cond do
      Map.has_key?(run, key) -> Map.get(run, key)
      Map.has_key?(run, to_string(key)) -> Map.get(run, to_string(key))
      true -> nil
    end
  end

  # Tool arguments never travel verbatim: structural digest + seq only.
  defp tool_call(%_{} = s), do: s |> Map.from_struct() |> tool_call()

  defp tool_call(m) when is_map(m) do
    tool = Map.get(m, :tool) || Map.get(m, "tool")

    args =
      Map.get(m, :args) || Map.get(m, "args") || Map.get(m, :arguments) || Map.get(m, "arguments")

    seq = Map.get(m, :seq) || Map.get(m, "seq") || Map.get(m, :index) || Map.get(m, "index")

    %{
      "tool" => to_string(tool),
      "digest" => digest_of(args || m),
      "seq" => seq
    }
    |> filter_nils()
  end

  defp tool_call({t, args}), do: %{"tool" => to_string(t), "digest" => digest_of(args)}
  defp tool_call(t) when is_binary(t), do: %{"tool" => t}
  defp tool_call(t) when is_atom(t), do: %{"tool" => to_string(t)}
  defp tool_call(other), do: %{"tool" => inspect(other)}

  defp digest_of(v) do
    "sha256:" <>
      (:sha256
       |> :crypto.hash(Audit.canonical_json(v) |> IO.iodata_to_binary())
       |> Base.encode16(case: :lower))
  end

  # metrics flush into this record without consuming a sibling flush
  defp flush_metrics(run) do
    case Map.get(run, :metrics) || Map.get(run, "metrics") do
      m when is_map(m) ->
        Map.new(m, fn {k, v} -> {to_string(k), v} end)

      _ ->
        m = Ensemble.Behavior.Metrics

        if Code.ensure_loaded?(m) and function_exported?(m, :peek_and_reset, 0) do
          case apply(m, :peek_and_reset, []) do
            map when is_map(map) and map_size(map) > 0 ->
              Map.new(map, fn {k, v} -> {to_string(k), v} end)

            _ ->
              nil
          end
        end
    end
  end

  defp behavior_id(run) do
    case fetch(run, :behavior_id) do
      b when is_binary(b) ->
        b

      _ ->
        case fetch(run, :definition) do
          %_{name: n, version: v} = d ->
            "#{n}@#{version_string(v)}" <> digest_suffix(Map.get(d, :digest))

          nil ->
            string_or_nil(fetch(run, :name)) || "unknown"

          _ ->
            "unknown"
        end
    end
  end

  defp version_string(%{major: a, minor: b, patch: c} = v) do
    base = "#{a}.#{b}.#{c}"

    case Map.get(v, :pre) do
      nil -> base
      [] -> base
      pre -> base <> "-" <> Enum.join(List.wrap(pre), ".")
    end
  end

  defp version_string(v), do: to_string(v)

  defp digest_suffix(nil), do: ""

  # Definition digests are raw 32-byte binaries, not "sha256:" strings.
  defp digest_suffix(d) when is_binary(d) and byte_size(d) == 32,
    do: "#" <> (d |> Base.encode16(case: :lower) |> String.slice(0, 12))

  defp digest_suffix(d) when is_binary(d), do: "#" <> short(d)
  defp digest_suffix(_), do: ""

  defp short(s), do: s |> String.replace_prefix("sha256:", "") |> String.slice(0, 12)

  defp outcome_kind(nil), do: "completed"
  defp outcome_kind(a) when is_atom(a), do: to_string(a)
  defp outcome_kind(s) when is_binary(s), do: s
  defp outcome_kind(other), do: inspect(other)

  defp stringify_keys(m) when is_struct(m), do: m |> Map.from_struct() |> stringify_keys()
  defp stringify_keys(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), v} end)

  defp time_ms(%DateTime{} = dt), do: DateTime.to_unix(dt, :millisecond)
  defp time_ms(ms) when is_integer(ms), do: ms
  defp time_ms(nil), do: nil

  defp time_ms(s) when is_binary(s) do
    case DateTime.from_iso8601(s) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end

  defp time_ms(_), do: nil

  defp iso(nil), do: nil

  defp iso(ms) when is_integer(ms),
    do: ms |> DateTime.from_unix!(:millisecond) |> DateTime.to_iso8601()

  defp iso(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp iso(s) when is_binary(s), do: s

  defp string_or_nil(nil), do: nil
  defp string_or_nil(v) when is_binary(v), do: v
  defp string_or_nil(v), do: to_string(v)

  defp filter_nils(map), do: :maps.filter(fn _k, v -> v != nil end, map)

  defp keep?(rec, opts) do
    Enum.all?(opts, fn
      {:behavior_id, b} -> rec["behavior_id"] == b
      {:event_id, e} -> rec["event_id"] == e
      {:since, s} -> (time_ms(rec["completed_at"]) || 0) >= (time_ms(s) || 0)
      _ -> true
    end)
  end

  defp sort_key(rec),
    do: {time_ms(rec["completed_at"]) || 0, rec["behavior_id"] || "", rec["event_id"] || ""}

  defp limit(list, nil), do: list
  defp limit(list, n) when is_integer(n) and n > 0, do: Enum.take(list, n)
  defp limit(list, _), do: list

  defp decode_line(line) do
    case :json.decode(line) do
      m when is_map(m) -> m
      _ -> nil
    end
  rescue
    _ -> nil
  end
end
