defmodule Ensemble.Behavior.TestCase do
  @moduledoc """
  Shared test helpers for behavior fixtures (TRD §1.9).

  Exposes `behavior_yaml/1` (valid YAML with overridable fields) and
  `sample_event/0` for fixture-driven tests across all Phase 1 suites.
  """
  use ExUnit.CaseTemplate

  using do
    quote do
      import Ensemble.Behavior.TestCase
    end
  end

  @doc """
  Valid behavior.yaml text with keyword overrides applied at the top level.
  """
  def behavior_yaml(overrides \\ []) do
    base = %{
      "api_version" => "ensemble.sunstone.dev/v1",
      "kind" => "Behavior",
      "metadata" => %{
        "name" => "pr-review-nudge",
        "version" => "1.0.0",
        "description" => "Nudges reviewers when a PR sits unreviewed."
      },
      "trigger" => %{
        "event_type" => "ensemble.run.completed",
        "predicate" => %{
          "payload.repository.visibility" => %{"equals" => "public"},
          "payload.pull_request.draft" => %{"not" => true}
        }
      },
      "policy" => %{
        "mode" => "propose",
        "max_concurrent" => 1,
        "cooldown" => "5m",
        "timeout" => "10m",
        "max_causal_depth" => 2,
        "max_children" => 3,
        "dedup_window" => "24h",
        "retry" => %{"max_attempts" => 2, "retryable" => ["transient"]}
      },
      "capabilities" => %{
        "tools" => ["ensemble.github.pr_comment", "ensemble.notify.dispatch"],
        "mutation_classes" => ["comment"]
      },
      "execution" => %{"graph" => "ensemble.review-pr", "params" => %{"channel" => "#eng"}},
      "outcomes" => ["ensemble.behavior.executed", "ensemble.run.completed"],
      "constitution_rules" => [%{"id" => "rule:two-reviewers"}]
    }

    merged = deep_merge(base, Map.new(overrides))
    encode_yaml(merged)
  end

  @doc "Minimal normalized Event map for trigger matching."
  def sample_event(overrides \\ []) do
    base = %{
      event_id: "e-001",
      event_type: "github.pull_request.opened",
      occurred_at: System.system_time(:millisecond),
      emitted_at: System.system_time(:millisecond),
      source: :github,
      payload: %{
        "repository" => %{"visibility" => "public"},
        "pull_request" => %{"draft" => false, "number" => 42}
      },
      actor: %{type: :user, id: "u-1"},
      causal_parent: nil,
      depth: 0,
      dedup_key: "dk-001"
    }

    Map.merge(base, Map.new(overrides))
  end

  defp deep_merge(base, over) do
    Map.merge(base, over, fn _k, v1, v2 ->
      if is_map(v1) and is_map(v2), do: deep_merge(v1, v2), else: v2
    end)
  end

  @doc "YAML encoder — emits block maps; empty collections as flow."
  def encode_yaml(map) do
    map
    |> Map.to_list()
    |> Enum.map(&encode_kv/1)
    |> Enum.join("\n")
    |> Kernel.<>("\n")
  end

  defp encode_kv({k, v}), do: "#{k}: #{encode_val(v, 0)}"

  defp encode_val(v, _indent) when is_binary(v), do: inspect(v)
  defp encode_val(v, _indent) when is_integer(v), do: to_string(v)
  defp encode_val(v, _indent) when is_float(v), do: to_string(v)
  defp encode_val(true, _), do: "true"
  defp encode_val(false, _), do: "false"
  defp encode_val(nil, _), do: "null"
  defp encode_val([], _indent), do: " []"
  defp encode_val(%{} = v, _indent) when map_size(v) == 0, do: " {}"

  defp encode_val(v, indent) when is_map(v) do
    pad = String.duplicate("  ", indent + 1)

    v
    |> Map.to_list()
    |> Enum.map(fn {k, val} ->
      cond do
        is_map(val) and map_size(val) > 0 -> "\n#{pad}#{k}:#{encode_block(val, indent + 1)}"
        is_list(val) and val != [] -> "\n#{pad}#{k}:#{encode_list(val, indent + 1)}"
        true -> "\n#{pad}#{k}: #{encode_val(val, indent + 1)}"
      end
    end)
    |> Enum.join("")
  end

  defp encode_val(v, _indent) when is_list(v) do
    v
    |> Enum.map(fn item -> "\n- " <> encode_inline(item) end)
    |> Enum.join("")
  end

  defp encode_val(_v, _indent), do: "null"

  defp encode_block(v, indent) do
    v
    |> Map.to_list()
    |> Enum.map(fn {k, val} ->
      pad = String.duplicate("  ", indent + 1)

      cond do
        is_map(val) and map_size(val) > 0 -> encode_val(%{k => val}, indent)
        is_list(val) and val != [] -> "\n#{pad}#{k}:#{encode_list(val, indent + 1)}"
        true -> "\n#{pad}#{k}: #{encode_val(val, indent + 1)}"
      end
    end)
    |> Enum.join("")
  end

  defp encode_list(v, indent) do
    v
    |> Enum.map(fn item -> "\n#{String.duplicate("  ", indent)}- #{encode_inline(item)}" end)
    |> Enum.join("")
  end

  defp encode_inline(item) when is_binary(item), do: inspect(item)
  defp encode_inline(item) when is_atom(item), do: inspect(Atom.to_string(item))

  defp encode_inline(item) when is_map(item) do
    inner =
      item
      |> Enum.map(fn {k, v} -> "#{k}: #{encode_flow(v)}" end)
      |> Enum.join(", ")

    "{" <> inner <> "}"
  end

  defp encode_inline(item), do: to_string(item)

  defp encode_flow(v) when is_binary(v), do: inspect(v)
  defp encode_flow(v) when is_map(v), do: encode_inline(v)
  defp encode_flow(v) when is_list(v), do: "[" <> Enum.map_join(v, ", ", &encode_flow/1) <> "]"
  defp encode_flow(v), do: to_string(v)
end
