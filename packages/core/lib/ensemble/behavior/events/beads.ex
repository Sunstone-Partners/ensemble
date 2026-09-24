defmodule Ensemble.Behavior.Events.Beads do
  @moduledoc """
  Beads issue-tracking adapter (TRD-012, AC-022).

  Normalizes a status change (`%{"before" => %{"status" => old},
  "after" => %{"status" => new}}` or the flat `%{"issue" => ...,
  "from" => ..., "to" => ...}` form) to the canonical
  `issue.status_changed` event type with `old_status`/`new_status` in
  payload.
  """

  alias Ensemble.Behavior.Event

  @spec normalize(map()) :: {:ok, Event.t()} | {:warn, Event.t()}
  def normalize(raw) do
    issue = raw["issue"] || raw["id"] || ""
    old = get_in(raw, ["before", "status"]) || raw["from"]
    new = get_in(raw, ["after", "status"]) || raw["to"] || raw["status"]

    payload = %{
      "issue" => issue,
      "old_status" => old,
      "new_status" => new,
      "title" => raw["title"],
      "labels" => raw["labels"] || []
    }

    {:ok,
     Event.build(
       event_type: "issue.status_changed",
       source: "beads",
       project_id: raw["source_repo"] || raw["workspace"],
       subject_id: to_string(issue),
       payload: payload,
       actor: %{type: :user, id: raw["created_by"] || raw["updated_by"]},
       occurred_at: parse_time(raw["updated_at"])
     )}
  end

  defp parse_time(nil), do: nil

  defp parse_time(s) do
    case DateTime.from_iso8601(s) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end
end
