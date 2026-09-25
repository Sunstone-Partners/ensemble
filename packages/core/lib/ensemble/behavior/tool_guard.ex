defmodule Ensemble.Behavior.ToolGuard do
  @moduledoc """
  Tool-grant enforcement for a single compiled `Definition` (TRD §1.7
  lines 236-240, §4.2 lines 546-569; REQ-009 AC-033/AC-038, REQ-010
  AC-036/AC-037, REQ-026 AC-093).

  It answers exactly two independent questions, and the answers never
  imply one another:

  1. *May this invocation call tool T?* — `resolve/2` produces the grant
     list, `check_access/2` enforces it at call time (fail closed).
  2. *May this activation produce mutation class M?* —
     `mutation_allowed?/3` reads `capabilities.mutation_classes`.

  Granting a tool that happens to enforce a mutation class is **not**
  mutation authority: `"ensemble.artifact.write"` grants the tool, while
  class `"artifact.write"` is enforced by the bare tools `["write",
  "edit"]` and is only authorized when declared in `mutation_classes`
  (AC-035/AC-036).

  ## Naming seam: canonical form is the bare id

  `priv/registries/tools.json` registers both bare and namespaced ids
  (`"write"`, `"edit"`, `"read"` vs `"ensemble.artifact.write"`,
  `"ensemble.pr.open"`), while `mutation_classes.json` maps each class to
  **bare** ids only (`"artifact.write" => ["write", "edit"]`,
  `"pr.open" => ["gh.pr_create", "git.push"]`). A raw-string intersection
  of the two sides therefore silently yields `[]` — a namespaced grant
  would look like it enforces no mutation class at all.

  Rule: **the bare id is canonical for mutation-class matching.** Before
  a tool is compared with a class's enforcing set, a leading `"ensemble."`
  prefix is stripped (`canonical_tool/1`), so the namespaced grant
  `"ensemble.artifact.write"` is recognised as the tool `artifact.write`
  enforces — but only because the registry really maps that class to the
  bare `write`; the mapping, not the spelling, is authoritative. Prefix
  stripping is reserved for `ensemble.`-namespaced ids, so third-party ids
  such as `"git.push"` and `"gh.pr_create"` pass through untouched and no
  bare id can be mistaken for a class name. Every other comparison — the
  grant list in `check_access/2`, the ToolRegistry cross-check in
  `resolve/2` — stays raw-string, so a grant can never widen to an
  undeclared sibling tool.

  Worked example — declare the tool, declare the class, get both answers:

      capabilities:
        tools: ["ensemble.artifact.write"]
        mutation_classes: ["artifact.write"]

      ToolGuard.resolve(defn)
      # => {:ok, ["ensemble.artifact.write"]}

      ToolGuard.check_access("ensemble.artifact.write", granted)
      # => :ok                       # the tool call is permitted

      ToolGuard.check_access("write", granted)
      # => {:error, :tool_not_granted}  # enforcing tool not declared

      ToolGuard.tools_for_class("artifact.write")
      # => ["write", "edit"]         # canonical bare names

      ToolGuard.check_mutation("ensemble.artifact.write", granted)
      # => {:ok, "artifact.write"}   # registry maps that tool to this class

      ToolGuard.mutation_allowed?("artifact.write", defn.capabilities.mutation_classes)
      # => true                      # authority comes from the declaration

  Drop `mutation_classes: ["artifact.write"]` and the last line returns
  `false` while `check_access/2` keeps returning `:ok`: the invocation may
  call the tool, and any write it attempts is still denied by the mutation
  gate.
  """

  alias Ensemble.Behavior.{Capabilities, Definition, Registries}

  @typedoc "Tool identifier as declared in `capabilities.tools`."
  @type tool_id :: String.t() | atom()

  @typedoc "Mutation class identifier as declared in `capabilities.mutation_classes`."
  @type class_id :: String.t() | atom()

  @ensemble_prefix "ensemble."

  @doc """
  Cross-check the declared grants against the ToolRegistry snapshot
  (AC-033) and return them in declaration order.

  `Compiler.validate/1` already drops unknown tools from
  `capabilities.tools`, so this is a defence-in-depth re-check: any id
  still present that the registry does not know fails the whole resolve
  with `{:error, :unknown_tool}`. Nothing is partially granted.

  Pass `snapshot` explicitly to keep the call pure. With `nil`, the
  registry is read through `Registries.all()` — which falls back to disk
  when the registry process is not running — so this function never
  starts a process of its own.
  """
  @spec resolve(Definition.t(), Registries.t() | nil) ::
          {:ok, [String.t()]} | {:error, :unknown_tool}
  def resolve(%Definition{capabilities: %Capabilities{tools: tools}} = _defn, snapshot \\ nil) do
    declared = Enum.map(tools, &to_string/1)

    if Enum.all?(declared, &Registries.tool_known?(&1, snapshot)) do
      {:ok, declared}
    else
      # AC-100: an unresolvable grant set is a tool_not_found triage event.
      Ensemble.Behavior.Metrics.bump(:tool_not_found)
      {:error, :unknown_tool}
    end
  end

  @doc """
  Fail-closed runtime check for a single tool call (AC-038).

  Returns `:ok` only when `tool` is **provably** present in `granted`
  after id canonicalization (`to_string`, so `:read` and `"read"` are the
  same tool). An empty or malformed grant list, a `nil`/boolean tool, or
  anything else that cannot be proven granted is denied.
  """
  @spec check_access(tool_id(), [tool_id()]) :: :ok | {:error, :tool_not_granted}
  def check_access(tool, granted) when is_list(granted) do
    do_check_access(canonical_id(tool), granted)
  end

  def check_access(_tool, _granted), do: {:error, :tool_not_granted}

  defp do_check_access(nil, _granted), do: {:error, :tool_not_granted}

  defp do_check_access(tool, granted) do
    if tool in Enum.map(granted, &canonical_id/1), do: :ok, else: {:error, :tool_not_granted}
  end

  @doc """
  Tools that enforce `class`, canonicalised to bare ids and sorted.

  This is the naming-seam normaliser: `Registries.tools_for_mutation/2`
  returns registry ids, whose raw-string intersection with a
  namespaced `capabilities.tools` grant is silently empty (see the module
  doc). An unregistered class yields `[]`.
  """
  @spec tools_for_class(class_id(), Registries.t() | nil) :: [String.t()]
  def tools_for_class(class, snapshot \\ nil) do
    class
    |> Registries.tools_for_mutation(snapshot)
    |> Enum.map(&canonical_tool/1)
    |> Enum.sort()
  end

  @doc """
  Class-enforcement link: which mutation class (if any) `tool` enforces,
  restricted to the classes reachable from `granted`.

  Answers the naming question only — *does this granted tool belong to
  class C?* — and is deliberately **not** authority. Authority is
  `mutation_allowed?/2`. Returns `{:error, :tool_not_granted}` when the
  tool is absent from `granted`, and `{:error, :no_class}` for a granted
  tool that enforces no registered class (`read`, `bash.test`, ...).
  """
  @spec check_mutation(tool_id(), [tool_id()], Registries.t() | nil) ::
          {:ok, String.t()} | {:error, :tool_not_granted | :no_class}
  def check_mutation(tool, granted, snapshot \\ nil) do
    with :ok <- check_access(tool, granted) do
      case class_for(tool, snapshot) do
        nil -> {:error, :no_class}
        class -> {:ok, class}
      end
    end
  end

  @doc """
  True only when `class` is explicitly declared in `mutation_classes`
  (AC-035/AC-036).

  Comparison is canonical (atom or binary; an `ensemble.`-namespaced
  spelling resolves to its registered class), but authority is never
  inferred from a tool grant: an undeclared class — including an unknown
  one — returns `false`.
  """
  @spec mutation_allowed?(class_id(), [class_id()], Registries.t() | nil) :: boolean()
  def mutation_allowed?(class, declared_classes, snapshot \\ nil)

  def mutation_allowed?(class, declared_classes, snapshot) when is_list(declared_classes) do
    case canonical_class(class, snapshot) do
      nil -> false
      target -> Enum.any?(declared_classes, &canonical_class_equals?(target, &1, snapshot))
    end
  end

  def mutation_allowed?(_class, _declared_classes, _snapshot), do: false

  # Reads the mutation registry directly (never the EventCatalog
  # fallback in `Registries.mutation_known?/2`) so an extension event
  # name can never be mistaken for a class.
  defp class_declared?(class, snapshot) do
    Map.has_key?(reg_all(snapshot).mutation_classes, class)
  end

  @doc """
  Canonical bare form of a tool id: strips a leading `ensemble.` prefix,
  which is only ever a namespace marker in the ToolRegistry.
  """
  @spec canonical_tool(tool_id()) :: String.t()
  def canonical_tool(tool), do: strip_prefix(to_string(tool))

  # ---------------------------------------------------------------- naming

  defp canonical_id(tool) when is_binary(tool), do: tool
  defp canonical_id(tool) when is_atom(tool) and not is_nil(tool), do: Atom.to_string(tool)
  defp canonical_id(_tool), do: nil

  defp strip_prefix(@ensemble_prefix <> rest) when rest != "", do: rest
  defp strip_prefix(other), do: other

  # Which registered class (if any) this tool is the way into. Two
  # registry-driven routes, in this order:

  #   1. the class's enforcing-tool set contains the tool's bare name
  #      (`artifact.write` lists `write`/`edit`; canonical tool is `write`);
  #   2. the tool's own bare name *is* a registered class
  #      (`ensemble.constitution.propose` -> `constitution.propose`).
  #
  # `ensemble.` is the only prefix stripped, so ids like `git.push` are
  # compared intact and no unrelated id can be assigned a class.
  defp class_for(tool, snapshot) do
    canonical = canonical_tool(tool)

    cond do
      class = Enum.find(enforcing_classes(canonical, snapshot), & &1) -> class
      class_declared?(canonical, snapshot) -> canonical
      true -> nil
    end
  end

  defp enforcing_classes(canonical, snapshot) do
    snapshot
    |> class_index()
    |> Enum.flat_map(fn {class, tools} ->
      if class != "none" and canonical in tools, do: [class], else: []
    end)
  end

  # class => [canonical bare enforcing tools], from the registry snapshot.
  defp class_index(snapshot) do
    %Registries{mutation_classes: classes} = reg_all(snapshot)

    classes
    |> Enum.map(fn {class, tools} ->
      {class, Enum.map(tools, &canonical_tool/1) |> Enum.sort()}
    end)
    |> Enum.sort_by(&elem(&1, 0))
  end

  defp canonical_class(class, snapshot) when is_binary(class) do
    cond do
      class_declared?(class, snapshot) ->
        class

      true ->
        bare = strip_prefix(class)
        if bare != class and class_declared?(bare, snapshot), do: bare
    end
  end

  defp canonical_class(class, snapshot) when is_atom(class) and not is_nil(class) do
    canonical_class(Atom.to_string(class), snapshot)
  end

  defp canonical_class(_class, _snapshot), do: nil

  defp canonical_class_equals?(target, declared, snapshot) do
    case canonical_class(declared, snapshot) do
      nil -> false
      other -> other == target
    end
  end

  defp reg_all(nil), do: Registries.all()
  defp reg_all(%Registries{} = r), do: r
end
