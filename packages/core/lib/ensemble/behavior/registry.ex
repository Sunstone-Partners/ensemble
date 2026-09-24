defmodule Ensemble.Behavior.Registry do
  @moduledoc """
  Process-duplicate registry of compiled behavior definitions
  (TRD §1.4 `DefinitionRegistry`).

  Backed by a `GenServer` holding a map of
  `{name, version} => Definition.t()` plus a name => latest-compatible
  index. `register/1` is idempotent on identical digest; re-registering the
  same `{name, version}` with a *different* digest raises `RegistryError`
  (immutable-version rule, plan S1). Selection uses
  `Ensemble.Behavior.Compiler.select_candidate/2` semantics.
  """
  use GenServer

  alias Ensemble.Behavior.{Compiler, Definition}

  defmodule RegistryError do
    defexception [:message]
  end

  # --- client API -------------------------------------------------------

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, Keyword.put_new(opts, :name, __MODULE__))
  end

  @spec register(Definition.t()) :: :ok | {:error, term()}
  def register(%Definition{} = defn, server \\ __MODULE__) do
    GenServer.call(server, {:register, defn})
  end

  @spec lookup(String.t()) :: {:ok, Definition.t()} | {:error, :no_compatible_version}
  def lookup(name, server \\ __MODULE__) do
    GenServer.call(server, {:lookup, name})
  end

  @spec all() :: [Definition.t()]
  def all(server \\ __MODULE__), do: GenServer.call(server, :all)

  @spec clear(server :: GenServer.server()) :: :ok
  def clear(server \\ __MODULE__), do: GenServer.call(server, :clear)

  # --- server -----------------------------------------------------------

  @impl true
  def init(:ok), do: {:ok, %{}}

  @impl true
  def handle_call({:register, defn}, _from, state) do
    key = {defn.name, defn.version}
    digest = Compiler.digest(defn)

    case Map.fetch(state, key) do
      :error ->
        {:reply, :ok, Map.put(state, key, %{defn: defn, digest: digest})}

      {:ok, %{digest: ^digest}} ->
        {:reply, :ok, state}

      {:ok, %{digest: other}} ->
        {:reply,
         {:error,
          {:digest_conflict,
           "#{defn.name} #{defn.version} already registered with a different digest " <>
             "(#{Base.encode16(other, case: :lower)} != #{Base.encode16(digest, case: :lower)})"}},
         state}
    end
  end

  @impl true
  def handle_call({:lookup, name}, _from, state) do
    defs = state |> Map.values() |> Enum.map(& &1.defn)
    {:reply, Compiler.select_candidate(name, defs), state}
  end

  @impl true
  def handle_call(:all, _from, state) do
    {:reply, state |> Map.values() |> Enum.map(& &1.defn), state}
  end

  @impl true
  def handle_call(:clear, _from, _state), do: {:reply, :ok, %{}}
end
