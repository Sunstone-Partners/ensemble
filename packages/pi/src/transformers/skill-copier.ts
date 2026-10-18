/**
 * Skill Copier
 *
 * Propagates SKILL.md (and REFERENCE.md) files from Ensemble framework
 * skill packages into packages/pi/skills/ for consumption by the Pi runtime.
 *
 * Discovery pattern:
 *   - packages/*\/skills\/<subdir>\/{SKILL,REFERENCE}.md  (subdirectory layout)
 *   - packages/*\/skills\/{SKILL,REFERENCE}.md            (top-level layout, e.g. blazor, nestjs)
 *
 * Output layout:
 *   - Subdirectory layout: packages/pi/skills/<subdir>/<filename>
 *   - Top-level layout:    packages/pi/skills/<package-name>/<filename>
 *
 * Packages named in EXCLUDED_PACKAGES are not scanned: `pi` (the output target, avoids
 * self-referential copies), `full` (symlink mirror of other packages' skills) and every
 * self-contained Pi package (SELF_CONTAINED_PI_PACKAGES, currently `assessment`), which is
 * distributed as its own Pi package and not bundled into ensemble-pi.
 * Symlinks (e.g. packages/full/skills/) are resolved before copying; if two paths
 * resolve to the same real file, the second is skipped.
 *
 * Every copied file starts with the generated marker (../generated-marker.ts), on its first
 * line or right after the frontmatter: it is how a later generator run recognises a stale
 * copy of a removed or renamed skill as its own output and prunes it (see generator.ts).
 *
 * SKILL.md files are normalized for Pi compatibility:
 *   - `name` is always overridden with the output skill directory name
 *   - `description` is added if missing, extracted from body or generated from the name
 *
 * REFERENCE.md files are copied as they are, apart from the generated marker, CRLF -> LF
 * and the ensemble:<cmd> -> ensemble-<cmd> rewrite that applies to every copied file.
 *
 * @module ensemble-pi/transformers/skill-copier
 */

import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { TransformResult } from '../types';
import { SELF_CONTAINED_PI_PACKAGES } from '../self-contained-packages';
import { withGeneratedMarker } from '../generated-marker';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File names to copy from each skill directory. */
const SKILL_FILES = ['SKILL.md', 'REFERENCE.md'];

/** Maximum length for auto-extracted description. */
const DESC_MAX_LEN = 200;

// ---------------------------------------------------------------------------
// Frontmatter normalisation (SKILL.md only)
// ---------------------------------------------------------------------------

/**
 * Extract a description from the SKILL.md body when none is present in
 * the frontmatter.
 *
 * Strategy:
 *  1. Strip leading blank lines and heading lines (starting with `#`).
 *  2. Find the first non-empty line that is not a heading, blockquote,
 *     list item, table row, or fenced-code delimiter.
 *  3. Trim to DESC_MAX_LEN chars at a sentence boundary (`.`, `!`, `?`)
 *     when possible.
 *  4. Fallback: title-case each word of skillDirName + " skill".
 */
function extractDescription(body: string, skillDirName: string): string {
  const lines = body.split('\n');
  const skipPattern = /^(#|>|-|\*|\||\s*```)/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (skipPattern.test(trimmed)) continue;

    // We have a candidate paragraph line — truncate it
    if (trimmed.length <= DESC_MAX_LEN) {
      return trimmed;
    }

    // Try to cut at a sentence boundary within the limit
    const chunk = trimmed.slice(0, DESC_MAX_LEN);
    const lastSentence = Math.max(
      chunk.lastIndexOf('. '),
      chunk.lastIndexOf('! '),
      chunk.lastIndexOf('? ')
    );
    if (lastSentence > 40) {
      return chunk.slice(0, lastSentence + 1).trim();
    }
    return chunk.trim();
  }

  // Fallback: generate from the directory name
  return (
    skillDirName
      .split('-')
      .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ') + ' skill'
  );
}

