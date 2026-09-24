defmodule Ensemble.Behavior.DiscoveryEngine do
  @moduledoc """
  Pattern discovery over run telemetry (TRD §5.3, REQ-014; TRD-032;
  AC-051, AC-053, AC-054, AC-055, AC-056).

  ## Clustering

  `analyze/1` groups telemetry runs by `event_type` and extracts
  consecutive tool-call **bigrams** from each run's ordered tool sequence
  (AC-051: "match event → run tool X → run tool Y"). A run with a single
  distinct tool contributes the degenerate bigram `{t, t}` so singleton
  patterns still cluster (AC-056 covers them as exploratory).

  Each cluster becomes a suggestion (AC-054):

      %{pattern_name: "test-failed-read-bash-test",
        inferred_event_type: "test.failed",
        tools: ["read", "bash.test"],
        frequency: 12,
        confidence: 73,
        exploratory: false,
        recommended: true}

  Confidence is frequency-scaled: frequency 1 → 20 (<40 ⇒ `exploratory`,
  AC-056); 2 → 35; then +4/observation up to the recommend threshold;
  10+ → `recommended: true` (AC-053) climbing +3/observation, saturating
  at 95.

  ## Report + approve/reject (AC-051/AC-055)

  `report/1` renders the `ensemble behavior discover --report` view.
  `decide/3` records a maintainer decision in the tracked proposal
  artifact `.ensemble/discovery/proposals.jsonl` (append-only, one
  redacted line per decision). Approving inserts a draft package
  `behaviors/<slug>/behavior.yaml` with `mode: propose` — written only
  after the draft passes `Compiler.validate` (Phase-1 validator gates
  discovery drafts exactly like any behavior; no bypass). Rejecting
  records feedback and mutates nothing.

  Everything takes explicit `:dir` / `:behaviors_dir` options; no env, so
  tests stay async-safe.
  """

  alias Ensemble.Behavior.{Audit, Compiler, Registries, Telemetry, ToolGuard}

  @recommended_at 10

  # --- analysis -----------------------------------------------------------

  @doc """
  Cluster telemetry runs into suggestions. Accepts a run list (maps as
  returned by `Telemetry.replay_for/1`, either key style) or options
  (`:telemetry_dir`, `:since` — replayed; `:min_bigram`, default 1).

  Deterministic order: sort by `{-frequency, pattern_name}`.
  """
  @spec analyze([map()] | keyword()) :: [map()]
  def analyze(input \\ [])

  def analyze(input) do
    if Keyword.keyword?(input) do
      opts =
        case Keyword.pop(input, :telemetry_dir) do
          {nil, rest} -> rest
          {d, rest} -> Keyword.put(rest, :dir, d)
        end

      cluster(Telemetry.replay_for(opts), opts)
    else
      cluster(input, min_bigram: 1)
    end
  end

  defp cluster(runs, opts) do
    min = Keyword.get(opts, :min_bigram, 1)

    runs
    |> Enum.map(&normalize_run/1)
    |> Enum.flat_map(&bigrams_of/1)
    |> Enum.frequencies()
    |> Enum.map(&to_suggestion/1)
    |> Enum.filter(&(&1.frequency >= min))
    |> Enum.sort_by(fn s -> {-s.frequency, s.pattern_name} end)
  end

  defp normalize_run(r) when is_struct(r), do: r |> Map.from_struct() |> normalize_run()

  defp normalize_run(r) when is_map(r) do
    %{
      event_type: Map.get(r, :event_type) || Map.get(r, "event_type"),
      tools:
        (Map.get(r, :tool_calls) || Map.get(r, "tool_calls") || [])
        |> Enum.map(&tool_of/1)
    }
  end

  defp tool_of(tc) when is_map(tc), do: to_string(Map.get(tc, :tool) || Map.get(tc, "tool"))
  defp tool_of(t) when is_binary(t), do: t
  defp tool_of(t), do: to_string(t)

  # One run contributes every consecutive bigram of its tool sequence,
  # tagged with the run's event_type. Immediate repeats collapse first so
  # a retried tool cannot fake a bigram; a single distinct tool yields the
  # degenerate {t, t} bigram.
  defp bigrams_of(%{event_type: et, tools: tools}) do
    case Enum.uniq(tools) do
      [] -> []
      [t] -> [{et, t, t}]
      seq -> seq |> Enum.zip(tl(seq)) |> Enum.map(fn {a, b} -> {et, a, b} end)
    end
  end

  defp to_suggestion({{et, a, b}, freq}) do
    tools = if a == b, do: [a], else: [a, b]
    confidence = confidence(freq)

    %{
      pattern_name: pattern_name(et, tools),
      inferred_event_type: et,
      tools: tools,
      frequency: freq,
      confidence: confidence,
      exploratory: confidence < 40,
      recommended: freq >= @recommended_at
    }
  end

  defp confidence(freq) when freq <= 0, do: 0
  defp confidence(1), do: 20
  defp confidence(2), do: 35
  defp confidence(freq) when freq < @recommended_at, do: 35 + 4 * (freq - 2)
  defp confidence(freq) when freq < 30, do: min(67 + 3 * (freq - @recommended_at), 95)
  defp confidence(_), do: 95

  @doc """
  Deterministic suggestion name: event segments and tool segments joined
  with single dashes (every run of non-alphanumerics collapses to one),
  so the name doubles as the draft package slug.
  """
  @spec pattern_name(String.t() | nil, [String.t()]) :: String.t()
  def pattern_name(et, tools) do
    [slug(et || "unknown_event") | Enum.map(tools, &slug/1)]
    |> Enum.join("-")
    |> String.trim("-")
  end

  defp slug(s) do
    s
    |> to_string()
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9]+/, "-")
    |> String.trim("-")
  end

  # --- report -------------------------------------------------------------

  @doc """
  The `ensemble behavior discover --report` equivalent (AC-051): text
  report + structured suggestions.
  """
  @spec report([map()] | keyword()) :: {String.t(), [map()]}
  def report(input \\ []) do
    suggestions = analyze(input)

    header = "discovery report (#{length(suggestions)} pattern suggestions)\n"

    body =
      Enum.map(suggestions, fn s ->
        flag =
          cond do
            s.recommended -> "recommended"
            s.exploratory -> "exploratory"
            true -> "candidate"
          end

        "* #{s.pattern_name}\n" <>
          "    event:      #{s.inferred_event_type}\n" <>
          "    tools:      #{Enum.join(s.tools, " -> ")}\n" <>
          "    frequency:  #{s.frequency}   confidence: #{s.confidence}%   #{flag}\n"
      end)

    {IO.iodata_to_binary([header | body]), suggestions}
  end

  # --- proposal artifact + approve/reject ----------------------------------

  @doc "Path of the tracked proposal artifact."
  def proposals_file(opts \\ []), do: Path.join(dir(opts), "proposals.jsonl")

  defp dir(opts), do: Keyword.get(opts, :dir) || ".ensemble/discovery"

  @doc "Every decision recorded so far (chronological)."
  def proposals(opts \\ []) do
    file = proposals_file(opts)

    case File.read(file) do
      {:ok, body} ->
        body
        |> String.split("\n", trim: true)
        |> Enum.map(&decode/1)
        |> Enum.reject(&is_nil/1)

      _ ->
        []
    end
  end

  @doc """
  Record a maintainer decision (AC-055).

    * `:approve` — validates the draft via `Compiler.validate` and only
      then inserts `behaviors/<slug>/behavior.yaml` (mode: propose). A
      draft that fails Phase-1 validation writes nothing and returns
      `{:error, {:invalid, errors}}`.
    * `:reject` — records `feedback`, mutates nothing.

  The decision line itself lands in `.ensemble/discovery/proposals.jsonl`
  through the shared §5.3 redaction pass.

  Options: `:dir`, `:behaviors_dir`, `:feedback`.
  """
  @spec decide(map(), :approve | :reject, keyword()) :: {:ok, map()} | {:error, term()}
  def decide(suggestion, verdict, opts \\ []) when verdict in [:approve, :reject] do
    behav_dir = Keyword.get(opts, :behaviors_dir) || "behaviors"

    case verdict do
      :reject ->
        record(suggestion, :rejected, nil, opts)

      :approve ->
        path = draft_path(behav_dir, suggestion)

        with {:ok, yaml} <- draft_yaml(suggestion),
             {:ok, _defn} <- Compiler.validate(yaml, file: path),
             :ok <- write_draft(behav_dir, slug_of(suggestion), yaml) do
          record(suggestion, :approved, path, opts)
        else
          {:error, :unknown_event_type} = e -> e
          {:error, errs} -> {:error, {:invalid, errs}}
        end
    end
  end

  defp record(suggestion, status, draft_path, opts) do
    entry =
      Telemetry.redact(%{
        "ts" => DateTime.utc_now() |> DateTime.to_iso8601(),
        "decision" => Atom.to_string(status),
        "pattern_name" => fetch(suggestion, :pattern_name),
        "inferred_event_type" => fetch(suggestion, :inferred_event_type),
        "tools" => fetch(suggestion, :tools) || [],
        "frequency" => fetch(suggestion, :frequency) || 0,
        "confidence" => fetch(suggestion, :confidence) || 0,
        "feedback" => Keyword.get(opts, :feedback),
        "draft_path" => draft_path
      })

    file = proposals_file(opts)

    try do
      File.mkdir_p!(Path.dirname(file))
      File.write!(file, [Audit.canonical_json(entry), "\n"], [:append])
      {:ok, entry}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp fetch(m, k), do: Map.get(m, k) || Map.get(m, to_string(k))

  @doc "The catalog slug for a suggestion."
  def slug_of(suggestion) do
    suggestion
    |> fetch(:pattern_name)
    |> Kernel.||("discovered-pattern")
    |> to_string()
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9-]+/, "-")
    |> String.replace(~r/-+/, "-")
    |> String.trim("-")
  end

  # Catalog name for the draft: the package slug, clamped to the schema's
  # 64-char `^[a-z0-9-]{1,64}$` metadata/name pattern.
  def draft_name(suggestion), do: suggestion |> slug_of() |> String.slice(0, 64)

  defp draft_path(behav_dir, suggestion),
    do: Path.join([behav_dir, slug_of(suggestion), "behavior.yaml"])

  defp write_draft(behav_dir, slug, yaml) do
    dir = Path.join(behav_dir, slug)
    File.mkdir_p!(Path.join(dir, "fixtures/events"))
    File.write!(Path.join(dir, "behavior.yaml"), yaml)
    File.write!(Path.join(dir, "README.md"), draft_readme(slug))
    :ok
  end

  @doc """
  Draft behavior YAML for a suggestion: `mode: propose` (staged-rollout
  default), registry-valid event type and tools only, and a real
  workflow graph. Returns `{:error, :unknown_event_type}` for patterns
  whose inferred event type is not in the event registry or is deeper
  than the draft schema's four-segment cap — such patterns can only be
  rejected, never silently drafted. Every draft still goes through
  `Compiler.validate` before insertion (`decide/3`); no bypass.
  """
  @spec draft_yaml(map()) :: {:ok, String.t()} | {:error, :unknown_event_type}
  def draft_yaml(suggestion) do
    raw_et = fetch(suggestion, :inferred_event_type)

    if is_binary(raw_et) and Registries.event_known?(raw_et) and
         length(String.split(raw_et, ".")) <= 4 do
      {:ok, build_draft(raw_et, suggestion)}
    else
      {:error, :unknown_event_type}
    end
  end

  defp build_draft(et, suggestion) do
    registered =
      (fetch(suggestion, :tools) || [])
      |> Enum.map(&ToolGuard.canonical_tool/1)
      |> Enum.filter(&Registries.tool_known?/1)
      |> Enum.uniq()

    tools = if registered == [], do: ["read"], else: registered
    freq = fetch(suggestion, :frequency) || 0

    """
    api_version: ensemble.sunstone.dev/v1
    kind: Behavior
    metadata:
      name: #{draft_name(suggestion)}
      version: 0.1.0
      description: >-
        Draft behavior proposed by the discovery engine from #{freq}
        observed runs of #{et}. Mode: propose; review and add fixtures
        before promoting to active.
    trigger:
      event_type: #{et}
    policy:
      mode: propose
    capabilities:
      tools: [#{Enum.join(tools, ", ")}]
      mutation_classes: [none]
    execution:
      graph: #{pick_graph(tools)}
    outcomes: [ensemble.run.completed, ensemble.run.failed]
    """
  end

  defp pick_graph(tools) do
    review? =
      Enum.any?(
        tools,
        &(ToolGuard.canonical_tool(&1) in ["code_review", "review_pr", "pr_review"])
      )

    if review? and Registries.workflow_known?("ensemble.review-pr"),
      do: "ensemble.review-pr",
      else: "ensemble.fix"
  end

  defp draft_readme(slug) do
    """
    # #{slug}

    Draft behavior auto-inserted by `DiscoveryEngine.decide/3` after a
    maintainer approved a discovery suggestion. It runs in `mode:
    propose`: matches are audited and proposals emitted, nothing
    executes until the policy mode is raised. Add fixtures
    (`fixtures/events/*.json` + expected matches) before promoting.
    """
  end

  defp decode(line) do
    case :json.decode(line) do
      m when is_map(m) -> m
      _ -> nil
    end
  rescue
    _ -> nil
  end
end
