import { BehaviorEvent } from "../events";
import { BehaviorDefinition, BehaviorPackage } from "./schema";

/**
 * Matches an incoming event against a compiled behavior package's
 * triggers, returning every behavior whose trigger fires.
 */
export function match(pkg: BehaviorPackage, event: BehaviorEvent): BehaviorDefinition[] {
  return pkg.behaviors.filter((behavior) =>
    behavior.triggers.some((trigger) => {
      if (trigger.eventType !== event.type) return false;
      if (!trigger.match) return true;
      return Object.entries(trigger.match).every(
        ([key, value]) => event.payload[key] === value,
      );
    }),
  );
}
