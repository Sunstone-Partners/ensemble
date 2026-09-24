defmodule Ensemble.Behavior.Registry do
  @moduledoc """
  Process-duplicate registry of compiled behavior definitions
  (TRD §1.4 `DefinitionRegistry`).

  Backed by a `GenServer` holding a map of
  `{name, version} => %{defn: Definition.t(), digest: binary, shadow: boolean}`
  plus a name => latest-compatible index. `register/2` is idempotent on
  identical digest; re-registering the same `{name, version}` with a
  *different* digest raises `RegistryError` (immutable-version rule,
  plan S1). Selection uses `Ensemble.Behavior.Compiler.select_candidate/2`
  semantics.

  ## Shadow registrations (plan REQ-COMP-004, TRD-033)

  `register/3` takes opts `[shadow: boolean]` (default **false**). A
  shadow registration is metadata on the registration, not the
  definition: the digest rule is unchanged, and `shadow?/2` answers the
  dispatch gate. Callers (the Observability seam) pass `shadow: true`
  when a project is already registered with an external runner (e.g.
  Foreman); matching + auditing stay identical, dispatch is suppressed.
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

  @doc """
  Register `defn`. `opts`: `shadow: boolean` (default false) — a
  shadow-mode hint stored on the registration, consulted via
  `shadow?/2` by the dispatch seam (TRD-033).
  """
  @spec register(Definition.t(), GenServer.server(), keyword()) :: :ok | {:error, term()}
  def register(%Definition{} = defn, server \\ __MODULE__, opts \\ []) do
    GenServer.call(server, {:register, defn, Keyword.get(opts, :shadow, false) == true})
  end

  @spec lookup(String.t()) :: {:ok, Definition.t()} | {:error, :no_compatible_version}
  def lookup(name, server \\ __MODULE__) do
    GenServer.call(server, {:lookup, name})
  end

  @doc "True when `{name, version}` is registered in shadow mode (default false)."
  @spec shadow?({String.t(), Version.t() | String.t()}, GenServer.server()) :: boolean()
  def shadow?(key, server \\ __MODULE__)
  def shadow?({n, v}, server) when is_binary(n) do
    case GenServer.call(server, {:shadow?, {n, to_version(v)}}) do
      {:ok, s} -> s
      _ -> false
    end
  end

  @spec all() :: [Definition.t()]
  def all(server \\ __MODULE__), do: GenServer.call(server, :all)

  @spec clear(server :: GenServer.server()) :: :ok
  def clear(server \\ __MODULE__), do: GenServer.call(server, :clear)

  defp to_version(%Version{} = v), do: to_string(v)
  defp to_version(v) when is_binary(v), do: v

  # --- server -----------------------------------------------------------

  @impl true
  def init(:ok), do: {:ok, %{}}

  @impl true
  def handle_call({:register, defn, shadow?}, _from, state) do
    key = {defn.name, to_version(defn.version)}
    digest = Compiler.digest(defn)

    case Map.fetch(state, key) do
      :error ->
        {:reply, :ok, Map.put(state, key, %{defn: defn, digest: digest, shadow: shadow?})}

      {:ok, %{digest: ^digest} = entry} ->
        {:reply, :ok, Map.put(state, key, %{entry | shadow: shadow? or entry.shadow})}

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
  def handle_call({:shadow?, key}, _from, state) do
    case Map.fetch(state, key) do
      {:ok, %{shadow: s}} -> {:reply, {:ok, s}, state}
      :error -> {:reply, {:error, :not_found}, state}
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
