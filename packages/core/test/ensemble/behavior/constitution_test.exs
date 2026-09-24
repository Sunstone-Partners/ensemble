defmodule Ensemble.Behavior.ConstitutionTest do
  use Ensemble.Behavior.TestCase, async: true

  alias Ensemble.Behavior.{Constitution, Compiler}

  @ruleset """
  rules:
    - id: rule:two-reviewers
      approval_required: [merge]
      approvers: [maintainer]
    - id: rule:no-secrets
      approval_required: []
  """

  setup do
    {:ok, set} = Constitution.parse(@ruleset)
    %{set: set}
  end

  test "parses YAML ruleset into id-keyed map", %{set: set} do
    assert map_size(set) == 2
    assert set["rule:two-reviewers"].approvers == ["maintainer"]
  end

  test "inline entry takes precedence over global", %{set: set} do
    {:ok, [r]} =
      Constitution.merge([%{"id" => "rule:two-reviewers", "approvers" => ["admin"]}], set)

    assert r.approvers == ["admin"]
  end

  test "reference by id pulls global rule", %{set: set} do
    {:ok, [r]} = Constitution.merge([%{"id" => "rule:two-reviewers"}], set)
    assert r.approval_required == ["merge"]
  end

  test "unknown id fails closed", %{set: set} do
    assert {:error, ["rule:nope"]} = Constitution.merge([%{"id" => "rule:nope"}], set)
  end

  test "validate merges declared rules into definition", %{set: set} do
    assert {:ok, defn} = Compiler.validate(behavior_yaml([]), constitution: set)
    assert [%{id: "rule:two-reviewers"}] = defn.constitution_rules
  end

  test "validate rejects unknown constitution rule", %{set: set} do
    yaml =
      behavior_yaml(constitution_rules: [%{"id" => "rule:ghost"}])

    assert {:error, errors} = Compiler.validate(yaml, constitution: set)
    assert Enum.any?(errors, &(&1.field == "constitution_rules"))
  end

  test "rules change the digest", %{set: set} do
    {:ok, without} = Compiler.validate(behavior_yaml(constitution_rules: []))
    {:ok, with} = Compiler.validate(behavior_yaml([]), constitution: set)
    assert without.digest != with.digest
  end
end
