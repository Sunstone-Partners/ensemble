defmodule Ensemble.Behavior.YamlTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.Yaml

  defp roundtrip(map) do
    encoded = Yaml.encode(map)
    assert {:ok, decoded} = YamlElixir.read_from_string(encoded)
    assert decoded == map, "round-trip mismatch:\n#{encoded}"
  end

  test "empty map and empty list" do
    assert Yaml.encode(%{"a" => %{}}) == "a: {}\n"
    assert Yaml.encode(%{"a" => []}) == "a: []\n"
  end

  test "nested empty maps round-trip" do
    roundtrip(%{"a" => %{"b" => %{}}, "c" => %{}})
  end

  test "scalar types" do
    roundtrip(%{"s" => "x", "i" => 1, "f" => 1.5, "t" => true, "f2" => false, "n" => nil})
  end

  test "nested maps" do
    roundtrip(%{"a" => %{"b" => %{"c" => "d"}}, "e" => %{"f" => 1}})
  end

  test "list of scalars" do
    roundtrip(%{"xs" => ["a", "b", "c"], "ns" => [1, 2]})
  end

  test "list of maps" do
    roundtrip(%{"rules" => [%{"id" => "a", "x" => 1}, %{"id" => "b"}]})
  end

  test "list of lists" do
    roundtrip(%{"m" => [["a"], ["b", 2]]})
  end

  test "strings needing quotes round-trip" do
    roundtrip(%{"s" => "hello: world", "t" => "true", "q" => "he said \"hi\""})
  end

  test "keyword list input" do
    assert Yaml.encode(a: 1, b: "two") == "a: 1\nb: \"two\"\n"
  end

  test "nested empty collections" do
    roundtrip(%{"a" => %{"b" => []}, "c" => %{}, "d" => [%{}, %{"e" => []}]})
  end

  test "atom values render as strings" do
    assert Yaml.encode(%{"a" => :b}) == "a: \"b\"\n"
  end
end
