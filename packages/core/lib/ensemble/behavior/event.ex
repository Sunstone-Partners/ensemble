defmodule Ensemble.Behavior.Event do
  @moduledoc """
  Normalized event envelope (TRD §1.4, REQ-005/REQ-006).

  One fact, one `event_id`. `dedup_key` is a semantic-equivalence key
  derived from `{event_type, subject_id, behavior_name, identity_fields}`
  and MUST NOT be conflated with `event_id` (plan §3.3).

  Field access is atom-keyed for `Ensemble.Behavior.Matcher`. Payload is a
  string-keyed map mirroring the source event body.
  """

  @enforce_keys [:event_id, :event_type]
  defstruct [
    :event_id,
    :event_type,
    :subject_id,
    :dedup_key,
    :idempotency_key,
    :correlation_id,
    :causation_id,
    :project_id,
    :emitted_at,
    :occurred_at,
    schema_version: 1,
    source: "local",
    payload: %{},
    actor: %{type: :system, id: nil},
    causal_parent: nil,
    depth: 0
  ]

  @type t :: %__MODULE__{}

  @doc "Milliseconds since epoch."
  @spec now() :: non_neg_integer()
  def now, do: System.system_time(:millisecond)

  @doc """
  Derive the dedup key from the semantic tuple (AC-013, TRD-018).
  `identity_fields` are dotted paths into `payload`.
  """
  @spec derive_dedup_key(String.t(), String.t(), String.t() | nil, [String.t()], map()) ::
          String.t()
  def derive_dedup_key(event_type, subject_id, behavior_name \\ nil, identity_fields \\ [], payload \\ %{}) do
    canonical =
      [
        "e:#{event_type}",
        "s:#{subject_id}",
        "b:#{behavior_name}",
        "id:" <>
          Enum.map_join(identity_fields, ",", fn f ->
            "#{f}=#{payload_path(payload, f) |> inspect()}"
          end)
      ]
      |> Enum.join("|")

    :sha256
    |> :crypto.hash(canonical)
    |> Base.encode16(case: :lower)
  end

  defp payload_path(payload, dotted) do
    dotted
    |> String.split(".")
    |> Enum.reduce(payload, fn k, acc ->
      case acc do
        %{} -> Map.get(acc, k) || Map.get(acc, safe_atom(k))
        _ -> nil
      end
    end)
  end

  defp safe_atom(k) do
    try do
      String.to_existing_atom(k)
    rescue
      ArgumentError -> :__nonexistent__
    end
  end

  @doc """
  Build an Event from normalized fields. Computes defaults for
  `event_id`/`occurred_at`/`emitted_at`/`dedup_key`.
  """
  @spec build(keyword() | map()) :: t()
  def build(fields) do
    m = Map.new(fields)

    %__MODULE__{
      event_id: m[:event_id] || generate_id(),
      event_type: m[:event_type],
      occurred_at: m[:occurred_at] || now(),
      emitted_at: m[:emitted_at] || now(),
      source: m[:source] || "local",
      project_id: m[:project_id],
      subject_id: m[:subject_id] || "",
      payload: m[:payload] || %{},
      actor: m[:actor] || %{type: :system, id: nil},
      correlation_id: m[:correlation_id],
      causation_id: m[:causation_id],
      causal_parent: m[:causal_parent],
      depth: m[:depth] || 0,
      dedup_key:
        m[:dedup_key] ||
          derive_dedup_key(
            m[:event_type],
            m[:subject_id] || "",
            m[:behavior_name],
            m[:identity_fields] || [],
            m[:payload] || %{}
          )
    }
  end

  defp generate_id do
    "e-" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end
end
