defmodule Ensemble.Behavior.RegistryTest do
  use Ensemble.Behavior.TestCase, async: true

  alias Ensemble.Behavior.{Compiler, Definition, Registry}

  defp defn(name, version, overrides \\ %{}) do
    base = %Definition{
      name: name,
      version: Version.parse!(version),
      description: "d",
      trigger: %Ensemble.Behavior.Trigger{event_type: "github.push", predicate: []},
      policy: %Ensemble.Behavior.PolicySpec{
        mode: :observe,
        max_concurrent: 1,
        cooldown: 0,
        timeout: 1_800_000,
        max_causal_depth: 2,
        max_children: 3,
        dedup_window: 3_600_000,
        retry: %{max_attempts: 0, retryable: []}
      },
      capabilities: %Ensemble.Behavior.Capabilities{tools: [], mutation_classes: ["none"]},
      execution: %Ensemble.Behavior.ExecutionSpec{graph: nil, params: %{}},
      outcomes: [],
      constitution_rules: [],
      source: %{path: nil, git_sha: nil}
    }

    struct!(base, overrides)
  end

  setup do
    name = String.to_atom("reg_test_" <> Integer.to_string(System.unique_integer([:positive])))
    {:ok, pid} = Registry.start_link(name: name)
    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)
    %{server: name}
  end

  test "register + lookup + all", %{server: s} do
    d = defn("a.b", "1.0.0")
    assert :ok = Registry.register(d, s)
    assert {:ok, ^d} = Registry.lookup("a.b", s)
    assert Registry.all(s) == [d]
  end

  test "idempotent re-register same digest", %{server: s} do
    d = defn("a.b", "1.0.0")
    assert :ok = Registry.register(d, s)
    assert :ok = Registry.register(d, s)
    assert length(Registry.all(s)) == 1
  end

  test "digest conflict returns error tuple", %{server: s} do
    assert :ok = Registry.register(defn("a.b", "1.0.0"), s)
    other = defn("a.b", "1.0.0", description: "changed")
    assert {:error, {:digest_conflict, msg}} = Registry.register(other, s)
    assert msg =~ "already registered with a different digest"
  end

  test "lookup selects highest compatible version", %{server: s} do
    Registry.register(defn("a.b", "1.0.0"), s)
    Registry.register(defn("a.b", "1.2.0"), s)
    Registry.register(defn("a.b", "2.0.0"), s)
    assert {:ok, d} = Registry.lookup("a.b", s)
    assert d.version == Version.parse!("1.2.0")
  end

  test "unknown name errors", %{server: s} do
    assert {:error, :no_compatible_version} = Registry.lookup("nope", s)
  end

  test "clear empties registry", %{server: s} do
    Registry.register(defn("a.b", "1.0.0"), s)
    assert :ok = Registry.clear(s)
    assert Registry.all(s) == []
  end

  test "digest is deterministic across struct field order", %{server: _s} do
    d1 =
      defn("a.b", "1.0.0",
        execution: %Ensemble.Behavior.ExecutionSpec{graph: nil, params: %{"z" => 1, "a" => 2}}
      )

    d2 =
      defn("a.b", "1.0.0",
        execution: %Ensemble.Behavior.ExecutionSpec{graph: nil, params: %{"a" => 2, "z" => 1}}
      )

    assert Compiler.digest(d1) == Compiler.digest(d2)
  end
end
