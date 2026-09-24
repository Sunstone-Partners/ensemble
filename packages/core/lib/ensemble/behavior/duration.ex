defmodule Ensemble.Behavior.Duration do
  @moduledoc """
  Parses TRD §1.5 duration values to milliseconds.

  Accepts a non-negative integer (already milliseconds) or a string of the
  form `<count><unit>` where unit is one of `s | m | h | d`.
  """

  @units %{"s" => 1_000, "m" => 60_000, "h" => 3_600_000, "d" => 86_400_000}


  @doc "Milliseconds per duration unit — exposed for property tests."
  def __unit_ms__(unit), do: Map.fetch!(@units, unit)
  def parse(ms) when is_integer(ms) and ms >= 0, do: {:ok, ms}

  def parse(str) when is_binary(str) do
    case Regex.run(~r/^([0-9]+)(s|m|h|d)$/, str) do
      [_, count, unit] -> {:ok, String.to_integer(count) * Map.fetch!(@units, unit)}
      _ -> {:error, {:invalid_duration, str}}
    end
  end

  def parse(other), do: {:error, {:invalid_duration, other}}

  @doc "Parse raising on error; used post-schema-validation."
  def parse!(value) do
    case parse(value) do
      {:ok, ms} -> ms
      {:error, reason} -> raise ArgumentError, "invalid duration: #{inspect(reason)}"
    end
  end
end
