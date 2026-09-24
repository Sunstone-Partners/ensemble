defmodule Ensemble.Behavior.Audit.Retention do
  @moduledoc """
  Monthly partitioning + retention policy for the audit ledger
  (TRD §5.1 / TRD-027, REQ-021).

  Partitions are the ledger of record: JSONL files named by entry family
  and UTC month, so a date-bounded query can prune whole files and an
  expiry sweep drops partitions instead of rewriting them (the
  append-only invariant is preserved):

      activations-202609.jsonl   # activation / tool_violation /
                                 # proposal_link / skill_invocation /
                                 # policy_rejection  (365d default)
      matches-202609.jsonl       # match_recorded   (90d default)

  (Deliberate deviation from the TRD's single `activations-YYYYMM.jsonl`
  example: retention windows differ per class, so per-class partitions
  let expiry drop a whole file. Legacy flat `match.jsonl` /
  `violations.jsonl` files written before TRD-026 remain readable —
  `Audit` treats every `*.jsonl` under the dir as part of the ledger.)

  ## Defaults (TRD §5.1)

  | class        | kinds                                                                  | window |
  |---           |---                                                                     |---     |
  | match        | `match_recorded`                                                       | 90d    |
  | activation   | `activation`, `tool_violation`, `proposal_link`, `skill_invocation`, `policy_rejection` | 365d |

  Windows are overridable per project:

  * `[audit] retention_days` / `[audit] match_retention_days` — read from
    `ENSEMBLE_AUDIT_RETENTION_DAYS` / `ENSEMBLE_AUDIT_MATCH_RETENTION_DAYS`
    (env is the transport for the config table; §12 Q7 proposes the
    default), or
  * `retention_days:` / `match_retention_days:` options passed directly
    to `purge/1`.

  Expiry keys on **entry `occurred_at`**: a whole partition is dropped
  when its newest possible instant is already outside the window;
  partially expired partitions are rewritten atomically (write temp +
  rename), never silently truncated.
  """

  alias Ensemble.Behavior.Audit
  alias Ensemble.Behavior.Audit.Kind

  @match_days 90
  @activation_days 365

  @doc "Default retention window in days for a kind."
  @spec default_window(atom()) :: non_neg_integer()
  def default_window(:match_recorded), do: @match_days
  def default_window(_), do: @activation_days

  @doc """
  Resolve the retention windows as `{match_days, other_days}`, honoring
  options first, then the documented env overrides, then defaults.
  """
  @spec windows(keyword() | map()) :: {non_neg_integer(), non_neg_integer()}
  def windows(opts \\ []) do
    opts = normalize_opts(opts)

    match =
      Keyword.get(opts, :match_retention_days) ||
        env_days("ENSEMBLE_AUDIT_MATCH_RETENTION_DAYS") ||
        @match_days

    other =
      Keyword.get(opts, :retention_days) ||
        env_days("ENSEMBLE_AUDIT_RETENTION_DAYS") ||
        @activation_days

    {match, other}
  end

  defp normalize_opts(%{} = m), do: Enum.into(m, [])
  defp normalize_opts(kw) when is_list(kw), do: kw

  defp env_days(key) do
    case System.get_env(key) do
      nil -> nil
      "" -> nil
      v ->
        case Integer.parse(v) do
          {n, _} when n > 0 -> n
          _ -> nil
        end
    end
  end

  @doc """
  Partition file name for an entry kind + timestamp.
  """
  @spec partition_name(atom(), DateTime.t() | String.t() | integer()) :: String.t()
  def partition_name(kind, ts) do
    fam = if Kind.retention_class(kind) == :match, do: "matches", else: "activations"
    "#{fam}-#{month_of(ts)}.jsonl"
  end

  @doc """
  Absolute partition paths matching a query filter. With no date bounds
  this is every `*.jsonl` in the dir (including legacy flat files) —
  correctness before speed, AC-084.
  """
  @spec partitions_for(keyword() | map(), String.t()) :: [String.t()]
  def partitions_for(filter, dir \\ Audit.audit_dir()) do
    filter = normalize_opts(filter)
    since = month_or_nil(Keyword.get(filter, :since))
    until = month_or_nil(Keyword.get(filter, :until))

    cond do
      is_nil(since) and is_nil(until) ->
        dir |> Path.join("*.jsonl") |> Path.wildcard()

      true ->
        months = month_range(since, until)

        for fam <- ["matches", "activations"],
            m <- months,
            p = Path.join(dir, "#{fam}-#{m}.jsonl"),
            File.exists?(p),
            do: p
    end
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp month_or_nil(nil), do: nil
  defp month_or_nil(v), do: month_of(v)

  defp month_range(nil, nil), do: all_months()
  defp month_range(a, nil), do: from_month(a)
  defp month_range(nil, b), do: to_month(b)
  defp month_range(a, b), do: between(a, b)

  defp all_months do
    Audit.audit_dir()
    |> Path.join("*.jsonl")
    |> Path.wildcard()
    |> Enum.map(&month_from_name/1)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
    |> Enum.sort()
  end

  # Months from `ym` to "now". The ledger cannot contain future-dated
  # entries older than today, and capping at a decade keeps the range
  # bounded for pathological inputs.
  defp from_month(ym) do
    walk(ym, month_of(DateTime.utc_now()), 120)
  end

  # Months up to `ym`, extended a decade into the past so no historical
  # partition can be missed.
  defp to_month(ym) do
    walk(add_months(ym, -120), ym, 121)
  end

  defp between(a, b) do
    if a <= b, do: walk(a, b, 1_200), else: []
  end

  defp walk(a, b, cap) do
    {y0, m0} = parse_month(a)
    {y1, m1} = parse_month(b)
    n = (y1 * 12 + m1) - (y0 * 12 + m0)
    n = min(max(n, 0), cap - 1)
    for i <- 0..n, do: add_months(a, i)
  end

  defp add_months(ym, 0), do: ym

  defp add_months(ym, n) do
    {y, m} = parse_month(ym)
    t = y * 12 + (m - 1) + n
    "#{div(t, 12)}#{pad(rem(t, 12) + 1)}"
  end

  defp parse_month(ym) when is_binary(ym),
    do: {String.to_integer(binary_part(ym, 0, 4)), String.to_integer(binary_part(ym, 4, 2))}

  defp pad(n), do: n |> Integer.to_string() |> String.pad_leading(2, "0")

  @doc """
  Drop entries older than their retention class window (partition-drop on
  expiry). Returns `{dropped_partitions, rewritten_partitions, removed_entries}`.
  """
  @spec purge(keyword()) :: {non_neg_integer(), non_neg_integer(), non_neg_integer()}
  def purge(opts \\ []) do
    {match_days, other_days} = windows(opts)
    dir = Keyword.get(normalize_opts(opts), :dir, Audit.audit_dir())
    now_ms = Keyword.get(normalize_opts(opts), :now_ms, System.system_time(:millisecond))

    dir
    |> Path.join("*.jsonl")
    |> Path.wildcard()
    |> Enum.reduce({0, 0, 0}, fn file, {d, r, n} ->
      cutoff = cutoff_for(Path.basename(file), now_ms - match_days * 86_400_000, now_ms - other_days * 86_400_000)

      case purge_file(file, cutoff) do
        :untouched -> {d, r, n}
        {:dropped, k} -> {d + 1, r, n + k}
        {:rewritten, k} -> {d, r + 1, n + k}
      end
    end)
  end

  defp purge_file(_file, :never), do: :untouched

  defp purge_file(file, cutoff) do
    case month_from_name(Path.basename(file)) do
      m when is_binary(m) ->
        if month_end(m) <= cutoff do
          {:ok, content} = File.read(file)
          k = content |> String.split("\n", trim: true) |> length()
          File.rm(file)
          {:dropped, k}
        else
          rewrite_if_needed(file, cutoff)
        end

      nil ->
        # legacy flat file — per-entry rewrite only
        rewrite_if_needed(file, cutoff)
    end
  rescue
    _ -> :untouched
  end

  defp rewrite_if_needed(file, cutoff) do
    with {:ok, content} <- File.read(file) do
      lines = String.split(content, "\n", trim: true)
      keep = for line <- lines, keep_line?(line, cutoff), do: line
      removed = length(lines) - length(keep)

      cond do
        removed == 0 -> :untouched
        keep == [] ->
          File.rm(file)
          {:dropped, removed}

        true ->
          tmp = file <> ".tmp"
          File.write!(tmp, Enum.map_join(keep, "\n", &(&1 <> "\n")))
          File.rename!(tmp, file)
          {:rewritten, removed}
      end
    end
  end

  defp keep_line?(line, cutoff) do
    case Audit.decode_record(line) do
      nil -> true
      record -> occurred_or_filetime(record, cutoff) > cutoff
    end
  end

  defp occurred_or_filetime(record, cutoff) do
    case Audit.occurred_at_ms(record) do
      nil -> cutoff + 1
      ms -> ms
    end
  end

  defp cutoff_for("matches-" <> _, match_cutoff, _), do: match_cutoff
  defp cutoff_for("activations-" <> _, _, other), do: other
  defp cutoff_for(_other, _, _), do: :never

  defp month_from_name(name) do
    case Regex.run(~r/-([0-9]{4})([0-9]{2})\.jsonl$/, name) do
      [_, y, m] -> y <> m
      _ -> nil
    end
  end
  defp month_end(ym) do
    {y, m} = parse_month(ym)
    {ny, nm} = if m == 12, do: {y + 1, 1}, else: {y, m + 1}

    DateTime.new!(Date.new!(ny, nm, 1), ~T[00:00:00.000], "Z")
    |> DateTime.to_unix(:millisecond)
    |> Kernel.-(1)
  end

  @doc "First millisecond of the month containing `ts` (UTC)."
  @spec month_start_ms(DateTime.t() | String.t() | integer()) :: integer()
  def month_start_ms(ts) do
    {y, m} = ts |> month_of() |> parse_month()
    DateTime.new!(Date.new!(y, m, 1), ~T[00:00:00.000], "Z") |> DateTime.to_unix(:millisecond)
  end

  @doc "UTC `YYYYMM` month bucket for any timestamp representation."
  @spec month_of(DateTime.t() | String.t() | integer()) :: String.t()
  def month_of(%DateTime{} = dt), do: "#{dt.year}#{pad(dt.month)}"
  def month_of(ms) when is_integer(ms), do: ms |> DateTime.from_unix!(:millisecond) |> month_of()
  def month_of(ym) when is_binary(ym) and byte_size(ym) == 6, do: ym

  def month_of(iso) when is_binary(iso) do
    case iso do
      <<y::binary-4, "-", m::binary-2, _::binary>> -> y <> m
      _ -> "000000"
    end
  end

  def month_of(_), do: "000000"
end
