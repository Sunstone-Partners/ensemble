defmodule Ensemble.Behavior.Registries do
  @moduledoc """
  Canonical registries loaded from `priv/registries/*.json`.

  Four registries (TRD §1.8):

  * **ToolRegistry** — tool ids a behavior may declare in `capabilities.tools`.
    Unknown declared tool => **warning**, excluded from the grant set.
  * **MutationRegistry** — mutation class -> enforcing tool sets. Unknown
    class => **failure** (validation). A tool grant never implies mutation
    authority (plan §3.1 rule).
  * **EventCatalog** — every `trigger.event_type` / `outcomes` entry must be
    registered or namespaced `x-<project>.*`. Unknown event type fails at
    *validation* time.
  * **WorkflowCatalog** — resolves `execution.graph`; missing graph =>
    validation error, behavior not registered (REQ-011 AC-042).

  Project-level `ensemble.config.yaml` may extend the sets (additive only);
  `reload/0` re-reads disk + env-registered extensions.
  """

  @tools_file "registries/tools.json"
  @mutations_file "registries/mutation_classes.json"
  @events_file "registries/events.json"
  @workflows_file "registries/workflows.json"

  defstruct tools: MapSet.new(),
            mutation_classes: %{},
            events: MapSet.new(),
            workflows: MapSet.new()

  @type t :: %__MODULE__{
          tools: MapSet.t(String.t()),
          mutation_classes: %{String.t() => [String.t()]},
          events: MapSet.t(String.t()),
          workflows: MapSet.t(String.t())
        }

  use Agent

  @doc "Start the registry agent (idempotent; used by Application/Supervisor in later phases)."
  def start_link(opts \\ []) do
    Agent.start_link(fn -> load() end, Keyword.put_new(opts, :name, __MODULE__))
  end

  @doc "Current registry snapshot (from agent if running, else load from disk)."
  def all do
    case Process.whereis(__MODULE__) do
      nil -> load()
      pid -> Agent.get(pid, & &1)
    end
  end

  @doc "Re-read registries from disk."
  def reload do
    if pid = Process.whereis(__MODULE__) do
      Agent.update(pid, fn _ -> load() end)
    end

    all()
  end

  defp load do
    %__MODULE__{
      tools: MapSet.new(read_list(@tools_file, "tools")),
      mutation_classes: read_map(@mutations_file, "mutation_classes"),
      events: MapSet.new(read_list(@events_file, "event_types")),
      workflows: MapSet.new(read_list(@workflows_file, "graphs"))
    }
  end

  @doc "True when `tool_id` is a known tool."
  def tool_known?(tool_id, reg \\ nil) do
    MapSet.member?(reg_all(reg).tools, tool_id)
  end

  @doc "True when `class` is a registered mutation class."
  def mutation_known?(class, reg \\ nil) do
    Map.has_key?(reg_all(reg).mutation_classes, class)
  end

  @doc """
  True when `event_type` is registered or carries an `x-<project>.`
  extension namespace (TRD §1.8).
  """
  def event_known?(event_type, reg \\ nil) do
    MapSet.member?(reg_all(reg).events, event_type) or extension_event?(event_type)
  end

  @doc "True when `graph` is a registered workflow graph."
  def workflow_known?(graph, reg \\ nil) do
    MapSet.member?(reg_all(reg).workflows, graph)
  end

  @doc "Tools that enforce a mutation class (plan §3.1 mapping)."
  def tools_for_mutation(class, reg \\ nil) do
    Map.get(reg_all(reg).mutation_classes, class, [])
  end

  defp reg_all(nil), do: all()
  defp reg_all(%__MODULE__{} = r), do: r

  defp extension_event?(event_type) do
    String.starts_with?(event_type, "x-")
  end

  defp read_list(file, key) do
    file |> read_json() |> Map.get(key, [])
  end

  defp read_map(file, key) do
    file |> read_json() |> Map.get(key, %{})
  end

  defp read_json(file) do
    path = Path.join(:code.priv_dir(:ensemble) |> List.to_string(), file)

    case File.read(path) do
      {:ok, body} -> Jason.decode!(body)
      {:error, _} -> %{}
    end
  end
end
