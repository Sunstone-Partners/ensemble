defmodule Ensemble.Behavior.ComplianceReport do
  @moduledoc """
  Compliance reporting over the audit ledger (TRD §5.1 / TRD-028,
  REQ-022 AC-085/AC-086).

  `generate/1` reads the ledger — by default through
  `Ensemble.Behavior.Audit.query/1` (index-accelerated, never-omitting —
  AC-084) — and renders the PRD's sections, deterministically ordered
  everywhere:

  * **Invocation Patterns** — per behavior: invocation count, top trigger
    `event_type`s, distinct actors (AC-086)
  * **Success Rates** — per behavior: terminal-status counts + rate
    (AC-086)
  * **Violations** — every tool violation with timestamp, behavior,
    attempted tool, declared set and actor (AC-082/AC-086)
  * **Constitution mutations in window** — `proposal_link` entries inside
    the retention window (AC-085's example query:
    `--mutation constitution.change --since 30` →
    `mutation: "constitution.change", since: <now-30d>`)
  * **Decision traces** — activation → event → proposal links (AC-085)

  ## Options

  * `:records` — pre-decoded ledger records (bypasses the sink; used by
    tests/fixtures; anything the ledger can hold is accepted)
  * `:dir` — audit dir override (default `ENSEMBLE_AUDIT_DIR`)
  * `:since` / `:until` — millisecond or ISO-8601 bounds on the whole
    report window
  * `:mutation` — class for the constitution-mutations section (default
    `"constitution.change"`)
  * `:now_ms` — reference instant for window defaults (deterministic tests)
  * `:format` — `:markdown` (default) | `:json`
  * `:index` — passed through to `Audit.query/1` (`nil` disables)

  JSON output runs through `Ensemble.Behavior.Audit.replay/1` (canonical
  sorted keys), so two calls over the same input are byte-identical.

  Entry shapes are read tolerantly: `kind` may be a canonical atom string
  or the legacy dotted `type`; status may appear as `payload.status` or
  `payload.final_status`; actors as `%{id, type}` maps or plain strings.
  """

  alias Ensemble.Behavior.Audit
  alias Ensemble.Behavior.Audit.Kind

  @default_mutation "constitution.change"
  @window_days 30

  @doc "Render the compliance report. See the moduledoc for options."
  @spec generate(keyword() | map()) :: String.t()
  def generate(opts \\ []) do
    opts = normalize_opts(opts)
    now_ms = Keyword.get(opts, :now_ms, System.system_time(:millisecond))
    since_ms = bound_ms(Keyword.get(opts, :since), now_ms - @window_days * 86_400_000)
    until_ms = bound_ms(Keyword.get(opts, :until), now_ms)

    records =
      case Keyword.get(opts, :records) do
        nil -> Audit.query(Keyword.take(opts, [:dir, :index, :since, :until]))
        rs when is_list(rs) -> rs
      end

    in_window = Enum.filter(records, &in_window?(&1, since_ms, until_ms))

    sections = %{
      "now_ms" => now_ms,
      "window" => %{"since" => since_ms, "until" => until_ms},
      "total_entries" => length(in_window),
      "behaviors" => behaviors(in_window),
      "violations" => violations(in_window),
      "constitution_mutations" => constitution_mutations(in_window, Keyword.get(opts, :mutation, @default_mutation)),
      "decision_traces" => decision_traces(in_window)
    }

    case Keyword.get(opts, :format, :markdown) do
      f when f in [:json, "json"] -> Audit.replay(sections)
      _ -> to_markdown(sections)
    end
  end

  defp bound_ms(nil, default), do: default
  defp bound_ms(v, _default) when is_integer(v), do: v
  defp bound_ms(%DateTime{} = dt, _default), do: DateTime.to_unix(dt, :millisecond)
  defp bound_ms(v, _default) when is_binary(v), do: Audit.iso_ms_public(v)

  # --- entry accessors (tolerant across shapes) ---------------------------

  defp kind_of(record), do: Kind.normalize(record["kind"] || record[:kind] || record["type"] || record[:type])

  defp behavior_of(record) do
    case record["behavior"] || record[:behavior] do
      %{"name" => n} when is_binary(n) ->
        n

      b when is_binary(b) and b != "" ->
        b

      b when is_map(b) ->
        b[:name] || b["name"]

      nil ->
        record["subject"] || record[:subject]

      _ ->
        nil
    end
  end

  defp version_of(record) do
    case record["behavior"] do
      %{"version" => v} when is_binary(v) -> v
      %{} = b -> b[:version]
      _ -> record["version"] || record[:version]
    end
  end

  defp ts_ms(record) do
    case record["occurred_at"] || record["ts"] || record[:occurred_at] do
      nil -> Audit.occurred_at_ms(record)
      v when is_integer(v) -> v
      v when is_binary(v) -> Audit.iso_ms_public(v)
      %DateTime{} = dt -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end

  defp in_window?(record, since_ms, until_ms) do
    case ts_ms(record) do
      nil -> true
      ms -> ms >= since_ms and ms <= until_ms
    end
  end

  defp payload(record) do
    case record["payload"] || record[:payload] do
      p when is_map(p) -> p
      _ -> %{}
    end
  end

  defp payload_get(record, keys) do
    p = payload(record)

    Enum.find_value(keys, fn k ->
      p[k] || Map.get(p, to_atom(k))
    end)
  end

  defp to_atom(k) when is_binary(k), do: String.to_atom(k)
  defp to_atom(k) when is_atom(k), do: k

  defp status_of(record), do: payload_get(record, ["status", "final_status"])

  defp event_type_of(record), do: payload_get(record, ["event_type"])

  defp actor_of(record) do
    case record["actor"] || record[:actor] || payload(record)["actor"] do
      %{"id" => id} when is_binary(id) -> id
      %{} = a -> a[:id] || a["id"]
      s when is_binary(s) -> s
      _ -> nil
    end
  end

  defp str(v) when is_binary(v), do: v
  defp str(v) when is_atom(v) and not is_nil(v), do: Atom.to_string(v)
  defp str(v), do: v

  # --- sections -----------------------------------------------------------

  defp behaviors(records) do
    records
    |> Enum.filter(&(kind_of(&1) in [:activation, :match_recorded]))
    |> Enum.group_by(&behavior_of/1)
    |> Enum.reject(fn {k, _} -> is_nil(k) end)
    |> Enum.map(fn {id, rs} ->
      acts = Enum.filter(rs, &(kind_of(&1) == :activation))

      statuses =
        acts
        |> Enum.map(&status_of/1)
        |> Enum.map(&(&1 || "unknown"))
        |> Enum.frequencies()

      triggers =
        acts
        |> Enum.map(&event_type_of/1)
        |> Enum.reject(&is_nil/1)
        |> Enum.frequencies()
        |> Enum.sort_by(fn {t, n} -> {-n, t} end)
        |> Enum.map(fn {t, n} -> %{"event_type" => t, "count" => n} end)

      %{
        "behavior_id" => id,
        "version" => version_of(List.first(acts) || List.first(rs)),
        "invocations" => length(acts),
        "top_triggers" => triggers,
        "distinct_actors" =>
          acts
          |> Enum.map(&actor_of/1)
          |> Enum.reject(&is_nil/1)
          |> Enum.uniq()
          |> Enum.sort(),
        "status_counts" => statuses,
        "success_rate" => rate(Map.get(statuses, "completed", 0), length(acts))
      }
    end)
    |> Enum.sort_by(& &1["behavior_id"])
  end

  defp rate(_n, 0), do: nil
  defp rate(n, total), do: Float.round(n / total, 4)

  defp violations(records) do
    records
    |> Enum.filter(&(kind_of(&1) == :tool_violation))
    |> Enum.map(fn r ->
      %{
        "audit_id" => r["audit_id"],
        "timestamp_ms" => ts_ms(r),
        "behavior_id" => behavior_of(r),
        "activation_id" => r["activation_id"],
        "invocation_id" => r["invocation_id"],
        "attempted_tool" => str(r["attempted_tool"] || payload_get(r, ["attempted_tool"])),
        "declared_tools" =>
          (r["declared_tools"] || payload_get(r, ["declared_tools", "declared"]) || [])
          |> Enum.map(&str/1),
        "actor" => actor_of(r)
      }
    end)
    |> Enum.sort_by(&{to_string(&1["timestamp_ms"]), to_string(&1["audit_id"])})
  end

  defp constitution_mutations(records, mutation) do
    rejected = MapSet.new(rejected_activation_ids(records))
    approved = MapSet.new(approved_activation_ids(records))

    records
    |> Enum.filter(&(kind_of(&1) == :proposal_link))
    |> Enum.filter(fn r -> mutation_of(r) == mutation end)
    |> Enum.map(fn r ->
      aid = r["activation_id"] || payload_get(r, ["activation_id"])

      %{
        "audit_id" => r["audit_id"],
        "proposal_id" => r["proposal_id"] || payload_get(r, ["proposal_id"]),
        "activation_id" => aid,
        "event_id" => r["event_id"],
        "actor" => actor_of(r),
        "timestamp_ms" => ts_ms(r),
        "status" => payload_get(r, ["status"]),
        "denied_without_approval" => denied?(aid, rejected, approved)
      }
    end)
    |> Enum.sort_by(&{to_string(&1["timestamp_ms"]), to_string(&1["proposal_id"])})
  end

  defp mutation_of(record) do
    str(record["mutation_class"] || payload_get(record, ["mutation_class"]))
  end

  defp rejected_activation_ids(records) do
    records
    |> Enum.flat_map(fn r ->
      k = kind_of(r)

      cond do
        k == :policy_rejection -> [r["activation_id"]]
        k == :activation and verdict(r) in ["block", "deny", "reject"] -> [r["activation_id"]]
        true -> []
      end
    end)
    |> Enum.reject(&is_nil/1)
  end

  defp approved_activation_ids(records) do
    records
    |> Enum.filter(&(kind_of(&1) == :activation))
    |> Enum.filter(fn r -> verdict(r) == "activate" end)
    |> Enum.map(& &1["activation_id"])
    |> Enum.reject(&is_nil/1)
  end

  defp verdict(record) do
    str(record["verdict"] || payload_get(record, ["verdict"]))
  end

  defp denied?(nil, _rejected, _approved), do: nil

  defp denied?(aid, rejected, approved) do
    cond do
      MapSet.member?(rejected, aid) and not MapSet.member?(approved, aid) -> true
      MapSet.member?(approved, aid) -> false
      true -> nil
    end
  end

  defp decision_traces(records) do
    proposals_by_activation =
      records
      |> Enum.filter(&(kind_of(&1) == :proposal_link))
      |> Enum.group_by(fn r -> r["activation_id"] || payload_get(r, ["activation_id"]) end)

    records
    |> Enum.filter(&(kind_of(&1) == :activation))
    |> Enum.map(fn r ->
      aid = r["activation_id"]

      %{
        "activation_id" => aid,
        "event_id" => r["event_id"],
        "behavior_id" => behavior_of(r),
        "verdict" => verdict(r),
        "final_status" => status_of(r),
        "causal_root" => r["causal_root"],
        "actor" => actor_of(r),
        "timestamp_ms" => ts_ms(r),
        "proposal_ids" =>
          proposals_by_activation
          |> Map.get(aid, [])
          |> Enum.map(fn p -> p["proposal_id"] || payload_get(p, ["proposal_id"]) end)
          |> Enum.reject(&is_nil/1)
          |> Enum.sort()
      }
    end)
    |> Enum.reject(&is_nil(&1["activation_id"]))
    |> Enum.sort_by(& &1["activation_id"])
  end

  defp normalize_opts(%{__struct__: _} = s), do: s |> Map.from_struct() |> Enum.into([])
  defp normalize_opts(%{} = m), do: Enum.into(m, [])
  defp normalize_opts(kw) when is_list(kw), do: kw

  # --- markdown -----------------------------------------------------------

  defp to_markdown(s) do
    """
    # Compliance Report

    Window: #{fmt_ms(s["window"]["since"])} .. #{fmt_ms(s["window"]["until"])}
    Entries in window: #{s["total_entries"]}

    ## Invocation Patterns

    #{invocation_patterns_md(s["behaviors"])}
    ## Success Rates

    #{success_rates_md(s["behaviors"])}
    ## Violations

    #{violations_md(s["violations"])}
    ## Constitution mutations in window

    #{constitution_md(s["constitution_mutations"])}
    ## Decision traces

    #{traces_md(s["decision_traces"])}
    """
  end

  defp fmt_ms(ms) when is_integer(ms) do
    ms |> DateTime.from_unix!(:millisecond) |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end

  defp fmt_ms(_), do: "n/a"

  defp invocation_patterns_md([]), do: "_No behaviors with activation entries._\n\n"

  defp invocation_patterns_md(rows) do
    header = "| behavior | invocations | top trigger event_types | distinct actors |\n|---|---|---|---|\n"

    body =
      Enum.map(rows, fn r ->
        triggers =
          case r["top_triggers"] do
            [] -> "—"
            ts -> Enum.map_join(ts, ", ", fn t -> "#{t["event_type"]}×#{t["count"]}" end)
          end

        "| #{r["behavior_id"]} | #{r["invocations"]} | #{triggers} | #{Enum.join(r["distinct_actors"], ", ")} |\n"
      end)

    [header, body]
  end

  defp success_rates_md([]), do: "_No behaviors with activation entries._\n\n"

  defp success_rates_md(rows) do
    header = "| behavior | completed | failed | timeout | other | success rate |\n|---|---|---|---|---|---|\n"

    body =
      Enum.map(rows, fn r ->
        c = r["status_counts"]

        other =
          c
          |> Enum.reject(fn {k, _} -> k in ["completed", "failed", "timeout"] end)
          |> Enum.map(&elem(&1, 1))
          |> Enum.sum()

        "| #{r["behavior_id"]} | #{Map.get(c, "completed", 0)} | #{Map.get(c, "failed", 0)} | #{Map.get(c, "timeout", 0)} | #{other} | #{fmt_rate(r["success_rate"])} |\n"
      end)

    [header, body]
  end

  defp fmt_rate(nil), do: "n/a"
  defp fmt_rate(v) when is_float(v), do: "#{Float.round(v * 100, 1)}%"

  defp violations_md([]), do: "_None recorded._\n\n"

  defp violations_md(rows) do
    header = "| timestamp | behavior | actor | attempted tool | declared tools |\n|---|---|---|---|---|\n"

    body =
      Enum.map(rows, fn r ->
        declared = Enum.join(r["declared_tools"] || [], ", ")

        "| `#{r["timestamp_ms"]}` | #{r["behavior_id"] || "unknown"} | #{r["actor"] || "unknown"} | #{r["attempted_tool"]} | #{declared} |\n"
      end)

    [header, body]
  end

  defp constitution_md([]), do: "_No constitution mutations in window._\n\n"

  defp constitution_md(rows) do
    header =
      "| proposal | activation | triggering event | approver | timestamp | denied without approval |\n|---|---|---|---|---|---|\n"

    body =
      Enum.map(rows, fn r ->
        "| #{r["proposal_id"]} | #{r["activation_id"] || "—"} | #{r["event_id"] || "—"} | #{r["actor"] || "—"} | #{fmt_ms(r["timestamp_ms"])} | #{fmt_denied(r["denied_without_approval"])} |\n"
      end)

    [header, body]
  end

  defp fmt_denied(true), do: "yes"
  defp fmt_denied(false), do: "no"
  defp fmt_denied(nil), do: "unknown"

  defp traces_md([]), do: "_None recorded._\n\n"

  defp traces_md(rows) do
    header = "| activation | event | behavior | verdict | final status | proposals |\n|---|---|---|---|---|---|\n"

    body =
      Enum.map(rows, fn r ->
        "| #{r["activation_id"]} | #{r["event_id"] || "—"} | #{r["behavior_id"] || "—"} | #{r["verdict"] || "—"} | #{r["final_status"] || "—"} | #{Enum.join(r["proposal_ids"], ", ")} |\n"
      end)

    [header, body]
  end
end
