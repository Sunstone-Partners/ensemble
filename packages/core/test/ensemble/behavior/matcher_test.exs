defmodule Ensemble.Behavior.MatcherTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.{Compiler, Matcher, Definition}

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "m", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "github.push"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  defp defn(overrides \\ %{}) do
    {:ok, d} = Compiler.validate(deep_merge(@base, overrides))
    d
  end

  defp deep_merge(left, right) do
    Map.merge(left, right, fn _k, l, r ->
      if is_map(l) and is_map(r), do: deep_merge(l, r), else: r
    end)
  end

  defp event(overrides \\ %{}) do
    Map.merge(
      %{
        event_type: "github.push",
        idempotency_key: "ek-1",
        causal_depth: 0,
        payload: %{"repo" => %{"visibility" => "public"}, "ref" => "refs/heads/main"}
      },
      overrides
    )
  end

  describe "candidates/2" do
    test "only matching event_type appears" do
      push = defn()
      other = defn(%{"trigger" => %{"event_type" => "jira.issue.created"}})

      assert [%{definition: %Definition{name: "m"}}] = Matcher.candidates(event(), [push, other])
    end

    test "predicate no-match excluded, skip-only match included" do
      strict = defn(%{"trigger" => %{"predicate" => %{"payload.ref" => %{"equals" => "dev"}}}})

      # missing field => skip => still match (AC-015-S)
      missing = defn(%{"trigger" => %{"predicate" => %{"nonexistent" => %{"equals" => 1}}}})

      assert [%{verdict: :match, trace: [%{verdict: :skipped}]}] =
               Matcher.candidates(event(), [missing])
    end

    test "tie-break: more predicate constraints first, then deeper event_type" do
      a =
        defn(%{
          "metadata" => %{"name" => "a"},
          "trigger" => %{"predicate" => %{"payload.ref" => %{"equals" => "refs/heads/main"}}}
        })

      b = defn(%{"metadata" => %{"name" => "b"}})

      assert [%{definition: %{name: "a"}}, %{definition: %{name: "b"}}] =
               Matcher.candidates(event(), [b, a])
    end

    test "deterministic order under random input order (AC-016)" do
      defs = for n <- 1..6, do: defn(%{"metadata" => %{"name" => "n#{n}"}})

      assert Enum.map(Matcher.candidates(event(), defs), & &1.definition.name) ==
               Enum.map(Matcher.candidates(event(), Enum.reverse(defs)), & &1.definition.name)
    end
  end

  describe "propose/3 filters (AC-013/AC-014/AC-026/AC-027)" do
    alias Ensemble.Behavior.MatchResult

    test "dedup window reports :suppressed, does not hide candidate" do
      d = defn(%{"policy" => %{"dedup_window" => "24h"}})
      store = Matcher.record_fire(%{}, event(), d, 1_000)

      assert [%MatchResult{status: :suppressed}] =
               Matcher.propose(event(), [d], %{dedup_store: store, now_ms: 2_000, audit: :none})

      # past the window -> matched again
      assert [%MatchResult{status: :matched}] =
               Matcher.propose(event(), [d], %{dedup_store: store, now_ms: 86_402_000, audit: :none})
    end

    test "causal-depth reports :depth_dropped with reason" do
      d = defn(%{"policy" => %{"max_causal_depth" => 2}})

      assert [%MatchResult{status: :matched}] =
               Matcher.propose(event(%{causal_depth: 1}), [d], %{audit: :none})

      assert [%MatchResult{status: :depth_dropped}] =
               Matcher.propose(event(%{causal_depth: 2}), [d], %{audit: :none})
    end

    test "predicate mismatch reports :predicate_failed (AC-026, no silent miss)" do
      d = defn(%{"trigger" => %{"predicate" => %{"payload.ref" => %{"equals" => "dev"}}}})

      assert [%MatchResult{status: :predicate_failed}] = Matcher.propose(event(), [d], %{audit: :none})
    end

    test "matched results sort deterministically; rejected sink to end" do
      a = defn(%{"metadata" => %{"name" => "a", "version" => "1.0.0"}})
      b = defn(%{"metadata" => %{"name" => "b", "version" => "1.0.0"}})
      c = defn(%{"metadata" => %{"name" => "c", "version" => "1.0.0"},
                 "trigger" => %{"predicate" => %{"payload.ref" => %{"equals" => "no"}}}})

      assert [%MatchResult{definition: %{name: "a"}, status: :matched},
              %MatchResult{definition: %{name: "b"}, status: :matched},
              %MatchResult{definition: %{name: "c"}, status: :predicate_failed}] =
               Matcher.propose(event(), [c, b, a], %{audit: :none})
    end
  end
end
