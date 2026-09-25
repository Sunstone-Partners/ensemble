defmodule Ensemble.Behavior.Audit.Kind do
  @moduledoc """
  The audit vocabulary (TRD §5.1, TRD-026): exactly six entry kinds.

  | kind               | written when                          | ACs               |
  |---                 |---                                    |---                |
  | `match_recorded`   | Matcher produced ≥1 candidate, **before** `Policy.evaluate` | AC-026 |
  | `activation`       | Policy verdict + terminal status      | AC-020, AC-081    |
  | `tool_violation`   | tool-grant check denied               | AC-038/040, AC-082 |
  | `proposal_link`    | proposal emitted (activation ↔ proposal) | AC-083         |
  | `policy_rejection` | disabled/revoked/blocked path         | AC-095            |
  | `skill_invocation` | composed skill ran                    | AC-046            |

  ## On-disk `type` field (legacy compatibility)

  Records written before TRD-026 used the dotted wire strings
  `"behavior.match"` and `"behavior.violation"`. Those strings remain
  **read-compatible**: `Audit.stream/0` and `Audit.query/1` normalize them
  to `:match_recorded` and `:tool_violation` (see `normalize/1`). New
  writes carry the canonical `"kind"` name; the legacy dotted `"type"`
  field is retained on every record so pre-existing readers keep working
  unchanged (AC-084: no entry may be omitted or renamed out of a query).
  """

  @kinds [
    :match_recorded,
    :activation,
    :tool_violation,
    :proposal_link,
    :policy_rejection,
    :skill_invocation
  ]

  @legacy_types %{
    "behavior.match" => :match_recorded,
    "behavior.activation" => :activation,
    "behavior.violation" => :tool_violation,
    "behavior.proposal" => :proposal_link,
    "behavior.policy" => :policy_rejection
  }

  @doc "The six canonical entry kinds."
  @spec all() :: [atom()]
  def all, do: @kinds

  @doc "Canonical kind for a dotted wire string (nil when unrecognized)."
  @spec from_legacy_type(String.t()) :: atom() | nil
  def from_legacy_type(type) when is_binary(type), do: Map.get(@legacy_types, type)

  @doc "The on-disk `type` string a kind is additionally stamped with (compat)."
  @spec legacy_type(atom()) :: String.t() | nil
  def legacy_type(kind) when kind in @kinds, do: Enum.find_value(@legacy_types, fn {t, k} -> if k == kind, do: t end)
  def legacy_type(_), do: nil

  @doc """
  Normalize a kind atom, dotted wire string, or any value to a canonical
  kind atom. Unknown or missing values map to `:unknown` so a query can
  still surface the record rather than silently drop it (AC-084).
  """
  @spec normalize(term()) :: atom()
  def normalize(kind) when kind in @kinds, do: kind

  def normalize(kind) when is_binary(kind) do
    cond do
      Map.has_key?(@legacy_types, kind) -> Map.fetch!(@legacy_types, kind)
      kind in Enum.map(@kinds, &Atom.to_string/1) -> String.to_atom(kind)
      true -> :unknown
    end
  end

  def normalize(_), do: :unknown

  @doc "Retention class for a kind (TRD §5.1 defaults)."
  @spec retention_class(atom()) :: :match | :activation | :none
  def retention_class(:match_recorded), do: :match
  def retention_class(k) when k in [:activation, :tool_violation, :proposal_link, :skill_invocation], do: :activation
  def retention_class(k) when k in [:policy_rejection], do: :none
  def retention_class(_), do: :none
end
