defmodule Ensemble.Behavior.Compiler do
  @moduledoc """
  Phase 1 compiler: schema validation, discovery, registries cross-check,
  digest, semver/api_version compatibility, predicate compilation
  (REQ-001..REQ-004; TRD §1.7).

  Public API (contract shared with Matcher/Policy/ToolGuard):

      validate(yaml_or_map, opts \\\\ []) :: {:ok, Definition.t()} | {:error, [ValidationError.t()]}
      discover(root) :: {[Definition.t()], [DiscoveryIssue.t()]}
      select_candidate(name, registry) :: {:ok, Definition.t()} | {:error, :no_compatible_version}
      compatibility(old, new) :: :compatible | :breaking

  Fail-closed: a behavior that fails schema or registry validation
  registers nothing (AC-004). Unknown tool => warning, excluded from the
  grant set (AC-033).
  """

  alias Ensemble.Behavior.{
    Constitution,
    Definition,
    Trigger,
    PolicySpec,
    Capabilities,
    ExecutionSpec,
    Duration,
    Predicate,
    Registries,
    SkillCatalog
  }

  @schema_path "schemas/behavior-v1.schema.json"

  defmodule ValidationError do
    @moduledoc "A single validation failure with location + machine-readable reason."
    defstruct [:field, :reason, :location]

    @type t :: %__MODULE__{
            field: String.t(),
            reason: String.t(),
            location: %{file: String.t() | nil, line: pos_integer() | nil}
          }
  end

  defmodule DiscoveryIssue do
    @moduledoc "Non-fatal discovery observation (missing README, unknown tool warning, etc.)."
    defstruct [:path, :kind, :message]

    @type t :: %__MODULE__{path: String.t(), kind: atom(), message: String.t()}
  end

  @doc """
  Validates raw YAML (binary) or an already-decoded map against the
  behavior-v1 schema + registry cross-checks. On success returns a compiled
  immutable `Definition` carrying sha256 digest of canonical form.
  """
  @spec validate(binary() | map(), keyword()) ::
          {:ok, Definition.t()} | {:error, [ValidationError.t()]}
  def validate(input, opts \\ []) do
    file = Keyword.get(opts, :file)
    reg = Keyword.get(opts, :registries, Registries.all())
    constitution = Keyword.get(opts, :constitution, %{})

    with {:ok, decoded} <- decode(input),
         :ok <- schema_check(decoded, file),
         :ok <- registry_check(decoded, reg, file),
         {:ok, rules} <-
           constitution_check(decoded["constitution_rules"] || [], constitution, file),
         {:ok, defn} <- build(decoded, file, reg, rules) do
      {:ok, %{defn | digest: digest(defn)}}
    else
      {:error, %ValidationError{} = e} -> {:error, [e]}
      {:error, errs} when is_list(errs) -> {:error, errs}
      err -> {:error, [wrap(err, file)]}
    end
  end

  defp wrap(reason, file),
    do: %ValidationError{field: "/", reason: inspect(reason), location: %{file: file, line: nil}}

  defp decode(input) when is_binary(input) do
    case YamlElixir.read_from_string(input) do
      {:ok, map} when is_map(map) -> {:ok, map}
      {:ok, other} -> {:error, {:not_a_map, other}}
      {:error, reason} -> {:error, {:yaml_parse, reason}}
    end
  end

  defp decode(map) when is_map(map), do: {:ok, map}

  defp schema_check(map, file) do
    schema = ExJsonSchema.Schema.resolve(read_schema())

    case ExJsonSchema.Validator.validate(schema, map) do
      :ok ->
        :ok

      {:error, errors} ->
        {:error,
         Enum.map(errors, fn
           {msg, pointer} ->
             %ValidationError{
               field: pointer || "/",
               reason: msg,
               location: %{file: file, line: nil}
             }

           msg when is_binary(msg) ->
             %ValidationError{field: "/", reason: msg, location: %{file: file, line: nil}}
         end)}
    end
  end

  defp registry_check(map, reg, file) do
    with {:ok, _warnings} <- tools_check(map["capabilities"], reg, file),
         :ok <- mutation_check(map["capabilities"], reg, file),
         :ok <- event_check(map, reg, file),
         :ok <- graph_check(map, reg, file),
         :ok <- skills_check(map["execution"], file) do
      :ok
    end
  end

  # An unknown `@skill:` reference cannot be honored at runtime, so it fails
  # closed (AC-045). A *known* skill that is deprecated/revoked resolves fine
  # and only produces a warning — the behavior keeps running and can be
  # bumped in place without redeploy (AC-047).
  defp skills_check(exec, file) do
    exec
    |> Kernel.||(%{})
    |> SkillCatalog.skills_from_raw()
    |> Enum.split_with(&SkillCatalog.known?/1)
    |> case do
      {_, []} ->
        :ok

      {_, unknown} ->
        {:error,
         Enum.map(
           unknown,
           &%ValidationError{
             field: "execution.skills",
             reason: "skill #{inspect(&1)} missing from SkillCatalog (REQ-012 AC-045)",
             location: %{file: file, line: nil}
           }
         )}
    end
  end

  defp constitution_check(declared, ruleset, file) do
    case Constitution.merge(declared, ruleset) do
      {:ok, rules} ->
        {:ok, rules}

      {:error, ids} ->
        {:error,
         Enum.map(ids, fn id ->
           %ValidationError{
             field: "constitution_rules",
             reason: "unknown constitution rule #{inspect(id)} (fail-closed)",
             location: %{file: file, line: nil}
           }
         end)}
    end
  end

  defp tools_check(caps, reg, file) do
    tools = (caps && caps["tools"]) || []
    {known, unknown} = Enum.split_with(tools, &Registries.tool_known?(&1, reg))

    warnings =
      Enum.map(unknown, fn t ->
        %DiscoveryIssue{
          path: file,
          kind: :unknown_tool,
          message: "tool #{inspect(t)} not in ToolRegistry — excluded from grant set (AC-033)"
        }
      end)

    {:ok, %{granted: known, warnings: warnings}}
  end

  defp mutation_check(caps, reg, file) do
    classes = (caps && caps["mutation_classes"]) || ["none"]

    case Enum.reject(classes, &Registries.mutation_known?(&1, reg)) do
      [] ->
        :ok

      bad ->
        {:error,
         Enum.map(
           bad,
           &%ValidationError{
             field: "capabilities.mutation_classes",
             reason: "unknown mutation class #{inspect(&1)} (AC-034)",
             location: %{file: file, line: nil}
           }
         )}
    end
  end

  defp event_check(map, reg, file) do
    trig = map["trigger"]["event_type"]
    outcomes = map["outcomes"] || []

    cond do
      not Registries.event_known?(trig, reg) ->
        {:error,
         [
           %ValidationError{
             field: "trigger.event_type",
             reason: "event type #{inspect(trig)} not registered (fail at validation, plan S1)",
             location: %{file: file, line: nil}
           }
         ]}

      Enum.find(outcomes, &(not Registries.event_known?(&1, reg))) ->
        bad = Enum.find(outcomes, &(not Registries.event_known?(&1, reg)))

        {:error,
         [
           %ValidationError{
             field: "outcomes",
             reason: "event type #{inspect(bad)} not registered",
             location: %{file: file, line: nil}
           }
         ]}

      true ->
        :ok
    end
  end

  defp graph_check(map, reg, file) do
    case map["execution"]["graph"] do
      nil ->
        :ok

      graph ->
        if Registries.workflow_known?(graph, reg) do
          :ok
        else
          {:error,
           [
             %ValidationError{
               field: "execution.graph",
               reason:
                 "workflow graph #{inspect(graph)} missing from WorkflowCatalog (REQ-011 AC-042)",
               location: %{file: file, line: nil}
             }
           ]}
        end
    end
  end

  defp build(map, file, reg, rules) do
    meta = map["metadata"]
    trig = map["trigger"] || %{}
    pol = map["policy"] || %{}
    caps = map["capabilities"] || %{}
    exec = map["execution"] || %{}

    with {:ok, version} <- Version.parse(meta["version"]),
         {:ok, pred_ast} <- Predicate.compile(trig["predicate"]) do
      {:ok, tools} = tools_granted(caps, reg)

      defn = %Definition{
        api_version: map["api_version"],
        name: meta["name"],
        version: version,
        description: meta["description"],
        trigger: %Trigger{event_type: trig["event_type"], predicate: pred_ast},
        policy: %PolicySpec{
          mode: mode_atom(pol["mode"]),
          max_concurrent: pol["max_concurrent"] || 1,
          cooldown: Duration.parse!(pol["cooldown"] || 0),
          timeout: Duration.parse!(pol["timeout"] || 1_800_000),
          max_causal_depth: pol["max_causal_depth"] || 2,
          max_children: pol["max_children"] || 3,
          dedup_window: Duration.parse!(pol["dedup_window"] || 3_600_000),
          retry: %{
            max_attempts: get_in(pol, ["retry", "max_attempts"]) || 0,
            retryable: get_in(pol, ["retry", "retryable"]) || []
          }
        },
        capabilities: %Capabilities{
          tools: tools,
          mutation_classes: caps["mutation_classes"] || ["none"]
        },
        execution: %ExecutionSpec{graph: exec["graph"], params: exec["params"] || %{}},
        outcomes: map["outcomes"] || [],
        constitution_rules: rules,
        source: composition_source(map, file)
      }

      {:ok, defn}
    end
  end

  # Skill refs + composition strategy are composition metadata, not behavior
  # data: they ride on `source` so `Digest.canonical_map/1` stays unchanged
  # (a catalog edit must not silently re-version a behavior) while
  # `Composition` can still read the declared pins off the compiled
  # definition. Keys are atoms, matching the pre-existing `:path`/`:git_sha`
  # shape; nothing is added when the behavior declares no composition data,
  # so such a definition's `source` is byte-identical to the pre-T024 form.
  defp composition_source(map, file) do
    exec = map["execution"] || %{}

    extras =
      %{}
      |> then(fn m ->
        case SkillCatalog.skills_from_raw(exec) do
          [] -> m
          skills -> Map.put(m, :skills, skills)
        end
      end)
      |> then(fn m ->
        case exec["strategy"] do
          nil -> m
          s -> Map.put(m, :strategy, s)
        end
      end)
      |> then(fn m ->
        case exec["prompt"] do
          nil -> m
          pr -> Map.put(m, :prompt, pr)
        end
      end)

    Map.merge(%{path: file, git_sha: nil}, extras)
  end

  defp tools_granted(caps, reg) do
    tools = caps["tools"] || []
    {:ok, Enum.filter(tools, &Registries.tool_known?(&1, reg))}
  end

  # Schema already constrains mode to observe|propose|active, so these atoms
  # are guaranteed loaded; to_atom/1 is safe here.
  defp mode_atom(nil), do: :propose
  defp mode_atom(mode) when mode in ["observe", "propose", "active"], do: String.to_atom(mode)

  defp read_schema do
    path = Path.join(:code.priv_dir(:ensemble) |> List.to_string(), @schema_path)
    path |> File.read!() |> Jason.decode!()
  end

  @doc """
  SHA-256 digest over the canonical (deterministically ordered, key-sorted)
  JSON form of the definition's data portion. Any version-relevant change
  yields a new immutable digest (plan S1).
  """
  @spec digest(Definition.t()) :: binary()
  def digest(%Definition{} = d), do: Ensemble.Behavior.Digest.compute(d)

  @doc """
  Discovers behavior packages under `root`:

      packages/*/behaviors/*/behavior.yaml

  Creates missing fixture subdirs on-demand (AC-005); missing README.md is a
  warning, not a failure (AC-006). Returns `{definitions, issues}`.
  """
  @spec discover(Path.t()) :: {[Definition.t()], [DiscoveryIssue.t()]}
  def discover(root) do
    pattern = Path.join([root, "packages", "*", "behaviors", "*", "behavior.yaml"])

    Path.wildcard(pattern)
    |> Enum.sort()
    |> Enum.flat_map_reduce([], fn yaml_path, issues ->
      package_dir = Path.dirname(yaml_path)
      fixture_issues = ensure_fixture_layout(package_dir)

      case File.read(yaml_path) do
        {:ok, body} ->
          case validate(body, file: yaml_path) do
            {:ok, defn} ->
              readme_issue =
                unless File.exists?(Path.join(package_dir, "README.md")) do
                  [
                    %DiscoveryIssue{
                      path: package_dir,
                      kind: :missing_readme,
                      message: "README.md recommended (AC-006)"
                    }
                  ]
                else
                  []
                end

              {[defn], issues ++ fixture_issues ++ readme_issue}

            {:error, errs} ->
              reason = errs |> Enum.map(& &1.reason) |> Enum.join("; ")

              {[],
               issues ++
                 fixture_issues ++
                 [%DiscoveryIssue{path: yaml_path, kind: :invalid, message: reason}]}
          end

        {:error, reason} ->
          {[],
           issues ++
             fixture_issues ++
             [%DiscoveryIssue{path: yaml_path, kind: :unreadable, message: inspect(reason)}]}
      end
    end)
  end

  @fixtures_subdirs ~w(fixtures/events fixtures/expected-matches fixtures/expected-outcomes)

  defp ensure_fixture_layout(package_dir) do
    base = Path.join(package_dir, "fixtures")

    created =
      Enum.filter(@fixtures_subdirs, fn sub ->
        full = Path.join(package_dir, sub)

        if File.dir?(full) do
          false
        else
          File.mkdir_p!(full)
          true
        end
      end)

    Enum.map(created, fn sub ->
      %DiscoveryIssue{
        path: Path.join(package_dir, sub),
        kind: :created_fixture_dir,
        message: "created missing fixture subdir on-demand (AC-005)"
      }
    end) ++
      if(base != package_dir, do: [], else: [])
  end

  @doc """
  Version/compatibility selection per TRD §1.7 (REQ-003 AC-009..012).

  Walks the same-name definitions newest-first and returns the first
  version compatible with every older definition (its cohort). Any
  newer-but-incompatible versions that were skipped trigger a
  deprecation warning (AC-011).
  """
  @spec select_candidate(String.t(), [Definition.t()]) ::
          {:ok, Definition.t()} | {:error, :no_compatible_version}
  def select_candidate(name, definitions) do
    same_name =
      definitions
      |> Enum.filter(&(&1.name == name))
      |> Enum.sort_by(& &1.version, {:desc, Version})

    case same_name do
      [] ->
        {:error, :no_compatible_version}

      candidates ->
        {selected, newer_incompatible} =
          Enum.reduce_while(candidates, {nil, []}, fn c, {_sel, skipped} ->
            older = Enum.filter(candidates, fn o -> o.version < c.version end)

            if Enum.all?(older, fn o -> compatibility(c, o) == :compatible end) do
              {:halt, {c, skipped}}
            else
              {:cont, {nil, skipped ++ [c]}}
            end
          end)

        cond do
          selected != nil and newer_incompatible != [] ->
            require Logger
            names = newer_incompatible |> Enum.map(&to_string(&1.version)) |> Enum.join(", ")

            Logger.warning(
              "deprecated: #{name} has newer incompatible version(s) #{names}; selecting #{selected.version} (AC-011)"
            )

            {:ok, selected}

          selected != nil ->
            {:ok, selected}

          true ->
            {:error, :no_compatible_version}
        end
    end
  end

  @doc """
  `:compatible` iff same api_version, same trigger event_type + predicate
  field-ops, and same capabilities (v1 -> v1.x rule, AC-009). Any v2+
  major bump or predicate/toolset change => `:breaking` (AC-010).
  """
  @spec compatibility(Definition.t(), Definition.t()) :: :compatible | :breaking
  def compatibility(%Definition{} = old, %Definition{} = new) do
    cond do
      old.name != new.name ->
        :breaking

      old.api_version != new.api_version ->
        :breaking

      old.version.major != new.version.major ->
        :breaking

      old.trigger.event_type != new.trigger.event_type ->
        :breaking

      predicate_signature(old.trigger.predicate) != predicate_signature(new.trigger.predicate) ->
        :breaking

      Enum.sort(old.capabilities.tools) != Enum.sort(new.capabilities.tools) ->
        :breaking

      Enum.sort(old.capabilities.mutation_classes) != Enum.sort(new.capabilities.mutation_classes) ->
        :breaking

      true ->
        :compatible
    end
  end

  defp predicate_signature(ast) do
    ast
    |> Enum.map(&{Enum.join(&1.path, "."), &1.op})
    |> Enum.sort()
  end
end
