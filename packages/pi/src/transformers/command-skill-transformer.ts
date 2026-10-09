/**
 * Command Skill Transformer
 *
 * Generates SKILL.md wrappers for every command prompt so each one appears
 * in Pi's skill inventory with the full workflow content embedded directly.
 *
 * Mirrors the codex generator's discovery (scripts/generate-codex/index.js
 * generateCommandSkills): dynamically globs the prompt sources instead of a
 * hardcoded allowlist, so a new command prompt gets a SKILL.md wrapper
 * automatically with no source change required.
 *
 * @module ensemble-pi/transformers/command-skill-transformer
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { TransformResult } from '../types';
import matter from 'gray-matter';

/**
 * Strip the HTML comment header block (lines starting with `<!--`) from prompt
 * content so the SKILL.md body starts with the actual markdown title.
 */
function stripHeader(content: string): string {
  return content.replace(/^<!--[\s\S]*?-->\n*/m, '');
}

/**
 * Extract the description from frontmatter or the first > **Mission:** paragraph.
 */
function extractDescription(promptContent: string, skillName: string): string {
  const parsed = matter(promptContent);
  if (parsed.data['description']) {
    return String(parsed.data['description']);
  }
  const match = parsed.content.match(/> \*\*Mission:\*\* ([^\n]+)/);
  return match ? match[1].trim() : `Ensemble ${skillName} command`;
}

/**
 * Generate SKILL.md wrappers for every command prompt.
 *
 * Discovers every prompts/*.md file dynamically and writes a SKILL.md with
 * the full command body embedded directly so each skill is self-contained.
 *
 * Files are written directly (like copySkills) and results returned with
 * type: 'skill' so the main write loop skips them.
 *
 * @param outputRoot  Pi package root (packages/pi)
 * @param options     Runtime options
 * @returns           Array of TransformResult entries, one per skill generated
 */
export async function generateCommandSkills(
  outputRoot: string,
  options: { dryRun?: boolean; verbose?: boolean }
): Promise<TransformResult[]> {
  const { dryRun = false, verbose = false } = options;

  const promptsDir = path.join(outputRoot, 'prompts');
  const skillsOutputDir = path.join(outputRoot, 'skills');
  const results: TransformResult[] = [];

  const promptFiles = (
    await glob(path.join(promptsDir, '*.md').split(path.sep).join('/'), { absolute: true })
  ).sort();

  for (const promptPath of promptFiles) {
    const skillName = path.basename(promptPath, '.md');

    let promptContent: string;
    try {
      promptContent = fs.readFileSync(promptPath, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `  command-skill: warning — cannot read ${promptPath}: ${(err as Error).message}\n`
      );
      continue;
    }

    const description = extractDescription(promptContent, skillName);
    const promptBody = stripHeader(promptContent);

    // Build SKILL.md with frontmatter + embedded prompt body.
    // NOTE: disable-model-invocation is experimental — Pi may not consume this field.
    // Remove it if Pi rejects unknown frontmatter keys.
    const skillBody = matter.stringify(promptBody, {
      name: skillName,
      description,
      // Prevent auto-trigger from description matching; invoke via explicit /skill-name only
      'disable-model-invocation': true,
    });

    const outputPath = path.join(skillsOutputDir, skillName, 'SKILL.md');

    const result: TransformResult = {
      sourcePath: promptPath,
      outputPath,
      content: skillBody,
      type: 'skill',
    };

    if (!dryRun) {
      const outDir = path.dirname(outputPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(outputPath, skillBody.replace(/\r\n/g, '\n'), 'utf-8');
    }

    if (verbose) {
      process.stdout.write(`  command-skill: ${promptPath} → ${outputPath}\n`);
    }

    results.push(result);
  }

  if (verbose) {
    process.stdout.write(
      `command-skill: ${results.length} skill(s) ${dryRun ? 'collected (dry-run)' : 'generated'}.\n`
    );
  }

  return results;
}