/**
 * Normalize the frontmatter of a SKILL.md file for Pi compatibility.
 *
 * Rules:
 *  - `name` is always set to `skillDirName` (overrides whatever the source says).
 *  - `description` is added when absent, using body extraction or a generated fallback.
 *
 * @param content      Raw SKILL.md content (may or may not have frontmatter).
 * @param skillDirName Output skill directory name (lowercase, a-z0-9 and hyphens).
 * @returns            Normalised content string.
 */
export function normalizeSkillMd(content: string, skillDirName: string): string {
  // Normalize CRLF → LF so output is consistent across macOS and Linux
  const normalized = content.replace(/\r\n/g, '\n');
  const parsed = matter(normalized);

  // Override / set required fields
  parsed.data['name'] = skillDirName;

  if (!parsed.data['description']) {
    parsed.data['description'] = extractDescription(parsed.content, skillDirName);
  }

  return matter.stringify(parsed.content, parsed.data);
}

/**
 * Package directories to skip during scanning. `pi` and `full` are output/mirror
 * targets, not sources; self-contained Pi packages ship as their own Pi package, so the
 * generator also writes their command prompts into the package itself (see
 * ../self-contained-packages.ts).
 */
const EXCLUDED_PACKAGES: Record<string, true> = {
  pi: true,
  full: true,
  ...SELF_CONTAINED_PI_PACKAGES,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SkillFileEntry {
  /** Absolute path to the source file (resolved through symlinks). */
  realSrcPath: string;
  /** Absolute path to the source file as discovered (may be a symlink). */
  srcPath: string;
  /** Skill directory name to use in the output path. */
  skillDirName: string;
  /** File name (SKILL.md or REFERENCE.md). */
  fileName: string;
  /**
   * Where the file was discovered, as a path relative to the monorepo root built from names
   * alone (never from realpath, which differs per machine when a checkout sits behind a
   * symlink). It goes into the generated marker, and committed output must not vary by machine.
   */
  sourceLabel: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Discover skill files across all packages.
 *
 * Handles two layouts:
 *   1. Subdirectory layout: packages/<pkg>/skills/<subdir>/SKILL.md
 *      → skillDirName = <subdir>
 *   2. Top-level layout: packages/<pkg>/skills/SKILL.md
 *      → skillDirName = <pkg>
 *
 * Skips packages in EXCLUDED_PACKAGES (pi, full and the self-contained Pi packages).
 */
function discoverSkillFiles(packagesDir: string): SkillFileEntry[] {
  const entries: SkillFileEntry[] = [];

  if (!fs.existsSync(packagesDir)) {
    return entries;
  }

  let packageDirents: fs.Dirent[];
  try {
    packageDirents = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const pkgDirent of packageDirents) {
    if (!pkgDirent.isDirectory() && !pkgDirent.isSymbolicLink()) continue;
    if (Object.prototype.hasOwnProperty.call(EXCLUDED_PACKAGES, pkgDirent.name)) continue;

    const pkgName = pkgDirent.name;
    const skillsDir = path.join(packagesDir, pkgName, 'skills');

    if (!fs.existsSync(skillsDir)) continue;

    let skillDirents: fs.Dirent[];
    try {
      skillDirents = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    // Check for top-level SKILL.md / REFERENCE.md directly in skills/
    for (const fileName of SKILL_FILES) {
      const topLevelFile = path.join(skillsDir, fileName);
      if (fs.existsSync(topLevelFile)) {
        let realSrcPath: string;
        try {
          realSrcPath = fs.realpathSync(topLevelFile);
        } catch {
          continue;
        }
        entries.push({
          realSrcPath,
          srcPath: topLevelFile,
          skillDirName: pkgName,
          fileName,
          sourceLabel: `packages/${pkgName}/skills/${fileName}`,
        });
      }
    }

    // Check each subdirectory entry for SKILL.md / REFERENCE.md
    for (const skillDirent of skillDirents) {
      // Only look at directories (including symlinked dirs)
      const subPath = path.join(skillsDir, skillDirent.name);

      let resolvedSubPath: string;
      try {
        resolvedSubPath = fs.realpathSync(subPath);
      } catch {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolvedSubPath);
      } catch {
        continue;
      }

      if (!stat.isDirectory()) continue;

      for (const fileName of SKILL_FILES) {
        const filePath = path.join(resolvedSubPath, fileName);
        if (fs.existsSync(filePath)) {
          let realSrcPath: string;
          try {
            realSrcPath = fs.realpathSync(filePath);
          } catch {
            continue;
          }
          entries.push({
            realSrcPath,
            srcPath: filePath,
            skillDirName: skillDirent.name,
            fileName,
            sourceLabel: `packages/${pkgName}/skills/${skillDirent.name}/${fileName}`,
          });
        }
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Copy SKILL.md and REFERENCE.md files from all Ensemble skill packages
 * into the Pi output root under `skills/<skill-name>/`.
 *
 * SKILL.md files are normalised for Pi compatibility (name + description fields).
 * REFERENCE.md files are copied byte-for-byte.
 *
 * Deduplication: if two paths resolve to the same real file (common when
 * packages/full uses symlinks), only the first occurrence is copied.
 *
 * @param sourceRoot  Monorepo root (contains packages/ directory)
 * @param outputRoot  Pi package root (packages/pi) — output goes to outputRoot/skills/
 * @param options     Runtime options
 * @returns           Array of TransformResult entries, one per file copied
 */
export async function copySkills(
  sourceRoot: string,
  outputRoot: string,
  options: { dryRun?: boolean; verbose?: boolean }
): Promise<TransformResult[]> {
  const { dryRun = false, verbose = false } = options;

  const packagesDir = path.join(sourceRoot, 'packages');
  const skillsOutputDir = path.join(outputRoot, 'skills');

  if (verbose) {
    process.stdout.write(`skill-copier: scanning ${packagesDir}\n`);
  }

  const skillEntries = discoverSkillFiles(packagesDir);

  if (verbose) {
    process.stdout.write(
      `skill-copier: found ${skillEntries.length} skill file(s) before dedup\n`
    );
  }

  // Deduplicate by resolved (real) path to avoid double-copying symlinked skills
  const seen = new Set<string>();
  const results: TransformResult[] = [];

  for (const entry of skillEntries) {
    if (seen.has(entry.realSrcPath)) {
      if (verbose) {
        process.stdout.write(`  skill-copier: skipping duplicate ${entry.srcPath}\n`);
      }
      continue;
    }
    seen.add(entry.realSrcPath);

    const outputPath = path.join(skillsOutputDir, entry.skillDirName, entry.fileName);

    // Read file content
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(entry.realSrcPath, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `  skill-copier: warning — cannot read ${entry.srcPath}: ${(err as Error).message}\n`
      );
      continue;
    }

    // Normalise SKILL.md frontmatter for Pi compatibility; normalize CRLF for all files
    const normalizedContent =
      entry.fileName === 'SKILL.md'
        ? normalizeSkillMd(rawContent, entry.skillDirName)
        : rawContent.replace(/\r\n/g, '\n');

    // Rewrite Claude-style command references (ensemble:<cmd>) to the Pi
    // invocation form (ensemble-<cmd>). Pi commands are emitted as
    // prompts/ensemble-<cmd>.md and invoked as /ensemble-<cmd>; skill bodies
    // that point at ensemble:<cmd> would otherwise reference names that do not
    // resolve in Pi. Source stays authored in the Claude-canonical colon form.
    // The generated marker goes on last, so it never feeds description extraction above.
    const content = withGeneratedMarker(
      normalizedContent.replace(/ensemble:([a-z0-9-]+)/g, 'ensemble-$1'),
      entry.sourceLabel
    );

    const result: TransformResult = {
      sourcePath: entry.srcPath,
      outputPath,
      content,
      type: 'skill',
    };

    if (!dryRun) {
      const outDir = path.dirname(outputPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(outputPath, content, 'utf-8');
    }

    if (verbose) {
      process.stdout.write(`  skill: ${entry.srcPath} → ${outputPath}\n`);
    }

    results.push(result);
  }

  if (verbose) {
    process.stdout.write(
      `skill-copier: ${results.length} skill file(s) ${dryRun ? 'collected (dry-run)' : 'copied'}.\n`
    );
  }

  return results;
}
