defmodule Ensemble.Behavior.Predicate do
  @moduledoc """
  Predicate tree compilation and evaluation (TRD §1.6, REQ-004).

  Grammar:

      tree     := field: subtree
      subtree  := { constraint_name: value }   # leaves only under one field path
      constraint := equals | not | matches | gte | lte | contains

  Semantics:
  * AND across sibling field keys; each leaf is one constraint.
  * `matches` compiles the regex source string once at compile time.
  * Missing field / wrong type for a constraint => the constraint is
    **skipped, not failed** (AC-015-S), and the skip appears in the trace.
  * Evaluation is deterministic and agent-free (REQ-007).
  """

  @constraint_ops [:equals, :not, :matches, :gte, :lte, :contains]

  @type constraint :: {:equals | :not | :matches | :gte | :lte | :contains, term()}
  @type ast :: [%{path: [String.t()], op: atom(), expected: term()}]

  @type constraint_result :: %{
          path: [String.t()],
          op: atom(),
          expected: term(),
          actual: term(),
          verdict: :pass | :fail | :skipped
        }

  @doc """
  Compiles a raw predicate map (from YAML) into an AST of pre-resolved
  constraints, pre-compiling regexes so evaluation performs no parsing.

  Returns `{:ok, ast}` or `{:error, reason}`.
  """
  @spec compile(map() | nil) :: {:ok, ast()} | {:error, term()}
  def compile(nil), do: {:ok, []}
  def compile(pred) when map_size(pred) == 0, do: {:ok, []}

  def compile(pred) when is_map(pred) do
    Enum.reduce_while(pred, {:ok, []}, fn {field, constraints}, {:ok, acc} ->
      case compile_field(String.split(field, "."), constraints) do
        {:ok, cs} -> {:cont, {:ok, acc ++ cs}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  def compile(other), do: {:error, {:invalid_predicate, other}}

  defp compile_field(path, constraints) when is_map(constraints) do
    Enum.reduce_while(constraints, {:ok, []}, fn {op, val}, {:ok, acc} ->
      with {:ok, atom} <- op_atom(op),
           {:ok, prepared} <- precompile(atom, val) do
        {:cont, {:ok, acc ++ [%{path: path, op: atom, expected: prepared}]}}
      else
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp compile_field(_path, other), do: {:error, {:invalid_constraints, other}}

  defp op_atom(op) when is_atom(op), do: op_atom(Atom.to_string(op))

  defp op_atom(op) when is_binary(op) do
    if op in Enum.map(@constraint_ops, &Atom.to_string/1) do
      {:ok, String.to_existing_atom(op)}
    else
      {:error, {:unknown_constraint, op}}
    end
  end

  defp precompile(:matches, src) when is_binary(src) do
    case Regex.compile(src) do
      {:ok, re} -> {:ok, re}
      {:error, reason} -> {:error, {:invalid_regex, src, inspect(reason)}}
    end
  end

  defp precompile(_op, val), do: {:ok, val}

  @doc """
  Evaluates a compiled AST against a payload map (or normalized Event).

  Returns `{:match, trace}` when every constraint passes or is skipped, and
  `{:no_match, trace}` when at least one fails. Skips are recorded, never
  treated as failures (AC-015-S).
  """
  @spec eval(ast(), map()) :: {:match | :no_match, [constraint_result()]}
  def eval(ast, event) when is_list(ast) do
    trace = Enum.map(ast, &eval_constraint(&1, event))

    verdict =
      if Enum.any?(trace, &(&1.verdict == :fail)), do: :no_match, else: :match

    {verdict, trace}
  end

  defp eval_constraint(%{path: path, op: op, expected: expected}, event) do
    case fetch_path(event, path) do
      {:ok, actual} ->
        do_eval(op, expected, actual, path)

      :error ->
        %{path: path, op: op, expected: expected_repr(op, expected), actual: nil, verdict: :skipped}
    end
  end

  defp do_eval(:equals, expected, actual, path) do
    result(actual, expected, path, :equals, Kernel.==(actual, expected))
  end

  defp do_eval(:not, expected, actual, path) do
    result(actual, expected, path, :not, actual != expected)
  end

  defp do_eval(:matches, %Regex{} = re, actual, path) when is_binary(actual) do
    result(actual, re.source, path, :matches, Regex.match?(re, actual))
  end

  defp do_eval(:matches, expected, actual, path) when not is_binary(actual) do
    %{path: path, op: :matches, expected: expected, actual: actual, verdict: :skipped}
  end

  defp do_eval(:gte, expected, actual, path) when is_number(actual) and is_number(expected) do
    result(actual, expected, path, :gte, actual >= expected)
  end

  defp do_eval(:lte, expected, actual, path) when is_number(actual) and is_number(expected) do
    result(actual, expected, path, :lte, actual <= expected)
  end

  defp do_eval(op, expected, actual, path) when op in [:gte, :lte] do
    %{path: path, op: op, expected: expected, actual: actual, verdict: :skipped}
  end

  defp do_eval(:contains, expected, actual, path) do
    cond do
      is_binary(actual) and is_binary(expected) ->
        result(actual, expected, path, :contains, String.contains?(actual, expected))

      is_list(actual) ->
        result(actual, expected, path, :contains, expected in actual)

      is_map(actual) ->
        result(actual, expected, path, :contains, Map.has_key?(actual, expected))

      true ->
        %{path: path, op: :contains, expected: expected, actual: actual, verdict: :skipped}
    end
  end

  defp result(actual, expected, path, op, true), do: %{path: path, op: op, expected: expected, actual: actual, verdict: :pass}
  defp result(actual, expected, path, op, false), do: %{path: path, op: op, expected: expected, actual: actual, verdict: :fail}

  defp expected_repr(:matches, %Regex{} = re), do: re.source
  defp expected_repr(_op, val), do: val

  @doc """
  Fetches a dotted path from a nested map, atom or string keys.

  Looks under the root, then under `payload` (the normalized Event shape
  keeps source data there), then under the envelope itself.
  """
  @spec fetch_path(map(), [String.t()]) :: {:ok, term()} | :error
  def fetch_path(event, path) do
    Enum.find_value([event, Map.get(event, :payload) || Map.get(event, "payload") || %{}], :error, fn
      root -> walk(root, path)
    end)
  end

  defp walk(map, []), do: {:ok, map}

  defp walk(map, [key | rest]) when is_map(map) do
    cond do
      Map.has_key?(map, key) -> walk(Map.fetch!(map, key), rest)
      Map.has_key?(map, String.to_atom(key)) -> walk(Map.fetch!(map, String.to_atom(key)), rest)
      true -> :error
    end
  end

  defp walk(_other, _path), do: :error
end
