import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Captures and exactly restores the files an auto-fix attempt writes
 * (TRD-021 / REQ-015).
 *
 * Scope is deliberately narrow: only paths the attempt itself declares
 * it will write are captured, never a whole-tree checkout. A broad
 * snapshot would revert a developer's concurrent edits on restore,
 * which is a worse failure than the one it prevents. This is the
 * accepted risk recorded in the TRD, handled by narrowing rather than
 * by hoping.
 *
 * A file that does not exist at capture time is recorded as absent, and
 * restore deletes it — otherwise a rejected attempt would leave newly
 * created files behind, which is not a restore.
 *
 * Contents are held as a Buffer, never a utf8 string: a decode/encode
 * round-trip silently corrupts binaries and any non-UTF8 file, so a
 * "restore" would have quietly damaged exactly the files nobody
 * inspects. File modes are captured and reapplied for the same reason
 * — restoring an executable without its +x bit is not a restore.
 */

interface CapturedFile {
  path: string;
  existed: boolean;
  contents?: Buffer;
  mode?: number;
}

export interface RestoreReport {
  /** Paths whose on-disk content or mode differed and were written back. */
  restored: string[];
  /** Paths that did not exist at capture, existed at restore, and were removed. */
  deleted: string[];
  /**
   * Paths already in their captured state, so restore did nothing. Kept
   * separate from `restored` on purpose: reporting an untouched path as
   * restored claims a rollback that never happened. Observed live -- a
   * file mutated BEFORE capture was "restored" to its mutated contents and
   * the outcome still listed it as restored.
   */
  unchanged: string[];
  failed: { path: string; error: string }[];
}

export class WorkspaceSnapshot {
  private readonly captured = new Map<string, CapturedFile>();

  constructor(private readonly rootDir: string) {}

  /** Captures a path's current state. Repeat captures are ignored. */
  capture(relPath: string): void {
    if (this.captured.has(relPath)) return;

    const abs = resolve(this.rootDir, relPath);
    if (!existsSync(abs)) {
      this.captured.set(relPath, { path: relPath, existed: false });
      return;
    }

    this.captured.set(relPath, {
      path: relPath,
      existed: true,
      contents: readFileSync(abs),
      mode: statSync(abs).mode,
    });
  }

  captureAll(relPaths: readonly string[]): void {
    relPaths.forEach((p) => this.capture(p));
  }

  get capturedPaths(): string[] {
    return [...this.captured.keys()];
  }

  /**
   * Restores every captured path to its captured state.
   *
   * Continues past individual failures and reports them, rather than
   * aborting midway: a partial restore that stops at the first error
   * leaves the tree in a state that is neither the attempt's nor the
   * original's.
   */
  restore(): RestoreReport {
    const report: RestoreReport = { restored: [], deleted: [], unchanged: [], failed: [] };

    for (const file of this.captured.values()) {
      const abs = resolve(this.rootDir, file.path);
      try {
        if (!file.existed) {
          if (existsSync(abs)) {
            rmSync(abs, { force: true });
            report.deleted.push(file.path);
          } else {
            report.unchanged.push(file.path);
          }
          continue;
        }
        const expected = file.contents ?? Buffer.alloc(0);
        if (existsSync(abs)) {
          const stat = statSync(abs);
          if (
            stat.isFile() &&
            readFileSync(abs).equals(expected) &&
            (file.mode === undefined || stat.mode === file.mode)
          ) {
            report.unchanged.push(file.path);
            continue;
          }
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, expected);
        if (file.mode !== undefined) chmodSync(abs, file.mode);
        report.restored.push(file.path);
      } catch (error) {
        report.failed.push({ path: file.path, error: (error as Error).message });
      }
    }

    return report;
  }
}
