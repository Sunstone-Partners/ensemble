defmodule Ensemble.Behavior.Invocation do
  @moduledoc """
  Immutable record of one agent invocation (TRD §1.7 lines 242-246,
  §4.2 lines 548-566; REQ-010 AC-037/AC-039, REQ-026 AC-093).

  The `granted` list is the **frozen** authority slice, resolved from the
  individual `Definition` at request-build time — before any
  subprocess/SDK session exists (AC-037). It is stored as a plain list of
  binaries inside a struct: there is deliberately no update function, no
  merge path, and no callback field anywhere on this struct by which a
  prompt, steering message, model output, or follow-up could widen it
  (AC-039/AC-093). `requested_tools` is the declared set as written, kept
  only so a violation audit can distinguish declared from granted.

  Per-behavior scope (AC-036): `granted` comes from `defn`, never from a
  union across the behavior registry, so revoking a tool from one
  behavior cannot touch another.
  """

  defstruct [
    :invocation_id,
    :activation_id,
    :behavior,
    :name,
    :version,
    :digest,
    :event_id,
    :granted,
    :requested_tools,
    :started_at,
    :ended_at,
    :actor,
    status: :pending
  ]

  @type t :: %__MODULE__{
          invocation_id: String.t(),
          activation_id: String.t(),
          behavior: Ensemble.Behavior.Definition.t(),
          name: String.t(),
          version: String.t(),
          digest: String.t(),
          event_id: String.t() | nil,
          granted: [String.t()],
          requested_tools: [String.t()],
          started_at: non_neg_integer() | nil,
          ended_at: non_neg_integer() | nil,
          actor: term(),
          status: :pending | :built
        }
end

