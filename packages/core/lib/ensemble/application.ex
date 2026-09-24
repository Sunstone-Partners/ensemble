defmodule Ensemble.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      # Behavior runtime children wired in later phases:
      # Phase 1: {Registry, keys: :duplicate, name: Ensemble.Behavior.Registry}
      # Phase 3: PolicyContext stores (ETS tables via Task or DynamicSupervisor)
      # Phase 4: Audit ledger writer process
      Ensemble.Behavior.Supervisor
    ]

    opts = [strategy: :one_for_one, name: Ensemble.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
