defmodule Ensemble.Behavior.Composition do
  @moduledoc """
  Workflow + skill composition for one activation (TRD §4.3 lines 573-581;
  REQ-011 AC-041..AC-044, REQ-012 AC-045..AC-048).

  Three responsibilities, deliberately thin:

  * `resolve_graph/2` — turn the declared `execution.graph` name into a
    workflow the catalog actually knows (AC-041). Compile-time
    `Compiler.graph_check/3` already refuses to register a behavior whose
    graph is missing (AC-042); this is the activation-time counterpart and
    adds no new validation rule.
  * `bind_params/2` — evaluate declared parameter bindings against the
    triggering event (AC-043), literals passing through and `$.`-prefixed
    strings reading a path out of the event.
  * `build_workflow_input/2` — the payload a workflow is invoked with: all
    declared params plus the triggering event as context (AC-044).

  ## Fail-closed, never nil-filled (AC-043)

  A `$.` reference whose path is absent returns
  `{:error, {:param_unresolved, key}}`. Substituting `nil` would hand the
  workflow a *plausible but wrong* argument — a nil project id reads like
  "no project", which is a different instruction than the behavior author
  declared. So an unresolvable binding stops composition before dispatch.

  ## Skill composition (AC-045..AC-048)

  `skills/1` returns the behavior's composed skills, each pinned by the
  digest recorded in `Ensemble.Behavior.SkillCatalog`, and `strategy/1`
  returns the declared composition strategy the invoker honors. Neither is
  re-derived from anything but the compiled definition, and skill metadata
  is surfaced from `defn.source` so the content digest of the behavior
  itself stays a function of its data, not of catalog state.
  """

  alias Ensemble.Behavior.{Definition, Event, Registries, SkillCatalog}

  @event_paths %{
    "$.event_id" => :event_id,
    "$.event_type" => :event_type,
    "$.subject_id" => :subject_id,
    "$.source" => :source,
    "$.project_id" => :project_id,
    "$.correlation_id" => :correlation_id,
    "$.causation_id" => :causation_id,
    "$.dedup_key" => :dedup_key,
    "$.idempotency_key" => :idempotency_key,
    "$.actor.id" => {:actor, :id},
    "$.actor.type" => {:actor, :type}
  }

  @doc """
  Resolves `execution.graph` against the WorkflowCatalog (AC-041).

      resolve_graph(defn) #=> {:ok, %{graph: "investigate-test-failure"}}

  Unknown graph => `{:error, :workflow_missing}`. Fail-closed: composition
  stops rather than dispatching a workflow that does not exist.
  """
  @spec resolve_graph(Definition.t(), Registries.t() | nil) ::
          {:ok, %{graph: String.t()}} | {:error, :workflow_missing}
  def resolve_graph(%Definition{execution: exec} = defn, reg \\ nil) do
    cond do
      is_binary(exec.graph) and exec.graph != "" and Registries.workflow_known?(exec.graph, reg) ->
        {:ok, %{graph: exec.graph}}

      is_binary(exec.graph) and exec.graph != "" ->
        {:error, :workflow_missing}

      true ->
        # No graph declared: fall back to the behavior name, which is how a
        # single-behavior workflow package is registered in the catalog.
        case defn.name do
          name when is_binary(name) -> resolve_name(name, reg)
          _ -> {:error, :workflow_missing}
        end
    end
  end

  defp resolve_name(name, reg) do
    if Registries.workflow_known?(name, reg) do
      {:ok, %{graph: name}}
    else
      {:error, :workflow_missing}
    end
  end

  @doc """
  Binds `execution.params` against `event` (AC-043).

  Literal values pass through untouched. A string beginning with `$.` is a
  path into the event: `$.payload.<dotted>` reads the (string-keyed)
  payload, and the envelope paths `$.event_id`, `$.event_type`,
  `$.subject_id`, `$.source`, `$.project_id`, `$.correlation_id`,
  `$.causation_id`, `$.dedup_key`, `$.idempotency_key`, `$.actor.id` and
  `$.actor.type` read the normalized envelope. Maps and lists recurse, so a
  nested template can mix literals and references.

  An unresolvable reference => `{:error, {:param_unresolved, key}}` naming
  the top-level param that failed. Never `nil`-filled.
  """
  @spec bind_params(Definition.t() | map(), Event.t() | map()) ::
          {:ok, map()} | {:error, {:param_unresolved, String.t()}}
  def bind_params(%Definition{execution: exec}, event), do: bind_params(exec.params, event)
  def bind_params(params, event) when is_map(params) do
    Enum.reduce_while(params, {:ok, %{}}, fn {key, value}, {:ok, acc} ->
      case bind_value(value, event) do
        {:ok, bound} -> {:cont, {:ok, Map.put(acc, key, bound)}}
        :error -> {:halt, {:error, {:param_unresolved, to_string(key)}}}
      end
    end)
  end

  @doc """
  Full workflow input for one activation (AC-041 + AC-043 + AC-044).

      build_workflow_input(defn, event)
      #=> {:ok, %{graph: "investigate-test-failure", params: %{...}, event: %Event{}}}

  The workflow receives every declared parameter already bound, plus the
  triggering event itself as context — so a workflow can read fields the
  behavior author did not enumerate without the runtime guessing at them.
  Graph resolution is checked first; a missing workflow composes nothing.
  """
  @spec build_workflow_input(Definition.t(), Event.t() | map(), Registries.t() | nil) ::
          {:ok, %{graph: String.t(), params: map(), event: Event.t() | map()}}
          | {:error, :workflow_missing | {:param_unresolved, String.t()}}
  def build_workflow_input(%Definition{} = defn, event, reg \\ nil) do
    with {:ok, %{graph: graph}} <- resolve_graph(defn, reg),
         {:ok, params} <- bind_params(defn, event) do
      {:ok, %{graph: graph, params: params, event: event}}
    end
  end

  @doc """
  The behavior's composed skills, pinned by catalog digest (AC-045/AC-046).

  Reads the reference list carried by the compiled definition (`defn.source`
  by default) and resolves each against the catalog. An unknown reference
  fails closed with `{:error, {:skill_unknown, name}}`; a deprecated or
  revoked reference resolves, and `lifecycle/1` reports it as a migration
  flag rather than a failure (AC-047).
  """
  @spec skills(Definition.t(), keyword() | map() | nil) ::
          {:ok, [map()]} | {:error, {:skill_unknown, String.t()}}
  def skills(%Definition{} = defn, catalog \\ nil) do
    defn
    |> skill_names()
    |> Enum.reduce_while({:ok, []}, fn name, {:ok, acc} ->
      case SkillCatalog.resolve(name, catalog) do
        {:ok, skill} -> {:cont, {:ok, acc ++ [skill]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  @doc """
  Same as `skills/2` but tolerant of an unresolvable name: returns
  `{resolved, errors}` so a `validate` run can report every problem in one
  pass instead of stopping at the first.
  """
  @spec skills_with_errors(Definition.t(), keyword() | map() | nil) ::
          {[map()], [{String.t(), {:skill_unknown, String.t()}}]}
  def skills_with_errors(%Definition{} = defn, catalog \\ nil) do
    defn
    |> skill_names()
    |> Enum.map_reduce([], fn name, errors ->
      case SkillCatalog.resolve(name, catalog) do
        {:ok, skill} -> {skill, errors}
        {:error, reason} -> {nil, errors ++ [{name, reason}]}
      end
    end)
    |> then(fn {resolved, errors} -> {Enum.reject(resolved, &is_nil/1), errors} end)
  end

  @doc "The declared skill names, in first-seen order."
  @spec skill_names(Definition.t()) :: [String.t()]
  def skill_names(%Definition{} = defn) do
    # The compiler already normalized `execution.skills` to bare names on
    # `source`; `prompt` still holds inline `@skill:` refs, so extract those.
    declared = defn |> raw("skills") |> List.wrap() |> Enum.flat_map(&names_of/1)
    inline = defn |> raw("prompt") |> refs_in()
    (declared ++ inline) |> Enum.uniq()
  end

  @doc "Migration flags for a behavior's skills (AC-046/AC-047)."
  @spec lifecycle(Definition.t(), keyword() | map() | nil) :: [map()]
  def lifecycle(%Definition{} = defn, catalog \\ nil) do
    SkillCatalog.lifecycle_warnings(skill_names(defn), catalog)
  end

  @doc """
  Declared composition strategy, `:sequential` (default) or `:parallel`
  (AC-048). The invoker honors this; nothing here executes skills.
  """
  @spec strategy(Definition.t()) :: :sequential | :parallel
  def strategy(%Definition{} = defn) do
    case raw(defn, "strategy") do
      s when is_binary(s) -> String.to_atom(s)
      :sequential -> :sequential
      :parallel -> :parallel
      _ -> :sequential
    end
  end

  @doc """
  Skill digest pins as `{name, digest}` pairs, for the child audit records
  an activation writes per composed skill (AC-046).
  """
  @spec digest_pins(Definition.t(), keyword() | map() | nil) :: [{String.t(), String.t() | nil}]
  def digest_pins(%Definition{} = defn, catalog \\ nil) do
    case skills(defn, catalog) do
      {:ok, list} -> Enum.map(list, &{&1.name, &1.digest})
      {:error, _} -> []
    end
  end

  # -- internals ---------------------------------------------------------

  # The compiler carries declared composition metadata on `Definition.source`
  # under atom keys; accept the string form too so a hand-built definition (or
  # a definition round-tripped through JSON) composes identically.
  defp raw(%Definition{source: source}, key) when is_map(source) do
    case Map.fetch(source, key) do
      {:ok, v} -> v
      :error -> Map.get(source, String.to_atom(key))
    end
  end

  defp raw(_, _), do: nil

  # Both forms occur in practice: the compiler normalizes refs to bare names,
  # but a hand-built or JSON-round-tripped definition may still carry the
  # `@skill:` syntax. Accept either.
  defp names_of(name) when is_binary(name) do
    case refs_in(name) do
      [] when name != <<>> -> [name]
      [ref | _] -> [ref]
      _ -> []
    end
  end

  defp names_of(_), do: []

  # Single source of truth for the reference grammar (see the note in
  # `SkillCatalog` on why extraction avoids `Regex`).
  defp refs_in(value), do: SkillCatalog.refs_in(value)

  defp bind_value(value, event) when is_binary(value) do
    case value do
      "$" <> _ -> bind_ref(value, event)
      _ -> {:ok, value}
    end
  end

  defp bind_value(value, event) when is_map(value) and not is_struct(value) do
    value
    |> Enum.reduce_while({:ok, %{}}, fn {k, v}, {:ok, acc} ->
      case bind_value(v, event) do
        {:ok, bound} -> {:cont, {:ok, Map.put(acc, k, bound)}}
        :error -> {:halt, :error}
      end
    end)
  end

  defp bind_value(value, event) when is_list(value) do
    value
    |> Enum.reduce_while({:ok, []}, fn v, {:ok, acc} ->
      case bind_value(v, event) do
        {:ok, bound} -> {:cont, {:ok, acc ++ [bound]}}
        :error -> {:halt, :error}
      end
    end)
  end

  defp bind_value(value, _event), do: {:ok, value}

  # A `$...` string is a reference; anything else was handled as a literal.
  defp bind_ref(ref, event) do
    case fetch_ref(ref, event) do
      {:ok, _} = ok -> ok
      :error -> :error
    end
  end

  defp fetch_ref("$.payload", event), do: wrap(get_field(event, :payload))
  defp fetch_ref("$.payload." <> path, event), do: payload_path(event, path)

  defp fetch_ref(ref, event) do
    case Map.fetch(@event_paths, ref) do
      {:ok, field} -> wrap(get_field(event, field))
      :error -> :error
    end
  end

  # Envelope reads tolerate both the normalized struct/map (atom keys) and a
  # raw wire map (string keys); `false`/`0` are values, not absence.
  defp get_field(event, {key, sub}) do
    case get_field(event, key) do
      m when is_map(m) -> get_field(m, sub)
      _ -> :missing
    end
  end

  defp get_field(event, key) when is_map(event) do
    cond do
      Map.has_key?(event, key) -> Map.get(event, key)
      is_atom(key) and Map.has_key?(event, to_string(key)) -> Map.get(event, to_string(key))
      is_binary(key) -> atom_fetch(event, key)
      true -> :missing
    end
  end

  defp get_field(_event, _key), do: :missing

  defp atom_fetch(event, key) do
    try do
      atom = String.to_existing_atom(key)
      if Map.has_key?(event, atom), do: Map.get(event, atom), else: :missing
    rescue
      ArgumentError -> :missing
    end
  end

  # An absent path and an explicit nil are equally unusable as a bound
  # argument: both fail closed rather than nil-fill (AC-043).
  defp wrap(:missing), do: :error
  defp wrap(nil), do: :error
  defp wrap(v), do: {:ok, v}

  defp payload_path(event, dotted) do
    keys = String.split(dotted, ".")
    root = get_field(event, :payload)

    case walk(root, keys) do
      :missing -> :error
      value -> wrap(value)
    end
  end

  defp walk(value, []), do: value

  defp walk(container, [key | rest]) when is_map(container) do
    case get_field(container, key) do
      :missing -> :missing
      next -> walk(next, rest)
    end
  end

  defp walk(_value, _keys), do: :missing
end
