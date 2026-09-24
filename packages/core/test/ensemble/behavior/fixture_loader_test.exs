defmodule Ensemble.Behavior.FixtureLoaderTest do
  use ExUnit.Case, async: false

  alias Ensemble.Behavior.{Compiler, Definition, Event, FixtureLoader}

  setup do
    root = Path.join(System.tmp_dir!(), "ens-fixture-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(root) end)
    {:ok, root: root}
  end

  defp write_fixture(root, subdir, name, body) do
    path = Path.join([root, "fixtures", subdir, name])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, body)
    path
  end

  defp defn_with_path(root) do
    # A Definition whose source[:path] points at <root>/behavior.yaml so
    # fixture_dir resolves to <root>/fixtures.
    %Definition{
      name: "fx-behavior",
      version: Version.parse!("1.0.0"),
      digest: :binary.copy(<<0>>, 32),
      trigger: %Ensemble.Behavior.Trigger{event_type: "github.pull_request.opened", predicate: []},
      source: %{path: Path.join(root, "behavior.yaml"), git_sha: nil}
    }
  end

  test "fixture_dir derives from definition source path", %{root: root} do
    assert FixtureLoader.fixture_dir(defn_with_path(root)) == Path.join(root, "fixtures")
  end

  test "load_all returns three kind buckets sorted by path", %{root: root} do
    write_fixture(root, "events", "a.json", ~s({"kind":"Event","event_type":"test.failed"}))
    write_fixture(root, "expected-matches", "a.expected.json", ~s({"event":"a","matches":[]}))
    write_fixture(root, "expected-outcomes", "z.expected.json", ~s({"event":"a","verdict":"activate"}))

    loaded = FixtureLoader.load_all(defn_with_path(root))

    assert %{"events" => [%{name: "a"}], "expected-matches" => [%{name: "a"}],
            "expected-outcomes" => [%{name: "z"}]} = loaded

    assert Enum.all?(Map.values(loaded), fn xs -> Enum.all?(xs, &is_nil(&1.reason)) end)
  end

  test "missing fixtures dir yields empty buckets, not error", %{root: root} do
    assert FixtureLoader.load_all(defn_with_path(root)) == %{
             "events" => [],
             "expected-matches" => [],
             "expected-outcomes" => []
           }
  end

  test "unreadable / malformed json surfaces reason not crash", %{root: root} do
    p = write_fixture(root, "events", "bad.json", "{not json")

    [%{data: nil, reason: r}] = FixtureLoader.load_all(defn_with_path(root))["events"]
    assert is_binary(r)
    assert File.exists?(p)
  end

  describe "normalize_event_fixture/1 exercises the production adapter path (AC-057)" do
    test "canonical envelope normalizes via Local adapter" do
      env = %{
        "kind" => "Event",
        "event_type" => "test.failed",
        "subject_id" => "mix test",
        "payload" => %{"exit_code" => 1}
      }

      {:ok, [e], warns} = FixtureLoader.normalize_event_fixture(env)
      assert %Event{event_type: "test.failed", subject_id: "mix test"} = e
      assert warns == []
    end

    test "raw github shape selects the Github adapter" do
      raw = %{
        "hook_event_name" => "pull_request",
        "action" => "opened",
        "repository" => %{"full_name" => "acme/app"},
        "pull_request" => %{"number" => 3}
      }

      {:ok, [e], _} = FixtureLoader.normalize_event_fixture(raw)
      assert e.event_type == "github.pull_request.opened"
    end

    test "raw observer record normalizes to test.failed" do
      raw = %{
        "raw" => %{
          "kind" => "test_failure",
          "command" => "mix test",
          "exit_code" => 1,
          "session_id" => "s1",
          "cwd" => "/repo"
        },
        "source_hint" => "local"
      }

      {:ok, [e], _} = FixtureLoader.normalize_event_fixture(raw)
      assert e.event_type == "test.failed"
      assert e.payload["command"] == "mix test"
    end

    test "explicit raw + hint wrapper" do
      data = %{
        "raw" => %{"before" => %{"status" => "open"}, "after" => %{"status" => "closed"}, "issue" => "B-1"},
        "source_hint" => "beads"
      }

      {:ok, [e], _} = FixtureLoader.normalize_event_fixture(data)
      assert e.event_type == "issue.status_changed"
    end

    test "multi-event file keeps declaration order" do
      data = %{
        "events" => [
          %{"raw" => %{"kind" => "test_failure", "command" => "a"}, "source_hint" => "local"},
          %{"raw" => %{"kind" => "test_failure", "command" => "b"}, "source_hint" => "local"}
        ]
      }

      {:ok, evs, _} = FixtureLoader.normalize_event_fixture(data)
      assert Enum.map(evs, & &1.payload["command"]) == ["a", "b"]
    end

    test "generic fallback warns but yields an event" do
      {:ok, [e], [_w]} = FixtureLoader.normalize_event_fixture(%{"type" => "weird", "id" => "x"})
      assert e.event_type == "weird"
    end
  end

  test "pilot fixtures load and normalize end-to-end" do
    yaml = "behaviors/test-failure/behavior.yaml"
    {:ok, d} = Compiler.validate(File.read!(yaml), file: yaml)
    loaded = FixtureLoader.load_all(d)

    assert [%{name: "test-failed", data: %{"event_type" => "test.failed"}}] = loaded["events"]
    assert [%{name: "test-failed-investigation"}] = loaded["expected-matches"]
    assert [%{name: "test-failed-propose"}] = loaded["expected-outcomes"]

    {:ok, [e], _} = FixtureLoader.normalize_event_fixture(hd(loaded["events"])[:data])
    assert e.payload["exit_code"] == 1
  end
end
