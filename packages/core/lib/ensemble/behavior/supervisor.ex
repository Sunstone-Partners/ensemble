defmodule Ensemble.Behavior.Supervisor do
  @moduledoc """
  Root supervisor for the Ensemble behavior runtime.

  Children: `ActivationSupervisor` (empty DynamicSupervisor — activation
  children appear only on demand via `Observability.start_activation/3`)
  and `Observability` (stateless bookkeeping server). Both are inert at
  boot: no env reads, no spawned tail loops — supervision trees boot in
  tests too.
  """
  use Supervisor

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, :ok, Keyword.put_new(opts, :name, __MODULE__))
  end

  @impl true
  def init(:ok) do
    children = [
      Ensemble.Behavior.ActivationSupervisor,
      Ensemble.Behavior.Observability
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
