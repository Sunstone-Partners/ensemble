defmodule Ensemble.Behavior.DiscoveryEngineTest do
  @moduledoc """
  TRD-032: DiscoveryEngine (AC-051, AC-053, AC-054, AC-055, AC-056).

  PRD labels AC-053/054/055/056 **[C] = canonical examples** — the
  fixtures below ARE those examples: a synthetic 10-run cluster
  (`run → report`), one-off exploratory pattern, and the approve/reject
  artifact contract. Determinism is golden-filed.
  """
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.{Compiler, DiscoveryEngine, Telemetry}

  defp tmp(tag), do: Path.join(System.tmp_dir!(), "discovery-#{tag}-#{Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)}")

  # --- canonical run fixtures ---------------------------------------------

  defp run(seq, event_type) do
    %{
      behavior_id: "probe@0.1.0",
      event_type: event_type,
      completed_at: ~U[2026-09-01 12:00:00Z],
      tool_calls: Enum.map(Enum.with_index(seq, 1), fn {t, i} -> %{tool: t, args: %{n: i}, seq: i} end),
      outcome_kind: "completed"
    }
  end

  defp n_runs(n, seq, event_type) do
    for i <- 1..n, do: run(seq, event_type) |> Map.put(:event_id, "evt-#{i}")
  end

  describe "analyze/1 clustering (AC-051, AC-053)" do
    test "10 runs with the same (event_type, tool-sequence) cluster into one suggestion" do
      runs = n_runs(10, ["read", "bash.test"], "test.failed")
      [s] = DiscoveryEngine.analyze(runs)

      assert s.inferred_event_type == "test.failed"
      assert s.tools == ["read", "bash.test"]
      assert s.frequency == 10
      assert s.recommended == true
      assert s.confidence >= 67
    end

    test "bigrams from mixed runs split into per-bigram clusters" do
      runs =
        n_runs(4, ["read", "git.diff", "ensemble.github.pr_comment"], "github.pull_request.opened") ++
          n_runs(2, ["read", "grep"], "test.failed")

      sugg = DiscoveryEngine.analyze(runs)
      names = Enum.map(sugg, & &1.pattern_name)

      assert "github-pull-request-opened-read-git-diff" in names
      assert "test-failed-read-grep" in names
      assert Enum.any?(sugg, &(&1.frequency == 4))
    end

    test "single-observation pattern: confidence < 40 and exploratory (AC-056)" do
      [s] = DiscoveryEngine.analyze([run([{"read", 1}], "one.off.event")])

      assert s.frequency == 1
      assert s.confidence < 40
      assert s.exploratory == true
      assert s.recommended == false
      assert s.tools == ["read"]
    end

    test "suggestion carries every AC-054 field" do
      [s] = DiscoveryEngine.analyze(n_runs(3, ["read", "write"], "a.b"))

      for key <- [:pattern_name, :inferred_event_type, :tools, :frequency, :confidence] do
        assert Map.has_key?(s, key), "missing #{key}"
      end

      assert is_binary(s.pattern_name)
    end

    test "retried tools in one run don't fabricate a self-bigram" do
      [s] = DiscoveryEngine.analyze([run([{"read", 1}, {"read", 2}, {"grep", 3}], "t.t")])
      assert s.tools == ["read", "grep"]
      assert s.frequency == 1
    end
  end

  describe "determinism (golden file)" do
    @moduledoc false

    test "analyze output is byte-identical across runs and seed orders" do
      runs =
        n_runs(11, ["read", "bash.test"], "test.failed") ++
          n_runs(3, ["git.diff", "write"], "pr.opened") ++
          n_runs(1, ["grep"], "solo.event")

      golden_path = Path.join(__DIR__, "../../fixtures/discovery-golden.txt")

      a = runs |> DiscoveryEngine.analyze() |> Enum.map(&inspect/1) |> Enum.join("\n")
      b = runs |> Enum.reverse() |> DiscoveryEngine.analyze() |> Enum.map(&inspect/1) |> Enum.join("\n")
      assert a == b

      if File.exists?(golden_path) do
        assert a == File.read!(golden_path)
      else
        File.mkdir_p!(Path.dirname(golden_path))
        File.write!(golden_path, a)
      end
    end
  end

  describe "report/2 — the discover --report surface (AC-051)" do
    test "renders name, event, tools, frequency, confidence, flag" do
      runs = n_runs(10, ["read", "bash.test"], "test.failed") ++ n_runs(1, ["grep"], "solo")
      {text, sugg} = DiscoveryEngine.report(runs)

      assert text =~ "discovery report"
      assert text =~ "read -> bash.test"
      assert text =~ "recommended"
      assert text =~ "exploratory"
      assert length(sugg) == 2
    end

    test "reads real telemetry when given options" do
      d = tmp("report")

      for i <- 1..12 do
        {:ok, _} =
          Telemetry.record_run(
            %{
              behavior_id: "seed@1.0.0",
              event_id: "e#{i}",
              event_type: "test.failed",
              completed_at: ~U[2026-09-01 10:00:00Z],
              tool_calls: [%{tool: "bash.test", seq: 1}, %{tool: "read", seq: 2}]
            },
            dir: d,
            enabled: true
          )
      end

      {text, [s]} = DiscoveryEngine.report(telemetry_dir: d)
      assert s.frequency == 12
      assert text =~ "bash-test-read"
    end
  end

  describe "approve/reject (AC-055)" do
    setup do
      %{suggestion: hd(DiscoveryEngine.analyze(n_runs(12, ["read", "bash.test"], "test.failed"))),
        dir: tmp("artifacts"),
        bdir: tmp("behaviors")}
    end

    test "approve writes a draft that passes Compiler.validate and records the decision", %{suggestion: s, dir: d, bdir: bd} do
      assert {:ok, entry} = DiscoveryEngine.decide(s, :approve, dir: d, behaviors_dir: bd)

      path = Path.join([bd, DiscoveryEngine.slug_of(s), "behavior.yaml"])
      assert entry["decision"] == "approved"
      assert entry["draft_path"] == path
      assert File.exists?(path)

      yaml = File.read!(path)
      assert yaml =~ "mode: propose"
      assert {:ok, defn} = Compiler.validate(yaml)
      assert defn.name =~ "discovery."
    end

    test "approve never bypasses the Phase-1 validator: unregistered event type ⇒ no draft", %{dir: d, bdir: bd} do
      bad = %{
        pattern_name: "evil pattern",
        inferred_event_type: "not.registered.event",
        tools: ["read"],
        frequency: 12,
        confidence: 70
      }

      assert {:error, {:invalid, errs}} = DiscoveryEngine.decide(bad, :approve, dir: d, behaviors_dir: bd)
      assert is_list(errs)
      assert File.ls!(bd) == []
      # nothing recorded as approved either
      assert DiscoveryEngine.proposals(dir: d) == []
    end

    test "reject records feedback, mutates no catalog", %{suggestion: s, dir: d, bdir: bd} do
      assert {:ok, entry} = DiscoveryEngine.decide(s, :reject, dir: d, behaviors_dir: bd, feedback: "too generic")
      assert entry["decision"] == "rejected"
      assert entry["feedback"] == "too generic"
      assert File.ls!(bd) == []
      assert [_] = DiscoveryEngine.proposals(dir: d)
    end

    test "decision artifact is append-only JSONL and redacted", %{suggestion: s, dir: d, bdir: bd} do
      {:ok, _} = DiscoveryEngine.decide(s, :reject, dir: d, behaviors_dir: bd, feedback: "uses token=ghp_" <> String.duplicate("x", 36))
      {:ok, _} = DiscoveryEngine.decide(s, :reject, dir: d, behaviors_dir: bd, feedback: "second")

      raw = File.read!(DiscoveryEngine.proposals_file(dir: d))
      assert length(String.split(raw, "\n", trim: true)) == 2
      refute raw =~ "ghp_"
      assert raw =~ "[REDACTED:github-token]"
      assert [%{"decision" => "rejected"}, %{"decision" => "rejected"}] = DiscoveryEngine.proposals(dir: d)
    end
  end

  describe "draft_yaml/1" do
    test "canonical example draft is schema-valid with propose mode" do
      sugg = %{
        pattern_name: "github-pull-request-opened-read-git-diff",
        inferred_event_type: "github.pull_request.review_requested",
        tools: ["read", "git.diff"],
        frequency: 14,
        confidence: 79
      }

      yaml = DiscoveryEngine.draft_yaml(sugg)
      assert {:ok, defn} = Compiler.validate(yaml)
      assert defn.policy.mode == :propose
      assert defn.capabilities.tools == ["read", "git.diff"]
    end

    test "unknown tools are dropped from the draft grant list" do
      sugg = %{
        pattern_name: "weird",
        inferred_event_type: "test.failed",
        tools: ["read", "totally.made.up"],
        frequency: 2
      }

      yaml = DiscoveryEngine.draft_yaml(sugg)
      assert {:ok, defn} = Compiler.validate(yaml)
      assert defn.capabilities.tools == ["read"]
    end
  end
end
