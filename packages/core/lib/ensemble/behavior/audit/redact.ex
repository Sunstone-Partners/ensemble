defmodule Ensemble.Behavior.Audit.Redact do
  @moduledoc """
  Secret redaction for audit records (TRD §5.1/§5.3, REQ-026 AC-096).

  Every ledger entry passes this pass **before write** — the same pass the
  telemetry exporter uses, so no plaintext credential can land in the
  audit trail even when an agent's tool output contains one. Values are
  replaced with `[REDACTED:<kind>]`, which keeps the fact that something
  was there (forensics) without the secret.

  Patterns (TRD §5.3):

  * `AWS_ACCESS_KEY_ID` — `AKIA` + 16 upper alphanumerics → `[REDACTED:aws-access-key-id]`
  * GitHub personal tokens — `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + 36 → `[REDACTED:github-token]`
  * Generic assignments — `password|secret|token|api_key` `:`/`=` + value → `[REDACTED:credential]`

  `redact/1` walks maps, lists and binaries recursively and leaves
  everything else untouched; atom keys are preserved (redaction applies to
  the key text too, which in practice never matches).
  """

  # Order matters: specific credential shapes first so their label is
  # accurate, generic assignment last.
  @rules [
    {"aws-access-key-id", ~r/AKIA[0-9A-Z]{16}/},
    {"github-token", ~r/gh[pousr]_[A-Za-z0-9]{36,}/},
    {"credential", ~r/(password|secret|token|api_key|apikey)[\s]*[:=][\s]*\S+/i}
  ]

  @doc """
  Redact every secret in a value (string, map, list, tuple, keyword).
  Returns a same-shaped value with matching substrings replaced by
  `[REDACTED:<kind>]`.
  """
  @spec redact(term()) :: term()
  def redact(text) when is_binary(text), do: redact_string(text)

  def redact(%_{} = struct), do: struct |> Map.from_struct() |> redact()

  def redact(map) when is_map(map),
    do: Map.new(map, fn {k, v} -> {redact(k), redact(v)} end)

  def redact(list) when is_list(list) do
    if Keyword.keyword?(list) and list != [] do
      Enum.map(list, fn {k, v} -> {redact(k), redact(v)} end)
    else
      Enum.map(list, &redact/1)
    end
  end

  def redact(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> redact() |> List.to_tuple()
  def redact(other), do: other

  defp redact_string(text) do
    # A redaction marker must never be re-matched by a later rule
    # (`token` inside `[REDACTED:github-token]` would otherwise trip the
    # generic assignment rule on some inputs), so split on existing
    # markers and only transform the un-redacted segments.
    parts =
      text
      |> String.split(~r/(\[REDACTED:[a-z0-9_-]+\])/, include_captures: true)
      |> Enum.map(fn
        "[REDACTED:" <> _ = marker -> marker
        segment -> Enum.reduce(@rules, segment, &apply_rule/2)
      end)

    IO.iodata_to_binary(parts)
  end

  defp apply_rule({label, re}, text) do
    Regex.replace(re, text, "[REDACTED:#{label}]", global: true)
  end

  @doc "True when `text` still contains a match for any redaction rule."
  @spec secret?(String.t()) :: boolean()
  def secret?(text) when is_binary(text),
    do: Enum.any?(@rules, fn {_l, re} -> Regex.match?(re, text) end)
end
