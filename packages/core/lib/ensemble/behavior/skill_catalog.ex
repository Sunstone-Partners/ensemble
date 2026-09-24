defmodule Ensemble.Behavior.SkillCatalog do
  @moduledoc """
  Skill composition catalog (TRD §4.3 lines 576-581; REQ-012 AC-045..AC-047).

  Skills are referenced from a behavior as `@skill:<name>` — either in
  `execution.skills` or inline in `execution.prompt`. A reference means
  "compose this existing skill", so the catalog is the one place that turns
  a bare name into an immutable, digest-pinned record.

  ## Pins, not drift (AC-045)

  Every catalog entry carries a `digest`. `resolve/2` returns the pin as part
  of the skill record, so a composed skill is always attributable to a
  specific content revision. Nothing here re-reads skill bodies at activation
  time — the pin is the record.

  ## Fail-closed on unknown, warn-not-fail on lifecycle (AC-046/AC-047)

  An unlisted skill is a hard error — `{:error, {:skill_unknown, name}}` —
  because composing a skill that does not exist cannot be honored at runtime.
  A *listed* skill whose `status` is `deprecated` or `revoked` is the opposite
  case: the reference still resolves (so the behavior keeps running and can be
  updated **in place**, without redeploy — AC-047), and `lifecycle_warnings/2`
  reports it for the next `validate` run as a migration flag.

  ## In-place bump without redeploy (AC-047)

  The catalog is read from disk on demand and can be overridden per call with
  an injected snapshot, so changing a behavior's skill reference takes effect
  on the next `validate`/`reload`; there is no compiled artifact to redeploy.
  """

  @skills_file "registries/skills.json"
  @skill_ref_prefix "@skill:"
  @max_skill_name_bytes 64
  @statuses ~w(active deprecated revoked)

  @doc """
  Resolves `@skill:<name>` to a pinned skill record.

      resolve("file-reader")
      #=> {:ok, %{name: "file-reader", digest: "sha256:...", status: "active", ...}}

  Fail-closed: an unlisted name returns `{:error, {:skill_unknown, name}}`.
  `deprecated`/`revoked` entries resolve normally — the lifecycle state is
  reported, never hidden, so callers can warn (AC-047).
  """
  @spec resolve(String.t(), keyword() | map() | nil) ::
          {:ok, map()} | {:error, {:skill_unknown, String.t() | nil}}
  def resolve(name, catalog \\ nil)

  def resolve(name, catalog) when is_binary(name) do
    case Map.fetch(entries(catalog), name) do
      {:ok, skill} -> {:ok, skill}
      :error -> {:error, {:skill_unknown, name}}
    end
  end

  def resolve(_name, _catalog), do: {:error, {:skill_unknown, nil}}

  @doc "`resolve/2` in boolean form."
  @spec known?(String.t(), map() | keyword() | nil) :: boolean()
  def known?(name, catalog \\ nil), do: match?({:ok, _}, resolve(name, catalog))

  @doc """
  Extracts skill references from raw decoded `execution` data.

  Collects `execution.skills` plus every `@skill:<name>` occurrence in
  `execution.prompt` (AC-045 allows either), preserving first-seen order and
  dropping duplicates. Returns plain binaries — the `@skill:` prefix is
  reference syntax, not part of the name.

      skills_from_raw(%{"skills" => ["@skill:file-reader"],
                        "prompt" => "use @skill:log-search then summarize"})
      #=> ["file-reader", "log-search"]

  Accepts string-keyed (decoded YAML) and atom-keyed (`Definition.source`)
  maps alike.
  """
  @spec skills_from_raw(map() | nil) :: [String.t()]
  def skills_from_raw(exec) when is_map(exec) do
    (refs_in(pick(exec, "skills")) ++ refs_in(pick(exec, "prompt"))) |> Enum.uniq()
  end

  def skills_from_raw(_), do: []

  @doc "Catalog-wide skill records, sorted by name."
  @spec all(map() | keyword() | nil) :: [map()]
  def all(catalog \\ nil) do
    catalog |> entries() |> Map.values() |> Enum.sort_by(& &1.name)
  end

  @doc """
  Migration flags for a behavior's skill references (AC-046/AC-047).

  One issue per reference whose catalog entry is `deprecated` or `revoked`.
  Unknown references are **not** reported here — they fail closed at
  validation instead.
  """
  @spec lifecycle_warnings([String.t()], map() | keyword() | nil) :: [map()]
  def lifecycle_warnings(names, catalog \\ nil) when is_list(names) do
    names
    |> Enum.map(&resolve(&1, catalog))
    |> Enum.flat_map(fn
      {:ok, %{status: s} = skill} when s in ~w(deprecated revoked) ->
        [
          %{
            kind: :skill_lifecycle,
            skill: skill.name,
            status: s,
            digest: skill.digest,
            migrations: skill.migrations,
            message:
              "skill #{inspect(skill.name)} is #{s} — flag for migration; the reference can be " <>
                "updated in place without redeploy (AC-047)"
          }
        ]

      _ ->
        []
    end)
  end

  @doc """
  Finds `@skill:<name>` references in any decoded value — a string, a list of
  strings, or a nested map — and returns the bare names in first-seen order
  without de-duplicating.
  """
  @spec refs_in(term()) :: [String.t()]
  def refs_in(value), do: value |> scan([]) |> Enum.reverse()

  @doc "The literal that introduces a skill reference."
  @spec skill_ref_prefix() :: String.t()
  def skill_ref_prefix, do: @skill_ref_prefix

  @doc "Valid composition strategies (AC-048)."
  @spec strategies() :: [atom()]
  def strategies, do: ~w(sequential parallel)a

  @doc "Maximum skills a single behavior may compose (schema `maxItems`)."
  @spec max_skills() :: pos_integer()
  def max_skills, do: 8

  @doc "Longest skill name the reference grammar accepts."
  @spec max_skill_name_bytes() :: pos_integer()
  def max_skill_name_bytes, do: @max_skill_name_bytes

  # -- internals ---------------------------------------------------------
  #
  # Reference extraction walks bytes instead of using `Regex`, because two
  # shapes of the regex route are broken on this toolchain (Elixir 1.20.4 and
  # its OTP): `capture: 1` raises a bare `:re.run` argument error, and a
  # pattern built by `Regex.compile!/1` fails to reach `Regex.scan/3`'s
  # `%Regex{}` clause. The grammar is a literal prefix plus a `[a-z0-9-]`
  # token, so an explicit walk is both correct and free of that guesswork.

  # Binary: an `@skill:` marker hands off to the token walker, anything else
  # advances one character.
  defp scan(<<@skill_ref_prefix, rest::binary>>, acc), do: token(rest, acc, <<>>)
  defp scan(<<_ :: utf8, rest::binary>>, acc), do: scan(rest, acc)
  defp scan(<<_ :: 8, rest::binary>>, acc), do: scan(rest, acc)
  defp scan(<<>>, acc), do: acc

  # Containers recurse. A keyword list is how an atom-keyed map round-trips
  # through `Definition.source`, so its values are walked, not its atoms.
  defp scan(list, acc) when is_list(list) do
    if list != [] and Keyword.keyword?(list) do
      Enum.reduce(list, acc, fn {_k, v}, a -> scan(v, a) end)
    else
      scan_each(list, acc)
    end
  end

  defp scan(map, acc) when is_map(map) and not is_struct(map) do
    map |> Map.values() |> scan_each(acc)
  end

  # A leaf with nothing to extract.
  defp scan(_other, acc), do: acc

  defp scan_each([head | tail], acc), do: scan_each(tail, scan(head, acc))
  defp scan_each([], acc), do: acc

  # `@skill:` immediately followed by `-` is outside the grammar (names start
  # with an alphanumeric), so it is not a reference.
  defp token(<<?-, rest::binary>>, acc, <<>>), do: drop_one(rest, acc)

  defp token(<<c, rest::binary>>, acc, name)
       when c in ?a..?z or c in ?0..?9 or c == ?- do
    token(rest, acc, <<name::binary, c::8>>)
  end

  # End of the token: enforce the length bound here, where the accumulator is
  # real data (in a guard, `byte_size(name)` would always see `<<>>`).
  defp token(rest, acc, name) when name != <<>> do
    if byte_size(name) > @max_skill_name_bytes do
      drop_one(rest, acc)
    else
      scan(rest, [name | acc])
    end
  end

  defp token(rest, acc, <<>>), do: drop_one(rest, acc)

  defp drop_one(<<_ :: utf8, rest::binary>>, acc), do: scan(rest, acc)
  defp drop_one(<<_ :: 8, rest::binary>>, acc), do: scan(rest, acc)
  defp drop_one(<<>>, acc), do: acc

  # String keys come from decoded YAML; atom keys from `Definition.source`.
  defp pick(exec, key) do
    case Map.fetch(exec, key) do
      {:ok, v} -> v
      :error -> Map.get(exec, String.to_atom(key))
    end
  rescue
    ArgumentError -> nil
  end

  # Catalog snapshots arrive with either key convention, so everything funnels
  # through `index/1`, which normalizes each entry's keys.
  defp entries(nil), do: read_disk()
  defp entries(%{"skills" => list}), do: index(list)
  defp entries(%{skills: list}) when is_list(list), do: index(list)
  defp entries(list) when is_list(list), do: index(list)
  defp entries(map) when is_map(map), do: index(Map.values(map))
  defp entries(_), do: %{}

  defp index(list) when is_list(list) do
    list
    |> Enum.map(&entry/1)
    |> Enum.reject(&is_nil/1)
    |> Map.new(&{&1.name, &1})
  end

  defp entry(%{} = m), do: m |> normalize() |> build_entry()
  defp entry(other) when is_binary(other), do: build_entry(%{"name" => other})
  defp entry(_), do: nil

  defp build_entry(m) do
    name = Map.get(m, "name")

    if is_binary(name) and name != "" do
      status = Map.get(m, "status") || "active"

      %{
        name: name,
        description: Map.get(m, "description") || "",
        source: Map.get(m, "source"),
        digest: Map.get(m, "digest"),
        status: if(status in @statuses, do: status, else: "active"),
        migrations: List.wrap(Map.get(m, "migrations") || [])
      }
    end
  end

  defp normalize(m) do
    m |> Enum.map(fn {k, v} -> {to_string(k), v} end) |> Map.new()
  rescue
    ArgumentError -> m
  end

  defp read_disk do
    path = Path.join(:code.priv_dir(:ensemble) |> List.to_string(), @skills_file)

    case File.read(path) do
      {:ok, body} -> body |> Jason.decode!() |> Map.get("skills", []) |> index()
      {:error, _} -> %{}
    end
  end
end
