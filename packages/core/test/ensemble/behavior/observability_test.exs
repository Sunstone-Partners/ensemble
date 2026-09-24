defmodule Ensemble.Behavior.ObservabilityTest do
  @moduledoc """
  TRD-033: events tail, per-activation DynamicSupervision, diagnose
  (PRD AC-097, AC-098, AC-099).

  Every path takes an explicit `:dir` — no `ENSEMBLE_AUDIT_DIR`, no
  shared registry — so the file is async-safe.
  """
  use ExUnit.Case, async: true
  import ExUnit.CaptureLog

  alias Ensemble.Behavior.{Audit, Compiler, Event, Observability, Registry}

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "obs", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "test.failed"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  defp tmp(tag) do
    Path.join(
      System.tmp_dir!(),
      "obs-#{tag}-#{Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)}"
    )
  end

  defp defn(name) do
    {:ok, d} =
      Compiler.validate(%{
        @base
        | "metadata" => %{"name" => name, "version" => "1.0.0", "description" => "d"}
      })

    d
  end

  defp event(id \\ "evt-obs") do
    %Event{event_id: id, event_type: "test.failed", payload: %{}, occurred_at: Event.now()}
  end

  defp with_registry(name, defns) do
    {:ok, pid} = Registry.start_link(name: name)
    ExUnit.Callbacks.on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)
    Enum.each(defns, fn {d, opts} -> :ok = Registry.register(d, name, opts) end)
    name
  end

  describe "tail/1 (AC-097)" do
    test "yields ledger records and the cursor advances only on new data" do
      dir = tmp("tail")
      {:ok, _} = Audit.log_activation(nil, nil, nil, dir: dir, behavior_name: "vee", verdict: :activate)

      {[rec1], cur1} = Observability.tail(dir: dir, mirror: :off)
      assert rec1["kind"] == "activation"

      {:ok, _} = Audit.link_proposal("act-x", "prop-x", dir: dir, mutation_class: "constitution.change")

      {[rec2], cur2} = Observability.tail(dir: dir, after: cur1, mirror: :off)
      assert rec2["kind"] == "proposal_link"
      # drained -> sentinel for "next file"; re-query must yield nothing more
      assert {[], cur3} = Observability.tail(dir: dir, after: cur2, mirror: :off)
      assert cur3 == cur2 or elem(cur3, 0) > elem(cur2, 0)
      assert {[], ^cur3} = Observability.tail(dir: dir, after: cur3, mirror: :off)

      # from-scratch cursor sees both records
      {both, _} = Observability.tail(dir: dir, after: {0, 0}, mirror: :off)
      assert length(both) == 2
    end

    test "a partial trailing line is not yielded until complete" do
      dir = tmp("partial")
      File.mkdir_p!(dir)
      path = Path.join(dir, "matches-202609.jsonl")
      File.write!(path, "{\"kind\":\"activation\",\"subject\":\"a\"}\n{\"kind\":\"act")
      {recs, cur} = Observability.tail(dir: dir, mirror: :off)
      assert length(recs) == 1
      File.write!(path, "{\"kind\":\"activation\",\"subject\":\"a\"}\n{\"kind\":\"activation\",\"subject\":\"b\"}\n")
      {recs2, _} = Observability.tail(dir: dir, after: cur, mirror: :off)
      assert [%{"subject" => "b"}] = recs2
    end

    test "stderr mirror is gated by ENSEMBLE_BEHAVIORS_DEBUG=1 (AC-097)" do
      dir = tmp("mirror")
      {:ok, _} = Audit.append_kind(:activation, dir: dir, subject: "m1")

      System.delete_env("ENSEMBLE_BEHAVIORS_DEBUG")
      assert capture_log(fn -> Observability.tail(dir: dir) end) == ""

      System.put_env("ENSEMBLE_BEHAVIORS_DEBUG", "1")

      try do
        logged = capture_log(fn -> Observability.tail(dir: dir) end)
        assert logged =~ "behavior-events"
        assert logged =~ "subject=m1" or logged =~ "activation"
      after
        System.delete_env("ENSEMBLE_BEHAVIORS_DEBUG")
      end
    end

    test "tail_until polls until the predicate fires" do
      dir = tmp("until")

      spawn_link(fn ->
        Process.sleep(30)
        {:ok, _} = Audit.append_kind(:activation, dir: dir, subject: "late")
      end)

      assert {:ok, recs} =
               Observability.tail_until([dir: dir, mirror: :off, poll_ms: 10, tries: 200], fn rs ->
                 length(rs) >= 1
               end)

      assert hd(recs)["subject"] == "late"
    end

    test "tail_until reports timeout" do
      dir = tmp("until2")
      assert :timeout = Observability.tail_until([dir: dir, mirror: :off, poll_ms: 5, tries: 3], fn _ -> false end)
    end
  end

  describe "start_activation/3 (AC-097, AC-099)" do
    test "non-shadow: starts a supervised child that completes and audits" do
      dir = tmp("run")
      d = defn("obs-run")
      reg = with_registry(:obs_run_reg, [{d, []}])
      parent = self()

      {:ok, %{activation_id: id, shadow: false, pid: pid}} =
        Observability.start_activation(event(), d,
          registry: reg,
          fun: fn -> send(parent, :ran); :ok end,
          audit_opts: [dir: dir]
        )

      assert is_pid(pid)
      assert_receive :ran, 2_000
      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, _}, 2_000

      kinds = Audit.query(dir: dir, index: :none) |> Enum.map(& &1["kind"])
      assert "match_recorded" in kinds
      assert "skill_invocation" in kinds
      assert is_binary(id)
    end

    test "a failing activation is supervised one-for-one and audits the failure" do
      dir = tmp("fail")
      d = defn("obs-fail")
      reg = with_registry(:obs_fail_reg, [{d, []}])

      {:ok, %{pid: pid}} =
        Observability.start_activation(event("evt-fail"), d,
          registry: reg,
          fun: fn -> raise "kaboom" end,
          audit_opts: [dir: dir]
        )

      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, _, {:activation_failed, _}}, 2_000

      rej = Audit.query(dir: dir, index: :none, kind: :policy_rejection)
      assert [_] = rej
      assert get_in(hd(rej), ["payload", "reason"]) =~ "kaboom"
    end

    test "shadow: match + audit recorded, zero dispatch" do
      dir = tmp("shadow")
      d = defn("obs-shadow")
      reg = with_registry(:obs_shadow_reg, [{d, [shadow: true]}])

      assert Observability.shadow_for(d, reg)
      refute Observability.dispatch?(d, reg)

      {:ok, %{shadow: true, pid: nil, proposals: props}} =
        Observability.start_activation(event(), d,
          registry: reg,
          fun: fn -> flunk("shadow must never invoke") end,
          audit_opts: [dir: dir]
        )

      assert match?(%Ensemble.Behavior.MatchResult{status: :matched}, hd(props))
      [rec] = Audit.query(dir: dir, index: :none, kind: :match_recorded)
      assert get_in(rec, ["payload", "shadow"]) == true
    end

    test "parallel activations are independently supervised and separable (AC-099)" do
      dir = tmp("par")
      d = defn("obs-par")
      reg = with_registry(:obs_par_reg, [{d, []}])

      handles =
        for n <- 1..3 do
          {:ok, h} =
            Observability.start_activation(event("evt-par-#{n}"), d,
              registry: reg,
              fun: fn -> Process.sleep(20); :ok end,
              audit_opts: [dir: dir]
            )

          h
        end

      # distinct pids, all live at once
      pids = Enum.map(handles, & &1.pid)
      assert length(Enum.uniq(pids)) == 3
      assert Enum.all?(pids, &Process.alive?/1)

      Enum.each(handles, fn %{pid: pid} ->
        ref = Process.monitor(pid)
        assert_receive {:DOWN, ^ref, :process, _, _}, 2_000
      end)

      ids = Enum.map(handles, & &1.activation_id)

      invs = Audit.query(dir: dir, index: :none, kind: :skill_invocation)
      roots = invs |> Enum.map(& &1["causal_root"]) |> Enum.sort()
      assert roots == Enum.sort(ids)
    end
  end

  describe "correlation_index/2 (AC-099)" do
    test "groups log lines by causal root" do
      idx =
        Observability.correlation_index([
          {"act-a", "start a"},
          {"act-b", "start b"},
          {"act-a", "done a"}
        ])

      assert Enum.map(idx["act-a"], &elem(&1, 1)) == ["start a", "done a"]
      assert Enum.map(idx["act-b"], &elem(&1, 1)) == ["start b"]
    end

    test "extracts activation ids from unstructured lines" do
      idx = Observability.correlation_index(["[act-123] hi", "noise", "x [act-456] y"])
      assert Map.keys(idx) |> Enum.sort() == ["act-123", "act-456", "untagged"]
      assert idx["act-123"] == [{"act-123", "[act-123] hi"}]
    end
  end

  describe "diagnose/2 (AC-098)" do
    test "rebuilds the trail with last_completed_step and decisions" do
      dir = tmp("diag")
      aid = "act-diag-1"

      {:ok, _} =
        Audit.log_activation(nil, nil, nil,
          dir: dir,
          behavior_name: "vee",
          verdict: :activate,
          activation_id: aid
        )

      {:ok, _} =
        Audit.append_kind(:skill_invocation,
          dir: dir,
          activation_id: aid,
          causal_root: aid,
          subject: "activation:" <> aid,
          payload: %{"outcome" => "ok"}
        )

      {:ok, _} =
        Audit.append_kind(:policy_rejection,
          dir: dir,
          activation_id: aid,
          causal_root: aid,
          subject: "activation:" <> aid,
          payload: %{"outcome" => "error", "reason" => "boom"}
        )

      trail = Observability.diagnose(aid, dir: dir)
      assert trail.found
      assert trail.activation_id == aid
      assert trail.terminated?
      kinds = Enum.map(trail.steps, & &1.kind)
      assert kinds == ["activation", "skill_invocation", "policy_rejection"]
      assert trail.last_completed_step.kind == "skill_invocation"
      assert Enum.any?(trail.decisions, &(&1.decision == :invoked))
      assert Enum.any?(trail.decisions, &(&1.decision == :denied))
    end

    test "unknown activation reports not-found" do
      dir = tmp("diag2")
      trail = Observability.diagnose("act-nope", dir: dir)
      refute trail.found
      assert trail.steps == []
      refute trail.terminated?
    end
  end
end
