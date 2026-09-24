defmodule Ensemble.Behavior.CompositionTest do
  use ExUnit.Case, async: false

  alias Ensemble.Behavior.{Compiler, Composition, Definition, Event, ExecutionSpec, Registries, SkillCatalog}

  @seed_yaml File.read!(Path.join(__DIR__, "../../../behaviors/test-failure/behavior.yaml"))

  # The root that `Compiler.discover/1` runs against: the directory holding
  # `packages/*/behaviors/*/behavior.yaml`. Resolved by walking up from this
  # file until the seed fixture is found, so the depth never has to be
  # hard-coded and a leftover tmp tree under `packages/core/` cannot shadow it.
  defp repo_root do
    case ancestor_with_seeds(Path.expand(__DIR__)) do
      {:ok, root} -> root
      :error -> raise "no seeded behavior.yaml found above #{Path.expand(__DIR__)}"
    end
  end

  defp ancestor_with_seeds(dir) do
    cond do
      seeded_behaviors(dir) != [] -> {:ok, dir}
      Path.dirname(dir) == dir -> :error
      true -> ancestor_with_seeds(Path.dirname(dir))
    end
  end

  defp seeded_behaviors(root) do
    Path.wildcard(Path.join([root, "packages", "*", "behaviors", "*", "behavior.yaml"]))
    |> Enum.reject(&String.contains?(&1, "/tmp/"))
    |> Enum.sort()
  end

  setup do
    {:ok, _pid} = start_supervised({Registries, []})
    :ok
  end

  defp exec(extra) do
    %{
      "api_version" => "ensemble.sunstone.dev/v1",
      "kind" => "Behavior",
      "metadata" => %{"name" => "wf-compose", "version" => "1.0.0", "description" => "d"},
      "trigger" => %{"event_type" => "test.failed"},
      "capabilities" => %{"tools" => ["read", "grep"], "mutation_classes" => ["artifact.write"]},
      "execution" =>
        %{"graph" => "investigate-test-failure", "params" => %{"channel" => "#eng"}} |> Map.merge(extra),
      "outcomes" => ["test.failure.investigated", "ensemble.behavior.executed"]
    }
  end

  defp defn(params, graph \\ "investigate-test-failure") do
    %Definition{execution: %ExecutionSpec{graph: graph, params: params}}
  end

  defp event(overrides \\ []) do
    base = [
      event_id: "e-42",
      event_type: "test.failed",
      subject_id: "repo-1",
      source: :github,
      project_id: "p-9",
      correlation_id: "c-1",
      actor: %{type: :user, id: "u-7"},
      payload: %{
        "command" => "mix test",
        "exit_code" => 1,
        "pull_request" => %{"draft" => false, "number" => 42},
        "tags" => ["a", "$.event_id", "b"]
      }
    ]

    Event.build(Keyword.merge(base, overrides))
  end

  describe "resolve_graph/2 (AC-041, AC-042)" do
    test "resolves a catalogued graph to its name" do
      {:ok, d} = Compiler.validate(@seed_yaml)
      assert {:ok, %{graph: "investigate-test-failure"}} = Composition.resolve_graph(d)
    end

    test "unknown graph fails closed" do
      assert {:error, :workflow_missing} = Composition.resolve_graph(defn(%{}, "no.such.workflow"))
    end

    test "falls back to the behavior name when no graph is declared" do
      d = %Definition{
        name: "investigate-test-failure",
        execution: %ExecutionSpec{graph: nil, params: %{}}
      }

      assert {:ok, %{graph: "investigate-test-failure"}} = Composition.resolve_graph(d)
    end

    test "name fallback also fails closed when the catalog lacks it" do
      d = %Definition{name: "never-registered", execution: %ExecutionSpec{graph: nil, params: %{}}}
      assert {:error, :workflow_missing} = Composition.resolve_graph(d)
    end
  end

  describe "bind_params/2 (AC-043)" do
    test "literals pass through untouched" do
      assert {:ok, %{"a" => 1, "b" => true, "c" => "x"}} =
               Composition.bind_params(defn(%{"a" => 1, "b" => true, "c" => "x"}), event())
    end

    test "envelope refs resolve off the event" do
      params = %{
        "eid" => "$.event_id",
        "etype" => "$.event_type",
        "subject" => "$.subject_id",
        "src" => "$.source",
        "proj" => "$.project_id",
        "corr" => "$.correlation_id",
        "who" => "$.actor.id"
      }

      assert {:ok, bound} = Composition.bind_params(defn(params), event())

      assert bound == %{
               "eid" => "e-42",
               "etype" => "test.failed",
               "subject" => "repo-1",
               "src" => :github,
               "proj" => "p-9",
               "corr" => "c-1",
               "who" => "u-7"
             }
    end

    test "payload dotted paths resolve into the string-keyed payload" do
      assert {:ok, %{"cmd" => "mix test", "pr" => 42}} =
               Composition.bind_params(
                 defn(%{"cmd" => "$.payload.command", "pr" => "$.payload.pull_request.number"}),
                 event()
               )
    end

    test "a whole sub-object is a legal payload value" do
      assert {:ok, %{"pr" => %{"draft" => false, "number" => 42}}} =
               Composition.bind_params(defn(%{"pr" => "$.payload.pull_request"}), event())
    end

    test "false and 0 bind as values, not as absence" do
      assert {:ok, %{"d" => false, "x" => 1}} =
               Composition.bind_params(
                 defn(%{"d" => "$.payload.pull_request.draft", "x" => "$.payload.exit_code"}),
                 event()
               )
    end

    test "missing payload path fails closed naming the param, never nil-fills" do
      assert {:error, {:param_unresolved, "missing"}} =
               Composition.bind_params(defn(%{"missing" => "$.payload.nope"}), event())
    end

    test "unknown envelope ref fails closed" do
      assert {:error, {:param_unresolved, "m"}} =
               Composition.bind_params(defn(%{"m" => "$.not_a_field"}), event())
    end

    test "a nil-valued envelope field fails closed" do
      assert {:error, {:param_unresolved, "m"}} =
               Composition.bind_params(defn(%{"m" => "$.causation_id"}), event())
    end

    test "a path that bottoms out in a scalar fails closed" do
      assert {:error, {:param_unresolved, "m"}} =
               Composition.bind_params(defn(%{"m" => "$.payload.command.deeper"}), event())
    end

    test "maps and lists recurse; one bad element fails the param" do
      params = %{
        "tpl" => %{"id" => "$.event_id", "hard" => %{"deep" => "$.payload.pull_request.number"}},
        "list" => ["lit", "$.subject_id", %{"k" => "$.project_id"}],
        "tags" => "$.payload.tags"
      }

      assert {:ok, bound} = Composition.bind_params(defn(params), event())
      assert bound["tpl"] == %{"id" => "e-42", "hard" => %{"deep" => 42}}
      assert bound["list"] == ["lit", "repo-1", %{"k" => "p-9"}]
      # strings carried inside a payload value are data, not references
      assert bound["tags"] == ["a", "$.event_id", "b"]

      assert {:error, {:param_unresolved, "list"}} =
               Composition.bind_params(defn(%{"list" => ["ok", "$.payload.absent"]}), event())
    end

    test "binds from a plain wire map with string keys" do
      plain = %{"event_id" => "e-1", "payload" => %{"command" => "pytest"}}

      assert {:ok, %{"c" => "pytest", "e" => "e-1"}} =
               Composition.bind_params(defn(%{"c" => "$.payload.command", "e" => "$.event_id"}), plain)
    end
  end

  describe "build_workflow_input/2 (AC-044)" do
    test "workflow gets every declared param plus the event as context" do
      d = defn(%{"cmd" => "$.payload.command", "static" => 7})
      ev = event()
      assert {:ok, input} = Composition.build_workflow_input(d, ev)
      assert input.graph == "investigate-test-failure"
      assert input.params == %{"cmd" => "mix test", "static" => 7}
      assert input.event == ev
    end

    test "graph checked first — a missing workflow composes nothing" do
      assert {:error, :workflow_missing} =
               Composition.build_workflow_input(defn(%{"bad" => "$.payload.absent"}, "nope"), event())
    end

    test "unresolvable param aborts the whole input" do
      assert {:error, {:param_unresolved, "bad"}} =
               Composition.build_workflow_input(defn(%{"ok" => 1, "bad" => "$.payload.absent"}), event())
    end
  end

  describe "skill references + SkillCatalog (AC-045)" do
    test "declared refs and inline prompt refs both become skill names" do
      assert SkillCatalog.skills_from_raw(%{
               "skills" => ["@skill:file-reader", "@skill:log-search"],
               "prompt" => "use @skill:test-detector then summarize"
             }) == ["file-reader", "log-search", "test-detector"]
    end

    test "duplicates collapse, order preserved" do
      assert SkillCatalog.skills_from_raw(%{"skills" => ["@skill:file-reader", "@skill:file-reader"]}) ==
               ["file-reader"]
    end

    test "no execution / empty execution yields no skills" do
      assert SkillCatalog.skills_from_raw(nil) == []
      assert SkillCatalog.skills_from_raw(%{}) == []
    end

    test "catalog resolves a known skill pinned by digest" do
      assert {:ok, skill} = SkillCatalog.resolve("file-reader")
      assert skill.name == "file-reader"
      assert skill.status == "active"
      assert "sha256:" <> hex = skill.digest
      assert String.length(hex) == 64
    end

    test "unknown skill fails closed" do
      assert {:error, {:skill_unknown, "not-a-skill"}} = SkillCatalog.resolve("not-a-skill")
      refute SkillCatalog.known?("not-a-skill")
    end

    test "every catalog entry carries a sha256 pin" do
      skills = SkillCatalog.all()
      assert length(skills) >= 8

      for s <- skills do
        assert "sha256:" <> hex = s.digest
        assert String.length(hex) == 64
      end
    end

    test "pins match the shipped skill files they point at" do
      repo = repo_root()
      checked = Enum.filter(SkillCatalog.all(), fn s -> s.source && File.regular?(Path.join(repo, s.source)) end)
      assert length(checked) >= 4

      for s <- checked do
        body = File.read!(Path.join(repo, s.source))
        assert s.digest == "sha256:" <> (:crypto.hash(:sha256, body) |> Base.encode16(case: :lower))
      end
    end

    test "strategy vocabulary + max skill count are exposed" do
      assert SkillCatalog.strategies() == [:sequential, :parallel]
      assert SkillCatalog.max_skills() == 8
    end
  end

  describe "skills/2 + strategy/1 off a compiled definition (AC-046, AC-048)" do
    test "compiled behavior surfaces its pinned skills and strategy" do
      {:ok, d} =
        exec(%{"skills" => ["@skill:file-reader", "@skill:log-search"], "strategy" => "parallel"})
        |> Compiler.validate()

      assert Composition.skill_names(d) == ["file-reader", "log-search"]
      assert Composition.strategy(d) == :parallel

      assert {:ok, [one, two]} = Composition.skills(d)
      assert Enum.map([one, two], & &1.name) == ["file-reader", "log-search"]
      assert one.digest == SkillCatalog.all() |> Enum.find(&(&1.name == "file-reader")) |> Map.get(:digest)
      assert Composition.digest_pins(d) == [{"file-reader", one.digest}, {"log-search", two.digest}]
    end

    test "strategy defaults to sequential when undeclared" do
      {:ok, d} = exec(%{}) |> Compiler.validate()
      assert Composition.strategy(d) == :sequential
      assert Composition.skills(d) == {:ok, []}
      assert Composition.digest_pins(d) == []
    end

    test "an unknown skill reference fails closed at validate (AC-045)" do
      assert {:error, errs} = exec(%{"skills" => ["@skill:nope-not-listed"]}) |> Compiler.validate()
      assert Enum.any?(errs, &(&1.field == "execution.skills"))
    end

    test "skills_with_errors reports every unknown name in one pass" do
      d = %Definition{source: %{skills: ["@skill:file-reader", "@skill:ghost"]}}
      {resolved, errors} = Composition.skills_with_errors(d)
      assert Enum.map(resolved, & &1.name) == ["file-reader"]
      assert errors == [{"ghost", {:skill_unknown, "ghost"}}]
    end

    test "inline @skill refs in execution.prompt are composed" do
      {:ok, d} = exec(%{"prompt" => "run @skill:test-detector"}) |> Compiler.validate()
      assert Composition.skill_names(d) == ["test-detector"]
    end
  end

  describe "lifecycle warnings (AC-047)" do
    test "deprecated and revoked skills warn but still resolve" do
      {:ok, dep} = SkillCatalog.resolve("changelog-generator")
      {:ok, rev} = SkillCatalog.resolve("graph-query")
      assert dep.status == "deprecated"
      assert rev.status == "revoked"

      d = %Definition{
        source: %{skills: ["@skill:changelog-generator", "@skill:graph-query", "@skill:file-reader"]}
      }

      flags = Composition.lifecycle(d)
      assert Enum.map(flags, & &1.skill) == ["changelog-generator", "graph-query"]
      assert Enum.all?(flags, &(&1.kind == :skill_lifecycle))
      assert hd(flags).migrations != []
    end

    test "a deprecated skill does not fail validation — in-place bump, no redeploy" do
      assert {:ok, _} = exec(%{"skills" => ["@skill:changelog-generator"]}) |> Compiler.validate()
    end

    test "catalog accepts an injected snapshot so a pin can move without redeploy" do
      catalog = %{"skills" => [%{"name" => "file-reader", "digest" => "sha256:aaa", "status" => "active"}]}
      assert {:ok, %{digest: "sha256:aaa"}} = SkillCatalog.resolve("file-reader", catalog)
      assert {:error, {:skill_unknown, "log-search"}} = SkillCatalog.resolve("log-search", catalog)
    end
  end

  describe "schema (additive execution.skills / execution.strategy)" do
    test "seed behavior.yaml validates unchanged" do
      assert {:ok, %Definition{}} = Compiler.validate(@seed_yaml)
    end

    test "a malformed skill ref is rejected by the schema" do
      assert {:error, errs} = exec(%{"skills" => ["file-reader"]}) |> Compiler.validate()
      assert Enum.any?(errs, &String.contains?(&1.reason, "pattern"))
    end

    test "an unknown strategy is rejected by the schema" do
      assert {:error, errs} = exec(%{"strategy" => "diagonal"}) |> Compiler.validate()
      assert Enum.any?(errs, &(&1.field =~ "strategy"))
    end

    test "more than 8 skills is rejected by the schema" do
      skills = for n <- 1..9, do: "@skill:skill-#{n}"
      assert {:error, errs} = exec(%{"skills" => skills}) |> Compiler.validate()
      assert Enum.any?(errs, &(&1.field =~ "skills"))
    end

    test "skills and strategy ride on source, not on the digest inputs" do
      {:ok, plain} = exec(%{}) |> Compiler.validate()
      {:ok, composed} = exec(%{"skills" => ["@skill:file-reader"], "strategy" => "parallel"}) |> Compiler.validate()
      # composition metadata is catalog state, so it must not re-version the behavior
      assert plain.digest == composed.digest
      assert composed.source.skills == ["file-reader"]
      assert composed.source.strategy == "parallel"
      # a behavior with no composition data keeps the pre-T024 source shape
      refute Map.has_key?(plain.source, :skills)
      refute Map.has_key?(plain.source, :strategy)
    end
  end

  describe "discovery" do
    @tag :tmp_dir
    test "a packaged behavior with skills + strategy composes end to end", %{tmp_dir: tmp} do
      dir = Path.join([tmp, "packages", "demo", "behaviors", "composed"])
      File.mkdir_p!(dir)

      File.write!(
        Path.join(dir, "behavior.yaml"),
        """
        api_version: ensemble.sunstone.dev/v1
        kind: Behavior
        metadata:
          name: demo-composed
          version: 1.0.0
          description: Composes two skills in parallel.
        trigger:
          event_type: test.failed
        capabilities:
          tools: [read, grep]
          mutation_classes: [artifact.write]
        execution:
          graph: investigate-test-failure
          params:
            command: "$.payload.command"
          skills:
            - "@skill:file-reader"
            - "@skill:log-search"
          strategy: parallel
        outcomes:
          - test.failure.investigated
        """
      )

      File.write!(Path.join([tmp, "packages", "demo", "behaviors", "composed", "README.md"]), "# composed\n")
      {defns, issues} = Compiler.discover(tmp)
      # fixture subdirs are created on demand (AC-005); the package ships its
      # README, so no real finding should remain.
      assert Enum.all?(issues, &(&1.kind == :created_fixture_dir))
      assert [%Definition{} = d] = defns
      assert Composition.skill_names(d) == ["file-reader", "log-search"]
      assert Composition.strategy(d) == :parallel
      assert {:ok, [a, b]} = Composition.skills(d)
      assert Enum.map([a, b], & &1.name) == ["file-reader", "log-search"]

      assert {:ok, input} = Composition.build_workflow_input(d, event())
      assert input.params == %{"command" => "mix test"}
      assert input.graph == "investigate-test-failure"
    end

    test "every seeded behavior.yaml in the repo still composes" do
      root = repo_root()
      {defns, issues} = Compiler.discover(root)

      assert defns != []

      assert Enum.all?(issues, fn i ->
               i.kind in [:missing_readme, :created_fixture_dir]
             end)

      for d <- defns do
        assert {:ok, _} = Composition.resolve_graph(d)
        assert {:ok, _} = Composition.skills(d)
      end
    end
  end
end
