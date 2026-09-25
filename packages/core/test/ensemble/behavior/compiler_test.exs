defmodule Ensemble.Behavior.CompilerTest do
  use ExUnit.Case, async: true
  alias Ensemble.Behavior.{Compiler, Definition, Registry}
  import ExUnit.CaptureLog

  @valid %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "t", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "github.push"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  @moduletag :phase1

  describe "validate/2" do
    test "accepts minimal valid map" do
      assert {:ok, %Definition{}} = Compiler.validate(@valid)
    end

    test "rejects unknown top-level keys" do
      assert {:error, errs} = Compiler.validate(Map.put(@valid, "bogus", 1))
      assert Enum.any?(errs, &String.contains?(&1.reason, "additional properties"))
    end

    test "rejects bad name pattern" do
      assert {:error, errs} = Compiler.validate(set_in(@valid, ["metadata", "name"], "X_Y"))
      assert Enum.any?(errs, &(&1.field == "#/metadata/name"))
    end

    test "rejects unregistered event type" do
      assert {:error, errs} =
               Compiler.validate(set_in(@valid, ["trigger", "event_type"], "not.real"))

      assert Enum.any?(errs, &String.contains?(&1.reason, "not registered"))
    end

    test "rejects unknown mutation class" do
      assert {:error, errs} =
               Compiler.validate(set_in(@valid, ["capabilities", "mutation_classes"], ["bogus"]))

      assert Enum.any?(errs, &String.contains?(&1.reason, "unknown mutation class"))
    end

    test "drops unknown tools with a warning, keeps known grants" do
      assert {:ok, d} =
               Compiler.validate(
                 set_in(@valid, ["capabilities", "tools"], ["ensemble.github.pr_comment", "fake"])
               )

      assert d.capabilities.tools == ["ensemble.github.pr_comment"]
    end

    test "resolves missing policy conservatively" do
      assert {:ok, d} = Compiler.validate(@valid)
      assert d.policy.mode == :propose
      assert d.policy.max_concurrent == 1
      assert d.policy.max_causal_depth == 2
      assert d.policy.dedup_window == 3_600_000
    end

    test "parses duration strings and ints" do
      assert {:ok, d} = Compiler.validate(set_in(@valid, ["policy", "cooldown"], "5m"))
      assert d.policy.cooldown == 300_000
      assert {:ok, d2} = Compiler.validate(set_in(@valid, ["policy", "cooldown"], 1_000))
      assert d2.policy.cooldown == 1_000
    end
  end

  describe "digest/1" do
    test "is deterministic and sensitive to semantic fields" do
      {:ok, a} = Compiler.validate(@valid)
      {:ok, b} = Compiler.validate(@valid)
      assert a.digest == b.digest

      {:ok, c} = Compiler.validate(set_in(@valid, ["metadata", "description"], "changed"))
      assert a.digest != c.digest
    end

    test "encodes regex constraints via source" do
      assert {:ok, _} =
               Compiler.validate(
                 set_in(@valid, ["trigger", "predicate"], %{
                   "ref" => %{"matches" => "^refs/heads/.*$"}
                 })
               )
    end
  end

  describe "compatibility/2 + select_candidate/2" do
    setup do
      {:ok, v100} = Compiler.validate(v("1.0.0"))
      {:ok, v101} = Compiler.validate(v("1.0.1"))
      {:ok, v200} = Compiler.validate(v("2.0.0"))
      {:ok, %{v100: v100, v101: v101, v200: v200}}
    end

    defp v(version), do: set_in(@valid, ["metadata", "version"], version)

    test "patch/minor compatible, major breaking", %{v100: a, v101: b, v200: c} do
      assert Compiler.compatibility(a, b) == :compatible
      assert Compiler.compatibility(a, c) == :breaking
    end

    test "selects newest when all compatible", %{v100: a, v101: b} do
      assert {:ok, sel} = Compiler.select_candidate("t", [a, b])
      assert sel.version == Version.parse!("1.0.1")
    end

    test "falls back below breaking newest with warning", %{v100: a, v101: b, v200: c} do
      log =
        capture_log(fn ->
          assert {:ok, sel} = Compiler.select_candidate("t", [a, b, c])
          assert sel.version == Version.parse!("1.0.1")
        end)

      assert log =~ "deprecated"
      assert log =~ "2.0.0"
    end

    test "errors when nothing shares a cohort" do
      {:ok, x} = Compiler.validate(@valid)
      {:ok, y} = Compiler.validate(set_in(@valid, ["metadata", "name"], "other"))
      assert {:error, :no_compatible_version} = Compiler.select_candidate("nope", [x, y])
    end
  end

  describe "registry" do
    setup do
      {:ok, pid} = start_supervised({Registry, []})
      %{pid: pid}
    end

    test "round-trips identical digest", %{pid: pid} do
      {:ok, d} = Compiler.validate(@valid)
      assert :ok = Registry.register(d, pid)
      assert {:ok, found} = Registry.lookup("t", pid)
      assert found.digest == d.digest
    end

    test "rejects same version with different digest", %{pid: pid} do
      {:ok, d} = Compiler.validate(@valid)
      :ok = Registry.register(d, pid)
      tampered = %{d | description: "tampered"}

      assert {:error, {:digest_conflict, msg}} = Registry.register(tampered, pid)
      assert msg =~ "different digest"
    end
  end

  describe "discover/1" do
    @tag :tmp_dir
    test "finds packages, creates fixture dirs", %{tmp_dir: tmp} do
      dir = Path.join([tmp, "packages", "demo", "behaviors", "alpha"])
      File.mkdir_p!(dir)
      File.write!(Path.join(dir, "behavior.yaml"), Ensemble.Behavior.Yaml.encode(@valid))

      {defs, issues} = Compiler.discover(tmp)
      assert length(defs) == 1
      assert Enum.any?(issues, &(&1.kind == :created_fixture_dir))
      assert Enum.any?(issues, &(&1.kind == :missing_readme))
    end
  end

  defp set_in(map, [k], fun) when is_function(fun, 1), do: Map.put(map, k, fun.(Map.get(map, k)))
  defp set_in(map, [k], val), do: Map.put(map, k, val)

  defp set_in(map, [k, k2 | rest], val) do
    Map.put(map, k, set_in(Map.get(map, k, %{}), [k2 | rest], val))
  end
end
