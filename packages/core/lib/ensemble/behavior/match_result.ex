defmodule Ensemble.Behavior.MatchResult do
  @moduledoc """
  Candidate match annotated with an explicit decision (TRD §1.6, REQ-007
  AC-026..027, TRD-015).

  `propose/3` returns a list of these, ordered deterministically by
  `{definition.name, definition.version}` (AC-027). Every candidate the
  Matcher considered appears in the list — matches as `:matched`, rejected
  candidates with the reason they were dropped (`AC-026`: no silent misses).
  """

  alias Ensemble.Behavior.Definition

  @enforce_keys [:definition, :status]
  defstruct [:definition, :status, :reason, :match_reason, :audited_at]

  @type status :: :matched | :suppressed | :depth_dropped | :predicate_failed
  @type t :: %__MODULE__{
          definition: Definition.t(),
          status: status(),
          reason: term() | nil,
          match_reason: term() | nil,
          audited_at: integer() | nil
        }

  @doc "Wrap a candidate from `Matcher.candidates/2` as a matched result."
  def matched(defn, match_reason, audited_at \\ nil) do
    %__MODULE__{
      definition: defn,
      status: :matched,
      match_reason: match_reason,
      audited_at: audited_at || Ensemble.Behavior.Event.now()
    }
  end

  @doc "Wrap a rejected candidate with the reason it did not match."
  def rejected(defn, reason) do
    %__MODULE__{definition: defn, status: reason}
  end
end
