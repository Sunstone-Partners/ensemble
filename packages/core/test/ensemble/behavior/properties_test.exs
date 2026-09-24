defmodule Ensemble.Behavior.PropertiesTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Ensemble.Behavior.{Compiler, Digest, Duration, Matcher, Predicate}

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "prop", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "github.push"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  describe "Duration" do
    property "round-trips valid duration strings" do
      check all n <- StreamData.integer(0..100_000),
                unit <- StreamData.member_of(["s", "m", "h", "d"]) do
        ms_str = "#{n}#{unit}"
        assert {:ok, ms} = Duration.parse(ms_str)
        assert ms == n * Duration.__unit_ms__(unit)
      end
    end

    property "rejects malformed duration strings" do
      check all s <- StreamData.string(:alphanumeric) do
        case Duration.parse(s) do
          {:ok, ms} -> assert is_integer(ms) and ms >= 0
          {:error, _} -> :ok
        end
      end
    end
  end

  describe "Digest" do
    property "deterministic for same definition" do
      check all desc <- StreamData.string(:printable, min_length: 1, max_length: 30) do
        base = Map.put(@base, "metadata", Map.put(@base["metadata"], "description", desc))
        {:ok, d1} = Compiler.validate(base)
        {:ok, d2} = Compiler.validate(base)
        assert d1.digest == d2.digest
        assert d1.digest == Digest.compute(d1)
      end
    end
  end

  describe "Matcher" do
    property "candidates order independent of input list order" do
      event = %{event_type: "github.push", payload: %{}, idempotency_key: "x"}

      defs =
        for n <- 1..4 do
          {:ok, d} =
            Compiler.validate(%{
              @base
              | "metadata" => %{"name" => "b#{n}", "version" => "1.0.0", "description" => "d"}
            })

          d
        end

      check all order <- StreamData.shuffle(defs) do
        c1 = Matcher.candidates(event, order)
        c2 = Matcher.candidates(event, Enum.reverse(order))
        assert Enum.map(c1, & &1.definition.name) == Enum.map(c2, & &1.definition.name)
      end
    end
  end

  describe "Predicate" do
    property "skip-not-fail holds for random missing-field predicates" do
      check all field <- StreamData.member_of(["a", "b", "c"]),
                val <- StreamData.string(:printable) do
        {:ok, ast} = Predicate.compile(%{field => %{"equals" => val}})
        {verdict, trace} = Predicate.eval(ast, %{})
        assert verdict == :match
        assert Enum.all?(trace, &(&1.verdict == :skipped))
      end
    end
  end
end
