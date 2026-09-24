import { BehaviorEvent } from "../events";
import { BehaviorManifest, BehaviorPackage, BehaviorTriggerPredicate } from "./schema";

function predicateMatches(predicate: BehaviorTriggerPredicate | undefined, payload: Record<string, unknown>): boolean {
  if (!predicate) return true;

  return Object.entries(predicate).every(([field, condition]) => {
    const value = payload[field];
    if (condition.matches !== undefined) {
      return typeof value === "string" && new RegExp(condition.matches).test(value);
    }
    if (condition.not !== undefined) {
      return value !== condition.not;
    }
    if (condition.equals !== undefined) {
      return value === condition.equals;
    }
    return true;
  });
}

/**
 * Matches an incoming event against a behavior package's triggers,
 * returning every behavior whose `trigger.event_type` and (optional)
 * `trigger.predicate` fire.
 */
export function match(pkg: BehaviorPackage, event: BehaviorEvent): BehaviorManifest[] {
  return pkg.behaviors.filter((behavior) => {
    if (behavior.trigger.event_type !== event.type) return false;
    return predicateMatches(behavior.trigger.predicate, event.payload);
  });
}
