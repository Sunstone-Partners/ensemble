defmodule Ensemble.Behavior.ToolGuardTest do
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.{Capabilities, Compiler, Definition, Registries, ToolGuard}

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "tg", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "github.push"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  # Registry truth read straight from disk, so the suite never depends on
  # a started Registries process (ToolGuard must stay process-free).
  @disk Registries.all()

  # ---------------------------------------------------------------- resolve

  describe "resolve/2 (AC-033)" do
    test "returns the declared grant list in declaration order" do
      defn = defn_with(%{"tools" => ["read", "grep", "edit"]})
      assert {:ok, ["read", "grep", "edit"]} = ToolGuard.resolve(defn, @disk)
    end

    test "empty grant list resolves to an empty list" do
      defn = defn_with(%{"tools" => []})
      assert {:ok, []} = ToolGuard.resolve(defn, @disk)
    end

    test "namespaced registry ids are granted verbatim" do
      defn = defn_with(%{"tools" => ["ensemble.artifact.write"]})
      assert {:ok, ["ensemble.artifact.write"]} = ToolGuard.resolve(defn, @disk)
    end

    test "a tool absent from the registry fails the whole resolve" do
      defn = synthetic(["read", "not.in.registry"])
      assert {:error, :unknown_tool} = ToolGuard.resolve(defn, @disk)
    end

    test "unknown tool denies even the known siblings (no partial grant)" do
      defn = synthetic(["read", "ensemble.does.not.exist"])
      assert {:error, :unknown_tool} = ToolGuard.resolve(defn, @disk)
    end

    test "empty snapshot grants nothing" do
      defn = synthetic(["read"])
      assert {:error, :unknown_tool} = ToolGuard.resolve(defn, empty_registries())
    end

    test "resolver never starts a registry process" do
      assert Process.whereis(Registries) == nil
      defn = defn_with(%{"tools" => ["read"]})
      assert {:ok, ["read"]} = ToolGuard.resolve(defn)
      assert Process.whereis(Registries) == nil
    end

    test "nil snapshot falls back to the disk registry" do
      defn = defn_with(%{"tools" => ["read"]})
      assert ToolGuard.resolve(defn, nil) == ToolGuard.resolve(defn, @disk)
    end

    test "atom-declared tools canonicalize to binaries" do
      defn = synthetic([:read, :grep])
      assert {:ok, ["read", "grep"]} = ToolGuard.resolve(defn, @disk)
    end
  end

  # ----------------------------------------------------------- check_access

  describe "check_access/2 (AC-038, fail closed)" do
    test "granted binary tool is allowed" do
      assert :ok = ToolGuard.check_access("read", ["read", "grep"])
    end

    test "atom tool matches a binary grant" do
      assert :ok = ToolGuard.check_access(:read, ["read"])
    end

    test "binary tool matches an atom grant" do
      assert :ok = ToolGuard.check_access("read", [:read])
    end

    test "undeclared tool is denied" do
      assert {:error, :tool_not_granted} = ToolGuard.check_access("write", ["read"])
    end

    test "empty grant list denies everything" do
      assert {:error, :tool_not_granted} = ToolGuard.check_access("read", [])
    end

    test "nil grant list denies (fail closed, no crash)" do
      assert {:error, :tool_not_granted} = ToolGuard.check_access("read", nil)
    end

    test "nil and boolean tools are denied" do
      assert {:error, :tool_not_granted} = ToolGuard.check_access(nil, ["read"])
      assert {:error, :tool_not_granted} = ToolGuard.check_access(true, ["read"])
    end

    test "namespaced and bare spellings are distinct grants" do
      # Canonicalization for the grant check is to_string only: a grant of
      # the namespaced tool must not silently authorize the bare one.
      assert {:error, :tool_not_granted} =
               ToolGuard.check_access("write", ["ensemble.artifact.write"])

      assert :ok = ToolGuard.check_access("ensemble.artifact.write", ["ensemble.artifact.write"])
    end

    test "a grant cannot widen to a sibling under the same namespace" do
      granted = ["ensemble.github.pr_comment"]
      assert {:error, :tool_not_granted} = ToolGuard.check_access("ensemble.github.pr_merge", granted)
    end

    test "prefix-less dotted ids pass through untouched" do
      assert :ok = ToolGuard.check_access("git.push", ["git.push"])
      assert {:error, :tool_not_granted} = ToolGuard.check_access("git.push", ["push"])
    end
  end

  # ------------------------------------------------- naming seam (LANDMINE)

  describe "tools_for_class/2 — the registry naming seam" do
    test "artifact.write enforces the bare write/edit tools" do
      assert ToolGuard.tools_for_class("artifact.write", @disk) == ["edit", "write"]
    end

    test "pr.open enforces gh.pr_create and git.push" do
      assert ToolGuard.tools_for_class("pr.open", @disk) == ["gh.pr_create", "git.push"]
    end

    test "class tools are canonicalised: namespaced registry ids lose the prefix" do
      assert ToolGuard.tools_for_class("comment", @disk) ==
               ["beads.comment", "github.pr_comment", "gitlab.mr_comment", "jira.comment",
                "linear.issue_comment", "slack.post"]
    end

    test "the class named `none` enforces no tools" do
      assert ToolGuard.tools_for_class("none", @disk) == []
    end

    test "unknown class yields no enforcing tools" do
      assert ToolGuard.tools_for_class("chaos", @disk) == []
    end

    test "raw-string intersection is the bug this seam exists to fix" do
      declaring = ["ensemble.artifact.write"]

      # Without normalisation, a namespaced grant looks like it enforces nothing.
      assert [] == Enum.filter(Registries.tools_for_mutation("artifact.write", @disk), &(&1 in declaring))

      # With it, the class is recognisable from the namespaced grant.
      assert {:ok, "artifact.write"} = ToolGuard.check_mutation("ensemble.artifact.write", declaring, @disk)
    end
  end

  # -------------------------------------------------- mutation-class link

  describe "check_mutation/3 (AC-035)" do
    test "namespaced grant resolves to the class its bare tool enforces" do
      assert {:ok, "artifact.write"} =
               ToolGuard.check_mutation("ensemble.artifact.write", ["ensemble.artifact.write"], @disk)
    end

    test "bare grant resolves through the same mapping" do
      assert {:ok, "artifact.write"} = ToolGuard.check_mutation("write", ["write"], @disk)
    end

    test "pr.open class is reachable from gh.pr_create" do
      assert {:ok, "pr.open"} = ToolGuard.check_mutation("gh.pr_create", ["gh.pr_create"], @disk)
    end

    test "a tool that enforces no class reports :no_class" do
      assert {:error, :no_class} = ToolGuard.check_mutation("read", ["read"], @disk)
      assert {:error, :no_class} = ToolGuard.check_mutation("bash.test", ["bash.test"], @disk)
    end

    test "an ungranted tool never borrows another behaviour's class" do
      assert {:error, :tool_not_granted} =
               ToolGuard.check_mutation("write", ["ensemble.artifact.write"], @disk)
    end

    test "`none` is never reported as an enforced class" do
      assert {:error, :no_class} = ToolGuard.check_mutation("read", ["read", "none"], @disk)
    end

    test "denied before classified: grant check runs first" do
      assert {:error, :tool_not_granted} = ToolGuard.check_mutation("secret.tool", [], @disk)
    end
  end

  # ------------------------------------------------------------ authority

  describe "mutation_allowed?/2 (AC-035/AC-036)" do
    test "declared class is allowed" do
      assert ToolGuard.mutation_allowed?("artifact.write", ["artifact.write"])
    end

    test "undeclared class is denied" do
      refute ToolGuard.mutation_allowed?("artifact.write", [])
    end

    test "`none` is only allowed when declared" do
      assert ToolGuard.mutation_allowed?("none", ["none"])
      refute ToolGuard.mutation_allowed?("none", ["artifact.write"])
    end

    test "unknown class is denied" do
      refute ToolGuard.mutation_allowed?("chaos", ["artifact.write"], @disk)
      refute ToolGuard.mutation_allowed?("chaos", ["chaos"], @disk)
    end

    test "atom-form class and atom-form declarations match" do
      # Class ids in the registry are dotted binaries; an atom is just an
      # accepted spelling of the same name, not of a different one.
      assert ToolGuard.mutation_allowed?(:"artifact.write", [:"artifact.write"], @disk)
      assert ToolGuard.mutation_allowed?("artifact.write", [:"artifact.write"], @disk)
      refute ToolGuard.mutation_allowed?(:artifact_write, [:artifact_write], @disk)
    end

    test "namespaced class spelling resolves to the registered class" do
      assert ToolGuard.mutation_allowed?("ensemble.artifact.write", ["artifact.write"])
      assert ToolGuard.mutation_allowed?("artifact.write", ["ensemble.artifact.write"])
    end

    test "a tool grant alone never confers mutation authority (AC-036)" do
      classes = ["none"]
      granted = ["ensemble.artifact.write"]

      assert :ok = ToolGuard.check_access("ensemble.artifact.write", granted)
      refute ToolGuard.mutation_allowed?("artifact.write", classes)
    end

    test "declared classes are never unioned across behaviours (AC-036)" do
      a = defn_with(%{"tools" => ["write"], "mutation_classes" => ["artifact.write"]})
      b = defn_with(%{"tools" => ["ensemble.github.pr_comment"], "mutation_classes" => ["comment"]})

      assert ToolGuard.mutation_allowed?("artifact.write", a.capabilities.mutation_classes)
      refute ToolGuard.mutation_allowed?("comment", a.capabilities.mutation_classes)
      assert ToolGuard.mutation_allowed?("comment", b.capabilities.mutation_classes)
      refute ToolGuard.mutation_allowed?("artifact.write", b.capabilities.mutation_classes)
    end

    test "malformed declaration list denies" do
      refute ToolGuard.mutation_allowed?("artifact.write", nil)
      refute ToolGuard.mutation_allowed?(nil, ["artifact.write"])
    end
  end

  # ---------------------------------------------------------- canonical ids

  describe "canonical_tool/1" do
    test "strips the ensemble namespace" do
      assert ToolGuard.canonical_tool("ensemble.artifact.write") == "artifact.write"
      assert ToolGuard.canonical_tool(:edit) == "edit"
    end

    test "leaves third-party and bare ids intact" do
      assert ToolGuard.canonical_tool("git.push") == "git.push"
      assert ToolGuard.canonical_tool("gh.pr_create") == "gh.pr_create"
      assert ToolGuard.canonical_tool("read") == "read"
    end

    test "a bare `ensemble.` is not a tool" do
      assert ToolGuard.canonical_tool("ensemble.") == "ensemble."
    end
  end

  # ------------------------------------------------------------- end to end

  describe "grant + authority composed" do
    test "the seam case from the module doc" do
      defn =
        defn_with(%{
          "tools" => ["ensemble.artifact.write", "read"],
          "mutation_classes" => ["artifact.write"]
        })

      assert {:ok, granted} = ToolGuard.resolve(defn, @disk)
      assert :ok = ToolGuard.check_access("ensemble.artifact.write", granted)
      assert {:error, :tool_not_granted} = ToolGuard.check_access("write", granted)
      assert ToolGuard.tools_for_class("artifact.write", @disk) == ["edit", "write"]
      assert ToolGuard.mutation_allowed?("artifact.write", defn.capabilities.mutation_classes)
      refute ToolGuard.mutation_allowed?("pr.open", defn.capabilities.mutation_classes)
    end

    test "revoking the class declaration strips authority, not the grant" do
      defn = defn_with(%{"tools" => ["write"], "mutation_classes" => ["none"]})
      assert {:ok, granted} = ToolGuard.resolve(defn, @disk)
      assert :ok = ToolGuard.check_access("write", granted)
      refute ToolGuard.mutation_allowed?("artifact.write", defn.capabilities.mutation_classes)
    end
  end

  # ---------------------------------------------------------------- fixtures

  defp defn_with(capabilities) do
    {:ok, defn} =
      @base
      |> deep_merge(%{"capabilities" => capabilities})
      |> Compiler.validate()

    defn
  end

  # Bypasses the Compiler's registry filter so the guard's own cross-check
  # is what gets exercised.
  defp synthetic(tools, classes \\ ["none"]) do
    %Definition{
      name: "synthetic",
      version: Version.parse!("1.0.0"),
      capabilities: %Capabilities{tools: tools, mutation_classes: classes}
    }
  end

  defp empty_registries do
    %Registries{
      tools: MapSet.new(),
      mutation_classes: %{},
      events: MapSet.new(),
      workflows: MapSet.new()
    }
  end

  defp deep_merge(left, right) do
    Map.merge(left, right, fn _k, l, r ->
      if is_map(l) and is_map(r), do: deep_merge(l, r), else: r
    end)
  end
end
