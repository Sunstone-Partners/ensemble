import { BehaviorEvent } from "../events";
import { match } from "./discovery";
import { BehaviorManifest, BehaviorPackage } from "./schema";

export interface SimulationResult {
  matchedBehaviors: BehaviorManifest[];
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
        .flatMap((behavior) => behavior.capabilities.tools)
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
    const name = behavior.metadata.name;
    const relevantFixtures = fixtures.filter((fixture) => fixture.expectedBehaviorNames.includes(name));

    if (relevantFixtures.length === 0) {
      return { behaviorName: name, passed: false, details: "no fixtures reference this behavior" };
    }

    const failures = relevantFixtures.filter(
      (fixture) => !match(pkg, fixture.event).some((b) => b.metadata.name === name),
    );

    return {
      behaviorName: name,
      passed: failures.length === 0,
      details:
        failures.length === 0
          ? `all ${relevantFixtures.length} fixture(s) matched`
          : `${failures.length}/${relevantFixtures.length} fixture(s) failed to match`,
    };
  });
}
