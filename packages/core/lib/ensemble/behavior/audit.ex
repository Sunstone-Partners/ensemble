defmodule Ensemble.Behavior.Audit do
  @moduledoc """
  Append-only audit sink (TRD §1.7, REQ-011/REQ-012, TRD-016).

  Phase 2 exposes `log_match/2` — the synchronous match-before-decide hook
  (AC-026): every candidate the Matcher considered (matched,
  predicate_failed, depth_dropped, suppressed) is written **before**
  `Policy.evaluate` sees the event, so the ledger shows which behaviors
  were rejected and why, not just those that fired.

  Storage: newline-delimited JSON under `ENSEMBLE_AUDIT_DIR` (default
  `.ensemble/audit`) in the caller's cwd. `audit_id` is a UUIDv7-shaped
  string; records compose through `canonical_json/1` (sorted keys,
  escaped strings) so `replay/1` proves byte-equivalence (AC-017).
  """

  import Bitwise

  alias Ensemble.Behavior.MatchResult

  @doc """
  Log every Matcher proposal (match or reject) synchronously. Returns
  `{:ok, count}`. Sink errors are surfaced, not swallowed (AC-026).
  """
  @spec log_match(term(), [MatchResult.t()]) :: {:ok, non_neg_integer()} | {:error, term()}
  def log_match(event, results) when is_list(results) do
    with :ok <- File.mkdir_p(audit_dir()) do
      file = Path.join(audit_dir(), "match.jsonl")

      payload = %{
        "event_type" => event_type_of(event),
        "event_id" => event_id_of(event),
        "candidates" =>
          Enum.map(results, fn %MatchResult{} = r ->
            %{
              "behavior" => r.definition.name,
              "version" => to_string(r.definition.version),
              "status" => Atom.to_string(r.status),
              "digest" => Base.encode16(r.definition.digest, case: :lower)
            }
          end)
      }

      case append(file, "behavior.match", event_subject(event), payload) do
        :ok -> {:ok, length(results)}
        err -> err
      end
    end
  end

  @doc "Stream all audit records, sorted by audit_id."
  def stream do
    audit_dir()
    |> Path.join("*.jsonl")
    |> Path.wildcard()
    |> Enum.flat_map(fn f ->
      f
      |> File.stream!(:line, [])
      |> Stream.map(&decode_line/1)
      |> Stream.reject(&is_nil/1)
    end)
    |> Enum.sort_by(& &1["audit_id"])
  end

  defp decode_line(line) do
    case :json.decode(line) do
      m when is_map(m) -> m
      _ -> nil
    end
  rescue
    _ -> nil
  end

  @doc "Canonical JSON bytes for a payload (AC-017 byte-equivalent replay)."
  def replay(payload) when is_map(payload), do: payload |> canonical_json() |> IO.iodata_to_binary()

  @doc false
  def audit_dir, do: System.get_env("ENSEMBLE_AUDIT_DIR") || ".ensemble/audit"

  defp append(file, type, subject, payload) do
    record = %{
      "audit_id" => audit_id(),
      "ts" => timestamp(),
      "type" => type,
      "subject" => to_string(subject),
      "payload" => payload
    }

    try do
      File.write!(file, [canonical_json(record), "\n"], [:append])
      :ok
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  @doc false
  def canonical_json(v), do: v |> encode_value() |> IO.iodata_to_binary()

  defp encode_value(%_{} = struct), do: struct |> Map.from_struct() |> encode_value()

  defp encode_value(v) when is_map(v) do
    inner =
      v
      |> Map.to_list()
      |> Enum.sort_by(fn {k, _} -> to_string(k) end)
      |> Enum.map(fn {k, val} -> [~s("), escape(to_string(k)), ~s(":), encode_value(val)] end)
      |> Enum.intersperse(",")

    ["{", inner, "}"]
  end

  defp encode_value(v) when is_list(v) do
    if Keyword.keyword?(v) and v != [] do
      encode_value(Map.new(v))
    else
      ["[", v |> Enum.map(&encode_value/1) |> Enum.intersperse(","), "]"]
    end
  end

  defp encode_value(v) when is_binary(v), do: [~S("), escape(v), ~S(")]
  defp encode_value(nil), do: "null"
  defp encode_value(true), do: "true"
  defp encode_value(false), do: "false"
  defp encode_value(v) when is_atom(v), do: [~S("), Atom.to_string(v), ~S(")]
  defp encode_value(v) when is_integer(v), do: Integer.to_string(v)
  defp encode_value(v) when is_float(v), do: Float.to_string(v)
  defp encode_value(v) when is_tuple(v), do: encode_value(Tuple.to_list(v))
  defp encode_value(v), do: raise(ArgumentError, "cannot audit-encode: #{inspect(v)}")

  defp escape(s) do
    s
    |> String.replace("\\", "\\\\")
    |> String.replace(~s("), ~s(\\"))
    |> String.replace("\n", "\\n")
    |> String.replace("\r", "\\r")
    |> String.replace("\t", "\\t")
  end

  defp timestamp do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  @doc false
  def audit_id, do: uuid_v7()

  defp uuid_v7 do
    ms = System.system_time(:millisecond)
    <<rand_a::12, rand_b::14, rand_c::16, rand_d::48, _::6>> = :crypto.strong_rand_bytes(12)

    [
      hex(ms, 12),
      "-",
      hex(0x7000 ||| rand_a, 4),
      "-",
      hex(0x8000 ||| rand_b, 4),
      "-",
      hex(rand_c, 4),
      "-",
      hex(rand_d, 12)
    ]
    |> IO.iodata_to_binary()
  end

  defp hex(n, width),
    do: n |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(width, "0")

  defp event_type_of(%{event_type: t}), do: t
  defp event_type_of(t) when is_binary(t), do: t
  defp event_type_of(_), do: nil

  defp event_id_of(%{event_id: id}), do: id
  defp event_id_of(_), do: nil

  defp event_subject(%{subject_id: s}), do: s
  defp event_subject(%{subject: s}), do: s
  defp event_subject(_), do: nil
end
