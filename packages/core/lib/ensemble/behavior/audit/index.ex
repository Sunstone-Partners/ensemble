defmodule Ensemble.Behavior.Audit.Index do
  @moduledoc """
  Behaviour for audit query accelerators (TRD §5.1, TRD-027, AC-090).

  The JSONL partitions are the ledger of record; an index is an
  **accelerator only**. `Ensemble.Behavior.Audit.query/1` treats every
  index failure — missing file, stale row, unsupported backend — as "scan
  the partitions", so an index can never cause an omission (AC-084).

  Implementations MUST be safe to lose: `Audit` rebuilds via `build/1`
  (or falls back to scanning) whenever `open/1` or `lookup/2` fails.
  """

  @type filter :: %{
          optional(:behavior_id) => String.t(),
          optional(:kind) => atom(),
          optional(:event_id) => String.t(),
          optional(:since) => DateTime.t() | String.t(),
          optional(:until) => DateTime.t() | String.t(),
          optional(:mutation) => String.t()
        }

  @callback open(Path.t(), keyword()) :: {:ok, term()} | {:error, term()}
  @callback insert(term(), map()) :: :ok | {:error, term()}
  @callback flush(term()) :: :ok | {:error, term()}
  @callback close(term()) :: :ok
  @doc """
  Return `{:ok, [audit_id]}` when the index can answer the filter, or
  `{:error, term()}` to signal "scan instead". Returning a hit-list that
  is wrong is a correctness bug; returning an error is always safe.
  """
  @callback lookup(term(), filter()) :: {:ok, [String.t()]} | {:error, term()}
  @callback build(term(), Enumerable.t()) :: {:ok, non_neg_integer()} | {:error, term()}
  @callback delete(term(), non_neg_integer()) :: :ok | {:error, term()}
end
