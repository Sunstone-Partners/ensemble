defmodule Ensemble.Behavior.TestRunner do
  @moduledoc """
  Deterministic conformance runner for behavior packages (TRD §1.7,
  TRD-029/TRD-030, AC-058..AC-064).

      TestRunner.run(defn, opts) #=> %ConformanceReport{...}

  For every event fixture the runner normalizes it through the production
  adapter path (`FixtureLoader` → `Events.normalize/2`, AC-057), runs the
  full matcher (`Matcher.propose/3`), and compares the resulting candidate
  set against the fixture's `expected-matches` file (AC-058). Outcome tests
  additionally evaluate `Policy` on each matched candidate with a **frozen
  clock** and a neutral, fully-resolved policy context, and compare the
  resulting verdict/proposal/mutation set against `expected-outcomes`
  (AC-059).

  ## No real dispatch

  Outcome evaluation stops at the decision boundary. Proposals are the
  match+policy verdicts; **mutations** are the *declared* mutation classes of
  behaviors whose expected outcome declares a `test.*` mutation, computed
  against an empty executor. Nothing is invoked: no agents, no workflows, no
  constitution writes. Expected proposals/mutations are diffed
  **structurally** (sorted sets), so ordering differences never fabricate or
  mask a mismatch.

  ## Determinism

  Ordering is fixed (fixtures sorted by `{kind, name}`; assertions by
  `{fixture, assertion}`); `audit: :none` keeps the run file-write-free; the
  clock is frozen (`now_ms` / `test_mode.now`). A replayed stream therefore
  yields *identical decisions* — the property the exit-criteria tests assert.
  `:dedup_store` is threaded across events so the "one activation per dedup
  key" invariant holds.

  ## Coverage heuristic (TRD-030 / AC-060)

  A behavior's *distinct trigger paths* are the number of predicate
  disjunction branches plus its `event_type` fan-in (`distinct_trigger_paths/1`).
  Coverage is a `count(events) >= 3 * paths` floor; shortfalls produce
  `coverage_warnings` entries (surfaced in the report and by
  `Compiler.validate_coverage/2` as a WARN DiscoveryIssue). Zero fixtures is
  an explicit 0/0 "no fixtures" note, never a false failure (AC-063).
  """

  alias Ensemble.Behavior.{Definition, FixtureLoader, Matcher, Policy}

  defmodule TestResult do
    @moduledoc "One fixture assertion: pass/fail with an expected-vs-actual diff (AC-062)."
    defstruct [:kind, :fixture, :assertion, :path, :passed?, :expected, :actual]

    @type kind :: :match | :outcome
    @type t :: %__MODULE__{
            kind: kind(),
            fixture: String.t(),
            assertion: String.t(),
            path: String.t() | nil,
            passed?: boolean(),
            expected: term(),
            actual: term()
          }
  end

  defmodule ConformanceReport do
    @moduledoc "Aggregated conformance result for a single behavior (TRD §1.7)."
    defstruct behavior: nil,
              version: nil,
              fixtures_loaded: 0,
              match_tests: [],
              outcome_tests: [],
              coverage_warnings: [],
              trigger_paths: 0,
              events_required: 0,
              no_fixtures?: false

    @type t :: %__MODULE__{
            behavior: String.t() | nil,
            version: String.t() | nil,
            fixtures_loaded: non_neg_integer(),
            match_tests: [Ensemble.Behavior.TestRunner.TestResult.t()],
            outcome_tests: [Ensemble.Behavior.TestRunner.TestResult.t()],
            coverage_warnings: [String.t()],
            trigger_paths: non_neg_integer(),
            events_required: non_neg_integer(),
            no_fixtures?: boolean()
          }
  end

  @doc """
  Run the conformance suite for `defn`. See the module doc for the contract.

  ## Options

  * `:fixtures` — override the loaded fixture set (`FixtureLoader.load_all/1`
    shape); otherwise loaded from `defn.source[:path]`.
  * `:now_ms` — frozen clock. Default: max `occurred_at` across event fixtures,
    else `0`.
  * `:defs` — candidate definitions for matching (default `[defn]`).
  * `:policy_ctx` — extra policy-context keys merged over the neutral default.
  * `:test_mode` — `%{now: %DateTime{}}` (parent contract) or
    `%{timeout_ms, max_polls, poll_interval_ms}` (AC-064); `now` freezes the clock.
  * `:timeout_ms` / `:max_polls` / `:poll_interval_ms` — AC-064 knobs (also
    read from `defn.source[:test]`).
  * `:dedup_store` — initial dedup map, threaded across events.
  * `:audit` — matcher audit hook (default `:none`; no ledger writes).
  """
  @spec run(Definition.t(), keyword() | map()) :: ConformanceReport.t()
  def run(%Definition{} = defn, opts \\ []) do
    o = normalize_opts(Map.new(opts))
    loaded = Map.get_lazy(o, :fixtures, fn -> FixtureLoader.load_all(defn) end)

    events = collect_events(loaded["events"])
    match_exp = index_expectations(loaded["expected-matches"])
    outcome_exp = index_expectations(loaded["expected-outcomes"])

    defs = Map.get(o, :defs, [defn])
    now_ms = Map.get_lazy(o, :now_ms, fn -> default_now(events) end)
    audit = Map.get(o, :audit, :none)
    base_ctx = Map.get(o, :policy_ctx, %{})

    {match_tests, _store} = run_match_tests(events, defs, defn, now_ms, audit, match_exp, o[:dedup_store] || %{})
    outcome_tests = run_outcome_tests(events, defs, now_ms, base_ctx, outcome_exp, o)

    paths = distinct_trigger_paths(defn)
    n_events = length(events)
    warnings = coverage_warnings(defn, n_events)

    %ConformanceReport{
      behavior: defn.name,
      version: to_string(defn.version),
      fixtures_loaded: n_events,
      match_tests: Enum.sort_by(match_tests, &{&1.fixture, &1.assertion}),
      outcome_tests: Enum.sort_by(outcome_tests, &{&1.fixture, &1.assertion}),
      coverage_warnings: warnings,
      trigger_paths: paths,
      events_required: 3 * paths,
      no_fixtures?: n_events == 0
    }
  end

  # ── opts / fixture plumbing ──────────────────────────────────────────────

  defp normalize_opts(o) do
    tm = Map.get(o, :test_mode, %{})

    case tm[:now] || o[:now] do
      %DateTime{} = dt -> Map.put(o, :now_ms, DateTime.to_unix(dt, :millisecond))
      _ -> o
    end
  end

  defp collect_events(event_files) do
    event_files
    |> Enum.flat_map(fn f ->
      with %{data: data} when is_map(data) <- f,
           {:ok, evs, _} <- FixtureLoader.normalize_event_fixture(data) do
        Enum.map(evs, fn e -> {f.name, e} end)
      else
        _ -> []
      end
    end)
  end

  defp default_now(events) do
    events
    |> Enum.map(fn {_n, e} -> e.occurred_at || 0 end)
    |> Enum.max(fn -> 0 end)
  end

  defp index_expectations(files) do
    files
    |> Enum.flat_map(fn f ->
      case f do
        %{data: %{} = data} ->
          name = data["event"] || f.name
          [{name, f}]

        _ ->
          []
      end
    end)
    |> Map.new()
  end

  # ── AC-058: match tests ──────────────────────────────────────────────────

  defp run_match_tests(events, defs, defn, now_ms, audit, match_exp, store) do
    {tests, store} =
      Enum.flat_map_reduce(events, store, fn {evname, ev}, store ->
        results =
          Matcher.propose(ev, defs, %{now_ms: now_ms, dedup_store: store, audit: audit})

        store = Matcher.record_fire(store, ev, defn, now_ms)
        checks = compare_matches(evname, results, Map.get(match_exp, evname))
        {checks, store}
      end)

    tests =
      if match_exp == %{} do
        tests
      else
        missing = for {n, _} <- events, not Map.has_key?(match_exp, n), do: missing_match(n)
        tests ++ missing
      end

    {tests, store}
  end

  defp compare_matches(evname, _results, nil) do
    [
      %TestResult{
        kind: :match,
        fixture: evname,
        assertion: "expected-matches for #{inspect(evname)}",
        passed?: false,
        expected: "an expected-matches/*.expected.json file referencing this event",
        actual: "no fixture"
      }
    ]
  end

  defp compare_matches(evname, results, %{path: path, data: data}) when is_map(data) do
    matched_names = results |> Enum.filter(&(&1.status == :matched)) |> Enum.map(& &1.definition.name)

    matched_versions =
      results
      |> Enum.filter(&(&1.status == :matched))
      |> Enum.map(&{&1.definition.name, to_string(&1.definition.version)})
      |> Enum.sort()

    exp_matches = str_list(data["matches"])
    exp_non = str_list(data["non_matches"])
    exact? = Map.has_key?(data, "candidates")

    base = []

    base =
      if Map.has_key?(data, "matches") or exact? do
        passed = if exact?, do: true, else: Enum.all?(exp_matches, &(&1 in matched_names))
        [tr(:match, evname, path, "expected matches present", passed, exp_matches, matched_names) | base]
      else
        base
      end

    base =
      if exp_non != [] do
        passed = Enum.all?(exp_non, &(&1 not in matched_names))
        [tr(:match, evname, path, "expected non-matches absent", passed, exp_non, matched_names) | base]
      else
        base
      end

    base =
      if exact? do
        expected = sorted_candidate_pairs(data["candidates"])
        [tr(:match, evname, path, "exact matched candidate set", expected == matched_versions, expected, matched_versions) | base]
      else
        base
      end

    base =
      if exact? do
        expected = sorted_candidates(data["candidates"])
        actual = candidate_status_set(results)
        [tr(:match, evname, path, "candidate statuses", expected == actual, expected, actual) | base]
      else
        base
      end

    Enum.reverse(base)
  end

  defp compare_matches(_evname, _results, _other), do: []

  defp missing_match(n) do
    %TestResult{
      kind: :match,
      fixture: n,
      assertion: "expected-matches present for #{inspect(n)}",
      passed?: false,
      expected: "fixture file",
      actual: "no expected-matches"
    }
  end

  defp candidate_status_set(results) do
    results
    |> Enum.map(fn r -> {r.definition.name, to_string(r.definition.version), Atom.to_string(r.status)} end)
    |> Enum.sort()
  end

  defp sorted_candidates(list) do
    list
    |> Enum.map(fn c -> {c["behavior"], to_string(c["version"] || ""), c["status"]} end)
    |> Enum.sort()
  end

  defp sorted_candidate_pairs(list) do
    list
    |> Enum.filter(&(&1["status"] == "matched"))
    |> Enum.map(fn c -> {c["behavior"], to_string(c["version"] || "")} end)
    |> Enum.sort()
  end

  # ── AC-059: outcome tests ────────────────────────────────────────────────

  defp run_outcome_tests(events, defs, now_ms, base_ctx, outcome_exp, o) do
    Enum.flat_map(events, fn {evname, ev} ->
      case Map.fetch(outcome_exp, evname) do
        {:ok, exp} -> compare_outcomes(evname, exp, defs, ev, now_ms, base_ctx, o)
        :error -> []
      end
    end)
  end

  defp compare_outcomes(evname, %{path: path, data: data}, defs, ev, now_ms, base_ctx, o) when is_map(data) do
    ctx = Map.merge(neutral_ctx(now_ms), base_ctx)

    results =
      Matcher.propose(ev, defs, %{now_ms: now_ms, dedup_store: Map.get(o, :dedup_store, %{}), audit: :none})

    verdicts =
      for r <- results, r.status == :matched do
        pd = Policy.evaluate(r.definition, ev, %{now_ms: now_ms, ctx: ctx})
        {r.definition.name, pd.verdict, pd.reasons}
      end

    primary = Enum.find_value(defs, & &1.name)

    # expected matched candidate set
    checks = []

    checks =
      case Map.fetch(data, "matches") do
        {:ok, exp} ->
          exp = str_list(exp)
          act = verdicts |> Enum.map(&elem(&1, 0)) |> Enum.sort()
          [tr(:outcome, evname, path, "outcome matched set", exp == act, exp, act) | checks]

        :error ->
          checks
      end

    # verdict for each expected activated behavior
    checks =
      case Map.fetch(data, "verdict") do
        {:ok, exp_v} ->
          exp_v = verdict_atom(exp_v)
          case verdict_for(verdicts, primary) do
            :no_match ->
              [tr(:outcome, evname, path, "policy verdict", false, exp_v, :behavior_not_matched) | checks]

            got ->
              [tr(:outcome, evname, path, "policy verdict", got == exp_v, exp_v, got) | checks]
          end

        :error ->
          checks
      end

    # proposals: behaviors reaching :activate
    checks =
      case Map.fetch(data, "proposals") do
        {:ok, exp} ->
          exp = str_list(exp)
          act = verdicts |> Enum.filter(fn {_n, v, _} -> v == :activate end) |> Enum.map(&elem(&1, 0)) |> Enum.sort()
          [tr(:outcome, evname, path, "proposed actions (structural set)", exp == act, exp, act) | checks]

        :error ->
          checks
      end

    # mutations: declared classes of behaviors an expected test.* outcome belongs to
    checks =
      case Map.fetch(data, "mutations") do
        {:ok, exp} ->
          exp = str_list(exp)
          act =
            if test_mutation_outcome?(data) do
              defs |> Enum.flat_map(&List.wrap(&1.capabilities && &1.capabilities.mutation_classes)) |> Enum.reject(&(&1 == "none")) |> Enum.uniq() |> Enum.sort()
            else
              []
            end

          [tr(:outcome, evname, path, "declared mutation classes (structural set)", exp == act, exp, act) | checks]

        :error ->
          checks
      end

    Enum.reverse(checks)
    Enum.reverse(checks)
  end

  defp compare_outcomes(_evname, _broken, _defs, _ev, _now, _base, _o), do: []

  defp find_verdict(verdicts, name), do: Enum.find(verdicts, fn {n, _, _} -> n == name end)


  defp verdict_atom(v) when is_atom(v), do: v

  defp verdict_atom(v) when is_binary(v) do
    try do
      String.to_existing_atom(v)
    rescue
      ArgumentError -> {:unknown_verdict, v}
    end
  end
  defp verdict_for(verdicts, name) do
    case find_verdict(verdicts, name) do
      nil -> :no_match
      {_n, v, _r} -> v
    end
  end

  defp test_mutation_outcome?(data) do
    List.wrap(data["outcomes"])
    |> Enum.any?(fn o -> is_binary(o) && String.starts_with?(o, "test.") end)
  end

  defp neutral_ctx(now_ms) do
    %{enabled: true, active: 0, children: 0, dedup: %{}, cooldowns: %{}, causal_depth: 0, now_ms: now_ms}
  end

  # ── TRD-030 coverage heuristic ───────────────────────────────────────────

  @doc """
  Count the DISTINCT trigger paths for `defn` (AC-060): number of predicate
  disjunction branches plus `event_type` fan-in.

  The schema admits a single `trigger.event_type`, so fan-in is the
  registered alias set (`source[:fan_in_event_types]`) when present,
  otherwise 1. Disjunction branches: a field compiled with multiple branch
  entries (e.g. an `any_of` that expands to several constraints) contributes
  its branch count; a nil/empty predicate contributes the bare event type (1).
  """
  @spec distinct_trigger_paths(Definition.t()) :: non_neg_integer()
  def distinct_trigger_paths(%Definition{} = defn) do
    branches =
      case defn.trigger do
        %{predicate: ast} when is_list(ast) and ast != [] ->
          ast
          |> Enum.group_by(& &1.path)
          |> Enum.map(fn {_path, cs} -> max(1, length(cs)) end)
          |> Enum.max(fn -> 1 end)

        _ ->
          1
      end

    fan_in =
      case defn.source do
        m when is_map(m) -> max(1, length(List.wrap(Map.get(m, :fan_in_event_types, []))))
        _ -> 1
      end

    branches + fan_in - 1
  end

  @doc "Coverage floor: `3 × distinct_trigger_paths(defn)` event fixtures required (AC-060)."
  @spec required_event_fixtures(Definition.t()) :: non_neg_integer()
  def required_event_fixtures(%Definition{} = defn), do: 3 * distinct_trigger_paths(defn)

  @doc """
  Coverage warnings for a behavior (AC-060). `n_events` is the number of
  event fixtures actually loaded. Returns [] when coverage passes.
  """
  @spec coverage_warnings(Definition.t() | String.t(), non_neg_integer()) :: [String.t()]
  def coverage_warnings(defn, n_events) do
    paths = if match?(%Definition{}, defn), do: distinct_trigger_paths(defn), else: 1
    required = 3 * paths
    coverage_warnings(defn, n_events, paths, required)
  end

  @spec coverage_warnings(Definition.t() | String.t(), non_neg_integer(), non_neg_integer(), non_neg_integer()) :: [String.t()]
  def coverage_warnings(defn, n_events, paths, required) do
    label = label_of(defn)

    cond do
      n_events == 0 ->
        ["#{label}: no event fixtures — 0/0 conformance assertions (explicit no-fixtures note, AC-063)"]

      n_events < required ->
        ["#{label}: #{n_events} event fixture(s) < #{required} required (3 × #{paths} distinct trigger path(s) via disjunctions + event_type fan-in); add at least #{required - n_events} more (AC-060)"]

      true ->
        []
    end
  end

  defp label_of(%Definition{name: n, version: v}), do: "#{n} v#{v}"
  defp label_of(name) when is_binary(name), do: name

  # ── AC-064 knobs ─────────────────────────────────────────────────────────

  @doc "Resolve test knobs (timeout_ms/max_polls/poll_interval_ms) from defn.source/opts (AC-064)."
  @spec test_opts(Definition.t(), map()) :: %{timeout_ms: pos_integer(), max_polls: pos_integer(), poll_interval_ms: pos_integer()}
  def test_opts(%Definition{source: src}, overrides \\ %{}) do
    base = if is_map(src), do: Map.get(src, :test) || %{}, else: %{}

    %{
      timeout_ms: pick(overrides, base, :timeout_ms, 10_000),
      max_polls: pick(overrides, base, :max_polls, 20),
      poll_interval_ms: pick(overrides, base, :poll_interval_ms, 250)
    }
  end

  defp pick(overrides, base, key, default) do
    case {Map.get(overrides, key), stringify_key(Map.get(base, key))} do
      {nil, nil} -> default
      {nil, v} -> v
      {v, _} -> v
    end
  end

  defp stringify_key(v) when is_integer(v), do: v
  defp stringify_key(other), do: other

  defp tr(kind, fixture, path, assertion, passed?, expected, actual) do
    %TestResult{kind: kind, fixture: fixture, path: path, assertion: assertion, passed?: passed?, expected: expected, actual: actual}
  end

  defp str_list(list) when is_list(list), do: list |> Enum.map(&to_string/1) |> Enum.sort()
  defp str_list(_), do: []
end
