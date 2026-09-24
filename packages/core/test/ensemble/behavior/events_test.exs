defmodule Ensemble.Behavior.EventsTest do
  use ExUnit.Case, async: true

  import Ensemble.Behavior.TestCase

  alias Ensemble.Behavior.Event
  alias Ensemble.Behavior.Events
  alias Ensemble.Behavior.Events.{Beads, Github, Generic, Local}

  # ── TRD-010 envelope ───────────────────────────────────────────────────

  describe "Event envelope (TRD-010)" do
    test "derive_dedup_key is deterministic and type+subject scoped" do
      k1 = Event.derive_dedup_key("test.failed", "mix test")
      k2 = Event.derive_dedup_key("test.failed", "mix test")
      k3 = Event.derive_dedup_key("test.failed", "npm test")
      k4 = Event.derive_dedup_key("agent.completed", "mix test")

      assert k1 == k2
      assert k1 != k3
      assert k1 != k4
      assert String.length(k1) == 64
    end

    test "identity_fields narrow the dedup key" do
      payload = %{"file" => "a.ex", "count" => 2}
      base = Event.derive_dedup_key("test.failed", "s")
      narrow = Event.derive_dedup_key("test.failed", "s", nil, ["file", "count"], payload)
      other = Event.derive_dedup_key("test.failed", "s", nil, ["file"], %{"file" => "b.ex"})

      assert narrow != base
      assert narrow != other
    end

    test "build/1 defaults event_id, timestamps, and dedup_key" do
      e = Event.build(event_type: "test.failed", subject_id: "mix test")
      assert e.event_id =~ ~r/^e-[0-9a-f]{16}$/
      assert is_integer(e.occurred_at)
      assert is_integer(e.emitted_at)
      assert e.dedup_key == Event.derive_dedup_key("test.failed", "mix test")
    end

    test "explicit event_id and dedup_key win" do
      e = Event.build(event_id: "e-x", dedup_key: "dk", event_type: "t")
      assert e.event_id == "e-x"
      assert e.dedup_key == "dk"
    end

    test "dedup_key is distinct from event_id even when both derived" do
      e = Event.build(event_type: "test.failed", subject_id: "cmd")
      assert e.dedup_key != e.event_id
    end
  end

  # ── TRD-011 GitHub ─────────────────────────────────────────────────────

  describe "Events.Github (TRD-011)" do
    test "push webhook maps branch and commits into payload" do
      raw = %{
        "hook_event_name" => "push",
        "ref" => "refs/heads/main",
        "repository" => %{"full_name" => "acme/app", "visibility" => "public"},
        "commits" => [%{"id" => "abc123", "message" => "fix", "author" => %{"name" => "LD"}}],
        "head_commit" => %{"id" => "abc123"},
        "sender" => %{"login" => "ldangelo"}
      }

      {:ok, e} = Github.normalize(raw)
      assert e.event_type == "vcs.push"
      assert e.payload["branch"] == "main"
      assert [%{"id" => "abc123"}] = e.payload["commits"]
      assert e.source == "github"
      assert e.project_id == "acme/app"
      assert e.actor == %{type: :user, id: "ldangelo"}
    end

    test "pull_request.opened infers action when absent" do
      raw = %{
        "repository" => %{"full_name" => "o/r"},
        "pull_request" => %{"number" => 7, "draft" => false, "state" => "open"}
      }

      {:ok, e} = Github.normalize(raw)
      assert e.event_type == "github.pull_request.opened"
      assert e.subject_id == "7"
    end

    test "issue closed action surfaces in event type" do
      {:ok, e} =
        Github.normalize(%{
          "hook_event_name" => "issues",
          "action" => "closed",
          "repository" => %{"full_name" => "o/r"},
          "issue" => %{"number" => 3, "title" => "t"}
        })

      assert e.event_type == "github.issue.closed"
    end

    test "workflow_run completed maps status/conclusion" do
      {:ok, e} =
        Github.normalize(%{
          "hook_event_name" => "workflow_run",
          "workflow_run" => %{"id" => 9, "status" => "completed", "conclusion" => "failure", "name" => "CI"},
          "repository" => %{"full_name" => "o/r"}
        })

      assert e.event_type == "github.workflow_run.completed"
      assert e.payload["conclusion"] == "failure"
      assert e.subject_id == "9"
    end

    test "check_suite conclusion in payload" do
      {:ok, e} =
        Github.normalize(%{
          "hook_event_name" => "check_suite",
          "check_suite" => %{"id" => 5, "conclusion" => "success", "head_sha" => "abc"},
          "repository" => %{"full_name" => "o/r"}
        })

      assert e.event_type == "github.check_suite.completed"
      assert e.payload["conclusion"] == "success"
    end

    test "release published maps tag_name" do
      {:ok, e} =
        Github.normalize(%{
          "hook_event_name" => "release",
          "release" => %{"id" => 3, "tag_name" => "v1.2.3", "name" => "Release"},
          "repository" => %{"full_name" => "o/r"}
        })

      assert e.event_type == "github.release.published"
      assert e.payload["tag_name"] == "v1.2.3"
    end

    test "unknown hook_event_name falls back to snake type" do
      {:ok, e} =
        Github.normalize(%{
          "hook_event_name" => "label",
          "action" => "created",
          "repository" => %{"full_name" => "o/r"}
        })

      assert e.event_type == "github.label"
    end

    test "pull_request with action uses explicit action verb" do
      {:ok, e} =
        Github.normalize(%{
          "hook_event_name" => "pull_request",
          "action" => "synchronize",
          "repository" => %{"full_name" => "o/r"},
          "pull_request" => %{"number" => 11}
        })

      assert e.event_type == "github.pull_request.synchronize"
      assert e.subject_id == "11"
    end
  end

  # ── TRD-012 Beads ──────────────────────────────────────────────────────

  describe "Events.Beads (TRD-012)" do
    test "before/after status change normalizes with old_status/new_status" do
      {:ok, e} =
        Beads.normalize(%{
          "issue" => "BR-42",
          "before" => %{"status" => "open"},
          "after" => %{"status" => "closed"},
          "title" => "Fix flaky"
        })

      assert e.event_type == "issue.status_changed"
      assert e.payload["old_status"] == "open"
      assert e.payload["new_status"] == "closed"
      assert e.subject_id == "BR-42"
    end

    test "flat from/to form is supported" do
      {:ok, e} = Beads.normalize(%{"issue" => "BR-1", "from" => "open", "to" => "in_progress"})
      assert e.event_type == "issue.status_changed"
      assert e.payload["new_status"] == "in_progress"
    end
  end

  # ── TRD-013 Local ──────────────────────────────────────────────────────

  describe "Events.Local (TRD-013)" do
    test "observer record normalizes to test.failed" do
      {:ok, e} =
        Local.normalize(%{
          kind: "test_failure",
          command: "mix test",
          exit_code: 2,
          excerpt: "1 failing",
          session_id: "s1",
          cwd: "/repo"
        })

      assert e.event_type == "test.failed"
      assert e.payload["exit_code"] == 2
      assert e.actor == %{type: :ci, id: "s1"}
    end

    test "canonical envelope passes through without re-wrapping" do
      envelope = %{
        "schema_version" => 1,
        "event_id" => "e-abc",
        "event_type" => "test.failed",
        "source" => "local",
        "subject_id" => "mix test",
        "payload" => %{"exit_code" => 1},
        "actor" => %{"type" => "ci", "id" => "s9"},
        "occurred_at" => "2026-09-24T00:00:00Z"
      }

      {:ok, e} = Local.normalize(envelope)
      assert e.event_type == "test.failed"
      assert e.event_id == "e-abc"
      assert e.payload == %{"exit_code" => 1}
      assert e.subject_id == "mix test"
      assert is_integer(e.occurred_at)
    end

    test "agent run completion maps to agent.completed" do
      {:ok, e} = Local.normalize(%{"type" => "agent.run", "run_id" => "r1", "exit_code" => 0})
      assert e.event_type == "agent.completed"
      assert e.subject_id == "r1"
    end
  end

  # ── TRD-014 Generic ────────────────────────────────────────────────────

  describe "Events.Generic (TRD-014)" do
    test "untyped payload warns with best-effort envelope" do
      {:warn, e} = Generic.normalize(%{"type" => "weird.thing", "foo" => 1}, "mystery")
      assert e.event_type == "weird.thing"
      assert e.source == "mystery"
      refute Map.has_key?(e.payload, "type")
    end

    test "no type at all still normalizes with fallback type" do
      {:warn, e} = Generic.normalize(%{"id" => "x"}, "weird")
      assert e.event_type == "local.event"
      assert e.subject_id == "x"
    end

    test "Events.normalize with no hint falls back to Generic and warns" do
      assert {:warn, %Event{event_type: "local.event"}} = Events.normalize(%{"foo" => 1})
    end
  end

  # ── Events dispatcher ──────────────────────────────────────────────────

  describe "Events.normalize/2 (REQ-006)" do
    test "source hint selects the adapter" do
      {:ok, e} = Events.normalize(%{"status" => "closed", "issue" => "B"}, "beads")
      assert e.source == "beads"
    end

    test "shape detection without hint" do
      {:ok, gh} =
        Events.normalize(%{
          "hook_event_name" => "push",
          "ref" => "refs/heads/x",
          "repository" => %{"full_name" => "o/r"}
        })

      assert gh.source == "github"

      {:ok, bd} = Events.normalize(%{"issue" => "B", "before" => %{}, "after" => %{}})
      assert bd.source == "beads"
    end

    test "envelope shape is detected without a hint" do
      {:ok, e} =
        Events.normalize(%{
          "event_type" => "jira.issue.transitioned",
          "source" => "jira",
          "id" => "X-1"
        })
      assert e.source == "jira"
    end
  end
end
