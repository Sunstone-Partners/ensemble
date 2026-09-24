defmodule Ensemble.Behavior.FixtureLoader do
  @moduledoc """
  Conformance-fixture reader for the behavior package layout (TRD §1.7,
  TRD-029, AC-057).

      behaviors/<package>/
        behavior.yaml
        fixtures/
          events/*.json            # raw SOURCE shapes (hook records, webhook
                                   # payloads, beads diffs) — never pre-normalized
          expected-matches/*.json  # per-event candidate expectations
          expected-outcomes/*.json # proposals/mutations asserted after completion

  Event files are loaded **raw** and normalized end-to-end through the
  adapter dispatcher (`Ensemble.Behavior.Events.normalize/2`) so fixtures
  exercise the same normalization path production uses (AC-057). A fixture
  may pin an adapter with `"source"`; otherwise the raw shape selects one.

  ## File formats

  `fixtures/events/<name>.json` — either a raw source payload (recommended)
  or an already-canonical envelope (`{"kind": "Event", "event_type": ...}`).
  Raw payloads may be wrapped as `{"raw": {...}, "source_hint": "github"}`
  to make the pinning explicit; the wrapper is optional.

  `fixtures/expected-matches/<name>.expected.json`

      {
        "event": "test-failed",              # events/<event>.json
        "matches": ["investigate-test-failure"],  # expected :matched names
        "non_matches": ["other-behavior"],        # expected rejected names
        "candidates": [                           # optional, exact full set
          {"behavior": "investigate-test-failure", "version": "0.1.0",
           "status": "matched"}
        ]
      }

  `fixtures/expected-outcomes/<name>.expected.json`

      {
        "event": "test-failed",
        "verdict": "activate",                # expected policy verdict
        "proposals": ["investigate-test-failure"],
        "mutations": ["artifact.write"],      # declared classes proposed
        "outcomes": ["test.failure.investigated"]
      }

  Expected-outcomes assertions are evaluated against the match+policy path
  only — a conformance run NEVER dispatches real agents, workflows or
  mutations. The stubbed execution surface is owned by
  `Ensemble.Behavior.TestRunner`.

  Ordering is deterministic everywhere: fixtures sort by
  `{kind, name}` and multi-event files keep their declaration order.
  """

  alias Ensemble.Behavior.{Definition, Events}

  @kinds ~w(events expected-matches expected-outcomes)

  @type loaded :: %{
          kind: String.t(),
          name: String.t(),
          path: String.t(),
          data: map(),
          reason: String.t() | nil
        }

  @doc "Fixture root for a compiled definition (`source[:path]` → `<dir>/fixtures`)."
  @spec fixture_dir(Definition.t() | String.t()) :: String.t() | nil
  def fixture_dir(%Definition{source: src}) when is_map(src) do
    case Map.get(src, :path) do
      nil -> nil
      p when is_binary(p) -> p |> Path.dirname() |> Path.join("fixtures")
    end
  end

  def fixture_dir(dir) when is_binary(dir), do: Path.join(dir, "fixtures")

  @doc """
  Load every fixture for `defn`. Returns
  `%{"events" => [loaded], "expected-matches" => [loaded], "expected-outcomes" => [loaded]}`.
  Unreadable/unparseable files appear with `:data == nil` and a `:reason`,
  so the runner can fail loudly instead of silently skipping (AC-062).
  """
  @spec load_all(Definition.t()) :: map()
  def load_all(%Definition{} = defn) do
    root = fixture_dir(defn)

    Map.new(
      for kind <- @kinds do
        files =
          if root && File.dir?(root) do
            root |> Path.join("#{kind}/*.json") |> Path.wildcard() |> Enum.sort()
          else
            []
          end

        {kind, Enum.map(files, &load_file(kind, &1))}
      end
    )
  end

  defp load_file(kind, path) do
    name = fixture_name(path)

    case File.read(path) do
      {:ok, body} ->
        case decode_json(body) do
          {:ok, m} when is_map(m) ->
            %{kind: kind, name: name, path: path, data: m, reason: nil}

          {:ok, _other} ->
            %{kind: kind, name: name, path: path, data: nil, reason: "not a JSON object"}

          {:error, reason} ->
            %{kind: kind, name: name, path: path, data: nil, reason: "decode: #{inspect(reason)}"}
        end

      {:error, reason} ->
        %{kind: kind, name: name, path: path, data: nil, reason: inspect(reason)}
    end
  end

  defp decode_json(body) do
    case :json.decode(body) do
      m when is_map(m) -> {:ok, m}
      other -> {:ok, other}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp fixture_name(path) do
    base = Path.basename(path)

    cond do
      String.ends_with?(base, ".expected.json") ->
        String.slice(base, 0, byte_size(base) - byte_size(".expected.json"))

      String.ends_with?(base, ".json") ->
        Path.rootname(base, ".json")

      true ->
        base
    end
  end

  def normalize_event_fixture(data) when is_map(data) do
    entries =
      cond do
        is_list(data["events"]) -> data["events"]
        is_map(data["raw"]) -> [data]
        true -> [%{"raw" => data, "source_hint" => data["source_hint"]}]
      end

    {evs, warns} =
      entries
      |> Enum.map_reduce([], fn entry, acc ->
        case entry_result(entry) do
          {:ok, e, w} -> {e, [w | acc]}
          {:error, reason} -> {nil, ["unnormalizable event fixture: #{inspect(reason)}" | acc]}
        end
      end)

    {:ok, Enum.reject(evs, &is_nil/1), warns |> Enum.reverse() |> Enum.reject(&is_nil/1)}
  end

  defp entry_result(%{"raw" => raw} = entry), do: do_normalize(raw, entry["source_hint"])
  defp entry_result(raw), do: do_normalize(raw, raw["source_hint"])

  defp do_normalize(raw, hint) when is_map(raw) do
    case Events.normalize(raw, hint) do
      {:ok, e} -> {:ok, e, nil}
      {:warn, e} -> {:ok, e, "normalization warned (adapter fell back to generic)"}
      {:error, reason} -> {:error, reason}
    end
  end

  defp do_normalize(other, _hint), do: {:error, {:not_a_map, other}}

  @doc "Canonical-name lookup: `events/<name>.json` from a loaded set."
  @spec event_by_name(map(), String.t()) :: map() | nil
  def event_by_name(loaded, name) do
    Enum.find(loaded["events"], &(&1.name == name))
  end
end
