import { BehaviorEvent } from "../events";
import { match } from "./discovery";
import { BehaviorDefinition, BehaviorPackage } from "./schema";

export interface SimulationResult {
  matchedBehaviors: BehaviorDefinition[];
  missingToolGrants: string[];
}

/**
 * Dry-runs an event against a behavior package without invoking any
 * live adapter, tool, or side effect — purely local simulation so a
 * behavior author can validate wiring before an adapter ever sees it.
 */
export function simulate(
  pkg: BehaviorPackage,
  event: BehaviorEvent,
  availableTools: readonly string[],
): SimulationResult {
  const matchedBehaviors = match(pkg, event);
  const availableSet = new Set(availableTools);
  const missingToolGrants = Array.from(
    new Set(
      matchedBehaviors
        .flatMap((behavior) => behavior.requiredTools)
        .filter((tool) => !availableSet.has(tool)),
    ),
  );

  return { matchedBehaviors, missingToolGrants };
}

export interface ConformanceReport {
  behaviorName: string;
  passed: boolean;
  details: string;
}

/**
 * Runs a behavior package's declared triggers against a fixture list
 * of events and reports whether each behavior fired as expected.
 */
export function conformance_run(
  pkg: BehaviorPackage,
  fixtures: readonly { event: BehaviorEvent; expectedBehaviorNames: string[] }[],
): ConformanceReport[] {
  return pkg.behaviors.map((behavior) => {
    const relevantFixtures = fixtures.filter((fixture) =>
      fixture.expectedBehaviorNames.includes(behavior.name),
    );

    if (relevantFixtures.length === 0) {
      return {
        behaviorName: behavior.name,
        passed: false,
        details: "no fixtures reference this behavior",
      };
    }

    const failures = relevantFixtures.filter(
      (fixture) => !match(pkg, fixture.event).some((b) => b.name === behavior.name),
    );

    return {
      behaviorName: behavior.name,
      passed: failures.length === 0,
      details:
        failures.length === 0
          ? `all ${relevantFixtures.length} fixture(s) matched`
          : `${failures.length}/${relevantFixtures.length} fixture(s) failed to match`,
    };
  });
}
