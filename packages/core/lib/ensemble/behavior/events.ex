defmodule Ensemble.Behavior.Events do
  @moduledoc """
  Adapter registry + normalization dispatcher (TRD §1.6, REQ-006 AC-021..024).

  `normalize/2` picks an adapter by `source_hint` (or by inspecting the
  raw map's shape) and returns `{:ok, Event.t()} | {:warn, Event.t()} |
  {:error, :unknown_schema_version}`. Unrecognized payloads fall through to
  `Events.Generic` with a logged warning naming the source (AC-024).
  """

  alias Ensemble.Behavior.Event
  alias Ensemble.Behavior.Events.{Github, Beads, Local, Generic}

  @adapters [
    {"github", Github},
    {"beads", Beads},
    {"local", Local}
  ]

  @doc "Registered adapter pairs (source_hint -> module)."
  def adapters, do: @adapters

  @doc """
  Normalize a raw source payload. When `source_hint` is nil, the payload's
  own keys select an adapter; otherwise the named adapter runs.
  """
  @spec normalize(map(), String.t() | atom() | nil) ::
          {:ok, Event.t()} | {:warn, Event.t()} | {:error, :unknown_schema_version}
  def normalize(raw, source_hint \\ nil) when is_map(raw) do
    case detect(raw, source_hint) do
      {:ok, module} -> module.normalize(raw)
      :generic -> Generic.normalize(raw, hint_label(source_hint))
    end
  end

  defp detect(raw, nil) do
    cond do
      Map.has_key?(raw, "event_type") -> {:ok, Local}
      Map.has_key?(raw, "after") && Map.has_key?(raw, "issue") -> {:ok, Beads}
      Map.has_key?(raw, "action") && Map.has_key?(raw, "repository") -> {:ok, Github}
      Map.has_key?(raw, "hook_event_name") -> {:ok, Github}
      Map.get(raw, "type") == "agent.run" -> {:ok, Local}
      Map.has_key?(raw, "tool_name") -> {:ok, Local}
      true -> :generic
    end
  end

  defp detect(_raw, hint) when is_binary(hint) or is_atom(hint) do
    case List.keyfind(@adapters, to_string(hint), 0) do
      {_, module} -> {:ok, module}
      nil -> :generic
    end
  end

  defp hint_label(nil), do: "unknown"
  defp hint_label(h), do: to_string(h)

  @doc "Best-effort `schema_version` from raw payload; 1 when absent."
  def schema_version(raw), do: raw["schema_version"] || raw[:schema_version] || 1
end
