defmodule Ensemble.Behavior.Definition do
  @moduledoc """
  Compiled, immutable, validated representation of a `behavior.yaml`.

  Fields mirror the canonical data type in TRD §1.4. Construction goes
  exclusively through `Ensemble.Behavior.Compiler` — the struct itself
  performs no validation.
  """

  defstruct [
    :api_version,
    :name,
    :version,
    :description,
    :digest,
    :trigger,
    :policy,
    :capabilities,
    :execution,
    :outcomes,
    :constitution_rules,
    :source
  ]

  @type t :: %__MODULE__{
          api_version: String.t(),
          name: String.t(),
          version: Version.t(),
          description: String.t(),
          digest: binary(),
          trigger: Ensemble.Behavior.Trigger.t(),
          policy: Ensemble.Behavior.PolicySpec.t(),
          capabilities: Ensemble.Behavior.Capabilities.t(),
          execution: Ensemble.Behavior.ExecutionSpec.t(),
          outcomes: [String.t()],
          constitution_rules: [map()],
          source: map()
        }
end

defmodule Ensemble.Behavior.Trigger do
  @moduledoc "Event trigger: registered event_type plus optional predicate AST."
  defstruct [:event_type, predicate: []]

  @type t :: %__MODULE__{event_type: String.t(), predicate: Ensemble.Behavior.Predicate.ast()}
end

defmodule Ensemble.Behavior.PolicySpec do
  @moduledoc """
  Resolved policy. Missing safety fields resolve conservatively (TRD §1.5:
  a behavior may never receive *more* authority from a missing field than
  from an explicit one): mode -> :propose, max_concurrent -> 1,
  max_causal_depth -> 2, max_children -> 3, cooldown -> 0, timeout -> 30m,
  dedup_window -> 1h, retry -> %{max_attempts: 0, retryable: []}.
  """
  defstruct mode: :propose,
            max_concurrent: 1,
            cooldown: 0,
            timeout: 1_800_000,
            max_causal_depth: 2,
            max_children: 3,
            dedup_window: 3_600_000,
            retry: %{max_attempts: 0, retryable: []}

  @type t :: %__MODULE__{
          mode: :observe | :propose | :active,
          max_concurrent: pos_integer(),
          cooldown: non_neg_integer(),
          timeout: pos_integer(),
          max_causal_depth: non_neg_integer(),
          max_children: non_neg_integer(),
          dedup_window: non_neg_integer(),
          retry: %{max_attempts: 0..5, retryable: [atom()]}
        }
end

defmodule Ensemble.Behavior.Capabilities do
  @moduledoc "Declared tool grants + mutation classes (validated against registries)."
  defstruct tools: [], mutation_classes: ["none"]

  @type t :: %__MODULE__{tools: [String.t()], mutation_classes: [String.t()]}
end

defmodule Ensemble.Behavior.ExecutionSpec do
  @moduledoc "Workflow graph reference + literal/jsonpath param bindings."
  defstruct [:graph, params: %{}]

  @type t :: %__MODULE__{graph: String.t(), params: map()}
end
