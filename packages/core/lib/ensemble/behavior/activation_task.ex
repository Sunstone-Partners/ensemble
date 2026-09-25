defmodule Ensemble.Behavior.ActivationTask do
  @moduledoc """
  One supervised activation (TRD-033, AC-097/AC-099).

  Owns an `activation_id`, tags all of its log lines with Logger
  metadata `causal_root` (the activation_id) and `behavior`, runs the
  supplied work fun under the definition's frozen ToolGuard grant list,
  and emits a telemetry run record (AC-100 metrics ride along via
  `Metrics.peek_and_reset/0`). Failures are recorded and re-raised so
  the DynamicSupervisor sees them.

  A `nil` `:fun` means record-only mode: match/audit bookkeeping
  happened in `Observability.start_activation/3`; this child exists so
  the activation has a supervised process identity, then idles.
  """
  use GenServer

  alias Ensemble.Behavior.{Audit, Event, Metrics, Telemetry, ToolGuard}

  defstruct [:activation_id, :event, :defn, :fun, :telemetry_opts, :audit_opts, :started_at, :granted]

  @doc false
  def child_spec(args) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [args]},
      restart: :temporary,
      type: :worker
    }
  end

  @doc "Start a supervised activation. args: map with :activation_id, :event, optional :defn, :fun, :telemetry_opts."
  def start_link(%{activation_id: id} = args) when is_binary(id) do
    GenServer.start_link(__MODULE__, args)
  end

  @doc "Generate an opaque activation id (`act-<hex16>`)."
  def generate_id(prefix),
    do: prefix <> "-" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)

  @impl true
  def init(%{activation_id: id} = args) do
    Process.flag(:trap_exit, true)
    defn = Map.get(args, :defn)

    Logger.metadata(
      causal_root: id,
      activation_id: id,
      behavior: defn && "#{defn.name}@#{defn.version}"
    )

    state = %__MODULE__{
      activation_id: id,
      event: Map.fetch!(args, :event),
      defn: defn,
      fun: Map.get(args, :fun),
      telemetry_opts: Map.get(args, :telemetry_opts, []),
      audit_opts: Map.get(args, :audit_opts, []),
      started_at: DateTime.utc_now(),
      granted: granted_tools(defn)
    }

    send(self(), :run)
    {:ok, state}
  end

  @impl true
  def handle_info(:run, %__MODULE__{fun: nil} = state) do
    {:noreply, state}
  end

  @impl true
  def handle_info(:run, %__MODULE__{fun: fun} = state) when is_function(fun, 0) do
    %__MODULE__{activation_id: id, event: event, defn: defn} = state
    t0 = System.monotonic_time(:millisecond)

    result =
      try do
        {:ok, fun.()}
      rescue
        e -> {:error, e, __STACKTRACE__}
      end

    ms = System.monotonic_time(:millisecond) - t0

    outcome =
      case result do
        {:ok, value} ->
          Audit.append_kind(:skill_invocation,
            Keyword.merge(state.audit_opts,
              subject: "activation:" <> id,
              activation_id: id,
              causal_root: id,
              defn: defn,
              payload: %{event_type: event_type(event), outcome: "ok", duration_ms: ms}
            )
          )

          {:completed, value}
        {:error, e, st} ->
          Audit.append_kind(:policy_rejection,
            Keyword.merge(state.audit_opts,
              subject: "activation:" <> id,
              activation_id: id,
              causal_root: id,
              defn: defn,
              payload: %{
                event_type: event_type(event),
                outcome: "error",
                reason: Exception.message(e),
                stacksize: length(st)
              }
            )
          )

          {:failed, Exception.message(e)}
      end

    record_telemetry(state, t0, ms, outcome)

    case outcome do
      {:failed, reason} -> {:stop, {:activation_failed, reason}, state}
      _ -> {:stop, :normal, state}
    end
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  defp record_telemetry(%__MODULE__{} = s, _t0, ms, outcome) do
    {:ok, _} =
      Telemetry.record_run(
        %{
          behavior_id: s.defn && "#{s.defn.name}@#{s.defn.version}" || "unknown",
          event_type: event_type(s.event),
          event_id: s.event && s.event.event_id,
          activation_id: s.activation_id,
          causal_root: s.activation_id,
          started_at: s.started_at,
          completed_at: DateTime.utc_now(),
          duration_ms: ms,
          tool_calls: tool_calls(s.granted),
          outcome_kind: elem(outcome, 0),
          metrics: Metrics.peek_and_reset()
        },
        Keyword.put(s.telemetry_opts, :enabled, true)
      )

    :ok
  rescue
    _ -> :ok
  end

  defp tool_calls(granted) when is_list(granted) do
    granted
    |> Enum.with_index(1)
    |> Enum.map(fn {t, i} -> %{tool: t, seq: i} end)
  end

  defp tool_calls(_), do: []

  defp event_type(%Event{event_type: t}), do: t
  defp event_type(m) when is_map(m), do: m[:event_type] || m["event_type"]
  defp event_type(_), do: nil

  defp granted_tools(nil), do: []

  defp granted_tools(defn) do
    case ToolGuard.resolve(defn) do
      {:ok, g} -> g
      _ -> []
    end
  end

  @impl true
  def terminate(_reason, %__MODULE__{activation_id: id}) do
    Logger.metadata(causal_root: id)
    :ok
  end
end
