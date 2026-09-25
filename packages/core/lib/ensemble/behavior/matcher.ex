defmodule Ensemble.Behavior.Matcher do
  @moduledoc """
  Deterministic event-to-behavior matcher (TRD §1.6, REQ-005/REQ-007).

  On each event:

  1. Index lookup by `trigger.event_type` (exact registered type).
  2. Predicate evaluation against the event payload + envelope
     (`Predicate.eval/2`); skip-not-fail on missing fields (AC-015-S).
  3. Dedup-window filter (AC-013): suppress if the same
     dedup key fired inside `behavior.policy.dedup_window`.
  4. Causal-depth filter (AC-014): drop if `event.depth + 1 >
     behavior.policy.max_causal_depth`.
  5. Tie-break: most specific trigger (predicate constraint count, then
     event-type segment count), then `{name, version}` (AC-016/AC-027).

  `propose/3` returns `[MatchResult.t()]` — every same-event_type candidate,
  matched or annotated with a rejection reason (AC-026: no silent misses) —
  and calls the audit hook synchronously before returning, so the ledger
  records the decision input before `Policy.evaluate` sees anything (TRD-016).
  """

  require Logger
  alias Ensemble.Behavior.{Audit, Definition, Event, MatchResult, Predicate}

  @doc """
  Returns all definitions whose trigger matches `event`, in tie-break order,
  each annotated with its predicate trace (maps accepted for convenience).
  """
  @spec candidates(map() | Event.t(), [Definition.t()]) :: [map()]
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
  Full proposal with dedup/depth filters, deterministic ordering, and the
  synchronous match-before-decide audit hook (AC-026/AC-027, TRD-016).

  `opts`: `:now_ms`, `:dedup_store`, `:audit` (fun/1; default
  `&Audit.log_match(event, &1)`; pass `:none` to skip for pure tests).
  """
  @spec propose(map() | Event.t(), [Definition.t()], map()) :: [MatchResult.t()]
  def propose(event, defs, opts \\ %{}) do
    now = Map.get(opts, :now_ms, System.system_time(:millisecond))
    store = Map.get(opts, :dedup_store, %{})
    event_type = event_type_of(event)

    results =
      defs
      |> Enum.filter(fn d -> d.trigger.event_type == event_type end)
      |> Enum.map(fn d ->
        {verdict, trace} = Predicate.eval(d.trigger.predicate, event)

        cond do
          verdict != :match ->
            MatchResult.rejected(d, :predicate_failed)

          depth_dropped?(event, d) ->
            MatchResult.rejected(d, :depth_dropped)

          dedup_suppressed?(event, d, store, now) ->
            MatchResult.rejected(d, :suppressed)

          true ->
            MatchResult.matched(d, trace, now)
        end
      end)
      |> Enum.sort_by(fn r ->
        case r.status do
          :matched ->
            {0, -elem(specificity(r.definition), 0), -elem(specificity(r.definition), 1),
             r.definition.name, to_string(r.definition.version)}

          _ ->
            {1, 0, 0, r.definition.name, to_string(r.definition.version)}
        end
      end)

    audit = Map.get(opts, :audit, :default)

    if audit != :none and results != [] do
      hook =
        if is_function(audit, 1),
          do: audit,
          else: fn rs -> Audit.log_match(event, rs) end

      try do
        case hook.(results) do
          {:error, reason} -> Logger.error(fn -> "[behavior] audit write failed: #{inspect(reason)}" end)
          _ -> :ok
        end
      rescue
        e -> Logger.error(fn -> "[behavior] audit hook raised: #{inspect(e)}" end)
      end
    end

    results
  end

  defp depth_dropped?(%Event{depth: d}, %Definition{policy: %{max_causal_depth: cap}}) do
    d + 1 > cap
  end

  defp depth_dropped?(event, %Definition{policy: %{max_causal_depth: cap}}) do
    (event[:causal_depth] || event["causal_depth"] || 0) + 1 > cap
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

  defp event_key(%Event{dedup_key: dk, event_id: id, event_type: t, source: s}) do
    dk || id || {t, s}
  end

  defp event_key(event) do
    event[:idempotency_key] || event["idempotency_key"] ||
      (event[:event_id] || event["event_id"]) ||
      {event_type_of(event), event[:source] || event["source"]}
  end

  defp event_type_of(%Event{event_type: t}), do: t

  defp event_type_of(event) do
    event[:event_type] || event["event_type"]
  end

  defp specificity(%Definition{trigger: t}) do
    {length(t.predicate), t.event_type |> String.split(".") |> length()}
  end
end
