defmodule Mix.Tasks.Behavior.Test do
  @moduledoc """
  Run the conformance suite for one behavior (TRD-029 CLI surface, AC-061).

      mix behavior.test <name> [--format markdown|json] [--path PATH]

  Discovers behaviors via `Ensemble.Behavior.Compiler.discover/1` from the
  current package (`packages/core` by default, override with `--path`),
  selects the compiled `Definition` with `Compiler.select_candidate/2`,
  loads its fixtures, runs `Ensemble.Behavior.TestRunner.run/2`, prints the
  report, and exits non-zero on any failing match/outcome assertion.

  This is the Elixir-native equivalent of the JS entrypoint
  `ensemble test behavior:<name>` (there is no `bin/ensemble` in this
  package; see `Ensemble.Behavior.TestRunner`).
  """
  use Mix.Task

  alias Ensemble.Behavior.{Compiler, TestRunner}

  @shortdoc "Run conformance fixtures for a behavior"

  @impl Mix.Task
  def run(argv) do
    {opts, args, _} =
      OptionParser.parse(argv, switches: [format: :string, path: :string])

    case args do
      [name] -> do_run(name, opts)
      [] -> Mix.raise("usage: mix behavior.test <behavior-name>")
      other -> Mix.raise("expected one behavior name, got: #{inspect(other)}")
    end
  end

  defp do_run(name, opts) do
    Mix.Task.run("loadpaths")
    Application.ensure_all_started(:ensemble)

    root = Keyword.get(opts, :path, File.cwd!())
    {defs, _issues} = Compiler.discover(root)

    case Compiler.select_candidate(name, defs) do
      {:ok, defn} ->
        report = TestRunner.run(defn, [])
        IO.puts(format(report, Keyword.get(opts, :format, "markdown")))
        IO.write(coverage(report))

        failing =
          Enum.count(report.match_tests, &not(&1.passed?)) +
            Enum.count(report.outcome_tests, &not(&1.passed?))

        if failing > 0, do: exit({:shutdown, 1}), else: :ok

      {:error, :no_compatible_version} ->
        Mix.raise("no behavior named #{inspect(name)} discovered under #{root}")
    end
  end

  defp coverage(%TestRunner.ConformanceReport{coverage_warnings: []}), do: ""

  defp coverage(%TestRunner.ConformanceReport{coverage_warnings: ws}) do
    "\n## Coverage warnings\n" <> Enum.map_join(ws, "\n", fn w -> "- #{w}" end) <> "\n"
  end

  defp format(%TestRunner.ConformanceReport{} = r, "json"), do: Jason.encode!(to_jsonable(r))

  defp format(%TestRunner.ConformanceReport{} = r, _) do
    rows =
      (r.match_tests ++ r.outcome_tests)
      |> Enum.map(fn t ->
        flag = if t.passed?, do: "PASS", else: "FAIL"
        "  [#{flag}] #{t.kind} #{t.fixture}: #{t.assertion}" <>
          if t.passed? do
            ""
          else
            "\n      expected: #{inspect(t.expected)}" <>
              "\n      actual:   #{inspect(t.actual)}" <>
              "\n      fixture:  #{t.path || "(no file)"}"
          end
      end)

    "# Conformance: #{r.behavior} v#{r.version}\n" <>
      "fixtures_loaded=#{r.fixtures_loaded} match_tests=#{length(r.match_tests)} " <>
      "outcome_tests=#{length(r.outcome_tests)} trigger_paths=#{r.trigger_paths} " <>
      "required=#{r.events_required}\n" <> Enum.join(rows, "\n")
  end

  defp to_jsonable(%TestRunner.ConformanceReport{} = r) do
    r
    |> Map.from_struct()
    |> Map.put(:match_tests, Enum.map(r.match_tests, &test_result_json/1))
    |> Map.put(:outcome_tests, Enum.map(r.outcome_tests, &test_result_json/1))
  end

  defp test_result_json(%TestRunner.TestResult{} = t) do
    %{
      "kind" => Atom.to_string(t.kind),
      "fixture" => t.fixture,
      "assertion" => t.assertion,
      "path" => t.path,
      "passed" => t.passed?,
      "expected" => safe_json(t.expected),
      "actual" => safe_json(t.actual)
    }
  end

  # expected/actual can hold any term (atoms, tuples, lists). Encode a stable
  # textual form so the JSON stays machine-consumable without Jason failing.
  defp safe_json(v), do: inspect(v, printable_limit: :infinity, structs: false)
end
