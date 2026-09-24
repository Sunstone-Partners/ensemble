defmodule Ensemble.Behavior.Events.Local do
  @moduledoc """
  Local hook adapter (TRD-013, AC-023).

  Wraps the `test-failure-observer.js` PostToolUse record —
  `%{kind: "test_failure", command, exit_code, excerpt, session_id, cwd}` —
  into a `test.failed` Event. Also handles agent run completion records
  (`type: "agent.run"`) → `agent.completed`.

  Additive per Article V: the observer hook stays as transport; this module
  is the normalization wrapper around its output.
  """

  alias Ensemble.Behavior.Event

  @spec normalize(map()) :: {:ok, Event.t()} | {:warn, Event.t()}
  def normalize(raw) do
    r = stringify(raw)

    cond do
      # Canonical envelope (emitted by test-failure-observer.js and peers):
      # has event_type at top level.
      is_binary(r["event_type"]) -> envelope(r)
      r["kind"] == "test_failure" -> test_failure(r)
      r["type"] == "agent.run" -> agent_run(r)
      true -> {:warn, generic_local(r)}
    end
  end

  defp envelope(r) do
    {:ok,
     Event.build(
       event_id: r["event_id"],
       event_type: r["event_type"],
       source: r["source"] || "local",
       project_id: r["cwd"] || get_in(r, ["payload", "cwd"]),
       subject_id: to_string(r["subject_id"] || ""),
       payload: r["payload"] || %{},
       actor: r["actor"] || %{type: :system, id: nil},
       correlation_id: r["correlation_id"],
       causation_id: r["causation_id"],
       causal_parent: r["causal_parent"],
       occurred_at: parse_time(r["occurred_at"])
     )}
  end

  defp test_failure(r) do
    {:ok,
     Event.build(
       event_type: "test.failed",
       source: "local",
       project_id: r["cwd"],
       subject_id: r["command"] || "",
       identity_fields: ["command"],
       payload: %{
         "command" => r["command"],
         "exit_code" => r["exit_code"],
         "excerpt" => r["excerpt"],
         "session_id" => r["session_id"],
         "cwd" => r["cwd"]
       },
       actor: %{type: :ci, id: r["session_id"]},
       occurred_at: parse_time(r["ts"])
     )}
  end

  defp agent_run(r) do
    {:ok,
     Event.build(
       event_type: "agent.completed",
       source: "local",
       project_id: r["cwd"],
       subject_id: r["run_id"] || r["task_id"] || "",
       payload:
         Map.take(r, ["run_id", "task_id", "exit_code", "status", "tokens", "duration_ms", "cwd"]),
       actor: %{type: :behavior, id: r["run_id"]},
       occurred_at: parse_time(r["ts"])
     )}
  end

  defp generic_local(r) do
    Event.build(
      event_type: "local.event",
      source: "local",
      subject_id: to_string(r["id"] || r["cwd"] || ""),
      payload: r,
      actor: %{type: :system, id: nil}
    )
  end

  defp stringify(map), do: Map.new(map, fn {k, v} -> {to_string(k), v} end)

  defp parse_time(nil), do: nil
  defp parse_time(ms) when is_integer(ms), do: ms

  defp parse_time(s) when is_binary(s) do
    case DateTime.from_iso8601(s) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end
end
