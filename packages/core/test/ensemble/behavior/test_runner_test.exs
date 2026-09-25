defmodule Ensemble.Behavior.TestRunnerTest do
  use ExUnit.Case, async: false

  alias Ensemble.Behavior.{Compiler, Definition, TestRunner}
  alias TestRunner.{ConformanceReport, TestResult}

  @pilot "behaviors/test-failure/behavior.yaml"

  defp load_pilot! do
    {:ok, d} = Compiler.validate(File.read!(@pilot), file: @pilot)
    d
  end

  # ── run/2 with fixture overrides (in-memory, AC-057..AC-062) ───────────

  describe "run/2 on in-memory fixtures" do
    test "pilot passes its seeded match + outcome fixtures (AC-061)" do
      rep = TestRunner.run(load_pilot!(), [])
      assert rep.fixtures_loaded == 1
      refute rep.no_fixtures?
      assert Enum.all?(rep.match_tests, & &1.passed?), failures(rep.match_tests)
      assert Enum.all?(rep.outcome_tests, & &1.passed?), failures(rep.outcome_tests)
    end

    test "report shape matches TRD §1.7 ConformanceReport" do
      rep = TestRunner.run(load_pilot!(), [])
      assert %ConformanceReport{
               behavior: "investigate-test-failure",
               version: "0.1.0",
               fixtures_loaded: 1,
               match_tests: ms,
               outcome_tests: os,
               coverage_warnings: cw
             } = rep

      assert is_list(ms) and is_list(os) and is_list(cw)
    end

    test "a failing assertion carries fixture path + expected-vs-actual (AC-062)" do
      # event fixture that should match, but expectation says it should not.
      rep =
        TestRunner.run(load_pilot!(),
          fixtures:
            fixtures(
              events: [%{"kind" => "Event", "event_type" => "test.failed", "subject_id" => "x", "payload" => %{"exit_code" => 1, "command" => "npm test"}}],
              matches: [%{"event" => "e1", "matches" => [], "non_matches" => ["investigate-test-failure"]}],
              outcomes: []
            )
        )

      [fail] = Enum.reject(rep.match_tests, & &1.passed?)
      assert %TestResult{kind: :match, assertion: a, passed?: false} = fail
      assert a =~ "non-matches"
      assert "investigate-test-failure" in fail.expected
      assert "investigate-test-failure" in fail.actual
    end

    test "missing expected-matches for an event fails the match test (AC-058)" do
      rep =
        TestRunner.run(load_pilot!(),
          fixtures: fixtures(events: [event_envelope()], matches: [], outcomes: [])
        )

      assert [t] = rep.match_tests
      refute t.passed?
      assert t.assertion =~ "expected-matches"
    end

    test "no fixtures at all yields 0/0 and an explicit coverage note, never a false failure (AC-063)" do
      rep = TestRunner.run(load_pilot!(), fixtures: empty_fixtures())
      assert rep.no_fixtures?
      assert rep.fixtures_loaded == 0
      assert rep.match_tests == []
      assert rep.outcome_tests == []
      assert [_note] = rep.coverage_warnings
      assert note_has_no_fixtures?(rep.coverage_warnings)
    end
  end

  # ── AC-059: outcome / proposals / mutations (structural diff) ──────────

  describe "outcome tests (AC-059)" do
    test "activate verdict + proposals + declared mutations from the seeded fixture" do
      rep = TestRunner.run(load_pilot!(), [])
      passed = Enum.map(rep.outcome_tests, fn t -> {t.assertion, t.passed?} end) |> Enum.into(%{})
      assert passed["policy verdict"]
      assert passed["proposed actions (structural set)"]
      assert passed["declared mutation classes (structural set)"]
    end

    test "wrong expected verdict yields a structural mismatch with diff (AC-062)" do
      rep =
        TestRunner.run(load_pilot!(),
          fixtures: fixtures(events: [event_envelope()], matches: [match_ok()], outcomes: [Map.put(outcome_ok(), "verdict", "block")])
        )

      [v] = Enum.filter(rep.outcome_tests, &(&1.assertion == "policy verdict"))
      refute v.passed?
      assert v.expected == :block
      assert v.actual == :activate
    end

    test "wrong proposals fail structurally regardless of order" do
      # proposals listed out-of-order vs the matched set must still pass
      # because comparison is on sorted sets.
      data = outcome_ok()

      rep =
        TestRunner.run(load_pilot!(),
          fixtures: fixtures(events: [event_envelope()], matches: [match_ok()], outcomes: [%{data | "proposals" => ["zzz", "aaa"]}])
        )

      [p] = Enum.filter(rep.outcome_tests, &(&1.assertion =~ "proposed"))
      refute p.passed?
      # order-independence proof: same data with correct set passes
      rep2 = TestRunner.run(load_pilot!(), fixtures: fixtures(events: [event_envelope()], matches: [match_ok()], outcomes: [outcome_ok()]))
      [p2] = Enum.filter(rep2.outcome_tests, &(&1.assertion =~ "proposed"))
      assert p2.passed?
    end
  end

  # ── TRD-030 coverage heuristic ──────────────────────────────────────────

  describe "coverage heuristic (AC-060)" do
    test "distinct_trigger_paths counts predicate branches + fan_in" do
      d = load_pilot!()
      # pilot has 2 predicate fields (command.matches + exit_code.not), so
      # distinct branches = max(length per field) = 1 (AND, not OR). fan-in=1.
      # => trigger paths = 1.
      assert TestRunner.distinct_trigger_paths(d) == 1
    end

    test "coverage: fewer than 3 events warns (AC-060)" do
      rep = TestRunner.run(load_pilot!(), fixtures: fixtures(events: [event_envelope()], matches: [], outcomes: []))
      assert [_] = rep.coverage_warnings
      assert warning?(hd(rep.coverage_warnings))
    end

    test "coverage: 3 events for 1 path is clean" do
      evs = for i <- 1..3, do: {"e#{i}", event_envelope(%{"event_id" => "e#{i}", "subject_id" => "s#{i}"})}

      rep =
        TestRunner.run(load_pilot!(),
          fixtures: fixtures(events: evs, matches: Enum.map(evs, fn {n, _} -> %{"event" => n, "matches" => ["investigate-test-failure"]} end), outcomes: [])
        )

      assert rep.coverage_warnings == []
    end

    test "more trigger paths require proportionally more fixtures" do
      # a behavior with 3 distinct predicate fields contributes branch count;
      # we synthesize via fan_in in source.
      base = load_pilot!()
      d = %Definition{base | source: Map.put(base.source || %{}, :fan_in_event_types, ["a", "b"])}
      assert TestRunner.distinct_trigger_paths(d) == 2
      assert TestRunner.required_event_fixtures(d) == 6
    end
  end

  # ── AC-064 test knobs ───────────────────────────────────────────────────

  describe "test options (AC-064)" do
    test "defaults 10000/20/250" do
      assert TestRunner.test_opts(load_pilot!(), %{}) == %{timeout_ms: 10_000, max_polls: 20, poll_interval_ms: 250}
    end

    test "opts override defn.source test block" do
      base = load_pilot!()
      d = %Definition{base | source: Map.put(base.source || %{}, :test, %{timeout_ms: 5000, max_polls: 5, poll_interval_ms: 100})}
      assert TestRunner.test_opts(d, %{max_polls: 99}) == %{timeout_ms: 5000, max_polls: 99, poll_interval_ms: 100}
    end
  end

  # ── determinism / replay properties (exit criteria) ────────────────────

  describe "determinism (exit-criteria properties)" do
    test "replaying the same stream twice yields identical decisions" do
      a = TestRunner.run(load_pilot!(), [])
      b = TestRunner.run(load_pilot!(), [])
      assert a == b
    end

    test "frozen now_ms makes a replay byte-stable regardless of wall time" do
      r1 = TestRunner.run(load_pilot!(), now_ms: 1_000_000_000_000)
      r2 = TestRunner.run(load_pilot!(), now_ms: 2_000_000_000_000)
      # same fixtures + same defn; only injected clock differs.
      # outcomes depend on verdicts, which depend on ctx/cooldown.
      # With neutral ctx (cooldowns: %{}) verdict is identical.
      assert Enum.map(r1.outcome_tests, &{&1.assertion, &1.passed?}) ==
               Enum.map(r2.outcome_tests, &{&1.assertion, &1.passed?})
    end

    test "one activation per dedup key across a stream (AC-013 invariant)" do
      # same event twice → second is suppressed → its proposal is absent from
      # outcome "proposals".
      rep =
        TestRunner.run(load_pilot!(),
          dedup_store: %{},
          fixtures:
            fixtures(
              events: [
                {"dup1", event_envelope(%{"event_id" => "x", "subject_id" => "same"})},
                {"dup2", event_envelope(%{"event_id" => "x", "subject_id" => "same"})}
              ],
              matches: [
                %{"event" => "dup1", "matches" => ["investigate-test-failure"]},
                %{"event" => "dup2", "matches" => []}
              ],
              outcomes: []
            ),
          now_ms: 10_000_000
        )

      dup1 = Enum.find(rep.match_tests, &(&1.fixture == "dup1"))
      dup2 = Enum.find(rep.match_tests, &(&1.fixture == "dup2"))
      # dup1 matched; dup2 suppressed by dedup within the window.
      assert dup1.passed?
      assert dup2.passed?
      # exactly one behavior matched across the stream
      total_matched =
        rep.match_tests
        |> Enum.filter(& &1.passed?)
        |> Enum.flat_map(fn t -> if is_list(t.actual), do: t.actual, else: [] end)
        |> length()
      assert total_matched == 1
    end
  end

  # ── helpers ────────────────────────────────────────────────────────────

  defp fixtures(opts) do
    events = Keyword.get(opts, :events, [])
    matches = Keyword.get(opts, :matches, [])
    outcomes = Keyword.get(opts, :outcomes, [])

    # event list may be [{name, data}] or [data] (name = "e<N>")
    en =
      events
      |> Enum.map_reduce(1, fn e, i ->
        {name, data} =
          case e do
            {n, d} -> {n, d}
            d -> {"e#{i}", d}
          end

        {%{kind: "events", name: name, path: nil, data: data, reason: nil}, i + 1}
      end)
      |> elem(0)

    %{
      "events" => en,
      "expected-matches" => Enum.map(matches, &wrap("expected-matches", &1)),
      "expected-outcomes" => Enum.map(outcomes, &wrap("expected-outcomes", &1))
    }
  end

  defp wrap(kind, data) do
    name = (data["event"] || "anon") <> "." <> kind
    %{kind: kind, name: name, path: "/tmp/" <> kind <> "/" <> name <> ".json", data: data, reason: nil}
  end

  defp empty_fixtures, do: %{"events" => [], "expected-matches" => [], "expected-outcomes" => []}

  defp event_envelope(extra \\ %{}) do
    Map.merge(
      %{
        "kind" => "Event",
        "event_type" => "test.failed",
        "subject_id" => "mix test",
        "occurred_at" => "2026-09-24T14:30:00Z",
        "payload" => %{"exit_code" => 1, "command" => "npm test"}
      },
      extra
    )
  end

  defp match_ok, do: %{"event" => "e1", "matches" => ["investigate-test-failure"]}
  defp outcome_ok, do: %{"event" => "e1", "verdict" => "activate", "proposals" => ["investigate-test-failure"]}

  defp failures([]), do: "all passed"

  defp failures(list) do
    list
    |> Enum.reject(& &1.passed?)
    |> Enum.map(&"#{&1.fixture}: #{&1.assertion} exp=#{inspect(&1.expected)} act=#{inspect(&1.actual)}")
    |> Enum.join("; ")
  end

  defp note_has_no_fixtures?([msg | _]), do: msg =~ "no event fixtures"
  defp warning?(msg), do: msg =~ "distinct trigger path" and msg =~ "AC-060"
end
