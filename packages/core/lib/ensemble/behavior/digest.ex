defmodule Ensemble.Behavior.Digest do
  @moduledoc """
  Content-addressed digest of a compiled `Definition` (TRD §1.7).

  SHA-256 over a canonical JSON form: keys sorted recursively, lists that
  carry no ordering meaning (tools, mutation classes, outcomes, predicate
  constraints) sorted by a stable representation. Any version-relevant
  change to a behavior yields a new digest (plan S1).
  """

  alias Ensemble.Behavior.Definition

  @spec compute(Definition.t()) :: binary()
  def compute(%Definition{} = d) do
    canonical = canonical_map(d)

    :crypto.hash(:sha256, canonical |> sort_deep() |> encode())
  end

  defp canonical_map(%Definition{} = d) do
    %{
      "api_version" => d.api_version,
      "name" => d.name,
      "version" => to_string(d.version),
      "description" => d.description,
      "trigger" => %{
        "event_type" => d.trigger.event_type,
        "predicate" => canonical_predicate(d.trigger.predicate)
      },
      "policy" => %{
        "mode" => to_string(d.policy.mode),
        "max_concurrent" => d.policy.max_concurrent,
        "cooldown" => d.policy.cooldown,
        "timeout" => d.policy.timeout,
        "max_causal_depth" => d.policy.max_causal_depth,
        "max_children" => d.policy.max_children,
        "dedup_window" => d.policy.dedup_window,
        "retry" => %{
          "max_attempts" => d.policy.retry.max_attempts,
          "retryable" => Enum.sort(d.policy.retry.retryable)
        }
      },
      "capabilities" => %{
        "tools" => Enum.sort(d.capabilities.tools),
        "mutation_classes" => Enum.sort(d.capabilities.mutation_classes)
      },
      "execution" => %{
        "graph" => d.execution.graph,
        "params" => d.execution.params
      },
      "outcomes" => Enum.sort(d.outcomes)
    }
  end

  defp canonical_predicate(ast) do
    ast
    |> Enum.map(fn c ->
      %{
        "path" => Enum.join(c.path, "."),
        "op" => to_string(c.op),
        "expected" => expected_form(c.op, c.expected)
      }
    end)
    |> Enum.sort_by(&encode/1)
  end

  defp expected_form(:matches, %Regex{} = re), do: re.source
  defp expected_form(_op, val), do: val

  # Recursively sort map keys so Jason's object encoding is deterministic.
  defp sort_deep(%{} = m) do
    m
    |> Enum.map(fn {k, v} -> {to_string(k), sort_deep(v)} end)
    |> Enum.sort_by(fn {k, _} -> k end)
    |> Map.new()
  end

  defp sort_deep(v) when is_list(v), do: Enum.map(v, &sort_deep/1)
  defp sort_deep(v), do: v

  defp encode(term), do: Jason.encode!(term, unique: true)
end
