defmodule Ensemble.Behavior.PolicyTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.{Compiler, Event, Matcher, Policy, PolicyDecision, PolicySpec}

  @now 1_000_000

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "p", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "github.push"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  defp defn(policy \\ %{}) do
    {:ok, d} = Compiler.validate(deep_merge(@base, %{"policy" => policy}))
    d
  end

  defp with_policy(%{policy: p} = d, overrides), do: %{d | policy: struct(p, overrides)}

  defp deep_merge(left, right) do
    Map.merge(left, right, fn _k, l, r ->
      if is_map(l) and is_map(r), do: deep_merge(l, r), else: r
    end)
  end

  defp event(overrides \\ %{}) do
    struct(Event, Map.merge(%{event_id: "e-1", event_type: "github.push", dedup_key: "dk-1", depth: 0}, overrides))
  end

  # A fully resolved context: every live gate has evidence.
  defp ctx(overrides \\ %{}) do
    Map.merge(
      %{enabled: true, dedup: %{}, cooldowns: %{}, active: 0, children: 0},
      overrides
    )
  end

  defp run(d, e, c, opts \\ %{}) do
    Policy.evaluate(d, e, Map.merge(%{ctx: c, now_ms: @now}, opts))
  end

  describe "evaluate/3" do
    test "all gates resolved and passing => :activate with no reasons" do
      assert %PolicyDecision{verdict: :activate, reasons: []} = run(defn(), event(), ctx())
    end

    test "returns the PolicyDecision struct, not a tuple" do
      assert %PolicyDecision{} = run(defn(), event(), ctx())
    end

    test "empty context fails closed, never defaults open (TRD-021)" do
      assert %PolicyDecision{verdict: :block, reasons: reasons} =
               Policy.evaluate(defn(), event(), %{ctx: %{}, now_ms: @now})

      assert Enum.map(reasons, & &1.gate) == [:dedup, :concurrency, :recursion]
      assert Enum.all?(reasons, &(&1.code == :policy_unresolved))
    end

    test "same inputs produce the same decision (determinism)" do
      d = defn()
      e = event()
      assert run(d, e, ctx()) == run(d, e, ctx())
    end

    test "raises when the context is not a map" do
      assert_raise ArgumentError, ~r/must be a map/, fn ->
        Policy.evaluate(defn(), event(), %{ctx: :nope, now_ms: @now})
      end
    end

    test "raises when opts are not a map" do
      assert_raise ArgumentError, ~r/opts must be a map/, fn ->
        Policy.evaluate(defn(), event(), :nope)
      end
    end

    test "policy_context is accepted as an alias for ctx" do
      assert %PolicyDecision{verdict: :activate} =
               Policy.evaluate(defn(), event(), %{policy_context: ctx(), now_ms: @now})
    end

    test "reasons are maps with gate, code and detail" do
      assert %PolicyDecision{reasons: [%{gate: g, code: c, detail: d}]} =
               run(defn(), event(), Map.delete(ctx(), :active))

      assert is_atom(g) and is_atom(c) and is_binary(d)
    end
  end

  describe "gate 1 — enabled" do
    test "false blocks with :disabled" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :enabled, code: :disabled}]} =
               run(defn(), event(), ctx(%{enabled: false}))
    end

    test "nil blocks fail-closed rather than reading as unset" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :enabled, code: :disabled}]} =
               run(defn(), event(), ctx(%{enabled: nil}))
    end

    test ":unknown blocks as unresolved evidence" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :enabled, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{enabled: :unknown}))
    end

    test "a non-boolean, non-nil, non-:unknown value is unresolved" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :enabled, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{enabled: "yes"}))
    end

    test "absent key is not a failure — registry owns enable/disable" do
      assert %PolicyDecision{verdict: :activate} =
               run(defn(), event(), Map.delete(ctx(), :enabled))
    end

    test "gate order: disabled wins over a concurrency stop" do
      assert %PolicyDecision{reasons: [%{gate: :enabled} | _]} =
               run(defn(%{"max_concurrent" => 1}), event(), ctx(%{enabled: false, active: 5}))
    end
  end

  describe "gate 2 — dedup" do
    test "a fire inside dedup_window suppresses" do
      d = defn(%{"dedup_window" => "10m"})
      store = Matcher.record_fire(%{}, event(), d, @now - 60_000)

      assert %PolicyDecision{verdict: :suppress, reasons: [%{gate: :dedup, code: :duplicate_suppressed}]} =
               run(d, event(), ctx(%{dedup: store}))
    end

    test "a fire outside dedup_window passes" do
      d = defn(%{"dedup_window" => "10m"})
      store = Matcher.record_fire(%{}, event(), d, @now - 700_000)

      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx(%{dedup: store}))
    end

    test "dedup_window 0 disables the gate entirely" do
      d = defn(%{"dedup_window" => 0})
      store = Matcher.record_fire(%{}, event(), d, @now)
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx(%{dedup: store}))
    end

    test "agrees with Matcher.propose on what a duplicate is" do
      d = defn(%{"dedup_window" => "1h"})
      store = Matcher.record_fire(%{}, event(), d, @now - 1_000)

      assert [%{status: :suppressed}] =
               Matcher.propose(event(), [d], %{now_ms: @now, dedup_store: store, audit: :none})

      assert %PolicyDecision{verdict: :suppress} = run(d, event(), ctx(%{dedup: store}))
    end

    test "a non-map store is unresolved, not empty" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :dedup, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{dedup: :ets_table}))
    end

    test "an absent store is unresolved: the ledger must be read, not assumed" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :dedup, code: :policy_unresolved}]} =
               run(defn(), event(), Map.delete(ctx(), :dedup))
    end
  end

  describe "gate 3 — cooldown" do
    test "last fire inside cooldown suppresses with remaining time" do
      d = defn(%{"cooldown" => "5m"})

      assert %PolicyDecision{verdict: :suppress, reasons: [%{gate: :cooldown, code: :cooldown_active} = r]} =
               run(d, event(), ctx(%{cooldowns: %{"p" => @now - 60_000}}))

      assert r.detail =~ "240000ms of 300000ms"
    end

    test "elapsed cooldown passes" do
      d = defn(%{"cooldown" => "5m"})
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx(%{cooldowns: %{"p" => @now - 400_000}}))
    end

    test "never-fired (nil entry) passes" do
      d = defn(%{"cooldown" => "5m"})
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx(%{cooldowns: %{"p" => nil}}))
    end

    test "cooldowns are scoped per behavior name" do
      d = defn(%{"cooldown" => "5m"})
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx(%{cooldowns: %{"other" => @now}}))
    end

    test "cooldown 0 skips the gate without needing the table" do
      assert %PolicyDecision{reasons: r} =
               Policy.evaluate(defn(%{"cooldown" => 0}), event(), %{ctx: %{}, now_ms: @now})

      refute Enum.any?(r, &(&1.gate == :cooldown))
    end

    test "a garbage cooldown entry is unresolved" do
      d = defn(%{"cooldown" => "5m"})

      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :cooldown, code: :policy_unresolved}]} =
               run(d, event(), ctx(%{cooldowns: %{"p" => "yesterday"}}))
    end

    test "a non-map cooldown table is unresolved" do
      d = defn(%{"cooldown" => "5m"})

      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :cooldown, code: :policy_unresolved}]} =
               run(d, event(), ctx(%{cooldowns: :unknown}))
    end

    test "an absent cooldown table is unresolved" do
      d = defn(%{"cooldown" => "5m"})

      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :cooldown, code: :policy_unresolved}]} =
               run(d, event(), Map.delete(ctx(), :cooldowns))
    end
  end

  describe "gate 4 — concurrency" do
    test "running count at the ceiling defers (queue, not drop)" do
      assert %PolicyDecision{verdict: :defer, reasons: [%{gate: :concurrency, code: :limit_reached}]} =
               run(defn(%{"max_concurrent" => 2}), event(), ctx(%{active: 2}))
    end

    test "below the ceiling passes" do
      assert %PolicyDecision{verdict: :activate} =
               run(defn(%{"max_concurrent" => 2}), event(), ctx(%{active: 1}))
    end

    test "a negative count is unresolved evidence" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :concurrency, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{active: -1}))
    end

    test "a non-integer count is unresolved evidence" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :concurrency, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{active: :unknown}))
    end
  end

  describe "gate 5 — recursion" do
    test "depth that would exceed max_causal_depth blocks" do
      d = defn(%{"max_causal_depth" => 2})

      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :recursion, code: :depth_exceeded}]} =
               run(d, event(%{depth: 2}), ctx())
    end

    test "ctx causal_depth overrides the event envelope" do
      d = defn(%{"max_causal_depth" => 2})
      assert %PolicyDecision{verdict: :block} = run(d, event(%{depth: 0}), ctx(%{causal_depth: 4}))
    end

    test "children at max_children blocks on fan-out" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :recursion, code: :fan_out_exceeded}]} =
               run(defn(%{"max_children" => 3}), event(), ctx(%{children: 3}))
    end

    test "max_children 0 blocks spawn-capable behavior" do
      assert %PolicyDecision{reasons: r} = run(defn(%{"max_children" => 0}), event(), ctx())
      assert Enum.any?(r, &(&1.code == :fan_out_exceeded))
    end

    test "both halves report when both are blown" do
      d = defn(%{"max_causal_depth" => 1, "max_children" => 2})

      assert %PolicyDecision{reasons: [%{code: :depth_exceeded}, %{code: :fan_out_exceeded}]} =
               run(d, event(%{depth: 5}), ctx(%{children: 5}))
    end

    test "any spawn-capable behavior needs its child counter resolved" do
      for max <- [1, 3] do
        assert %PolicyDecision{verdict: :block, reasons: [%{gate: :recursion, code: :policy_unresolved}]} =
                 Policy.evaluate(defn(%{"max_children" => max}), event(), %{
                   ctx: Map.delete(ctx(), :children),
                   now_ms: @now
                 })
      end
    end

    test "nil children count blocks" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :recursion, code: :policy_unresolved}]} =
               run(defn(%{"max_children" => 3}), event(), ctx(%{children: nil}))
    end

    test "a non-numeric depth ceiling is unresolved" do
      d = with_policy(defn(%{"max_children" => 3}), %{max_causal_depth: :deep})
      assert %PolicyDecision{reasons: [%{gate: :recursion, code: :policy_unresolved}]} = run(d, event(), ctx())
    end

    test "a non-numeric max_children is unresolved" do
      d = with_policy(defn(), %{max_children: :many})
      assert %PolicyDecision{reasons: [%{gate: :recursion, code: :policy_unresolved}]} = run(d, event(), ctx())
    end

    test "a non-numeric ctx depth is unresolved" do
      d = defn(%{"max_children" => 3})
      assert %PolicyDecision{reasons: [%{gate: :recursion, code: :policy_unresolved}]} = run(d, event(), ctx(%{causal_depth: "0"}))
    end
  end

  describe "gate 6 — budget" do
    test "absent budget is inert: PolicySpec has no budget field (Phase 4 TRD-031)" do
      assert %PolicyDecision{verdict: :activate, reasons: []} = run(defn(), event(), ctx())
    end

    test "token exhaustion suppresses" do
      c = ctx(%{budget: %{limit: %{tokens: 100}, used: %{tokens: 100}}})

      assert %PolicyDecision{verdict: :suppress, reasons: [%{gate: :budget, code: :token_budget_exhausted}]} =
               run(defn(), event(), c)
    end

    test "wall-clock exhaustion suppresses" do
      c = ctx(%{budget: %{limit: %{wall_clock_ms: 1_000}, used: %{wall_clock_ms: 1_500}}})
      assert %PolicyDecision{verdict: :suppress, reasons: [%{code: :wall_clock_exhausted}]} = run(defn(), event(), c)
    end

    test "wall-clock falls back to policy.timeout when no limit axis is given" do
      d = defn(%{"timeout" => "30s"})

      assert %PolicyDecision{reasons: [%{code: :wall_clock_exhausted}]} =
               run(d, event(), ctx(%{budget: %{used: %{wall_clock_ms: 40_000}}}))
    end

    test "an axis-free limit does not invent a stop" do
      assert %PolicyDecision{verdict: :activate} =
               run(defn(), event(), ctx(%{budget: %{limit: %{}, used: %{}}}))
    end

    test "a non-map budget is unresolved" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :budget, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{budget: :unknown}))
    end

    test "a non-map limit inside the ledger is unresolved" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :budget, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{budget: %{limit: 5}}))
    end

    test "a non-map used inside the ledger is unresolved" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :budget, code: :policy_unresolved}]} =
               run(defn(), event(), ctx(%{budget: %{limit: %{tokens: 10}, used: :unknown}}))
    end

    test "used with no limit reads as spent against the flat map" do
      assert %PolicyDecision{verdict: :activate} =
               run(defn(), event(), ctx(%{budget: %{tokens: 1_000_000}}))
    end

    test "flat wall-clock charges against policy.timeout" do
      d = defn(%{"timeout" => "10s"})

      assert %PolicyDecision{reasons: [%{gate: :budget, code: :wall_clock_exhausted}]} =
               run(d, event(), ctx(%{budget: %{wall_clock_ms: 12_000}}))
    end
  end

  describe "gate 7 — constitution" do
    test ":allow is the only passing override" do
      assert %PolicyDecision{verdict: :activate} =
               run(defn(), event(), ctx(), %{constitution_verdict: :allow})
    end

    test ":pending requires approval" do
      assert %PolicyDecision{
               verdict: :require_approval,
               reasons: [%{gate: :constitution, code: :approval_required}]
             } = run(defn(), event(), ctx(), %{constitution_verdict: :pending})
    end

    test ":deny blocks" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :constitution, code: :constitution_denied}]} =
               run(defn(), event(), ctx(), %{constitution_verdict: :deny})
    end

    test "an unrecognized verdict is unresolved" do
      assert %PolicyDecision{verdict: :block, reasons: [%{code: :policy_unresolved}]} =
               run(defn(), event(), ctx(), %{constitution_verdict: "allow"})
    end

    test "a rule requiring approval with no state defaults to needing approval" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :require_approval} = run(d, event(), ctx())
    end

    test "ctx pending_approval true requires approval" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :require_approval} = run(d, event(), ctx(%{pending_approval: true}))
    end

    test "ctx pending_approval false satisfies the rule" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx(%{pending_approval: false}))
    end

    test "opts approval_state is consulted when ctx has none" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx(), %{approval_state: :granted})
    end

    test ":pending approval state requires approval" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :require_approval} = run(d, event(), ctx(%{approval_state: :pending}))
    end

    test ":denied approval state blocks" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :block} = run(d, event(), ctx(%{approval_state: :denied}))
    end

    test ":required approval state requires approval" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :require_approval} = run(d, event(), ctx(%{approval_state: :required}))
    end

    test "a garbage approval state is unresolved" do
      d = %{defn() | constitution_rules: [%{id: "R1", approval_required: true, approvers: []}]}
      assert %PolicyDecision{verdict: :block} = run(d, event(), ctx(%{approval_state: "approved"}))
    end

    test "rules that need no approval pass silently" do
      d = %{defn() | constitution_rules: [%{id: "R2", approval_required: false, approvers: []}]}
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx())
    end

    test "string-keyed rules are handled too" do
      d = %{defn() | constitution_rules: [%{"id" => "R1", "approval_required" => true}]}
      assert %PolicyDecision{verdict: :require_approval} = run(d, event(), ctx())
    end

    test "a rule with no approval_required key needs nothing" do
      d = %{defn() | constitution_rules: [%{id: "R3"}]}
      assert %PolicyDecision{verdict: :activate} = run(d, event(), ctx())
    end

    test "constitution is last: an earlier stop is the head reason" do
      assert %PolicyDecision{reasons: [%{gate: :enabled}, %{gate: :constitution}]} =
               run(defn(), event(), ctx(%{enabled: false}), %{constitution_verdict: :pending})
    end
  end

  describe "gates/0" do
    test "declares the TRD gate order" do
      assert Policy.gates() == [
               :enabled,
               :dedup,
               :cooldown,
               :concurrency,
               :recursion,
               :budget,
               :constitution
             ]
    end
  end

  describe "event shapes" do
    test "a map event is accepted alongside the struct" do
      assert %PolicyDecision{verdict: :activate} =
               run(defn(), %{event_id: "m-1", event_type: "github.push", causal_depth: 0}, ctx())
    end

    test "a string-keyed map event is accepted" do
      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :recursion, code: :depth_exceeded}]} =
               run(defn(%{"max_causal_depth" => 1}),
                 %{"event_id" => "s-1", "event_type" => "github.push", "causal_depth" => 5}, ctx())
    end

    test "an event with no depth reads as root" do
      assert %PolicyDecision{verdict: :activate} = run(defn(), %{event_type: "github.push"}, ctx())
    end
  end

  describe "purity" do
    test "writes no files when now_ms is injected" do
      dir = File.cwd!()
      probe = Path.join(dir, ".ensemble")
      before_ls = if File.dir?(probe), do: File.ls!(probe), else: nil

      assert %PolicyDecision{} = run(defn(), event(), ctx())

      assert before_ls == (if File.dir?(probe), do: File.ls!(probe), else: nil)
    end

    test "the injected clock is the only time source" do
      d = defn(%{"cooldown" => "5m"})
      c = ctx(%{cooldowns: %{"p" => 0}})

      assert %PolicyDecision{verdict: :suppress} = Policy.evaluate(d, event(), %{ctx: c, now_ms: 1_000})
      assert %PolicyDecision{verdict: :activate} = Policy.evaluate(d, event(), %{ctx: c, now_ms: 10**12})
    end

    test "replay of the same stream yields identical decisions (idempotency)" do
      d = defn(%{"dedup_window" => "10m"})
      events = for n <- 1..5, do: event(%{event_id: "e#{n}", dedup_key: "same"})

      decide = fn ->
        {_, verdicts} =
          Enum.reduce(events, {%{}, []}, fn e, {store, acc} ->
            case run(d, e, ctx(%{dedup: store})) do
              %PolicyDecision{verdict: :activate} ->
                {Matcher.record_fire(store, e, d, @now), [:activate | acc]}

              %PolicyDecision{verdict: v} ->
                {store, [v | acc]}
            end
          end)

        Enum.reverse(verdicts)
      end

      assert [:activate, :suppress, :suppress, :suppress, :suppress] = decide.()
      assert decide.() == decide.()
    end
  end

  test "PolicySpec defaults are conservative" do
    assert %PolicySpec{mode: :propose, max_concurrent: 1} = %PolicySpec{}
  end
end
