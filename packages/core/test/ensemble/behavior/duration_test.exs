defmodule Ensemble.Behavior.DurationTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.Duration

  test "integer passthrough and unit strings" do
    assert {:ok, 0} = Duration.parse(0)
    assert {:ok, 5_000} = Duration.parse(5_000)
    assert {:ok, ms} = Duration.parse("90m")
    assert ms == 90 * 60_000
    assert {:ok, 86_400_000} = Duration.parse("1d")
  end

  test "rejects malformed and negative inputs" do
    assert {:error, _} = Duration.parse("5x")
    assert {:error, _} = Duration.parse("m")
    assert {:error, _} = Duration.parse(1.5)
    assert {:error, _} = Duration.parse(:nope)
    assert {:error, _} = Duration.parse(-1)
  end

  test "parse! raises on error" do
    assert 300_000 == Duration.parse!("5m")
    assert_raise ArgumentError, fn -> Duration.parse!("1w") end
  end

  test "unit_ms accessor" do
    assert Duration.__unit_ms__("h") == 3_600_000
  end
end
