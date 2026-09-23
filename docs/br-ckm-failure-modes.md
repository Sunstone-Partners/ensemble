# br-ckm: Compile-time vs Run-time Failure Modes

Audit harness: `scripts/compile-vs-runtime-audit.js` (22 families, exit 2 on findings).
All mutating probes run against temp trees; the live checkout is never written.

## Layer-by-layer results

| Layer | Mechanism | Result |
|---|---|---|
| compiler (`generate-behaviors.js`) | validates frontmatter YAML, phrase shape (<3 chars, quotes), command refs against source set, duplicate phrase+skill, self-heals missing activation marker | 8/8 as-expected |
| router hook | corrupt/missing/mistyped registries exit 0 without blocking; malformed bindings still surface (skill-less binding still renders the block) | 6/6 as-expected |
| observer hook | every malformed stdin path exits 0; writes only on failure payloads; env-disable honored | 6/6 as-expected |
| generation chain | non-dry `run()` resolves REPO_ROOT from its own `__dirname`, so a `cwd`-based probe silently targets the live repo; the mutating drift probe must call the exported `run({ root })` in-process | 2/2 as-expected |

## Findings (none open)

1. **Marker variant in drift probe** — injecting `Use when user says:` (no "the") makes
   `syncDescription` treat the whole line as authored prefix, duplicating the marker
   instead of healing. Harness now uses the real marker ` Use when the user says:`.
2. **Quoted descriptions** — an unquoted colon-in-description fixture is invalid YAML
   frontmatter; the compiler rejects it before its description validator runs, so that
   family is only testable through the missing-marker (self-heal) path.
3. **`cwd`-based regeneration probes are unsafe** — the generate-behaviors CLI ignores
   `cwd` for root resolution; use `run({ root })` explicitly. Documented in the harness.
