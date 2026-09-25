defmodule Ensemble.Behavior.Audit.Index.Memory do
  @moduledoc """
  In-memory accelerator (TRD-027). Holds `audit_id → row` in process
  dictionary scoped by generation stamp; `open/2` seeds from the JSONL
  partitions when `seed: true`. Used as the deterministic index-vs-scan
  equality baseline in the query tests.

  Stateless (process-dict keyed by generation) so `Audit` can hold it in
  a caller-owned cache map across calls without GenServer.
  """

  @behaviour Ensemble.Behavior.Audit.Index

  alias Ensemble.Behavior.Audit

  @impl true
  def open(dir, opts) do
    gen = generation(dir, opts)
    st = %{dir: dir, gen: gen, rows: %{}}

    if Keyword.get(opts, :seed, false) do
      {:ok, _n, st2} = build(st, Audit.scan_all(dir))
      {:ok, st2}
    else
      {:ok, st}
    end
  end

  @impl true
  def insert(state, record) do
    {:ok, %{state | rows: Map.put(state.rows, record["audit_id"], row_for(record))}}
  end

  @impl true
  def build(state, records) do
    rows =
      Enum.reduce(records, state.rows, fn r, acc ->
        Map.put(acc, r["audit_id"], row_for(r))
      end)

    {:ok, map_size(rows), %{state | rows: rows}}
  end

  @impl true
  def lookup(state, filter) do
    ids =
      state.rows
      |> Enum.filter(fn {_id, row} -> matches?(row, filter) end)
      |> Enum.map(&elem(&1, 0))
      |> Enum.sort()

    {:ok, ids}
  end

  @impl true
  def flush(_state), do: :ok

  @impl true
  def close(_state), do: :ok

  @doc """
  Generation stamp for a dir — same convention as `Sqlite` (partition
  basenames + sizes) so a changed ledger rotates both backends' state.
  """
  @spec generation(String.t(), keyword()) :: non_neg_integer()
  def generation(dir, opts \\ []) do
    case Keyword.get(opts, :generation) do
      g when is_integer(g) ->
        g

      nil ->
        dir
        |> Path.join("*.jsonl")
        |> Path.wildcard()
        |> Enum.map(fn f -> {Path.basename(f), File.stat!(f).size} end)
        |> Enum.sort()
        |> :erlang.phash2()
    end
  rescue
    _ -> 0
  end

  @impl true
  def delete(_state, _before_ms), do: {:error, :unsupported}

  @doc false
  def row_for(record) do
    %{
      behavior_id: Audit.behavior_id_of(record),
      kind: Audit.kind_of(record),
      event_id: Audit.event_id_of(record),
      ts: Audit.occurred_at_of(record),
      mutation: Audit.mutation_of(record),
      partition: record["__partition__"]
    }
  end

  defp matches?(row, filter) do
    Enum.all?(filter, fn
      {:behavior_id, v} -> row.behavior_id == v
      {:kind, v} -> row.kind == v
      {:event_id, v} -> row.event_id == v
      {:mutation, v} -> row.mutation == v
      {:since, v} -> row.ts == nil or Audit.iso_ge(row.ts, v)
      {:until, v} -> row.ts == nil or Audit.iso_le(row.ts, v)
      _ -> true
    end)
  end
end
