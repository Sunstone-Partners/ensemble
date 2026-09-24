defmodule Ensemble.Behavior.Audit.Index.Sqlite do
  @moduledoc """
  SQLite query accelerator over the JSONL ledger (TRD §5.1 / TRD-027,
  AC-090): `index.db` in the audit dir, WAL mode, mirroring the
  `Audit.Index` behaviour.

  ## Deviation (documented per TRD-027)

  The TRD names SQLite as the index backend. Adding a compiled Hex driver
  (`exqlite`) to `packages/core` was rejected: this package deliberately
  carries no NIF dependencies, and an optional native dependency would
  fail-open (silently losing the accelerator) on machines without a
  compiler. Instead the accelerator is implemented over the **system
  `sqlite3` CLI**, present on macOS and mainstream Linux devboxes. The
  ledger itself remains JSONL, so if `sqlite3` is missing at runtime
  `open/2` returns `{:error, :sqlite3_missing}` and `Audit` falls back to
  full partition scanning for the lifetime of the state. **Correctness
  never depends on the index** (AC-084): every query path is
  result-identical with and without it — `lookup/2` returns candidate
  ids that `Audit.query/1` revalidates against the decoded ledger.

  ## Staleness model

  The DB file name is salted with a generation stamp derived from the
  partition set (basenames + sizes). Any added/deleted/truncated
  partition changes the stamp, which creates a fresh (empty) DB — stale
  rows can never answer queries from an old ledger state. Within a
  generation, inserts happen on the write path.

  ## Row format

  `idx(audit_id TEXT PRIMARY KEY, behavior_id, kind, event_id, ts,
  mutation, part)` — indexed on every filter column. Values are passed
  as `x'hex'` SQL literals (hex-encoded UTF-8), so no quoting hazard
  exists on any ledger content.
  """

  @behaviour Ensemble.Behavior.Audit.Index

  alias Ensemble.Behavior.Audit

  @columns ~w(audit_id behavior_id kind event_id ts mutation part)

  @schema """
  CREATE TABLE IF NOT EXISTS idx(
    audit_id TEXT PRIMARY KEY,
    behavior_id TEXT,
    kind TEXT,
    event_id TEXT,
    ts TEXT,
    mutation TEXT,
    part TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_behavior ON idx(behavior_id);
  CREATE INDEX IF NOT EXISTS idx_event ON idx(event_id);
  CREATE INDEX IF NOT EXISTS idx_kind ON idx(kind);
  CREATE INDEX IF NOT EXISTS idx_ts ON idx(ts);
  CREATE INDEX IF NOT EXISTS idx_part ON idx(part);
  """

  @impl true
  def open(dir, opts) do
    cond do
      is_nil(System.find_executable("sqlite3")) ->
        {:error, :sqlite3_missing}

      not File.dir?(dir) ->
        {:error, :no_audit_dir}

      true ->
        path = Path.join(dir, Keyword.get(opts, :db, "index.db"))
        db = "#{path}.#{generation_salt(dir)}"

        case exec(db, @schema) do
          {:ok, _} -> {:ok, %{db: db, dir: dir}}
          {:error, r} -> {:error, r}
        end
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  @impl true
  def insert(state, record) do
    sql = insert_sql([record])
    case exec(state.db, sql) do
      {:ok, _} -> :ok
      {:error, r} -> {:error, r}
    end
  end

  @impl true
  def build(state, records) do
    records = Enum.to_list(records)
    chunks = Enum.chunk_every(records, 500)
    sqls = Enum.map(chunks, &insert_sql/1)

    Enum.reduce_while(sqls, {:ok, length(records)}, fn sql, {:ok, n} ->
      case exec(state.db, sql) do
        {:ok, _} -> {:cont, {:ok, n}}
        {:error, r} -> {:halt, {:error, r}}
      end
    end)
  end

  defp insert_sql(records) do
    vals =
      records
      |> Enum.map(fn r -> "(" <> Enum.join(row_values(r), ",") <> ")" end)
      |> Enum.join(",")

    "INSERT OR REPLACE INTO idx(#{Enum.join(@columns, ",")}) VALUES #{vals};"
  end

  @impl true
  def lookup(state, filter) do
    {where, ord} = where_clause(filter)
    sql = "SELECT audit_id FROM idx" <> where <> ord <> ";"

    case exec(state.db, sql) do
      {:ok, rows} -> {:ok, Enum.map(rows, fn [id] -> id end)}
      {:error, r} -> {:error, r}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  @impl true
  def flush(state), do: exec(state.db, "PRAGMA wal_checkpoint(TRUNCATE);") |> elem(0)

  @impl true
  def close(_state), do: :ok

  @impl true
  def delete(state, before_ms) do
    cutoff = lit(Audit.to_iso(DateTime.from_unix!(before_ms, :millisecond)))
    exec(state.db, "DELETE FROM idx WHERE ts < #{cutoff};") |> elem(0)
  rescue
    e -> {:error, Exception.message(e)}
  end

  # --- internals ---------------------------------------------------------

  @doc "Generation salt for a dir (changes when partitions change)."
  @spec generation(String.t(), keyword()) :: non_neg_integer()
  def generation(dir, _opts \\ []) do
    salt = generation_salt(dir)
    <<head::64, _::binary>> = Base.decode16!(salt, case: :lower)
    head
  end

  defp generation_salt(dir) do
    stamp =
      dir
      |> Path.join("*.jsonl")
      |> Path.wildcard()
      |> Enum.sort()
      |> Enum.map(fn f ->
        case File.stat(f) do
          {:ok, s} -> "#{Path.basename(f)}:#{s.size}"
          _ -> Path.basename(f)
        end
      end)
      |> Enum.join("|")

    :sha256 |> :crypto.hash(stamp) |> Base.encode16(case: :lower) |> binary_part(0, 16)
  end

  defp row_values(record) do
    [
      lit(record["audit_id"]),
      lit(Audit.behavior_id_of(record)),
      lit(Audit.kind_of(record)),
      lit(Audit.event_id_of(record)),
      lit(Audit.occurred_at_of(record)),
      lit(Audit.mutation_of(record)),
      lit(record["__partition__"])
    ]
  end

  defp lit(nil), do: "NULL"
  defp lit(v) when is_atom(v), do: lit(Atom.to_string(v))
  defp lit(v) when is_integer(v), do: lit(Integer.to_string(v))
  defp lit(v) when is_binary(v), do: "x'" <> Base.encode16(v, case: :lower) <> "'"

  defp where_clause(filter) do
    parts =
      filter
      |> Enum.flat_map(fn
        {:behavior_id, v} -> ["behavior_id = #{lit(v)}"]
        {:event_id, v} -> ["event_id = #{lit(v)}"]
        {:kind, v} -> ["kind = #{lit(v)}"]
        {:mutation, v} -> ["mutation = #{lit(v)}"]
        {:since, v} -> ["ts >= #{lit(Audit.to_iso(v))}"]
        {:until, v} -> ["ts <= #{lit(Audit.to_iso(v))}"]
        _ -> []
      end)

    where = if parts == [], do: "", else: " WHERE " <> Enum.join(parts, " AND ")

    limit =
      case filter_value(filter, :limit) do
        n when is_integer(n) and n > 0 -> " LIMIT #{n}"
        _ -> ""
      end

    {where <> limit, " ORDER BY ts ASC, audit_id ASC"}
  end

  defp filter_value(filter, key) do
    case filter do
      %{} -> Map.get(filter, key)
      kw when is_list(kw) -> Keyword.get(kw, key)
      _ -> nil
    end
  end

  defp exec(db, sql) do
    case System.find_executable("sqlite3") do
      nil ->
        {:error, :sqlite3_missing}

      bin ->
        port =
          Port.open({:spawn_executable, bin}, [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: ["-batch", "-noheader", "-separator", "\t", "-nullvalue", "\x00", db]
          ])

        send(port, {self(), {:command, sql <> "\n"}})
        send(port, {self(), :close})
        collect(port, "")
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp collect(port, acc) do
    receive do
      {^port, {:data, d}} -> collect(port, acc <> d)
      {^port, :closed} -> finalize(acc)
    after
      20_000 ->
        try do
          Port.close(port)
        catch
          _, _ -> :ok
        end

        {:error, {:timeout, acc}}
    end
  end

  defp finalize(out) do
    lines =
      out
      |> String.split(["\r\n", "\n"], trim: true)
      |> Enum.map(&String.trim_trailing(&1, "\r"))
      |> Enum.reject(&(&1 == ""))

    cond do
      Enum.any?(lines, &String.contains?(&1, "** ERROR")) ->
        {:error, Enum.join(lines, "\n")}

      Enum.any?(lines, &Regex.match?(~r/^(Error|Parse error)/i, &1)) ->
        {:error, Enum.join(lines, "\n")}

      true ->
        {:ok, Enum.map(lines, &String.split(&1, "\t"))}
    end
  end
end
