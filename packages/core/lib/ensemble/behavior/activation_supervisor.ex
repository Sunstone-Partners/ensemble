defmodule Ensemble.Behavior.ActivationSupervisor do
  @moduledoc """
  DynamicSupervisor owning activation children (TRD-033 / AC-097).
  Started under `Ensemble.Behavior.Supervisor`; one-for-one so one
  failing activation cannot take down parallel runs.
  """
  use DynamicSupervisor

  def start_link(opts \\ []) do
    DynamicSupervisor.start_link(__MODULE__, :ok, Keyword.put_new(opts, :name, __MODULE__))
  end

  @impl true
  def init(:ok) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end
end
