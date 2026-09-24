defmodule Ensemble.Behavior.Events.Generic do
  @moduledoc """
  Fallback adapter (TRD-014, AC-024).

  Best-effort envelope: guesses `event_type` from common keys
  (`event_type`, `type`, `kind`, `name`); warns naming the source so the
  fallback is never silent.
  """

  require Logger

  alias Ensemble.Behavior.Event

  @spec normalize(map(), String.t()) :: {:warn, Event.t()}
  def normalize(raw, source \\ "unknown") do
    r = Map.new(raw, fn {k, v} -> {to_string(k), v} end)

    event_type = r["event_type"] || r["type"] || r["kind"] || r["name"] || "local.event"

    Logger.warning(fn ->
      "[behavior] generic fallback for source=#{inspect(source)} -> event_type=#{inspect(event_type)}"
    end)

    envelope =
      Event.build(
        event_type: to_string(event_type),
        source: source,
        subject_id: to_string(r["id"] || r["subject_id"] || r["uuid"] || ""),
        payload:
          Map.drop(r, ["event_type", "type", "kind", "name", "id", "subject_id", "uuid"]),
        actor: actor(r["actor"]),
        occurred_at: parse_time(r["timestamp"] || r["occurred_at"] || r["ts"])
      )

    {:warn, envelope}
  end

  defp actor(%{} = a), do: %{type: String.to_atom(to_string(a["type"] || "system")), id: a["id"]}
  defp actor(_), do: %{type: :system, id: nil}

  defp parse_time(nil), do: nil
  defp parse_time(ms) when is_integer(ms), do: ms

  defp parse_time(s) when is_binary(s) do
    case DateTime.from_iso8601(s) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end
end
