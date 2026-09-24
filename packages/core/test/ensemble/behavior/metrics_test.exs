defmodule Ensemble.Behavior.MetricsTest do
  @moduledoc """
  TRD-034: error buckets (AC-100) + telemetry flush wiring (TRD §5.4).

  The ETS table is process-wide, so every test snapshots-and-zeros in the
  same window it asserts on (async-safe); absolute totals are never
  asserted.
  """
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.{Metrics, Telemetry}

  @buckets Metrics.buckets()

  test "exactly the six TRD buckets" do
    assert @buckets == [
             :agent_timeout,
             :tool_not_found,
             :policy_violation,
             :workflow_missing,
             :budget_exhausted,
             :backend_unavailable
           ]
  end

  describe "bump/2" do
    test "counts per bucket and returns the running total" do
      before = Map.get(Metrics.counts(), :agent_timeout, 0)
      assert {:ok, a} = Metrics.bump(:agent_timeout)
      assert {:ok, b} = Metrics.bump(:agent_timeout)
      assert a == before + 1
      assert b == before + 2
    end

    test "unknown buckets never inflate a real one (fail-closed triage)" do
      snapshot = Metrics.counts()
      assert {:error, {:unknown_bucket, :oops}} = Metrics.bump(:oops)
      assert Metrics.counts() == snapshot
    end

    test "map_reason covers the error atoms raised at call sites" do
      assert Metrics.map_reason(:timeout) == :agent_timeout
      assert Metrics.map_reason(:worker_timeout) == :agent_timeout
      assert Metrics.map_reason(:unknown_tool) == :tool_not_found
      assert Metrics.map_reason(:tool_not_granted) == :policy_violation
      assert Metrics.map_reason(:token_budget_exhausted) == :budget_exhausted
      assert Metrics.map_reason(:wall_clock_exhausted) == :budget_exhausted
      assert Metrics.map_reason(:graph_missing) == :workflow_missing
      assert Metrics.map_reason(:provider_down) == :backend_unavailable
      # anything unmapped lands on a REAL bucket, never a new one
      assert Metrics.map_reason(:weird) in @buckets
    end

    test "bump_for routes atoms onto buckets" do
      {:ok, _} = Metrics.bump_for(:timeout)
      assert Map.has_key?(Metrics.counts(), :agent_timeout)
    end
  end

  describe "flush semantics" do
    test "counts/0 is non-consuming; peek_and_reset/0 drains" do
      Metrics.bump(:tool_not_found)
      assert Map.get(Metrics.counts(), :tool_not_found, 0) >= 1
      assert Map.get(Metrics.counts(), :tool_not_found, 0) >= 1
      drained = Metrics.peek_and_reset()
      assert Map.get(drained, :tool_not_found, 0) >= 1
      Metrics.peek_and_reset()
      assert Map.get(Metrics.counts(), :tool_not_found, 0) == 0
    end
  end

  describe "telemetry flush (TRD §5.4 'flushed with telemetry records')" do
    test "run record embeds the bucket counts" do
      Metrics.reset()
      {:ok, _} = Metrics.bump(:policy_violation, 2)

      d =
        Path.join(
          System.tmp_dir!(),
          "metrics-#{Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)}"
        )

      {:ok, rec} =
        Telemetry.record_run(%{behavior_id: "a.b@1.0.0", event_id: "e"}, dir: d, enabled: true)

      assert %{"policy_violation" => 2} = rec["metrics"]
      # drained: a second run carries nothing
      {:ok, rec2} =
        Telemetry.record_run(%{behavior_id: "a.b@1.0.0", event_id: "e2"}, dir: d, enabled: true)

      refute Map.has_key?(rec2, "metrics")
    end

    test "explicit metrics field wins over the ambient flush" do
      {:ok, rec} =
        Telemetry.record_run(
          %{behavior_id: "a.b@1.0.0", metrics: %{agent_timeout: 1}},
          dir:
            Path.join(System.tmp_dir!(), "metrics-#{Base.encode16(:crypto.strong_rand_bytes(8))}"),
          enabled: true
        )

      assert rec["metrics"] == %{"agent_timeout" => 1}
    end
  end
end
