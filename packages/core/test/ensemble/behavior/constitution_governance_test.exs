defmodule Ensemble.Behavior.ConstitutionGovernanceTest do
  use ExUnit.Case, async: false

  alias Ensemble.Behavior.{Compiler, ConstitutionGovernance, ConstitutionProposal, Event, Policy, PolicyDecision}

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "gov", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "github.push"},
    "capabilities" => %{
      "tools" => ["ensemble.constitution.propose"],
      "mutation_classes" => ["constitution.propose"]
    },
    "outcomes" => ["ensemble.behavior.executed"],
    "constitution_rules" => [%{"id" => "rule:x"}]
  }

  # The global ruleset every cited id must resolve against, mirroring the
  # constitution: option Compiler.validate takes in production.
  @ruleset %{"rule:x" => %{id: "rule:x", approval_required: [], approvers: []}}

  @dk "dk-gov-1"
  @now 1_000_000

  setup do
    dir = Path.join(System.tmp_dir!(), "cg-test-#{:rand.uniform(1_000_000_000)}")
    previous = System.get_env("ENSEMBLE_STATE_DIR")
    System.put_env("ENSEMBLE_STATE_DIR", dir)
    on_exit(fn ->
      if previous, do: System.put_env("ENSEMBLE_STATE_DIR", previous), else: System.delete_env("ENSEMBLE_STATE_DIR")
      File.rm_rf!(dir)
    end)

    {:ok, dir: dir, opts: [dir: dir]}
  end

  defp deep_merge(left, right) do
    Map.merge(left, right, fn _k, l, r ->
      if is_map(l) and is_map(r), do: deep_merge(l, r), else: r
    end)
  end

  defp defn(overrides \\ %{}) do
    {:ok, d} = Compiler.validate(deep_merge(@base, overrides), constitution: @ruleset)
    d
  end

  # A definition whose constitution_rules are declared inline (rosters,
  # approval gates) rather than pulled from the global ruleset.
  defp rule(declared) do
    set =
      Enum.reduce(declared, @ruleset, fn entry, acc ->
        id = entry["id"]
        Map.put(acc, id, %{
          id: id,
          approval_required: entry["approval_required"] || [],
          approvers: entry["approvers"] || []
        })
      end)

    {:ok, compiled} =
      Compiler.validate(deep_merge(@base, %{"constitution_rules" => declared}), constitution: set)

    compiled
  end

  defp event(overrides \\ %{}) do
    struct(
      Event,
      Map.merge(%{event_id: "e-gov-1", event_type: "github.push", dedup_key: @dk, depth: 0, ts: @now}, overrides)
    )
  end

  defp ctx(overrides \\ %{}) do
    Map.merge(
      %{
        active: %{},
        policy_context: %{"dedup_key" => @dk, "last_fired_at" => 0, "runs" => %{}, "budget_used" => 0},
        now_ms: @now
      },
      overrides
    )
  end

  defp change(rule_id \\ "rule:x", extra \\ %{}) do
    Map.merge(%{"rule_id" => rule_id, "approval_required" => true}, Map.put(extra, "rule_id", rule_id))
  end

  defp mirror, do: Path.join(System.get_env("ENSEMBLE_STATE_DIR"), "proposals.jsonl")
  defp lines, do: mirror() |> File.read!() |> String.split("\n", trim: true)
  defp trusted(opts), do: Keyword.put(opts, :trust_allowlist, ["gov"])

  # ---------------------------------------------------------------- capability

  describe "capability gate (AC-069)" do
    test "a behavior holding both halves may propose", %{opts: opts} do
      assert {:ok, %ConstitutionProposal{status: :pending} = p} =
               ConstitutionGovernance.propose(defn(), "act-1", change(), opts)

      assert p.rule_id == "rule:x"
      assert p.approvers == []
      assert p.threshold == 2
      assert 1 == length(lines())
    end

    test "missing the mutation class blocks and records nothing", %{dir: dir, opts: opts} do
      d = defn(%{"capabilities" => %{"tools" => ["ensemble.constitution.propose"], "mutation_classes" => ["comment"]}})

      assert {:error, :direct_write_blocked} = ConstitutionGovernance.propose(d, "act-1", change(), opts)
      refute File.exists?(mirror())
    end

    test "missing the tool blocks and records nothing", %{dir: dir, opts: opts} do
      d = defn(%{"capabilities" => %{"tools" => [], "mutation_classes" => ["constitution.propose"]}})

      assert {:error, :direct_write_blocked} = ConstitutionGovernance.propose(d, "act-1", change(), opts)
      refute File.exists?(mirror())
    end

    test "a change citing no rule is refused", %{opts: opts} do
      assert {:error, :missing_rule_id} =
               ConstitutionGovernance.propose(defn(), "act-1", %{"approval_required" => true}, opts)
    end

    test "an unknown rule fails closed with the id cited", %{opts: opts} do
      assert {:error, {:unknown_rule, "rule:nope"}} =
               ConstitutionGovernance.propose(defn(), "act-1", change("rule:nope"), opts)
    end

    test "capability_granted?/2 reads the declaration, no ledger needed" do
      assert ConstitutionGovernance.capability_granted?(defn())
      refute ConstitutionGovernance.capability_granted?(defn(%{"capabilities" => %{"mutation_classes" => ["none"]}}))
    end

    test "direct_write?/1 separates the write from the lawful outcome" do
      for w <- ["constitution.propose", "ensemble.constitution.propose", :constitution_propose] do
        assert ConstitutionGovernance.direct_write?(w), "expected #{inspect(w)} to be a direct write"
      end

      refute ConstitutionGovernance.direct_write?(ConstitutionGovernance.proposal_outcome())
      refute ConstitutionGovernance.direct_write?("ensemble.github.pr_comment")
      refute ConstitutionGovernance.direct_write?("comment")
      refute ConstitutionGovernance.direct_write?(nil)
    end

    test "the proposal outcome is the registered one" do
      assert ConstitutionGovernance.proposal_outcome() == "constitution.change.proposed"
    end
  end

  # ------------------------------------------------------------------ rosters

  describe "roster and threshold derive from the rule (AC-066..AC-068)" do
    test "the rule's named roster becomes the proposal's roster", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["sec-a", "sec-b", "sec-c"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), trusted(opts))
      assert p.approvers == ["sec-a", "sec-b", "sec-c"]
      assert p.threshold == 2
    end

    test "a stranger cannot approve; the ledger stays untouched", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["sec-a", "sec-b"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), trusted(opts))

      assert {:error, :not_approver} = ConstitutionGovernance.approve(p, "mallory", opts)
      assert {:ok, still} = ConstitutionGovernance.fetch(nil, p.id, opts)
      assert still.status == :pending
      assert still.approvals == []
    end

    test "quorum of a named roster approves", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["a", "b", "c"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), trusted(opts))
      {:ok, p1} = ConstitutionGovernance.approve(p, "a", opts)
      assert p1.status == :pending
      {:ok, p2} = ConstitutionGovernance.approve(p1, "c", opts)
      assert p2.status == :approved
      assert p2.approvals == ["a", "c"]
    end

    test "the same actor approving twice is not a quorum", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["a", "b"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), trusted(opts))
      {:ok, p1} = ConstitutionGovernance.approve(p, "a", opts)
      assert p1.status == :pending
      {:ok, again} = ConstitutionGovernance.approve(p1, "a", opts)
      assert again.status == :pending
      assert again.approvals == ["a"]
    end

    test "threshold/3 table (AC-068)" do
      assert ConstitutionGovernance.threshold(["a"]) == 1
      assert ConstitutionGovernance.threshold(["a", "b"]) == 1
      assert ConstitutionGovernance.threshold(["a", "b", "c"]) == 2
      assert ConstitutionGovernance.threshold(["a", "b", "c", "d"]) == 2
      assert ConstitutionGovernance.threshold(["a", "b", "c", "d", "e"]) == 3
      assert ConstitutionGovernance.threshold([], ["something"]) == 2
      assert ConstitutionGovernance.threshold([], []) == 1
    end

    test "deciding twice reports not_pending", %{opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), opts)
      {:ok, r} = ConstitutionGovernance.reject(p, "anyone", opts)
      assert {:error, {:not_pending, :rejected}} = ConstitutionGovernance.approve(r, "anyone", opts)
    end

    test "a named one-person roster needs just that one approval", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["sole"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), trusted(opts))
      assert p.threshold == 1
      {:ok, done} = ConstitutionGovernance.approve(p, "sole", opts)
      assert done.status == :approved
    end
  end

  # ------------------------------------------------------------------- ledger

  describe "durable ledger" do
    test "file(nil) follows the state-dir default and explicit dirs" do
      assert ConstitutionGovernance.file(nil) == Path.join(System.get_env("ENSEMBLE_STATE_DIR"), "proposals.jsonl")
    end

    test "records are canonical JSON lines that decode back to structs", %{dir: dir, opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), opts)
      {:ok, approved} = ConstitutionGovernance.approve(p, "whoever", opts)

      decoded = :json.decode(Enum.at(lines(), 1))
      assert decoded["status"] == "approved"
      assert decoded["id"] == approved.id
      assert decoded["approvals"] == ["whoever"]

      assert {:ok, back} = ConstitutionGovernance.from_record(decoded)
      assert back == approved
    end

    test "newest row per id wins", %{dir: dir, opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), trusted(opts))
      {:ok, a1} = ConstitutionGovernance.approve(p, "x", opts)
      {:ok, a2} = ConstitutionGovernance.approve(a1, "y", opts)

      assert length(lines()) == 3
      assert {:ok, ^a2} = ConstitutionGovernance.fetch(nil, p.id, opts)
      assert [%{status: :approved}] = ConstitutionGovernance.list(nil, opts)
    end

    test "pending/2 is the operator review queue", %{opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), opts)
      {:ok, q} = ConstitutionGovernance.propose(defn(), "act-2", change(%{"n" => 2}), opts)
      {:ok, _} = ConstitutionGovernance.reject(q, "no", opts)

      assert Enum.map(ConstitutionGovernance.pending(nil, opts), & &1.id) == [p.id]
    end

    test "a GenServer ledger serves fetch and survives restart from disk", %{dir: dir} do
      name = String.to_atom("cg-ledger-#{:rand.uniform(1_000_000)}")
      {:ok, pid} = ConstitutionGovernance.start_link(name: name, dir: dir)

      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), dir: dir, ledger: name)
      assert {:ok, ^p} = ConstitutionGovernance.fetch(name, p.id)
      assert [%ConstitutionProposal{}] = ConstitutionGovernance.list(name, [])

      GenServer.stop(pid)
      {:ok, pid2} = ConstitutionGovernance.start_link(name: name, dir: dir)
      assert {:ok, fetched} = ConstitutionGovernance.fetch(name, p.id)
      assert fetched.id == p.id
      assert fetched.status == :pending
      GenServer.stop(pid2)
    end

    test "corrupt mirror lines are skipped; good rows still read", %{dir: dir, opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), opts)
      File.write!(mirror(), File.read!(mirror()) <> "}}} not json\n")

      assert [%{id: id}] = ConstitutionGovernance.list(nil, opts)
      assert id == p.id
    end

    test "an unreadable mirror fails closed on replay", %{dir: dir} do
      File.mkdir_p!(mirror())
      Process.flag(:trap_exit, true)

      assert {:error, _} = GenServer.start_link(ConstitutionGovernance, [dir: dir])
    end
  end

  # ---------------------------------------------------------------- verdicts

  describe "verdict_for/3 renders gate 7 (AC-070)" do
    test "nil proposal leaves the gate pending" do
      assert ConstitutionGovernance.verdict_for(defn(), nil) ==
               %{ctx: %{}, constitution_verdict: :pending}
    end

    test "ctx is passed through under :ctx" do
      assert ConstitutionGovernance.verdict_for(defn(), nil, %{a: 1}) ==
               %{ctx: %{a: 1}, constitution_verdict: :pending}
    end

    test "approved proposal unlocks gate 7 and Policy activates", %{opts: opts} do
      o = trusted(opts)
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), o)
      {:ok, a1} = ConstitutionGovernance.approve(p, "one", o)
      {:ok, done} = ConstitutionGovernance.approve(a1, "two", o)

      d = defn(%{"policy" => %{"mode" => "active"}})
      assert ConstitutionGovernance.verdict_for(d, done) == %{ctx: %{}, constitution_verdict: :allow}

      assert %PolicyDecision{verdict: :activate, reasons: []} =
               Policy.evaluate(d, event(), Map.merge(ctx(), ConstitutionGovernance.verdict_for(d, done)))
    end

    test "pending quorum blocks with approval_required", %{opts: opts} do
      o = trusted(opts)
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), o)
      {:ok, one} = ConstitutionGovernance.approve(p, "solo", o)
      assert one.status == :pending
      assert ConstitutionGovernance.verdict_for(defn(), one)[:constitution_verdict] == :pending

      d = defn(%{"policy" => %{"mode" => "active"}})

      assert %PolicyDecision{verdict: :require_approval, reasons: [%{gate: :constitution, code: :approval_required}]} =
               Policy.evaluate(d, event(), Map.merge(ctx(), ConstitutionGovernance.verdict_for(d, one)))
    end

    test "rejected proposal is a hard constitution denial", %{opts: opts} do
      o = trusted(opts)
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), o)
      {:ok, r} = ConstitutionGovernance.reject(p, "no", o)

      assert ConstitutionGovernance.verdict_for(defn(), r)[:constitution_verdict] == :deny

      d = defn(%{"policy" => %{"mode" => "active"}})

      assert %PolicyDecision{verdict: :block, reasons: [%{gate: :constitution, code: :constitution_denied}]} =
               Policy.evaluate(d, event(), Map.merge(ctx(), ConstitutionGovernance.verdict_for(d, r)))
    end

    test "a revised original never reads as approved", %{opts: opts} do
      o = trusted(opts)
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), o)
      {:ok, done} = ConstitutionGovernance.approve(p, "one", o)
      {:ok, two} = ConstitutionGovernance.approve(done, "two", o)
      {:ok, child} = ConstitutionGovernance.revise(two, defn(), change("rule:x", %{"n" => 1}), o)
      assert child.status == :pending

      {:ok, original} = ConstitutionGovernance.fetch(nil, two.id, opts)
      assert original.status == :revised
      assert ConstitutionGovernance.verdict_for(defn(), original)[:constitution_verdict] == :pending
    end
  end

  # ------------------------------------------------------------------ revision

  describe "revise/4 (AC-070)" do
    test "original becomes revised, child is pending and linked", %{opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), opts)
      {:ok, child} = ConstitutionGovernance.revise(p, defn(), change("rule:x", %{"cooldown" => "1h"}), opts)

      assert child.status == :pending
      assert child.parent_id == p.id
      assert child.activation_id == "act-1"

      {:ok, original} = ConstitutionGovernance.fetch(nil, p.id, opts)
      assert original.status == :revised
      assert Enum.any?(original.events, &(&1.action == "revise"))
    end

    test "revising a decided proposal is refused", %{opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), opts)
      {:ok, r} = ConstitutionGovernance.reject(p, "no", opts)
      assert {:error, {:not_pending, :rejected}} = ConstitutionGovernance.revise(r, defn(), change(), opts)
    end
  end

  # ----------------------------------------------------------- apply boundary

  describe "apply_to_ruleset/2 (AC-069/AC-071)" do
    test "only an approved proposal touches the ruleset" do
      ruleset = %{"rule:x" => %{id: "rule:x", approval_required: false, approvers: []}}
      approved = %ConstitutionProposal{id: "p", rule_id: "rule:x", status: :approved, change: change()}

      assert {:ok, applied} = ConstitutionGovernance.apply_to_ruleset(approved, ruleset)
      assert get_in(applied, ["rule:x", :approval_required]) == true
      refute Map.has_key?(applied["rule:x"], :rule_id)
    end

    test "pending, rejected, and revised proposals are refused" do
      ruleset = %{"rule:x" => %{id: "rule:x"}}

      for status <- [:pending, :rejected, :revised] do
        p = %ConstitutionProposal{id: "p", rule_id: "rule:x", status: status, change: change()}
        assert {:error, :direct_write_blocked} = ConstitutionGovernance.apply_to_ruleset(p, ruleset)
      end

      assert ruleset == %{"rule:x" => %{id: "rule:x"}}
    end

    test "approved but the rule vanished fails closed" do
      p = %ConstitutionProposal{id: "p", rule_id: "rule:gone", status: :approved, change: change("rule:gone")}
      assert {:error, {:unknown_rule, "rule:gone"}} = ConstitutionGovernance.apply_to_ruleset(p, %{})
    end
  end

  # --------------------------------------------------------------- AC-072

  describe "trust escalation (AC-072)" do
    test "an unlisted behavior is low trust" do
      assert ConstitutionGovernance.low_trust?(defn(), trust_allowlist: [])
      refute ConstitutionGovernance.low_trust?(defn(), trust_allowlist: ["gov"])
      refute ConstitutionGovernance.low_trust?(defn(), trust_allowlist: "gov, other")
      refute ConstitutionGovernance.low_trust?(defn(), trust_allowlist: ~s(["gov"]))
    end

    test "low trust raises the empty-roster threshold to three reviewers", %{opts: opts} do
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), opts)
      assert p.trust_escalated == true
      assert p.threshold == 3

      {:ok, a} = ConstitutionGovernance.approve(p, "one", opts)
      {:ok, b} = ConstitutionGovernance.approve(a, "two", opts)
      assert b.status == :pending
      {:ok, c} = ConstitutionGovernance.approve(b, "three", opts)
      assert c.status == :approved
    end

    test "a trusted behavior keeps the plain threshold", %{opts: opts} do
      o = trusted(opts)
      {:ok, p} = ConstitutionGovernance.propose(defn(), "act-1", change(), o)
      assert p.trust_escalated == false
      assert p.threshold == 2
      {:ok, a} = ConstitutionGovernance.approve(p, "one", o)
      assert a.status == :pending
      {:ok, b} = ConstitutionGovernance.approve(a, "two", o)
      assert b.status == :approved
    end

    test "escalation on a named roster tightens the quorum, never invents members", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["a", "b", "c"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), opts)
      assert p.threshold == 3

      {:ok, x} = ConstitutionGovernance.approve(p, "a", opts)
      {:ok, y} = ConstitutionGovernance.approve(x, "b", opts)
      assert y.status == :pending
      {:ok, z} = ConstitutionGovernance.approve(y, "c", opts)
      assert z.status == :approved
    end

    test "escalation is capped at the roster size so quorum stays reachable", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["a", "b"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), opts)
      assert p.threshold == 2

      {:ok, a} = ConstitutionGovernance.approve(p, "a", opts)
      assert a.status == :pending
      {:ok, b} = ConstitutionGovernance.approve(a, "b", opts)
      assert b.status == :approved
    end

    test "an escalated proposal with a full named-roster approval satisfies gate 7", %{opts: opts} do
      d = rule([%{"id" => "rule:x", "approvers" => ["a", "b"]}])
      {:ok, p} = ConstitutionGovernance.propose(d, "act-1", change(), opts)
      {:ok, a} = ConstitutionGovernance.approve(p, "a", opts)
      {:ok, b} = ConstitutionGovernance.approve(a, "b", opts)
      assert b.status == :approved
      assert ConstitutionGovernance.verdict_for(d, b)[:constitution_verdict] == :allow

      partial = %{p | approvals: ["a"]}
      assert ConstitutionGovernance.verdict_for(d, partial)[:constitution_verdict] == :pending
    end
  end
end
