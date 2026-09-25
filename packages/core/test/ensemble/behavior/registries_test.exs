defmodule Ensemble.Behavior.RegistriesTest do
  use ExUnit.Case, async: false

  alias Ensemble.Behavior.Registries

  setup do
    {:ok, pid} = start_supervised({Registries, []})
    %{pid: pid}
  end

  test "loads tools/mutations/events/workflows from priv", %{pid: _pid} do
    reg = Registries.all()
    assert MapSet.size(reg.tools) > 0
    assert map_size(reg.mutation_classes) >= 5
    assert Enum.any?(reg.events, &(&1 == "github.push"))
    assert Enum.any?(reg.workflows, &(&1 == "ensemble.review-pr"))
  end

  test "tool/mutation/event/workflow predicates" do
    assert Registries.tool_known?("ensemble.github.pr_comment")
    refute Registries.tool_known?("does.not.exist")
    assert Registries.mutation_known?("comment")
    refute Registries.mutation_known?("chaos")
    assert Registries.event_known?("github.push")
    assert Registries.event_known?("x-myproject.some_event")
    refute Registries.event_known?("not.registered.event")
    assert Registries.workflow_known?("ensemble.implement")
  end

  test "tools_for_mutation returns enforcing tools" do
    assert "ensemble.jira.comment" in Registries.tools_for_mutation("comment")
  end

  test "reload re-reads from disk", %{pid: pid} do
    :ok =
      Agent.update(pid, fn _ ->
        %{
          tools: MapSet.new(),
          mutation_classes: %{},
          events: MapSet.new(),
          workflows: MapSet.new()
        }
      end)

    assert Registries.all().tools == MapSet.new()
    Registries.reload()
    assert MapSet.size(Registries.all().tools) > 0
  end
end
