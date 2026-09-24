defmodule Ensemble.Behavior.Supervisor do
  @moduledoc """
  Root supervisor for the Ensemble behavior runtime.

  Phase 1 keeps this empty of children; later phases mount the registry,
  policy stores, and audit writer under it.
  """
  use Supervisor

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, :ok, Keyword.put_new(opts, :name, __MODULE__))
  end

  @impl true
  def init(:ok) do
    children = []
    Supervisor.init(children, strategy: :one_for_one)
  end
end
