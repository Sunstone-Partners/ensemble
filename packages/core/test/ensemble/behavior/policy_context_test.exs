defmodule Ensemble.Behavior.PolicyContextTest do
  use ExUnit.Case, async: false

  alias Ensemble.Behavior.{Audit, Compiler, Event, Matcher, Policy, PolicyContext}

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "ctx", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "github.push"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  @dk "dk-ctx-1"
  @now 1_000_000

  defp defn(policy) do
    {:ok, d} = Compiler.validate(deep_merge(@base, %{"policy" => policy}))
    d
  end

  defp deep_merge(left, right) do
    Map.merge(left, right, fn _k, l, r ->
      if is_map(l) and is_map(r), do: deep_merge(l, r), else: r
    end)
  end

  defp event(overrides \\ %{}) do
    struct(
      Event,
      Map.merge(
        %{event_id: "e-1", event_type: "github.push", dedup_key: @dk, depth: 0},
        overrides
      )
    )
  end

  # Behaviors under test declare their windows rather than inheriting
  # Behaviors under test declare their windows rather than inheriting the
  # 1h PolicySpec dedup default, which would silently turn an intended
  # defer/suppress fixture into a block.

  defp evaluate(d, ctx, now_ms) do
    Policy.evaluate(d, event(), %{ctx: ctx, now_ms: now_ms})
  end

  # ---------------------------------------------------------------- helpers

  defp tmpdir(prefix) do
    dir =
      Path.join(System.tmp_dir!(), "#{prefix}-#{System.unique_integer([:positive, :monotonic])}")

    File.mkdir_p!(dir)
    dir
  end

  defp cleanup(dir) do
    ExUnit.Callbacks.on_exit(fn -> File.rm_rf!(dir) end)
    dir
  end

  defp open(dir, slug) do
    name = :"PC#{slug}#{System.unique_integer([:positive, :monotonic])}"
    {:ok, pid} = PolicyContext.start_link(name: name, dir: dir)

    ExUnit.Callbacks.on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    name
  end

  # A store rooted in a throwaway dir, seeded from `clauses` (see `seed/2`).
  defp store(clauses \\ []) do
    dir = cleanup(tmpdir("pc"))
    name = open(dir, "s")
    seed(name, clauses)
  end

  defp seed(name, clauses) do
    for {key, ms} <- Keyword.get(clauses, :fire, []), do: PolicyContext.fire(name, key, "ctx", ms)

    for n <- Keyword.get(clauses, :activate, []),
        do: times(name, "ctx", n, &PolicyContext.activate/2)

    for {n, ms} <- Keyword.get(clauses, :complete, []) do
      times(name, "ctx", n, &PolicyContext.activate/2)
      PolicyContext.complete(name, "ctx", ms)
    end

    name
  end

  defp times(name, behavior, n, fun) do
    Enum.each(1..max(n, 0), fn _ -> fun.(name, behavior) end)
  end

  # ---------------------------------------------------------------- contract

  describe "to_policy_ctx/1 — the shape Policy.evaluate/3 consumes" do
    test "a started store renders dedup, cooldowns and active — and nothing else" do
      ctx = PolicyContext.to_policy_ctx(store())

      assert ctx == %{dedup: %{}, cooldowns: %{}, active: %{}}
      # :enabled stays absent (the registry owns the kill-switch) and :budget
      # stays absent (gate 6 is inert until Phase 4): manufacturing either here
      # would let this store decide policy out of nothing.
      refute Map.has_key?(ctx, :enabled)
      refute Map.has_key?(ctx, :budget)
    end

    test "dedup keys are {event_key, name} tuples" do
      name = store(fire: [{@dk, @now}])
      assert PolicyContext.to_policy_ctx(name).dedup == %{{@dk, "ctx"} => @now}
      assert PolicyContext.to_map(name) == %{{@dk, "ctx"} => @now}
    end

    test "the ledger is interchangeable with Matcher's plain-map contract" do
      name = store(fire: [{@dk, @now}])
      d = defn(%{"dedup_window" => 10_000})

      # Identical answer from the ETS snapshot and from a hand-built map: the
      # store cannot disagree with the matcher about what a duplicate is.
      assert PolicyContext.dedup(name) == Matcher.record_fire(%{}, event(), d, @now)
      assert Matcher.dedup_suppressed?(event(), d, PolicyContext.to_map(name), @now + 1)
      refute Matcher.dedup_suppressed?(event(), d, PolicyContext.to_map(name), @now + 10_000)
    end

    test "dedup rows are keyed by {event_key, behavior_name}, as Matcher.dedup_suppressed?/4 looks them up" do
      name = store(complete: [{1, @now}])
      assert PolicyContext.cooldowns(name) == %{"ctx" => @now}
    end

    test "the counter table is per behavior; to_policy_ctx/2 gives gate 4 its scalar" do
      name = store(activate: [3])
      assert PolicyContext.to_policy_ctx(name).active == %{"ctx" => 3}
      assert PolicyContext.to_policy_ctx(name, "ctx").active == 3
      assert PolicyContext.active_for(name, "ctx") == 3
    end

    test "an unseen behavior reads :unknown as raw evidence, 0 as a running count" do
      name = store(activate: [2])
      # Absence of a fire/cooldown row is unresolved evidence; absence of a
      # counter row is a count of zero. The distinction is what keeps the store
      # honest without inventing permission.
      assert PolicyContext.running(name, "other") == :unknown
      assert PolicyContext.last_completed(name, "other") == :unknown
      assert PolicyContext.last_fired(name, @dk, "other") == :unknown
      assert PolicyContext.active_for(name, "other") == 0
      assert PolicyContext.running(name) == %{"ctx" => 2}
    end

    test "the API reads a plain snapshot the same way it reads a store" do
      snap = %{dedup: %{{@dk, "ctx"} => @now}, cooldowns: %{"ctx" => @now}, active: %{"ctx" => 1}}
      assert PolicyContext.to_policy_ctx(snap) == snap
      assert PolicyContext.to_policy_ctx(snap, "ctx").active == 1
      assert PolicyContext.last_fired(snap, @dk, "ctx") == @now
      assert PolicyContext.active_for(snap, "ctx") == 1
      assert PolicyContext.last_completed(snap, "ctx") == @now
      assert PolicyContext.to_map(snap) == %{{@dk, "ctx"} => @now}
      assert PolicyContext.file(snap) == Path.join(cwd_state(), "policy-context.jsonl")
    end

    test "a snapshot is read-only: mutating it fails closed instead of pretending" do
      assert_raise RuntimeError, ~r/read_only_snapshot.*:policy_unresolved/m, fn ->
        PolicyContext.fire(%{dedup: %{}}, @dk, "ctx", @now)
      end
    end

    test "a dead store fails closed rather than reading as empty" do
      dir = cleanup(tmpdir("pc-dead"))
      name = open(dir, "d")
      GenServer.stop(name)

      assert_raise RuntimeError, ~r/:policy_unresolved/, fn ->
        PolicyContext.to_policy_ctx(name)
      end

      assert_raise RuntimeError, ~r/:policy_unresolved/, fn ->
        PolicyContext.active_for(name, "ctx")
      end
    end
  end

  # -------------------------------------------------------------- mutations

  describe "fire/4" do
    test "records the caller's timestamp; the store never reads a clock" do
      name = store()
      assert PolicyContext.fire(name, @dk, "ctx", 555) == :ok
      assert PolicyContext.last_fired(name, @dk, "ctx") == 555
    end

    test "accepts an Event struct and derives Matcher's key" do
      name = store()
      PolicyContext.fire(name, event(), "ctx", @now)
      assert PolicyContext.last_fired(name, @dk, "ctx") == @now
    end

    test "an event with no dedup_key falls back to event_id" do
      name = store()
      PolicyContext.fire(name, event(%{dedup_key: nil}), "ctx", @now)
      assert PolicyContext.last_fired(name, "e-1", "ctx") == @now
    end

    test "same key with different behaviors are distinct rows" do
      name = store()
      PolicyContext.fire(name, @dk, "a", @now)
      PolicyContext.fire(name, @dk, "b", @now + 5)
      assert PolicyContext.last_fired(name, @dk, "a") == @now
      assert PolicyContext.last_fired(name, @dk, "b") == @now + 5
    end

    test "event_key/1 passes a bare key through and reads map events" do
      assert PolicyContext.event_key("k") == "k"
      assert PolicyContext.event_key(%{"dedup_key" => "mk"}) == "mk"
      assert PolicyContext.event_key(%{"event_type" => "github.push"}) == {"github.push", nil}
    end
  end

  describe "activate/2 and complete/3" do
    test "activate increments; complete decrements and stamps the cooldown" do
      name = store()
      PolicyContext.activate(name, "ctx")
      PolicyContext.activate(name, "ctx")
      assert PolicyContext.running(name, "ctx") == 2

      assert PolicyContext.complete(name, "ctx", @now) == :ok
      assert PolicyContext.running(name, "ctx") == 1
      assert PolicyContext.last_completed(name, "ctx") == @now
    end

    test "the count floors at zero instead of going negative" do
      name = store(activate: [1])
      PolicyContext.complete(name, "ctx", @now)
      PolicyContext.complete(name, "ctx", @now + 1)
      assert PolicyContext.running(name, "ctx") == 0
      assert PolicyContext.last_completed(name, "ctx") == @now + 1
    end
  end

  # ------------------------------------------------------------- durability

  describe "JSONL mirror" do
    test "every mutation appends exactly one record, in order" do
      dir = cleanup(tmpdir("pc-file"))
      name = open(dir, "f")

      assert PolicyContext.file(name) == Path.join(dir, "policy-context.jsonl")

      PolicyContext.fire(name, @dk, "ctx", @now)
      PolicyContext.activate(name, "ctx")
      PolicyContext.complete(name, "ctx", @now + 1)

      ops =
        name
        |> PolicyContext.file()
        |> File.read!()
        |> String.split("\n", trim: true)
        |> Enum.map(&(:json.decode(&1) |> Map.fetch!("op")))

      assert ops == ["fire", "activate", "complete"]
    end

    test "a write failure raises with :policy_unresolved instead of losing evidence" do
      # A directory where a file cannot be appended: durability must not be
      # best-effort.
      blocked = "/tmp"

      dir = Path.join(blocked, "pc-ro-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      File.chmod!(dir, 0o500)
      name = open(dir, "ro")
      pid = Process.whereis(name)

      try do
        assert {:error, {:policy_unresolved, _}} = PolicyContext.fire(name, @dk, "ctx", @now)
        assert PolicyContext.last_fired(name, @dk, "ctx") == :unknown
        assert Process.alive?(pid)
      after
        File.chmod!(dir, 0o700)
        File.rm_rf!(dir)
      end
    end

    test "ENSEMBLE_STATE_DIR roots the mirror when :dir is not given" do
      dir = cleanup(tmpdir("pc-env"))
      name = :"PCenv#{System.unique_integer([:positive])}"
      previous = System.get_env("ENSEMBLE_STATE_DIR")
      System.put_env("ENSEMBLE_STATE_DIR", dir)

      try do
        {:ok, pid} = PolicyContext.start_link(name: name)
        ExUnit.Callbacks.on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)
        PolicyContext.fire(name, @dk, "ctx", @now)
        assert File.exists?(Path.join(dir, "policy-context.jsonl"))
        assert PolicyContext.file(name) == Path.join(dir, "policy-context.jsonl")
      after
        if previous do
          System.put_env("ENSEMBLE_STATE_DIR", previous)
        else
          System.delete_env("ENSEMBLE_STATE_DIR")
        end
      end
    end
  end

  describe "restart reconstruction" do
    test "a restarted store rebuilds all three tables from the mirror" do
      dir = cleanup(tmpdir("pc-restart"))
      first = open(dir, "r1")

      PolicyContext.fire(first, "k1", "ctx", @now)
      PolicyContext.fire(first, "k2", "ctx", @now + 1)
      times(first, "ctx", 3, &PolicyContext.activate/2)
      PolicyContext.complete(first, "ctx", @now + 2)
      PolicyContext.activate(first, "other")
      GenServer.stop(first)

      second = open(dir, "r2")

      assert PolicyContext.last_fired(second, "k1", "ctx") == @now
      assert PolicyContext.last_fired(second, "k2", "ctx") == @now + 1
      assert PolicyContext.last_completed(second, "ctx") == @now + 2
      assert PolicyContext.running(second) == %{"ctx" => 2, "other" => 1}
    end

    test "reconstruction preserves the gate verdicts end to end" do
      dir = cleanup(tmpdir("pc-replay"))
      first = open(dir, "g1")
      d = defn(%{"dedup_window" => 60_000, "cooldown" => 5_000, "max_concurrent" => 3})
      PolicyContext.fire(first, @dk, "ctx", @now)
      PolicyContext.activate(first, "ctx")
      GenServer.stop(first)

      second = open(dir, "g2")

      before = evaluate(d, PolicyContext.to_policy_ctx(second, "ctx"), @now + 10)
      assert before.verdict == :suppress
      assert hd(before.reasons).code == :duplicate_suppressed

      # Past the dedup window the surviving cooldown takes over: the replayed
      # tables drive the same gates a live run would.
      PolicyContext.complete(second, "ctx", @now + 60_010)
      GenServer.stop(second)
      third = open(dir, "g3")
      later = evaluate(d, PolicyContext.to_policy_ctx(third, "ctx"), @now + 64_000)
      assert later.verdict == :suppress
      assert hd(later.reasons).gate == :cooldown
    end

    test "last write wins across a restart, in file order" do
      dir = cleanup(tmpdir("pc-order"))
      a = open(dir, "o1")
      PolicyContext.fire(a, "k", "ctx", @now)
      PolicyContext.fire(a, "k", "ctx", @now + 9)
      GenServer.stop(a)

      b = open(dir, "o2")
      assert PolicyContext.last_fired(b, "k", "ctx") == @now + 9
    end

    test "a corrupt line is skipped and logged; the rest still reconstructs" do
      dir = cleanup(tmpdir("pc-corrupt"))
      file = Path.join(dir, "policy-context.jsonl")

      File.write!(file, [
        Audit.canonical_json(%{"op" => "fire", "key" => "good", "name" => "ctx", "ms" => @now}),
        "\n",
        "{ this is not json at all\n",
        Audit.canonical_json(%{"op" => "activate", "name" => "ctx", "count" => 4}),
        "\n"
      ])

      name =
        ExUnit.CaptureLog.capture_log(fn ->
          send(self(), {:opened, open(dir, "c")})
        end)

      assert name =~ "skipping corrupt mirror line 2"
      assert_receive {:opened, srv}
      assert PolicyContext.last_fired(srv, "good", "ctx") == @now
      assert PolicyContext.running(srv, "ctx") == 4
    end

    test "a replayed fire row keeps Matcher {event_key, name} contract" do
      dir = cleanup(tmpdir("pc-tuple"))
      a = open(dir, "t1")
      PolicyContext.fire(a, event(), "ctx", @now)
      GenServer.stop(a)

      b = open(dir, "t2")
      d = defn(%{"dedup_window" => 60_000, "cooldown" => 0})
      assert PolicyContext.dedup(b) == %{{@dk, "ctx"} => @now}
      assert evaluate(d, PolicyContext.to_policy_ctx(b, "ctx"), @now + 1).verdict == :suppress
    end

    test "missing and empty mirrors start empty — and empty is not open" do
      dir = cleanup(tmpdir("pc-empty"))
      name = open(dir, "e")

      refute File.exists?(PolicyContext.file(name))
      assert PolicyContext.to_policy_ctx(name) == %{dedup: %{}, cooldowns: %{}, active: %{}}

      # Cold store, gate-2 evidence for the key that would fire: the ledger is
      # empty, so nothing is suppressed; but a gate handed unresolved evidence
      # blocks rather than dispatching (TRD lines 540-542).
      d = defn(%{"dedup_window" => 0, "cooldown" => 0, "max_concurrent" => 1})
      cold = evaluate(d, PolicyContext.to_policy_ctx(name, "ctx"), @now)
      assert cold.verdict == :activate

      unresolved =
        evaluate(d, Map.put(PolicyContext.to_policy_ctx(name), :active, :unknown), @now)

      assert unresolved.verdict == :block
      assert Enum.any?(unresolved.reasons, &(&1.code == :policy_unresolved))
    end
  end

  # ------------------------------------------------------ fail-closed chain

  describe "Policy.evaluate/3 over a real store" do
    test "gate 2 suppresses a replayed duplicate" do
      name = store(fire: [{@dk, @now}])
      d = defn(%{"dedup_window" => 60_000, "cooldown" => 0})
      decision = evaluate(d, PolicyContext.to_policy_ctx(name, "ctx"), @now + 1)
      assert decision.verdict == :suppress
      assert Enum.any?(decision.reasons, &(&1.code == :duplicate_suppressed))
    end

    test "gate 3 suppresses inside the replayed cooldown" do
      name = store(complete: [{1, @now}])
      d = defn(%{"dedup_window" => 0, "cooldown" => 60_000})
      decision = evaluate(d, PolicyContext.to_policy_ctx(name, "ctx"), @now + 1)
      assert decision.verdict == :suppress
      assert hd(decision.reasons).gate == :cooldown
    end

    test "gate 4 defers at the per-behavior ceiling" do
      name = store(activate: [2])
      d = defn(%{"dedup_window" => 0, "cooldown" => 0, "max_concurrent" => 2})
      decision = evaluate(d, PolicyContext.to_policy_ctx(name, "ctx"), @now)
      assert decision.verdict == :defer
      assert hd(decision.reasons).code == :limit_reached
    end

    test "gate 4 is per behavior: another behavior's activations do not consume this ceiling" do
      name = store()
      times(name, "other", 5, &PolicyContext.activate/2)
      d = defn(%{"dedup_window" => 0, "cooldown" => 0, "max_concurrent" => 1})
      assert evaluate(d, PolicyContext.to_policy_ctx(name, "ctx"), @now).verdict == :activate
      assert PolicyContext.running(name, "other") == 5
    end

    test "a completed activation frees the slot" do
      name = store(activate: [1])
      d = defn(%{"dedup_window" => 0, "cooldown" => 0, "max_concurrent" => 1})
      assert evaluate(d, PolicyContext.to_policy_ctx(name, "ctx"), @now).verdict == :defer
      PolicyContext.complete(name, "ctx", @now)
      assert evaluate(d, PolicyContext.to_policy_ctx(name, "ctx"), @now).verdict == :activate
    end

    test "unresolved concurrency evidence blocks — the store never defaults open" do
      name = store(activate: [1])
      d = defn(%{"dedup_window" => 0, "cooldown" => 0, "max_concurrent" => 1})
      # Deliberately hand gate 4 the raw per-behavior table, the way a caller
      # that never resolved the behavior would.
      decision = evaluate(d, Map.delete(PolicyContext.to_policy_ctx(name), :children), @now)
      assert decision.verdict == :block
      assert Enum.any?(decision.reasons, &(&1.code == :policy_unresolved))
    end

    test "a missing cooldown table blocks instead of assuming no cooldown" do
      d = defn(%{"dedup_window" => 0, "cooldown" => 60_000})
      ctx = PolicyContext.to_policy_ctx(store()) |> Map.delete(:cooldowns)
      assert evaluate(d, ctx, @now).verdict == :block
    end
  end

  describe "gates/0 coverage" do
    test "every live gate has a field in this store's snapshot" do
      assert Policy.gates() == [
               :enabled,
               :dedup,
               :cooldown,
               :concurrency,
               :recursion,
               :budget,
               :constitution
             ]

      ctx = PolicyContext.to_policy_ctx(store())
      assert MapSet.new(Map.keys(ctx)) == MapSet.new([:dedup, :cooldowns, :active])
    end
  end

  defp cwd_state, do: System.get_env("ENSEMBLE_STATE_DIR") || ".ensemble/state"
end
