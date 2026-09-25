defmodule Ensemble.Behavior.ComplianceReportTest do
  @moduledoc """
  TRD-028: `ComplianceReport.generate/1` over the audit ledger (AC-085, AC-086).

  Covers both input paths — hermetic `:records` (unit) and real on-disk
  partitions written through the `Audit` log functions (integration) — and
  the AC-085 example query: constitution mutations in a window, one row per
  mutation with proposal/activation/event/actor/timestamp.
  """
  use ExUnit.Case, async: false

  alias Ensemble.Behavior.{Audit, ComplianceReport}

  @now_ms 1_790_000_000_000

  defp activation(opts \\ []) do
    %{
      "audit_id" => opts[:audit_id] || Audit.audit_id(),
      "kind" => "activation",
      "ts" => DateTime.from_unix!(opts[:ms] || @now_ms, :millisecond) |> DateTime.to_iso8601(),
      "occurred_at" =>
        DateTime.from_unix!(opts[:ms] || @now_ms, :millisecond) |> DateTime.to_iso8601(),
      "behavior" => %{"name" => opts[:behavior] || "alpha", "version" => "1.0.0"},
      "subject" => opts[:behavior] || "alpha",
      "verdict" => "activate",
      "event_id" => opts[:event_id] || "evt-1",
      "activation_id" => opts[:activation_id] || "act-1",
      "actor" => %{"type" => "ci", "id" => opts[:actor] || "ci-runner"},
      "payload" => %{
        "event_type" => opts[:event_type] || "test.failed",
        "final_status" => opts[:status] || "completed"
      }
    }
  end

  defp match_record(behavior) do
    %{
      "audit_id" => Audit.audit_id(),
      "kind" => "match_recorded",
      "ts" => DateTime.from_unix!(@now_ms, :millisecond) |> DateTime.to_iso8601(),
      "behavior" => %{"name" => behavior, "version" => "2.1.0"},
      "subject" => behavior,
      "payload" => %{"candidates" => [behavior <> "@2.1.0"]}
    }
  end

  defp proposal_link(opts \\ []) do
    %{
      "audit_id" => opts[:audit_id] || Audit.audit_id(),
      "kind" => "proposal_link",
      "ts" => DateTime.from_unix!(opts[:ms] || @now_ms, :millisecond) |> DateTime.to_iso8601(),
      "activation_id" => opts[:activation_id] || "act-1",
      "proposal_id" => opts[:proposal_id] || "prop-1",
      "event_id" => opts[:event_id] || "evt-1",
      "actor" => %{"type" => "behavior", "id" => "alpha"},
      "mutation_class" => opts[:mutation] || "constitution.change",
      "payload" => %{"status" => opts[:status] || "pending"}
    }
  end

  defp violation(opts \\ []) do
    %{
      "audit_id" => Audit.audit_id(),
      "kind" => "tool_violation",
      "ts" => DateTime.from_unix!(@now_ms, :millisecond) |> DateTime.to_iso8601(),
      "behavior" => %{"name" => opts[:behavior] || "alpha", "version" => "1.0.0"},
      "subject" => opts[:behavior] || "alpha",
      "attempted_tool" => opts[:tool] || "bash.rm",
      "activation_id" => opts[:activation_id] || "act-1",
      "payload" => %{"declared_tools" => ["read", "grep"]}
    }
  end

  describe "generate/1 with :records (AC-086 sections)" do
    test "renders every compliance section deterministically" do
      records = [
        activation(behavior: "alpha", status: "completed"),
        activation(behavior: "alpha", status: "failed", activation_id: "act-2"),
        activation(behavior: "beta", status: "completed", activation_id: "act-3"),
        match_record("gamma"),
        violation(behavior: "alpha", tool: "bash.rm"),
        proposal_link(activation_id: "act-2")
      ]

      md_a = ComplianceReport.generate(records: records, now_ms: @now_ms, format: :markdown)
      md_b = ComplianceReport.generate(records: Enum.reverse(records), now_ms: @now_ms)

      assert md_a == md_b, "report must not depend on ledger order"

      for heading <- ["Invocation Patterns", "Success Rates", "Violations",
                      "Constitution mutations in window", "Decision traces"] do
        assert md_a =~ heading, "missing section: #{heading}"
      end

      # beta appears once, alpha twice, ordered by behavior_id
      assert html_index(md_a, "alpha") < html_index(md_a, "beta")
    end

    test "invocation patterns carry counts, triggers, and actors" do
      md =
        ComplianceReport.generate(
          records: [
            activation(status: "completed"),
            activation(status: "completed", activation_id: "act-2"),
            activation(status: "timeout", activation_id: "act-3")
          ],
          now_ms: @now_ms
        )

      assert md =~ "test.failed"
      assert md =~ "ci-runner"
      # 3 invocations, 2 completed
      assert md =~ "3"
      assert md =~ "66.7%" or md =~ "66.7", "success rate for 2/3 must surface: " <> md
    end

    test "json format parses with the documented keys" do
      json =
        ComplianceReport.generate(
          records: [activation(), violation(), proposal_link()],
          now_ms: @now_ms,
          format: :json
        )

      assert %{} = decoded = :json.decode(json)
      assert Map.has_key?(decoded, "behaviors")
      assert Map.has_key?(decoded, "violations")
      assert Map.has_key?(decoded, "constitution_mutations")
      assert Map.has_key?(decoded, "decision_traces")
      assert %{"total_entries" => 3} = decoded
    end
  end

  describe "windowing (AC-084 completeness within bounds)" do
    test "since/until exclude out-of-window entries; undated entries are kept" do
      inside = activation(ms: @now_ms - 86_400_000)
      outside = activation(ms: @now_ms - 40 * 86_400_000, activation_id: "act-old")
      undated = Map.delete(activation(), "ts") |> Map.delete("occurred_at")

      decoded =
        ComplianceReport.generate(
          records: [inside, outside, undated],
          now_ms: @now_ms,
          since: @now_ms - 10 * 86_400_000,
          until: @now_ms,
          format: :json
        )
        |> :json.decode()

      assert decoded["total_entries"] == 2
      ids = decoded["decision_traces"] |> Enum.map(& &1["activation_id"]) |> Enum.sort()
      assert ids == ["act-1", "act-1"] or "act-old" not in ids
    end

    test "default window is 30 days" do
      ancient = activation(ms: @now_ms - 31 * 86_400_000)
      recent = activation(ms: @now_ms - 29 * 86_400_000, activation_id: "act-r")

      decoded =
        ComplianceReport.generate(records: [ancient, recent], now_ms: @now_ms, format: :json)
        |> :json.decode()

      assert decoded["total_entries"] == 1
      assert hd(decoded["decision_traces"])["activation_id"] == "act-r"
    end
  end

  describe "constitution mutations (AC-085 example query)" do
    test "lists each mutation with proposal, activation, event, actor, timestamp" do
      recs = [
        activation(activation_id: "act-x", event_id: "evt-x", ms: @now_ms),
        proposal_link(activation_id: "act-x", proposal_id: "prop-9",
                      event_id: "evt-x", ms: @now_ms - 1_000)
      ]

      decoded =
        ComplianceReport.generate(records: recs, now_ms: @now_ms, format: :json)
        |> :json.decode()

      [row] = decoded["constitution_mutations"]
      assert row["proposal_id"] == "prop-9"
      assert row["activation_id"] == "act-x"
      assert row["event_id"] == "evt-x"
      assert row["actor"]
      assert row["timestamp_ms"]
    end

    test "non-constitution mutation classes are excluded by default" do
      decoded =
        ComplianceReport.generate(
          records: [proposal_link(mutation: "pr.open")],
          now_ms: @now_ms,
          format: :json
        )
        |> :json.decode()

      assert decoded["constitution_mutations"] == []

      filtered =
        ComplianceReport.generate(
          records: [proposal_link(mutation: "pr.open")],
          now_ms: @now_ms,
          mutation: "pr.open",
          format: :json
        )
        |> :json.decode()

      assert [row] = filtered["constitution_mutations"]
      assert row["proposal_id"]
    end
  end

  describe "decision traces (AC-085 traceability)" do
    test "activations link to events and proposals" do
      decoded =
        ComplianceReport.generate(
          records: [
            activation(activation_id: "act-9", event_id: "evt-9"),
            proposal_link(activation_id: "act-9", proposal_id: "prop-9")
          ],
          now_ms: @now_ms,
          format: :json
        )
        |> :json.decode()

      [trace] = decoded["decision_traces"]
      assert trace["activation_id"] == "act-9"
      assert trace["event_id"] == "evt-9"
      assert trace["proposals"] == ["prop-9"] or trace["proposal_ids"] == ["prop-9"]
    end
  end

  describe "integration with the real ledger (TRD-026 kinds)" do
    setup do
      dir = Path.join(System.tmp_dir!(), "cr-#{Audit.audit_id()}")
      on_exit(fn -> File.rm_rf!(dir) end)
      %{dir: dir}
    end

    test "reads partitions written by Audit's log functions", %{dir: dir} do
      now_iso = DateTime.from_unix!(@now_ms, :millisecond) |> DateTime.to_iso8601()

      {:ok, _} =
        Audit.log_activation(nil, nil, nil,
          dir: dir,
          occurred_at: now_iso,
          behavior: "delta",
          verdict: :activate,
          final_status: "completed",
          event_id: "evt-d",
          activation_id: "act-d",
          actor: %{type: :user, id: "ld"}
        )

      {:ok, _} =
        Audit.link_proposal("act-d", "prop-d",
          dir: dir,
          occurred_at: now_iso,
          behavior: "delta",
          mutation_class: "constitution.change"
        )

      decoded =
        ComplianceReport.generate(dir: dir, now_ms: @now_ms, index: :none, format: :json)
        |> :json.decode()

      assert decoded["total_entries"] >= 2
      [row] = decoded["constitution_mutations"]
      assert row["activation_id"] == "act-d"
      assert row["proposal_id"] == "prop-d"
    end

    test "violations section surfaces denied tools from Audit.log_violation", %{dir: dir} do
      # `log_violation/3` has no opts parameter — the audit dir is the
      # documented env channel (`ENSEMBLE_AUDIT_DIR`).
      previous = System.get_env("ENSEMBLE_AUDIT_DIR")
      System.put_env("ENSEMBLE_AUDIT_DIR", dir)

      try do
        :ok =
          Audit.log_violation(
            %{
              invocation_id: "inv-1",
              activation_id: "act-v",
              behavior: %{name: "vee"},
              name: "vee",
              declared_tools: ["read"]
            },
            "git.push",
            ["read"]
          )
      after
        if previous,
          do: System.put_env("ENSEMBLE_AUDIT_DIR", previous),
          else: System.delete_env("ENSEMBLE_AUDIT_DIR")
      end

      decoded =
        ComplianceReport.generate(dir: dir, index: :none, format: :json)
        |> :json.decode()

      assert [_] = decoded["violations"]
      row = hd(decoded["violations"])
      assert row["attempted_tool"] == "git.push"
    end
  end

  defp html_index(md, needle) do
    :binary.match(md, needle) |> elem(0)
  end
end
