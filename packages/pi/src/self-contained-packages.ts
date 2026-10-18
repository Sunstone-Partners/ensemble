/**
 * Self-contained Pi packages.
 *
 * Almost every Ensemble package is folded into the one `ensemble-pi` Pi package
 * (packages/pi). A package named here is distributed as a Pi package of its own
 * instead: its package.json carries the `pi-package` keyword and a `pi` manifest,
 * and users `pi install` it separately. Naming a package here has two effects,
 * and they have to stay together:
 *
 *   1. skill-copier does not copy its skills into ensemble-pi, so installing both
 *      packages never registers a skill twice.
 *   2. The Pi generator writes the package's command prompts and command-wrapper
 *      skills into the package itself (packages/<name>/prompts/ and
 *      packages/<name>/skills/ensemble-*), never into ensemble-pi. A prompt left in
 *      ensemble-pi would point at skills ensemble-pi does not contain.
 *
 * The package's own package.json must register what the generator writes:
 * `pi.prompts` as the NON-recursive `./prompts/*.md` (Pi registers subdirectories
 * for a bare `./prompts`, which would expose `prompts/_hidden/`) and `files`
 * listing `prompts/`. packages/pi/tests/self-contained-packages.test.ts checks this.
 *
 * Keyed by package directory name, never by command name: a new command in a listed
 * package needs no change here, and a new self-contained package is one entry.
 * Test membership with Object.prototype.hasOwnProperty.call, since a package
 * directory could be named like an inherited Object property.
 *
 * @module ensemble-pi/self-contained-packages
 */

export const SELF_CONTAINED_PI_PACKAGES: Record<string, true> = { assessment: true };
