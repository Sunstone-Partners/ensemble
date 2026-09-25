defmodule Ensemble.Behavior.Events.Github do
  @moduledoc """
  GitHub webhook adapter (TRD-011, AC-021).

  Maps `push`, `pull_request`, `issues`, `workflow_run`, `check_suite`,
  `release` webhook bodies to canonical event types (`vcs.push`) or
  provider-scoped types (`github.pull_request.*`), projecting the fields
  behaviors need into `payload`.
  """

  alias Ensemble.Behavior.Event

  @spec normalize(map()) :: {:ok, Event.t()} | {:warn, Event.t()}
  def normalize(raw) do
    repo = get_path(raw, ["repository", "full_name"]) || ""
    action = raw["action"]

    {event_type, payload, subject} =
      case {raw["hook_event_name"] || infer_event(raw), action} do
        {"push", _} ->
          {"vcs.push",
           %{
             "branch" => ref_branch(raw["ref"]),
             "commits" => Enum.map(raw["commits"] || [], &Map.take(&1, ["id", "message", "author"]))
           }, raw["head_commit"]["id"]}

        {"pull_request", nil} ->
          {"github.pull_request.opened", project_pr(raw), pr_ref(raw)}

        {"pull_request", a} ->
          {"github.pull_request." <> a, project_pr(raw), pr_ref(raw)}

        {"issues", nil} ->
          {"github.issue.opened", project_issue(raw), raw["issue"]["number"]}

        {"issues", a} ->
          {"github.issue." <> a, project_issue(raw), raw["issue"]["number"]}

        {"workflow_run", _} ->
          {"github.workflow_run.completed",
           Map.take(raw["workflow_run"] || %{}, ["status", "conclusion", "name"]), raw["workflow_run"]["id"]}

        {"check_suite", _} ->
          {"github.check_suite.completed",
           Map.take(raw["check_suite"] || %{}, ["conclusion", "head_sha"]), raw["check_suite"]["id"]}

        {"release", _} ->
          {"github.release.published", Map.take(raw["release"] || %{}, ["tag_name", "name"]), raw["release"]["id"]}

        {other, _} ->
          {"github." <> snake(to_string(other)), Map.take(raw, ["action", "sender"]), repo}
      end

    {:ok,
     Event.build(
       event_type: event_type,
       source: "github",
       project_id: repo,
       subject_id: to_string(subject || repo),
       payload: Map.merge(payload, %{"repository" => %{"full_name" => repo}}),
       actor: actor_from(raw["sender"]),
       correlation_id: raw["delivery_id"],
       occurred_at: parse_time(raw["sent_at"])
     )}
  end

  defp infer_event(raw) do
    cond do
      Map.has_key?(raw, "pull_request") -> "pull_request"
      Map.has_key?(raw, "issue") -> "issues"
      Map.has_key?(raw, "commits") -> "push"
      true -> "unknown"
    end
  end

  defp pr_ref(raw), do: get_path(raw, ["pull_request", "number"])
  defp project_pr(raw), do: Map.take(raw["pull_request"] || %{}, ["number", "title", "draft", "state"])

  defp project_issue(raw), do: Map.take(raw["issue"] || %{}, ["number", "title", "state", "labels"])

  defp ref_branch("refs/heads/" <> b), do: b
  defp ref_branch(other), do: other

  defp actor_from(%{"login" => login}), do: %{type: :user, id: login}
  defp actor_from(_), do: %{type: :system, id: nil}

  defp parse_time(nil), do: nil
  defp parse_time(s) do
    case DateTime.from_iso8601(s) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end

  defp snake(s), do: s |> String.replace(~r/([a-z])([A-Z])/, "\\1_\\2") |> String.downcase()

  defp get_path(map, path) do
    Enum.reduce_while(path, map, fn k, acc ->
      case acc do
        %{} -> {:cont, Map.get(acc, k)}
        _ -> {:halt, nil}
      end
    end)
  end
end
