/**
 * Repo-relative path globs for `artifact.changed` triggers (TRD-001).
 *
 * Hand-rolled rather than `fs.globSync` / `path.matchesGlob`: the first is
 * absent from the `@types/node` this workspace pins, the second is still
 * experimental on the Node 22 line the engines field allows, and REQ-023
 * forbids semantics that differ by platform or runtime version. What the
 * trigger needs is small, so it is spelled out here once and shared by the
 * matcher (does this event's path satisfy the predicate?) and the adapter
 * (which files does this watch cover?), which therefore cannot disagree.
 *
 * Supported: `*` (any run of characters within one segment), `?` (one
 * character within a segment) and `**` as a whole segment (zero or more
 * segments). Everything else is literal. Paths always use `/`.
 */

const MAGIC = /[*?]/;

/** Compiles a repo-relative glob to an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // Zero or more whole segments, so `a/**/b` also matches `a/b`.
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    for (const char of segment) {
      if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    if (!last) source += "/";
  });
  return new RegExp(`^${source}$`);
}

/** True when the repo-relative `path` is covered by `pattern`. */
export function matchesPathGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * The leading directory segments of `pattern` that contain no
 * metacharacter: the one directory an expansion has to walk, so
 * `coverage/*.json` never reads the rest of the repository.
 */
export function globStaticPrefix(pattern: string): string {
  const fixed: string[] = [];
  for (const segment of pattern.split("/").slice(0, -1)) {
    if (MAGIC.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join("/");
}
