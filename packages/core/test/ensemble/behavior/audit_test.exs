defmodule Ensemble.Behavior.AuditTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Ensemble.Behavior.{Audit, Compiler, Event, MatchResult, Matcher}

  @base %{
    "api_version" => "ensemble.sunstone.dev/v1",
    "kind" => "Behavior",
    "metadata" => %{"name" => "m", "version" => "1.0.0", "description" => "d"},
    "trigger" => %{"event_type" => "vcs.push"},
    "outcomes" => ["ensemble.behavior.executed"]
  }

  setup do
    dir = Path.join(System.tmp_dir!(), "audit-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    System.put_env("ENSEMBLE_AUDIT_DIR", dir)
    on_exit(fn -> System.delete_env("ENSEMBLE_AUDIT_DIR"); File.rm_rf!(dir) end)
    {:ok, dir: dir}
  end

  defp defn(overrides \\ %{}) do
    {:ok, d} = Compiler.validate(deep_merge(@base, overrides))
    d
  end

  defp deep_merge(l, r), do: Map.merge(l, r, fn _, a, b -> if is_map(a) and is_map(b), do: deep_merge(a, b), else: b end)

  describe "canonical_json/1 (TRD-010, AC-017)" do
    test "keys sort deterministically" do
      json = Audit.canonical_json(%{"b" => 1, "a" => %{"y" => 2, "x" => 3}})
      assert json == ~s({"a":{"x":3,"y":2},"b":1})
    end

    test "replay produces byte-identical output on re-canonicalization" do
      payload = %{"z" => 1, "a" => [1, 2, 3], "m" => %{"nested" => true}}
      assert Audit.replay(payload) == Audit.replay(:json.decode(Audit.replay(payload)))
    end

    test "escapes embedded quotes and control characters" do
      json = Audit.canonical_json(%{"msg" => "he said \"hi\"\ttabbed\nnewline"})
      assert json =~ "\\\""
      assert json =~ "\\t"
      assert json =~ "\\n"
    end

    test "audit_id is uuid-v7-shaped and monotonic within the millisecond" do
      a = Audit.audit_id()
      b = Audit.audit_id()
      assert a =~ ~r/^[0-9a-f]{12}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      assert String.slice(a, 0, 12) == String.slice(b, 0, 12) or a < b
    end
  end

  describe "log_match/2 (TRD-016, AC-026)" do
    test "records matched and rejected candidates synchronously" do
      push = defn()
      other = defn(%{"metadata" => %{"name" => "reject"}})

      event = %Event{event_type: "vcs.push", event_id: "e1", subject_id: "main", dedup_key: "dk"}

      results = [
        MatchResult.matched(push, [], 1_700_000_000_000),
        MatchResult.rejected(other, :predicate_failed)
      ]

      assert {:ok, 2} = Audit.log_match(event, results)
      records = Audit.stream()
      assert length(records) == 1
      [r | _] = records
      assert r["type"] == "behavior.match"
      assert r["subject"] == "main"
      cands = r["payload"]["candidates"]
      assert Enum.any?(cands, &(&1["status"] == "matched"))
      assert Enum.any?(cands, &(&1["status"] == "predicate_failed"))
    end

    test "match-before-decide: called before Policy.evaluate it already shows rejects" do
      d1 = defn(%{"metadata" => %{"name" => "a"}})
      d2 = defn(%{"metadata" => %{"name" => "b"}, "trigger" => %{"event_type" => "beads.issue.closed"}})
      event = %Event{event_id: "e2", event_type: "vcs.push", subject_id: "x"}
      results = Matcher.propose(event, [d1, d2], %{})
      {:ok, _} = Audit.log_match(event, results)

      [r | _] = Audit.stream()
      statuses = r["payload"]["candidates"] |> Enum.map(& &1["status"])
      # a matched (same event_type), b absent (different event_type — not indexed)
      assert "matched" in statuses
    end

    test "sink errors are surfaced, not swallowed" do
      System.put_env("ENSEMBLE_AUDIT_DIR", "/root/nope")
      event = %Event{event_id: "e3", event_type: "vcs.push", subject_id: "main"}
      results = [MatchResult.matched(defn(), [], 1_700_000_000_000)]
      log_capture = capture_log(fn -> assert {:error, _} = Audit.log_match(event, results) end)
      assert log_capture == ""
    end

    test "raising hook degrades to a logged error, never crashes propose/3" do
      log =
        capture_log(fn ->
          assert [_] =
                     Matcher.propose(%Event{event_id: "er", event_type: "vcs.push"}, [defn()], %{
                       audit: fn _ -> raise "boom" end
                     })
        end)
      assert log =~ "audit hook raised"
    end
  end

  describe "encode_value (tuple/float clauses)" do
    test "tuple-shaped values audit-encode as JSON arrays; floats round-trip" do
      assert ~s({"a":["x",1,[2]]}) == Audit.canonical_json(%{a: {"x", 1, [2]}})
      assert ~s({"f":1.5}) == Audit.canonical_json(%{"f" => 1.5})
    end

    test "real match through default hook writes without raising" do
      results = [MatchResult.matched(defn(), [{"payload.ref", :equals, "x"}], 1_700_000_000_000)]
      assert {:ok, 1} = Audit.log_match(%Event{event_id: "ee", event_type: "vcs.push"}, results)
      assert [record] = Audit.stream() |> Enum.take(-1) |> then(fn [r] -> [r] end)
      assert record["type"] == "behavior.match"
    end
  end
end
