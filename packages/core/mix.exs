defmodule Ensemble.MixProject do
  use Mix.Project

  def project do
    [
      app: :ensemble,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      test_coverage: [summary: [threshold: 85], threshold: 85],
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {Ensemble.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:yaml_elixir, "~> 2.9"},
      {:ex_json_schema, "~> 0.10"},
      {:stream_data, "~> 1.1", only: :test}
    ]
  end
end
