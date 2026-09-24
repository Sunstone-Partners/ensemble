defmodule Ensemble.Behavior.TelemetryTest do
  @moduledoc """
  TRD-031: opt-in telemetry + redaction (AC-049, AC-050, AC-052, AC-096,
  Article IV). Every path takes an explicit `:dir` — no env, no global
  state — so the file is async-safe.
  """
  use ExUnit.Case, async: true

  alias Ensemble.Behavior.Telemetry

  @t0 ~U[2026-09-01 10:00:00.000Z]
  @t1 ~U[2026-09-01 10:00:05.000Z]

  defp tmp(),
    do:
      Path.join(
        System.tmp_dir!(),
        "telemetry-#{Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)}"
      )

  defp run(overrides \\ %{}) do
    Map.merge(
      %{
        behavior_id: "acme.investigate@0.1.0",
        event_id: "evt-1",
        activation_id: "act-1",
        started_at: @t0,
        completed_at: @t1,
        tool_calls: [
          %{tool: "bash.test", args: %{"cmd" => "mix test"}, seq: 1},
          %{tool: "read", args: %{"path" => "lib/a.ex"}, seq: 2}
        ],
        outcome_kind: :completed
      },
      overrides
    )
  end

  describe "opt-in (AC-049)" do
    test "default is OFF: nothing is written" do
      d = tmp()
      assert :disabled = Telemetry.record_run(run(), dir: d)
      refute File.exists?(Path.join(d, "runs.jsonl"))
      assert Telemetry.replay_for(dir: d) == []
    end

    test "enabled: true writes exactly one record per run" do
      d = tmp()
      assert {:ok, rec} = Telemetry.record_run(run(), dir: d, enabled: true)
      assert rec["behavior_id"] == "acme.investigate@0.1.0"
      assert [again] = Telemetry.replay_for(dir: d)
      assert again["event_id"] == "evt-1"
    end

    test "config enable does not leak into tests that pass no opts (read-only check)" do
      # enabled?/0 must default false when no config set; assertion is on the
      # pure default path, config is never mutated here.
      assert Telemetry.enabled?() == false
    end
  end

  describe "record shape (AC-050)" do
    test "references behavior_id + triggering event_id, duration, tool calls, outcome" do
      d = tmp()
      {:ok, rec} = Telemetry.record_run(run(), dir: d, enabled: true)

      assert rec["duration_ms"] == 5_000

      assert [%{"tool" => "bash.test", "seq" => 1} = a, %{"tool" => "read", "seq" => 2} = b] =
               rec["tool_calls"]

      # tool ARGS are digests, never verbatim (plan REQ-SAFE-004)
      assert String.starts_with?(a["digest"], "sha256:")
      refute a["digest"] =~ "mix test"
      assert byte_size(b["digest"]) == 71
      assert rec["outcome_kind"] == "completed"
      assert rec["redaction"]["applied"] == true
    end

    test "definition-derived behavior_id carries name@version#digest" do
      {:ok, defn} =
        Ensemble.Behavior.Compiler.validate(File.read!("behaviors/test-failure/behavior.yaml"))

      rec = Telemetry.record_run(%{definition: defn, event_id: "e"}, dir: tmp(), enabled: true)
      assert {:ok, m} = rec
      assert m["behavior_id"] =~ "@"
      assert m["behavior_id"] =~ "#"
    end
  end

  describe "redaction (AC-052 / AC-096 / Article IV)" do
    test "secrets in extra fields become [REDACTED:<kind>] markers" do
      d = tmp()

      dirty =
        run()
        |> Map.put(:extra, %{
          note:
            "key AKIAABCDEFGHIJKLMNOP used; token=ghp_" <>
              String.duplicate("a", 36) <> " then ghp_" <> String.duplicate("b", 36),
          email: "user@example.com"
        })

      {:ok, rec} = Telemetry.record_run(dirty, dir: d, enabled: true)
      text = rec["extra"]["note"]

      assert text =~ "[REDACTED:aws-access-key-id]"
      assert text =~ "[REDACTED:github-token]"
      assert text =~ "[REDACTED:credential]"
      refute text =~ "AKIAABCDEFGHIJKLMNOP"

      refute :json.encode(rec)
             |> IO.iodata_to_binary()
             |> String.contains?("ghp_" <> String.duplicate("b", 36))
    end

    test "prompt bodies are NEVER stored — digest + length only" do
      d = tmp()
      secret_prompt = "run this: mix test with token=supersecretvalue please"

      {:ok, rec} =
        Telemetry.record_run(Map.put(run(), :prompt, secret_prompt), dir: d, enabled: true)

      assert %{"digest" => "sha256:" <> hex, "length" => len} = rec["prompt"]
      assert byte_size(hex) == 64
      assert len == byte_size(secret_prompt)
      # on-disk artifact must not contain the body either
      raw = File.read!(Path.join(d, "runs.jsonl"))
      refute raw =~ "supersecretvalue"
      refute raw =~ secret_prompt
    end

    test "field allowlist drops non-listed extra keys (AC-052)" do
      d = tmp()

      r =
        run()
        |> Map.put(:extra, %{keep_me: "x", drop_me: "y"})

      {:ok, rec} = Telemetry.record_run(r, dir: d, enabled: true, fields: [:keep_me])
      assert rec["extra"] == %{"keep_me" => "x"}
      refute Map.has_key?(rec["extra"], "drop_me")
    end

    test "redaction is idempotent: markers survive a second pass" do
      once = Telemetry.redact("token=ghp_" <> String.duplicate("b", 36))
      twice = Telemetry.redact(once)
      assert once == twice
      assert once =~ "[REDACTED:"
    end
  end

  describe "replay_for/1 (AC-050)" do
    setup do
      d = tmp()

      for i <- 1..3 do
        {:ok, _} =
          Telemetry.record_run(
            run(%{
              event_id: "evt-#{i}",
              behavior_id: "a.b@1.0.0",
              started_at: @t0,
              completed_at: @t1
            }),
            dir: d,
            enabled: true
          )
      end

      {:ok, _} =
        Telemetry.record_run(
          run(%{behavior_id: "c.d@2.0.0", completed_at: ~U[2026-09-02 00:00:00Z]}),
          dir: d,
          enabled: true
        )

      %{dir: d}
    end

    test "replays all runs chronologically", %{dir: d} do
      all = Telemetry.replay_for(dir: d)
      assert length(all) == 4
      ts = Enum.map(all, & &1["completed_at"])
      assert ts == Enum.sort(ts)
    end

    test "filters by behavior_id", %{dir: d} do
      assert length(Telemetry.replay_for(behavior_id: "a.b@1.0.0", dir: d)) == 3
      assert length(Telemetry.replay_for("c.d@2.0.0", dir: d)) == 1
    end

    test "filters by since", %{dir: d} do
      assert [%{"behavior_id" => "c.d@2.0.0"}] =
               Telemetry.replay_for(since: ~U[2026-09-01 23:00:00Z], dir: d)
    end

    test "replay_for_behavior is the shorthand", %{dir: d} do
      assert length(Telemetry.replay_for_behavior("a.b@1.0.0", dir: d)) == 3
    end

    test "missing file replays empty, no crash" do
      assert Telemetry.replay_for(dir: tmp()) == []
    end
  end
end
