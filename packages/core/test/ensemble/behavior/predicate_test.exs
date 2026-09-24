defmodule Ensemble.Behavior.PredicateTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.Predicate

  describe "compile/1" do
    test "empty predicate compiles to empty AST" do
      assert {:ok, []} = Predicate.compile(%{})
      assert {:ok, []} = Predicate.compile(nil)
    end

    test "ANDs field keys into one flat list" do
      assert {:ok, ast} =
               Predicate.compile(%{"a.b" => %{"equals" => 1}, "c" => %{"lte" => 5}})

      assert length(ast) == 2
      assert Enum.all?(ast, &(&1.op in [:equals, :lte]))
    end

    test "precompiles regex sources once" do
      assert {:ok, [%{op: :matches, expected: %Regex{}}]} =
               Predicate.compile(%{"r" => %{"matches" => "^x.*"}})
    end

    test "rejects invalid regex at compile time" do
      assert {:error, {:invalid_regex, _, _}} = Predicate.compile(%{"r" => %{"matches" => "["}})
    end

    test "rejects unknown constraint op" do
      assert {:error, {:unknown_constraint, "frobnicate"}} =
               Predicate.compile(%{"a" => %{"frobnicate" => 1}})
    end
  end

  describe "eval/2" do
    test "missing path => skipped, never fail" do
      {:ok, ast} = Predicate.compile(%{"missing.field" => %{"equals" => 1}})
      assert {:match, [%{verdict: :skipped}]} = Predicate.eval(ast, %{})
    end

    test "wrong type for constraint => skipped" do
      {:ok, ast} = Predicate.compile(%{"n" => %{"gte" => 3}})
      assert {:match, [%{verdict: :skipped}]} = Predicate.eval(ast, %{"n" => "abc"})
    end

    test "equals/not/gte/lte pass and fail" do
      {:ok, ast} =
        Predicate.compile(%{
          "a" => %{"equals" => 1},
          "b" => %{"not" => 2},
          "c" => %{"gte" => 3},
          "d" => %{"lte" => 4}
        })

      assert {:match, trace} =
               Predicate.eval(ast, %{"a" => 1, "b" => 9, "c" => 5, "d" => 3})

      assert Enum.all?(trace, &(&1.verdict == :pass))

      assert {:no_match, trace2} =
               Predicate.eval(ast, %{"a" => 2, "b" => 9, "c" => 5, "d" => 3})

      assert Enum.any?(trace2, &(&1.verdict == :fail))
    end

    test "matches uses precompiled regex on binary, skips on non-binary" do
      {:ok, ast} = Predicate.compile(%{"s" => %{"matches" => "^ok"}})
      assert {:match, _} = Predicate.eval(ast, %{"s" => "okay"})
      assert {:no_match, _} = Predicate.eval(ast, %{"s" => "nope"})
      assert {:match, [%{verdict: :skipped}]} = Predicate.eval(ast, %{"s" => 42})
    end

    test "contains supports strings, lists, maps" do
      {:ok, s} = Predicate.compile(%{"s" => %{"contains" => "ell"}})
      {:ok, l} = Predicate.compile(%{"l" => %{"contains" => :x}})
      {:ok, m} = Predicate.compile(%{"m" => %{"contains" => "k"}})

      assert {:match, _} = Predicate.eval(s, %{"s" => "hello"})
      assert {:match, _} = Predicate.eval(l, %{"l" => [:a, :x]})
      assert {:match, _} = Predicate.eval(m, %{"m" => %{"k" => 1}})
      assert {:no_match, _} = Predicate.eval(m, %{"m" => %{"j" => 1}})
    end

    test "traces every constraint verdict, never fails on skip-only" do
      {:ok, ast} = Predicate.compile(%{"x" => %{"gte" => 1}, "y" => %{"equals" => 2}})
      # x present, y absent -> one pass + one skip -> still match
      assert {:match, [%{verdict: :pass}, %{verdict: :skipped}]} =
               Predicate.eval(ast, %{"x" => 5})
    end

    test "resolves atom-keyed payloads" do
      {:ok, ast} = Predicate.compile(%{"a.b" => %{"equals" => 7}})
      event = %{payload: %{a: %{b: 7}}}
      assert {:match, _} = Predicate.eval(ast, event)
    end
  end
end
