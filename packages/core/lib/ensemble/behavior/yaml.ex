defmodule Ensemble.Behavior.Yaml do
  @moduledoc """
  Minimal YAML emitter for nested string-keyed maps whose leaves are scalars
  (strings, numbers, booleans, nil), maps, or lists. This is the shape of
  `behavior.yaml` fixtures and `Definition.source` maps.

  Lists of scalars flow (`[a, b]`); lists of maps use inline JSON-style flow
  form, which YAML 1.1/1.2 parsers accept as valid block content.
  """

  @spec encode(map() | keyword()) :: String.t()
  def encode(map) when is_map(map) or is_list(map) do
    map
    |> to_ordered_map()
    |> encode_map(0)
    |> String.trim_trailing("\n")
    |> Kernel.<>("\n")
  end

  defp to_ordered_map(list) when is_list(list), do: Map.new(list)
  defp to_ordered_map(map), do: map

  defp encode_map(map, indent) do
    map
    |> Enum.sort_by(fn {k, _} -> to_string(k) end)
    |> Enum.map_join("", fn {k, v} -> encode_pair(k, v, indent) end)
  end

  defp encode_pair(k, v, indent) do
    pad = String.duplicate("  ", indent)

    cond do
      is_map(v) and map_size(v) == 0 ->
        "#{pad}#{k}: {}\n"

      is_map(v) ->
        "#{pad}#{k}:\n" <> encode_map(v, indent + 1)

      is_list(v) ->
        encode_list_pair(k, v, indent)

      true ->
        "#{pad}#{k}: #{scalar(v)}\n"
    end
  end

  defp encode_list_pair(k, [], indent) do
    "#{String.duplicate("  ", indent)}#{k}: []\n"
  end

  defp encode_list_pair(k, list, indent) do
    pad = String.duplicate("  ", indent)

    if Enum.all?(list, &scalar?/1) do
      items = list |> Enum.map(&scalar/1) |> Enum.join(", ")
      "#{pad}#{k}: [#{items}]\n"
    else
      body =
        list
        |> Enum.map_join("", fn item ->
          cond do
            is_map(item) -> encode_list_map_item(item, indent + 1)
            true -> "#{String.duplicate("  ", indent + 1)}- #{scalar_or_json(item)}\n"
          end
        end)

      "#{pad}#{k}:\n#{body}"
    end
  end

  defp encode_list_map_item(item, indent) do
    pad = String.duplicate("  ", indent)

    case Enum.sort_by(Map.to_list(item), fn {k, _} -> to_string(k) end) do
      [] ->
        "#{pad}- {}\n"

      [first | rest] ->
        first_line =
          case first do
            {k, v} when is_map(v) -> "#{pad}- #{k}:\n" <> encode_map(v, indent + 2)
            {k, v} when is_list(v) -> encode_list_pair("- #{k}", v, indent)
            {k, v} -> "#{pad}- #{k}: #{scalar(v)}\n"
          end

        rest_lines =
          Enum.map_join(rest, "", fn {k, v} ->
            encode_pair(k, v, indent + 1)
          end)

        first_line <> rest_lines
    end
  end

  defp scalar_or_json(v) when is_binary(v), do: inspect(v)
  defp scalar_or_json(v) when is_number(v) or is_boolean(v) or is_nil(v), do: scalar(v)
  defp scalar_or_json(v), do: Jason.encode!(v)

  defp scalar?(v), do: is_binary(v) or is_number(v) or is_boolean(v) or is_nil(v)

  defp scalar(v) when is_binary(v), do: inspect(v)
  defp scalar(v) when is_integer(v), do: to_string(v)
  defp scalar(v) when is_float(v), do: to_string(v)
  defp scalar(true), do: "true"
  defp scalar(false), do: "false"
  defp scalar(nil), do: "null"
  defp scalar(v) when is_atom(v), do: inspect(Atom.to_string(v))
end
