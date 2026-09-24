defmodule Ensemble.Behavior.Constitution do
  @moduledoc """
  Parses `constitution-rules.yaml` (or a decoded ruleset) and merges a
  behavior's declared `constitution_rules` into its policy
  (TRD §1.5, REQ-002 AC-005/006; task TRD-005).

  Rule record shape after merge:

      %{id: "rule:two-reviewers", approval_required: ["merge"], approvers: [...]}

  Declaration entries are either a bare reference (`%{"id" => "rule:x"}`),
  which must exist in the loaded global ruleset (fail-closed), or a full
  inline rule (id + attributes), which takes precedence over a same-id
  global entry.
  """

  @type rule :: %{
          required(:id) => String.t(),
          optional(:approval_required) => [String.t()],
          optional(:approvers) => [String.t()]
        }

  @doc "Parses YAML binary or pre-decoded map/list into a `%{id => rule}` map."
  @spec parse(binary() | map() | list()) :: {:ok, %{String.t() => rule()}} | {:error, term()}
  def parse(input) when is_binary(input) do
    case YamlElixir.read_from_string(input) do
      {:ok, decoded} -> parse(decoded)
      {:error, reason} -> {:error, {:yaml_parse, reason}}
    end
  end

  def parse(%{"rules" => rules}) when is_list(rules), do: index(rules)
  def parse(rules) when is_list(rules), do: index(rules)
  def parse(%{} = m) when map_size(m) == 0, do: {:ok, %{}}
  def parse(other), do: {:error, {:invalid_ruleset, other}}

  @doc """
  Merges declared entries with a loaded global ruleset.
  Returns `{:ok, [rule]}` (inline precedence) or `{:error, [unknown_id]}`.
  """
  @spec merge([map()], %{String.t() => rule()}) :: {:ok, [rule()]} | {:error, [String.t()]}
  def merge(declared, ruleset) when is_list(declared) and is_map(ruleset) do
    {resolved, unknown} =
      Enum.reduce(declared, {[], []}, fn entry, {acc, unk} ->
        case resolve(entry, ruleset) do
          {:ok, rule} -> {[rule | acc], unk}
          {:unknown, id} -> {acc, [id | unk]}
        end
      end)

    case unknown do
      [] -> {:ok, Enum.reverse(resolved)}
      ids -> {:error, ids}
    end
  end

  defp index(rules) do
    rules
    |> Enum.map(&normalize/1)
    |> Enum.reduce_while({:ok, %{}}, fn
      {:ok, rule}, {:ok, acc} -> {:cont, {:ok, Map.put(acc, rule.id, rule)}}
      {:error, r}, _ -> {:halt, {:error, r}}
    end)
  end

  defp normalize(%{"id" => id} = raw) when is_binary(id) do
    {:ok,
     %{
       id: id,
       approval_required: raw["approval_required"] || [],
       approvers: raw["approvers"] || []
     }}
  end

  defp normalize(other), do: {:error, {:rule_missing_id, other}}

  defp resolve(%{"id" => id} = entry, ruleset) when is_binary(id) do
    case classify(entry) do
      {:inline, rule} ->
        {:ok, rule}

      :reference ->
        case Map.fetch(ruleset, id) do
          {:ok, rule} -> {:ok, rule}
          :error -> {:unknown, id}
        end
    end
  end

  defp resolve(other, _ruleset), do: {:unknown, inspect(other)}

  # bare id-only map is a reference; anything with known attributes is inline
  defp classify(%{"id" => _} = m) do
    case Map.take(m, ["approval_required", "approvers"]) do
      extra when map_size(extra) == 0 -> :reference
      _ -> normalize_inline(m)
    end
  end

  defp classify(_), do: :reference

  # inline with unknown extra keys still resolves via global if present; else unknown
  defp normalize_inline(m) do
    case normalize(m) do
      {:ok, rule} -> {:inline, rule}
      {:error, _} -> :reference
    end
  end
end
