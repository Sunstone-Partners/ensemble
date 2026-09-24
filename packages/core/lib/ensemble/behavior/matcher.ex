defmodule Ensemble.Behavior.Matcher do
  @moduledoc """
  Deterministic event-to-behavior matcher (TRD §1.6, REQ-005).

  On each event:

  1. Index lookup by `trigger.event_type` (exact registered type or
     `x-<project>.*` extension match).
  2. Predicate evaluation against the event payload + envelope
     (`Predicate.eval/2`); skip-not-fail on missing fields (AC-015-S).
  3. Dedup-window filter (AC-013): suppress if the same
     `{event.idempotency_key, behavior.name}` fired inside `policy.dedup_window`.
  4. Causal-depth filter (AC-014): drop if `event.causal_depth + 1 >
     behavior.policy.max_causal_depth`.
  5. Tie-break order: most specific trigger (predicate constraint count, then
     event-type segment count), then name (AC-016).

  `propose/2` is a pure query; `propose/3` with a dedup store performs the
  AC-013 suppression and records last-fired timestamps for the caller.
  """

  alias Ensemble.Behavior.{Definition, Predicate}

  @type dedup_state :: :ets.tab() | {atom(), reference()}

  @doc """
  Returns all definitions whose trigger matches `event`, in tie-break order,
  each annotated with its predicate trace.

      candidates(event, defs) :: [
        %{definition: Definition.t(), trace: [...], specificity: {non_neg_integer(), non_neg_integer()}}
      ]
  """
  @spec candidates(map(), [Definition.t()]) :: [map()]
  def candidates(event, defs) do
    event_type = event_type_of(event)

    defs
    |> Enum.filter(fn d -> d.trigger.event_type == event_type end)
    |> Enum.map(fn d ->
      {verdict, trace} = Predicate.eval(d.trigger.predicate, event)
      %{definition: d, trace: trace, verdict: verdict, specificity: specificity(d)}
    end)
    |> Enum.filter(&(&1.verdict == :match))
    |> Enum.sort_by(fn c ->
      {-elem(c.specificity, 0), -elem(c.specificity, 1), c.definition.name}
    end)
  end

  @doc """
  Like `candidates/2` but applies dedup-window (AC-013) and causal-depth
  (AC-014) filters. `store` is an `:ets` table (or map-backed ETS-equivalent
  process) holding `{event_key, behavior_name} -> last_fired_ms`; the caller
  owns it and records `record_fire/3` matches.

  Returns candidates annotated with `:suppressed` (dedup) or `:depth_dropped`.
  """
  @spec propose(map(), [Definition.t()], map()) :: [map()]
  def propose(event, defs, opts \\ %{}) do
    now = Map.get(opts, :now_ms, System.system_time(:millisecond))
    store = Map.get(opts, :dedup_store, %{})

    event
    |> candidates(defs)
    |> Enum.map(fn c ->
      d = c.definition

      cond do
        depth_dropped?(event, d) ->
          Map.put(c, :filtered, :causal_depth)

        dedup_suppressed?(event, d, store, now) ->
          Map.put(c, :filtered, :dedup)

        true ->
          Map.put(c, :filtered, nil)
      end
    end)
    |> Enum.reject(fn c -> c.filtered == :causal_depth or c.filtered == :dedup end)
  end

  defp depth_dropped?(event, %Definition{policy: %{max_causal_depth: cap}}) do
    depth = event[:causal_depth] || event["causal_depth"] || 0
    depth + 1 > cap
  end

  @doc "True when `store` holds a fire for `{event_key, name}` within the dedup window."
  def dedup_suppressed?(event, %Definition{} = d, store, now) do
    key = {event_key(event), d.name}

    case Map.get(store, key) do
      nil -> false
      last_fired_ms -> now - last_fired_ms < d.policy.dedup_window
    end
  end

  @doc "Record a fire in a map-based dedup store (ETS variant handled by caller)."
  def record_fire(store, event, %Definition{} = d, now \\ nil) do
    Map.put(store, {event_key(event), d.name}, now || System.system_time(:millisecond))
  end

  defp event_key(event) do
    event[:idempotency_key] || event["idempotency_key"] ||
      (event[:event_id] || event["event_id"]) ||
      {event_type_of(event), event[:source] || event["source"]}
  end

  defp event_type_of(event) do
    event[:event_type] || event["event_type"]
  end

  defp specificity(%Definition{trigger: t}) do
    {length(t.predicate), t.event_type |> String.split(".") |> length()}
  end
end