defmodule Ensemble.Behavior.AgentInvoker do
  @moduledoc """
  Builds and freezes the provider-neutral request for one activation of a
  `Definition` (TRD §1.7 lines 242-246, §4.2 lines 548-566; REQ-010,
  REQ-026 AC-093).

  ## Grant slicing happens before the session (AC-037)

  `invoke/3` calls `ToolGuard.resolve/2` against the registry snapshot at
  request-build time. A resolve error (`{:error, :unknown_tool}`) is
  fail-closed: **no invocation record is created and nothing is
  dispatched** (AC-033/AC-038). Likewise, `invoke/3` requires an explicit
  `opts[:policy_decision]` of `%PolicyDecision{verdict: :activate}` —
  defn/decide separation means the invoker never re-derives policy and
  never defaults open (`{:error, :not_activated}` for any other or
  missing verdict).

  ## Prompt immunity is architectural, not heuristic (AC-037/AC-039/AC-093)

  The built request is a frozen struct; `granted` is a list of binaries
  with no update path. Model-output-driven inputs — `opts[:prompt]`,
  `opts[:instructions]`, `opts[:tool_hints]`, `opts[:tools]`, any extra
  opt key, `event.payload["tools"]`, or a steering map — are carried as
  inert data or dropped entirely. They are NEVER merged into `granted`.
  The only authority source at call time is
  `AgentInvoker.authorize/2` -> `ToolGuard.check_access/2` against
  `invocation.granted`.

  ## Backend neutrality (AC-093)

  `build_request/3` returns a provider-neutral map. Per-backend shapes
  are derived on demand by `to_launch_config/2` (`:pi`, `:generic`). The
  request map never contains a mutation callback — there is nothing for
  "ignore previous tool restrictions" to hook.
  """

  alias Ensemble.Behavior.{
    Audit,
    Definition,
    Event,
    Invocation,
    Metrics,
    PolicyDecision,
    Registries,
    ToolGuard
  }

  require Logger

  @doc """
  Invoke `defn` for `event`. Returns `{:ok, %Invocation{}}` with the grant
  list frozen, or `{:error, term()}` without creating a record.

  ## Options

    * `:policy_decision` — REQUIRED; must be
      `%PolicyDecision{verdict: :activate}`, else `{:error, :not_activated}`.
    * `:registries` — registry snapshot for the grant cross-check;
      defaults to `Registries.all()` (disk fallback, never starts a process).
    * `:activation_id` — reuse an existing activation id; otherwise one
      is generated.
    * `:prompt`, `:instructions`, `:tool_hints`, and any other key —
      inert payload. They cannot and do not change `granted`
      (AC-039/AC-093).
  """
  @spec invoke(Definition.t(), Event.t(), keyword()) ::
          {:ok, Invocation.t()} | {:error, term()}
  def invoke(%Definition{} = defn, %Event{} = event, opts \\ []) do
    case opts[:policy_decision] do
      %PolicyDecision{verdict: :activate} ->
        do_invoke(defn, event, opts)

      %PolicyDecision{} ->
        {:error, :not_activated}

      _ ->
        {:error, :not_activated}
    end
  end

  defp do_invoke(defn, event, opts) do
    snapshot = Keyword.get(opts, :registries, Registries.all())

    # AC-033/AC-038 fail-closed: an unresolved grant set produces no
    # invocation record at all.
    with {:ok, granted} <- ToolGuard.resolve(defn, snapshot) do
      now = Event.now()

      invocation = %Invocation{
        invocation_id: generate_id("inv"),
        activation_id: opts[:activation_id] || generate_id("act"),
        behavior: defn,
        name: defn.name,
        version: to_string(defn.version),
        digest: digest_hex(defn),
        event_id: event.event_id,
        granted: granted,
        requested_tools: Enum.map(defn.capabilities.tools, &to_string/1),
        started_at: now,
        actor: event.actor,
        status: :built
      }

      {:ok, invocation}
    end
  end

  @doc """
  Build the provider-neutral request map from a frozen invocation. The
  tool slice is read from `invocation.granted` only.
  """
  @spec build_request(Definition.t() | Invocation.t(), Event.t() | map(), keyword()) :: map()
  def build_request(target, event \\ %Event{event_id: "e-nil", event_type: "x-none"}, opts \\ [])

  def build_request(%Invocation{granted: granted} = inv, _event, opts) do
    %{
      invocation_id: inv.invocation_id,
      activation_id: inv.activation_id,
      behavior: %{name: inv.name, version: inv.version, digest: inv.digest},
      event_id: inv.event_id,
      tools: granted,
      payload: payload_of(opts[:payload]),
      prompt: opts[:prompt],
      instructions: opts[:instructions]
    }
  end

  def build_request(%Definition{} = defn, %Event{} = event, opts) do
    granted =
      case ToolGuard.resolve(defn, Keyword.get(opts, :registries, Registries.all())) do
        {:ok, g} -> g
        _ -> []
      end

    %{
      invocation_id: opts[:invocation_id] || generate_id("inv"),
      activation_id: opts[:activation_id] || generate_id("act"),
      behavior: %{name: defn.name, version: to_string(defn.version), digest: digest_hex(defn)},
      event_id: event.event_id,
      tools: granted,
      payload: payload_of(event.payload),
      prompt: opts[:prompt],
      instructions: opts[:instructions]
    }
  end

  defp payload_of(p) when is_map(p), do: p
  defp payload_of(_), do: %{}

  @doc """
  Derive a backend launch config from a provider-neutral request
  (AC-093). Both shapes are pure allowlists; neither carries a callback.
  """
  @spec to_launch_config(atom(), map()) :: map()
  def to_launch_config(:pi, request) when is_map(request) do
    %{
      backend: :pi,
      custom_tools_allowlist: request.tools,
      session: %{tools: request.tools}
    }
  end

  def to_launch_config(:generic, request) when is_map(request) do
    %{
      backend: :generic,
      tool_policy: %{allow: request.tools}
    }
  end

  # AC-100: an unrecognized backend is a backend_unavailable triage event.
  def to_launch_config(backend, request) when is_map(request) do
    Metrics.bump(:backend_unavailable)
    %{backend: backend, error: :backend_unavailable, tool_policy: %{allow: []}}
  end

  @doc """
  Runtime interception for a single tool call (AC-038). The ONLY
  authority source is `invocation.granted` via `ToolGuard.check_access/2`
  — a deny never consults the registry, the definition, or any opts.

  On `{:error, :tool_not_granted}` a violation audit record is appended
  (AC-040). The audit result never changes the decision and never raises
  into the caller: a write failure is logged and swallowed.
  """
  @spec authorize(Invocation.t(), String.t() | atom()) :: :ok | {:error, :tool_not_granted}
  def authorize(%Invocation{granted: granted} = invocation, tool) do
    case ToolGuard.check_access(tool, granted) do
      :ok ->
        :ok

      error ->
        # AC-040 audit is best-effort: a sink failure is logged and
        # swallowed, never raised into the caller's decision.
        try do
          case Audit.log_violation(invocation, tool, invocation.requested_tools) do
            {:error, reason} ->
              Logger.error("violation audit write failed: #{inspect(reason)}")

            _ ->
              :ok
          end
        catch
          kind, reason ->
            Logger.error(
              "violation audit write failed: #{Exception.format(kind, reason, __STACKTRACE__)}"
            )
        end

        # AC-100 triage bucket; counter-only, never changes the decision.
        Metrics.bump(:policy_violation)

        error
    end
  end

  defp digest_hex(%Definition{digest: d}) when is_binary(d),
    do: Base.encode16(d, case: :lower)

  defp digest_hex(_), do: nil

  defp generate_id(prefix),
    do: prefix <> "-" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
end
