defmodule Ensemble.Behavior.PolicyContext do
  @moduledoc """
  Durable runtime evidence for the policy gates (TRD-021, TRD §4.1 lines
  540-544; REQ-008/009/010/012, Article IV / REQ-SAFE-006).

  Three in-memory ETS stores, mirrored to a JSONL append log so a restart
  rebuilds the same tables:

  | store     | key                       | value      | gate             |
  |-----------|---------------------------|------------|------------------|
  | dedup     | `{event_key, name}`       | `fired_ms` | 2 `:dedup`       |
  | cooldowns | `behavior_name`           | `last_ms`  | 3 `:cooldown`    |
  | active    | `behavior_name`           | `count`    | 4 `:concurrency` |

  `to_policy_ctx/1` renders the snapshot `Ensemble.Behavior.Policy.evaluate/3`
  consumes; `to_policy_ctx/2` is that snapshot with the scalars gates 4 and 5
  require resolved for one behavior. The reads mirror Policy's own consumption
  exactly — nothing is normalised or flattened differently than Policy reads
  it:

  * `:dedup` is a plain `%{{event_key, name} => fired_ms}` map, so
    `Matcher.dedup_suppressed?/4`'s `Map.get/2` contract holds whether the
    store is a hand-built map or the snapshot of these tables.
  * `:cooldowns` is keyed by bare `behavior_name` (TRD §12 Q2: the default
    `:event_type` scope is per-behavior for a single-event_type behavior, and
    `Policy.cooldown/6` looks the name up directly).
  * the counter table holds `active` **per behavior**, because gate 4 compares
    `active_count >= policy.max_concurrent` and `max_concurrent` is a
    per-behavior ceiling (TRD §4.1 line 532). `active_for/2` collapses the
    table to the `non_neg_integer()` `Policy.concurrency/6` requires.
  * `:children` — gate 5's fan-out count — is owned by the activation tree,
    not by this store. `to_policy_ctx/1` therefore leaves it absent, and any
    behavior with `max_children > 0` resolves `:policy_unresolved` on purpose
    rather than being handed a flattering zero. `to_policy_ctx/2` defaults it
    to `0` (no children spawned = evidence of absence, the same reasoning as
    `active_for/2`) and takes an explicit `:children` override for callers who
    do own that count.

  ## Never defaults open

  An empty or missing mirror file is not "no state, therefore allow": the
  tables start empty, absent evidence reads `:unknown`, and Policy converts
  unresolved evidence into `:policy_unresolved` → `:block` (TRD lines
  540-542). A restart with no log therefore blocks rather than dispatches.

  One deliberate distinction, because it is a fact and not a default: a
  behavior the counter table has never heard of has *zero* running activations
  — an empty ledger is evidence of absence for a running count, and
  `active_for/2` reports it as such. `running/2` keeps exposing the raw
  evidence and still answers `:unknown` for unseen behaviors. An unresolved
  **read** (dead store, failed lookup) yields `:unknown` through every path.

  A failed *write* is not a mutation: the caller gets
  `{:error, {:policy_unresolved, reason}}` instead of an `:ok` it cannot
  trust. Nothing is half-committed — the durable record is appended first, and
  only then do the tables take the change, so a refused append leaves both
  sides untouched (TRD lines 540-542; Article IV).

  ## Durability

  Every mutation (fire, activate, complete) appends one small record to

      Path.join(System.get_env("ENSEMBLE_STATE_DIR") || ".ensemble/state",
                "policy-context.jsonl")

  and `init/1` replays that file into the tables, newest record per key
  winning. A corrupt line is skipped and logged; replay continues with the
  rest. `now_ms` enters only through the API — the store never reads a clock
  on its own, so callers and tests control the timestamps in the ledger.
  """

  use GenServer

  require Logger

  alias Ensemble.Behavior.Audit

  @type event_key :: term()
  @type name :: String.t()
  @type snapshot :: %{
          dedup: %{{term(), name()} => integer()},
          cooldowns: %{name() => integer()},
          active: %{name() => non_neg_integer()}
        }
  @type ctx_arg :: GenServer.server() | snapshot()
  @type mutate_result :: :ok | {:error, {:policy_unresolved, term()}}

  @fire "fire"
  @activate "activate"
  @complete "complete"

  # ------------------------------------------------------------------- API

  @doc """
  Start a named context store.

  `opts`: `:name` (defaults to this module; it also names the ETS tables, so
  two stores can coexist) and `:dir` (overrides the state directory — tests
  and multi-tenant callers pass this instead of mutating the environment).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc "The JSONL mirror path this context reads and appends."
  @spec file(ctx_arg()) :: Path.t()
  def file(ctx) when is_map(ctx), do: mirror(ctx)
  def file(ctx), do: mirror(%{dir: read(ctx, :dir)})

  @doc """
  Record that `name` fired for `event_or_key` at `now_ms` (gate-2 evidence).

  `event_or_key` may be the event itself — any shape `Matcher` accepts — or a
  dedup key the caller computed; both land on the same `{key, name}` row.
  """
  @spec fire(ctx_arg(), event_key() | term(), name(), integer() | nil) :: mutate_result()
  def fire(ctx, event_or_key, name, now_ms \\ nil)

  def fire(ctx, event_or_key, name, nil) do
    fire(ctx, event_or_key, name, System.system_time(:millisecond))
  end

  def fire(ctx, event_or_key, name, now_ms) when is_integer(now_ms) do
    mutate(ctx, {:fire, event_key(event_or_key), name, now_ms})
  end

  @doc """
  The dedup key `Matcher` uses for `event`: `dedup_key || event_id ||
  {event_type, source}`. A value that is not an event is already a key and
  passes through unchanged.
  """
  @spec event_key(term()) :: term()
  def event_key(%Ensemble.Behavior.Event{} = event) do
    event.dedup_key || event.event_id || {event.event_type, event.source}
  end

  def event_key(event) when is_map(event) do
    cond do
      Map.get(event, :dedup_key) -> event[:dedup_key]
      Map.get(event, :event_id) -> event[:event_id]
      Map.get(event, "dedup_key") -> event["dedup_key"]
      Map.get(event, "event_id") -> event["event_id"]
      Map.has_key?(event, :event_type) -> {event[:event_type], event[:source]}
      Map.has_key?(event, "event_type") -> {event["event_type"], event["source"]}
      true -> event
    end
  end

  def event_key(key), do: key

  @doc "Last fire timestamp stored for `{key, name}`, or `:unknown`."
  @spec last_fired(ctx_arg(), event_key(), name()) :: integer() | :unknown
  def last_fired(ctx, key, name), do: read(ctx, {:last_fired, key, name})

  @doc "Stamp an activation of `name` as running (gate-4 evidence)."
  @spec activate(ctx_arg(), name()) :: mutate_result()
  def activate(ctx, name), do: mutate(ctx, {:activate, name})

  @doc """
  Close a running activation of `name`: sets its cooldown stamp to `now_ms`
  and decrements the active count, floored at zero.
  """
  @spec complete(ctx_arg(), name(), integer() | nil) :: mutate_result()
  def complete(ctx, name, now_ms \\ nil) do
    mutate(ctx, {:complete, name, now_ms || System.system_time(:millisecond)})
  end

  @doc "Running-activation counts, `%{name => non_neg_integer()}`."
  @spec running(ctx_arg()) :: %{name() => non_neg_integer()}
  def running(ctx), do: read(ctx, :running)

  @doc """
  Raw running count of one behavior — uninterpreted evidence. `:unknown` when
  the store holds no row for it.
  """
  @spec running(ctx_arg(), name()) :: non_neg_integer() | :unknown
  def running(ctx, name), do: read(ctx, {:running, name})

  @doc """
  Gate-4 scalar for `name`: its running count.

  A behavior the store has never heard of has zero running activations (an
  empty ledger is evidence of absence for a running count), so this reads `0`.
  An unresolved *read* — dead store, failed lookup — still yields `:unknown`,
  and Policy blocks on that (TRD lines 540-542).
  """
  @spec active_for(ctx_arg(), name()) :: non_neg_integer() | :unknown
  def active_for(ctx, name) do
    case running(ctx, name) do
      :unknown -> 0
      n -> n
    end
  end

  @doc "Last completion stamp for `name`, or `:unknown`."
  @spec last_completed(ctx_arg(), name()) :: integer() | :unknown
  def last_completed(ctx, name), do: read(ctx, {:last_completed, name})

  @doc "Cooldown table, `%{name => last_completed_ms}`."
  @spec cooldowns(ctx_arg()) :: %{name() => integer()}
  def cooldowns(ctx), do: read(ctx, :cooldowns)

  @doc "Dedup ledger, `%{{event_key, name} => fired_ms}`."
  @spec dedup(ctx_arg()) :: %{{term(), name()} => integer()}
  def dedup(ctx), do: read(ctx, :dedup)

  @doc """
  Snapshot for `Policy.evaluate/3` (as `opts[:ctx]` or `opts[:policy_context]`).

  Deliberately incomplete, and that is the point: `active` is the per-behavior
  table (gate 4 wants a scalar, so use `to_policy_ctx/2`), and `:children` is
  absent because this store does not own the activation tree. Never adds
  `:enabled` either — the kill-switch is registry state, and Policy documents
  an absent key as "nothing revoked this behavior". `:budget` stays absent for
  the same reason: gate 6 is inert until the Phase 4 ledger exists, and this
  store must not manufacture evidence for a feature it does not own.
  """
  @spec to_policy_ctx(ctx_arg()) :: map()
  def to_policy_ctx(ctx) when is_map(ctx) do
    %{
      dedup: Map.get(ctx, :dedup, %{}),
      cooldowns: Map.get(ctx, :cooldowns, %{}),
      active: Map.get(ctx, :active, %{})
    }
  end

  def to_policy_ctx(ctx), do: read(ctx, :ctx)

  @doc """
  `to_policy_ctx/1` with gates 4 and 5 resolved for `name`.

  This is the form to hand `Policy.evaluate/3`: gate 4 gets
  `active_for(ctx, name)`, and gate 5's `:children` defaults to `0` — unless
  the caller owns child accounting and passes `:children`, which is forwarded
  to Policy untouched (`:unknown` included, which blocks).
  """
  @spec to_policy_ctx(ctx_arg(), name(), keyword()) :: map()
  def to_policy_ctx(ctx, name, opts \\ []) do
    to_policy_ctx(ctx)
    |> Map.put(:active, active_for(ctx, name))
    |> Map.merge(Map.take(%{children: Keyword.get(opts, :children, 0)}, [:children]))
  end

  @doc "Plain dedup map for `Matcher.dedup_suppressed?/4`."
  @spec to_map(ctx_arg()) :: %{{term(), name()} => integer()}
  def to_map(ctx), do: dedup(ctx)

  # ------------------------------------------------------------- GenServer

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    dir = Keyword.get(opts, :dir) || default_dir()

    tables = [
      dedup: table(name, :dedup),
      cooldowns: table(name, :cooldowns),
      active: table(name, :active)
    ]

    state = %{dir: dir, name: name, tables: tables}
    replay(state)
    {:ok, state}
  end

  # Durable first: if the append is refused, no table is touched and the
  # caller learns the mutation did not happen.
  @impl true
  def handle_call({:fire, key, name, ms}, _from, state) do
    with {:ok, state} <- record(state, %{"op" => @fire, "key" => key, "name" => name, "ms" => ms}) do
      insert(state, :dedup, {{key, name}, ms})
      {:reply, :ok, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:activate, name}, _from, state) do
    count = counter_get(state, name) + 1

    with {:ok, state} <- record(state, %{"op" => @activate, "name" => name, "count" => count}) do
      insert(state, :active, {name, count})
      {:reply, :ok, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:complete, name, ms}, _from, state) do
    count = max(counter_get(state, name) - 1, 0)

    with {:ok, state} <-
           record(state, %{"op" => @complete, "name" => name, "ms" => ms, "count" => count}) do
      insert(state, :cooldowns, {name, ms})
      insert(state, :active, {name, count})
      {:reply, :ok, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:last_fired, key, name}, _from, state) do
    {:reply, lookup_et(state, :dedup, {key, name}), state}
  end

  def handle_call({:running, name}, _from, state) do
    {:reply, lookup_et(state, :active, name), state}
  end

  def handle_call({:last_completed, name}, _from, state) do
    {:reply, lookup_et(state, :cooldowns, name), state}
  end

  def handle_call(:running, _from, state), do: {:reply, dump(state, :active), state}
  def handle_call(:cooldowns, _from, state), do: {:reply, dump(state, :cooldowns), state}
  def handle_call(:dedup, _from, state), do: {:reply, dump(state, :dedup), state}
  def handle_call(:dir, _from, state), do: {:reply, state.dir, state}

  def handle_call(:ctx, _from, state) do
    {:reply,
     %{
       dedup: dump(state, :dedup),
       cooldowns: dump(state, :cooldowns),
       active: dump(state, :active)
     }, state}
  end

  # ------------------------------------------------------------- internals

  defp table(name, slot) do
    :ets.new(ets_name(name, slot), [:set, :public, :named_table, read_concurrency: true])
  end

  @doc false
  def ets_name(base, slot) do
    :"Elixir.Ensemble.Behavior.PolicyContext.#{slot}#{:erlang.phash2(base)}"
  end

  defp tab(state, slot), do: Keyword.fetch!(state.tables, slot)

  defp insert(state, slot, tuple), do: :ets.insert(tab(state, slot), tuple)

  defp counter_get(state, name) do
    case :ets.lookup(tab(state, :active), name) do
      [{^name, n}] when is_integer(n) -> n
      _ -> 0
    end
  end

  defp lookup_et(state, slot, key) do
    case :ets.lookup(tab(state, slot), key) do
      [{^key, v}] -> v
      _ -> :unknown
    end
  end

  defp dump(state, slot), do: state |> tab(slot) |> :ets.tab2list() |> Map.new()

  defp default_dir, do: System.get_env("ENSEMBLE_STATE_DIR") || ".ensemble/state"

  defp mirror(%{dir: dir}) when is_binary(dir), do: Path.join(dir, "policy-context.jsonl")
  defp mirror(_), do: Path.join(default_dir(), "policy-context.jsonl")

  defp read(ctx, what) when is_map(ctx), do: read_map(ctx, what)

  defp read(ctx, what) do
    try do
      GenServer.call(ctx, what)
    catch
      :exit, reason -> unresolved!(:read, reason)
    end
  end

  defp mutate(ctx, _what) when is_map(ctx), do: unresolved!(:mutation, :read_only_snapshot)
  defp mutate(ctx, what), do: GenServer.call(ctx, what)

  defp read_map(ctx, {:last_fired, key, name}), do: fetch(Map.get(ctx, :dedup, %{}), {key, name})
  defp read_map(ctx, {:running, name}), do: fetch(Map.get(ctx, :active, %{}), name)

  defp read_map(ctx, {:last_completed, name}), do: fetch(Map.get(ctx, :cooldowns, %{}), name)

  defp read_map(ctx, :running), do: Map.get(ctx, :active, %{})
  defp read_map(ctx, :cooldowns), do: Map.get(ctx, :cooldowns, %{})
  defp read_map(ctx, :dedup), do: Map.get(ctx, :dedup, %{})
  defp read_map(ctx, :ctx), do: to_policy_ctx(ctx)
  defp read_map(ctx, :dir), do: mirror_dir(ctx)

  defp mirror_dir(%{dir: dir}) when is_binary(dir), do: dir
  defp mirror_dir(_), do: default_dir()

  defp fetch(table, key) do
    case Map.fetch(table, key) do
      {:ok, v} -> v
      :error -> :unknown
    end
  end

  @doc false
  # Append one mutation record. Returns `{:ok, state}` or
  # `{:error, {:policy_unresolved, reason}}` — never raises inside the server,
  # so a write failure cannot take the store down with it.
  @spec record(map(), map()) :: {:ok, map()} | {:error, {:policy_unresolved, term()}}
  defp record(state, payload) do
    case File.write(mirror(state), [Audit.canonical_json(payload), "\n"], [:append]) do
      :ok -> {:ok, state}
      {:error, reason} -> {:error, {:policy_unresolved, reason}}
    end
  rescue
    e -> {:error, {:policy_unresolved, Exception.message(e)}}
  end

  # Rebuild the tables from the mirror. Records apply in file order, so the
  # newest record per key wins; activate/complete carry the resulting count,
  # which makes replay a fold rather than a re-derivation.
  defp replay(state) do
    path = mirror(state)

    case File.read(path) do
      {:error, :enoent} ->
        :ok

      {:ok, body} ->
        body
        |> String.split("\n")
        |> Enum.with_index(1)
        |> Enum.each(fn {line, idx} ->
          case decode_record(line) do
            nil -> if blank?(line), do: :ok, else: corrupt(path, idx)
            entry -> apply_entry(state, entry)
          end
        end)

        :ok

      {:error, reason} ->
        unresolved!(:replay, reason)
    end
  end

  defp blank?(line), do: String.trim(line) == ""

  defp corrupt(path, idx) do
    Logger.warning("PolicyContext: skipping corrupt mirror line #{idx} in #{path}")
  end

  defp decode_record(line) do
    case :json.decode(line) do
      m when is_map(m) -> normalize_record(m)
      _ -> nil
    end
  rescue
    _ -> nil
  end

  # JSON round-trips the dedup key tuple as an array; restore the tuple so the
  # replayed ledger keeps the `{event_key, name}` contract Matcher reads.
  defp normalize_record(%{"key" => key} = record) when is_list(key),
    do: Map.put(record, "key", List.to_tuple(key))

  defp normalize_record(record), do: record

  defp apply_entry(state, %{"op" => @fire, "key" => key, "name" => name, "ms" => ms})
       when is_integer(ms) do
    insert(state, :dedup, {{key, name}, ms})
  end

  defp apply_entry(state, %{"op" => @activate, "name" => name, "count" => count})
       when is_integer(count) do
    insert(state, :active, {name, count})
  end

  defp apply_entry(state, %{"op" => @complete, "name" => name} = entry) do
    if is_integer(entry["ms"]), do: insert(state, :cooldowns, {name, entry["ms"]})
    insert(state, :active, {name, entry["count"] || 0})
  end

  defp apply_entry(_state, _entry), do: :ok

  defp unresolved!(op, evidence) do
    raise "PolicyContext #{op} unresolved: #{inspect(evidence)} — fail closed (:policy_unresolved)"
  end
end
