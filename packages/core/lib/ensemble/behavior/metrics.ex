defmodule Ensemble.Behavior.Metrics do
  @moduledoc """
  Error-bucket counters for triage (TRD §5.4, REQ-025 AC-100; TRD-034).

  Six buckets, exactly the TRD vocabulary — see `buckets/0`:
  `agent_timeout | tool_not_found | policy_violation | workflow_missing |
  budget_exhausted | backend_unavailable`.

  ## Ownership

  A single process-wide ETS `:public` table with `write_concurrency`,
  created lazily by the first `bump/2` in the node and owned by `:init`
  (via `:ets.first`-safe creation under a global-name registration), so
  `bump/2` is atomic `update_counter` from any process with no GenServer
  round-trip and survives caller crashes. Because one table is shared by
  every test process, **tests must snapshot-and-zero with
  `peek_and_reset/0` inside the test that bumps** (async-safe: the reset
  is part of the same atomic read window they assert on) — never assert
  on absolute totals.

  ## Flushing with telemetry (TRD §5.4: "flushed with telemetry records")

  `Telemetry.record_run/2` embeds the current counts via
  `peek_and_reset/0` in the run record's `metrics` field.
  """

  @buckets [
    :agent_timeout,
    :tool_not_found,
    :policy_violation,
    :workflow_missing,
    :budget_exhausted,
    :backend_unavailable
  ]

  @table :ensemble_behavior_metrics

  @doc "The six error buckets (AC-100)."
  def buckets, do: @buckets

  @doc """
  Add `n` to bucket `kind`. Unknown kinds never silently inflate a real
  bucket: they return `{:error, {:unknown_bucket, kind}}` (fail-closed
  triage contract).
  """
  @spec bump(atom(), integer()) :: {:ok, non_neg_integer()} | {:error, term()}
  def bump(kind, n \\ 1) when is_atom(kind) and is_integer(n) do
    if kind in @buckets do
      ensure_table()

      try do
        {:ok, :ets.update_counter(@table, kind, {2, n})}
      rescue
        ArgumentError ->
          # bucket row missing (fresh table) — insert-then-bump
          :ets.insert_new(@table, {kind, n})
          {:ok, n}
      end
    else
      {:error, {:unknown_bucket, kind}}
    end
  end

  @doc "Convenience used at error sites: `bump_for(:timeout)` → agent_timeout."
  @spec bump_for(atom(), integer()) :: {:ok, non_neg_integer()} | {:error, term()}
  def bump_for(reason, n \\ 1) when is_atom(reason) do
    bump(map_reason(reason), n)
  end

  @doc "Map a runtime error atom onto exactly one triage bucket (AC-100)."
  @spec map_reason(atom()) :: atom()
  def map_reason(reason) when reason in @buckets, do: reason
  def map_reason(:timeout), do: :agent_timeout
  def map_reason(:worker_timeout), do: :agent_timeout
  def map_reason(:unknown_tool), do: :tool_not_found
  def map_reason(:tool_not_granted), do: :policy_violation
  def map_reason(v) when v in [:denied, :blocked, :constitution_denied], do: :policy_violation
  def map_reason(:graph_missing), do: :workflow_missing

  def map_reason(v) when v in [:token_budget_exhausted, :wall_clock_exhausted],
    do: :budget_exhausted

  def map_reason(v) when v in [:backend_unavailable, :no_backend, :provider_down],
    do: :backend_unavailable

  def map_reason(_other), do: :policy_violation

  @doc "Non-consuming snapshot: `%{bucket => count}` (only touched buckets appear)."
  @spec counts() :: %{atom() => non_neg_integer()}
  def counts do
    ensure_table()
    @table |> :ets.tab2list() |> Enum.filter(fn {_k, v} -> v != 0 end) |> Map.new()
  end

  @doc """
  Atomic-ish snapshot + zero in one step; the telemetry write path uses
  this so a bucket is flushed into exactly one run record.
  """
  @spec peek_and_reset() :: %{atom() => non_neg_integer()}
  def peek_and_reset do
    ensure_table()

    @table
    |> :ets.tab2list()
    |> Enum.map(fn {k, v} ->
      true = :ets.update_element(@table, k, {2, 0})
      {k, v}
    end)
    |> Enum.filter(fn {_k, v} -> v != 0 end)
    |> Map.new()
  end

  @doc "Zero every bucket (test hygiene / reporter checkpoint)."
  @spec reset() :: :ok
  def reset do
    ensure_table()
    :ets.delete_all_objects(@table)
    :ok
  end

  @doc false
  def ensure_table do
    case :ets.info(@table) do
      :undefined ->
        try do
          :ets.new(@table, [
            :named_table,
            :public,
            :set,
            write_concurrency: true,
            read_concurrency: true
          ])
        rescue
          ArgumentError -> @table
        end

      _ ->
        @table
    end
  end
end
