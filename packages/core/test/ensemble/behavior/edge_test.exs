defmodule Ensemble.Behavior.ConstitutionEdgeTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.Constitution

  test "bad yaml errors" do
    assert {:error, {:yaml_parse, _}} = Constitution.parse("a: [unclosed")
  end

  test "list input indexes directly" do
    assert {:ok, set} = Constitution.parse([%{"id" => "rule:a"}])
    assert set["rule:a"].id == "rule:a"
  end

  test "empty map -> empty ruleset" do
    assert {:ok, %{}} = Constitution.parse(%{})
  end

  test "non-map scalar -> invalid" do
    assert {:error, {:invalid_ruleset, 42}} = Constitution.parse(42)
  end

  test "rule without id -> error" do
    assert {:error, {:rule_missing_id, _}} = Constitution.parse([%{"x" => 1}])
  end

  test "malformed entries become unknown ids" do
    assert {:error, unknown} = Constitution.merge([42], %{})
    assert is_list(unknown)
  end

  test "unknown extra attributes fall back to reference then global" do
    set = %{"rule:a" => %{id: "rule:a", approval_required: ["x"], approvers: []}}
    assert {:ok, [r]} = Constitution.merge([%{"id" => "rule:a", "extra" => 1}], set)
    assert r.approvers == []
  end

  test "non-binary id fails closed" do
    assert {:error, [_]} = Constitution.merge([%{"id" => :a, "approvers" => ["z"]}], %{})
  end
end

defmodule Ensemble.Behavior.PredicateEdgeTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.Predicate

  test "compile non-map errors" do
    assert {:error, {:invalid_predicate, 5}} = Predicate.compile(5)
  end

  test "unknown constraint op errors" do
    assert {:error, {:unknown_constraint, "weird"}} =
             Predicate.compile(%{"a" => %{"weird" => 1}})
  end

  test "atom op key normalizes" do
    {:ok, [c]} = Predicate.compile(%{"a" => %{equals: 1}})
    assert c.op == :equals
  end

  test "non-walkable path values are skipped not failed" do
    {:ok, ast} = Predicate.compile(%{"a.b" => %{"equals" => 1}})
    {:match, trace} = Predicate.eval(ast, %{"a" => 5})
    assert hd(trace).verdict == :skipped
  end

  test "contains on non-comparable value is skipped" do
    {:ok, ast} = Predicate.compile(%{"a" => %{"contains" => "x"}})
    {:match, trace} = Predicate.eval(ast, %{"a" => 12345})
    assert hd(trace).verdict == :skipped
  end

  test "matches trace preserves regex source" do
    {:ok, ast} = Predicate.compile(%{"a" => %{"matches" => "^x.*$"}})
    {verdict, trace} = Predicate.eval(ast, %{"a" => "xyz"})
    assert verdict == :match
    assert hd(trace).expected == "^x.*$"
  end
end
