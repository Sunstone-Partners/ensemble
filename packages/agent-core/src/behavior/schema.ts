/**
 * Provider-neutral behavior package schema. A "behavior" describes
 * what an agent should do in response to events — compiled, validated,
 * matched, and simulated entirely within agent-core before any adapter
 * ever runs it live.
 */

export interface BehaviorTrigger {
  eventType: string;
  match?: Record<string, unknown>;
}

export interface BehaviorDefinition {
  name: string;
  version: string;
  triggers: BehaviorTrigger[];
  requiredTools: string[];
  description: string;
}

export interface BehaviorPackage {
  behaviors: BehaviorDefinition[];
}
