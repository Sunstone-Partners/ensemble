/**
 * Cloudflare Quick Tunnel helper for the refinement-review server.
 *
 * A "quick tunnel" is a Cloudflare-provided ephemeral HTTPS URL of the form
 * `https://<random>.trycloudflare.com` that forwards to a local TCP port.
 * No Cloudflare account, API token, or DNS change is required — only the
 * `cloudflared` binary on the host's PATH.
 *
 * Use this to expose the refinement-review server to a remote reviewer
 * (phone, browser on another machine, external collaborator) without
 * involving your real Cloudflare account or a permanent DNS record.
 *
 * Lifecycle:
 *   - Construct with the local target URL (e.g. `http://127.0.0.1:9876`).
 *   - `start()` spawns `cloudflared`, waits for the line that prints the
 *     public URL (~2-5s), resolves with `{ url, host, process }`.
 *   - `stop()` terminates the child process and waits for it to exit.
 *     Resolves immediately if the process has already exited.
 *
 * @module @sunstone-partners/ensemble-core/refinement-review/tunnel
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/**
 * Install hint surfaced when cloudflared is missing. Mirrors the
 * install commands documented in docs/guides/refinement-review-collab.md
 * and the wiki page 12-Refinement-Review-Collab. Kept in one place so
 * docs and runtime can be compared at a glance.
 */
const CLOUDFLARED_INSTALL_HINT =
  'cloudflared binary not found on PATH.\n' +
  'Install one of:\n' +
  '  macOS:   brew install cloudflared\n' +
  '  Linux:   See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ for the package matching your distro and architecture.\n' +
  'Or set CLOUDFLARED_PATH to the absolute path of an existing cloudflared binary.';

/**
 * Build the rejection error for a missing cloudflared binary. Used by both
 * the synchronous spawn-throw path and the asynchronous `'error'` event
 * path — the latter is the common case on POSIX because spawn(2) reports
 * missing executables via the child's `'error'` event rather than as a
 * synchronous throw.
 */
function missingBinaryError(bin) {
  return new Error(`${CLOUDFLARED_INSTALL_HINT}\n(attempted: ${bin})`);
}


/**
 * Locate the `cloudflared` binary.
 *
 * Resolution order:
 *   1. `opts.cloudflaredPath` (explicit), if set and exists as a file.
 *   2. `CLOUDFLARED_PATH` environment variable, if set and exists as a file.
 *   3. `~/.cloudflared/cloudflared` then well-known system paths.
 *   4. Bare `cloudflared` (OS PATH lookup at spawn time).
 *
 * @param {object} [opts]
 * @returns {string} path to use; may be a bare name if only PATH is available
 */
function resolveCloudflared(opts) {
  const candidates = [];
  if (opts && opts.cloudflaredPath) candidates.push(opts.cloudflaredPath);
  if (process.env.CLOUDFLARED_PATH) candidates.push(process.env.CLOUDFLARED_PATH);

  const home = os.homedir();
  candidates.push(path.join(home, '.cloudflared', 'cloudflared'));
  candidates.push('/usr/local/bin/cloudflared');
  candidates.push('/opt/homebrew/bin/cloudflared');
  candidates.push('/usr/bin/cloudflared');

  for (const c of candidates) {
    if (!c) continue;
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch (_) {
      /* not present */
    }
  }

  return 'cloudflared';
}

/**
 * Quick tunnel: ephemeral `*.trycloudflare.com` URL pointing at a local
 * TCP port. No Cloudflare account required.
 */
class QuickTunnel {
  /**
   * @param {object} opts
   * @param {string} opts.targetUrl  Local URL to expose (e.g. `http://127.0.0.1:9876`).
   * @param {string} [opts.cloudflaredPath]  Override path to the `cloudflared` binary.
   * @param {(line: string) => void} [opts.log]  Stdout/stderr forwarding.
   * @param {number} [opts.timeoutMs=20000]  How long to wait for the URL.
   * @param {string} [opts.extraArgs]  Extra args to pass to `cloudflared tunnel`.
   * @param {Function} [opts._spawn]  Injectable spawn for tests. Defaults to
   *   `child_process.spawn`. Must return an object with the same
   *   `stdio`/`on`/`once`/`kill`/`exitCode`/`signalCode` surface as a real
   *   ChildProcess.
   */
  constructor(opts) {
    if (!opts || !opts.targetUrl) {
      throw new TypeError('QuickTunnel requires opts.targetUrl');
    }
    this.opts = opts;
    this.targetUrl = opts.targetUrl;
    this.log = opts.log || (() => {});
    this.timeoutMs = opts.timeoutMs || 20000;
    this.extraArgs = opts.extraArgs || '';
    this._spawn = opts._spawn || spawn;
    this.proc = null;
    this.url = null;
    this.host = null;
  }

  /**
   * Start the tunnel. Resolves with `{ url, host, process }` once the
   * public `trycloudflare.com` URL has been parsed from stdout.
   * Rejects if the binary is missing, exits non-zero, or doesn't print
   * the URL within `timeoutMs`.
   */
  start() {
    if (this.proc) return Promise.resolve(this._handle());

    const bin = resolveCloudflared(this.opts);
    const args = ['tunnel', '--no-autoupdate', '--url', this.targetUrl];
    if (this.extraArgs) {
      for (const a of this.extraArgs.split(/\s+/).filter(Boolean)) args.push(a);
    }

    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = this._spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        // Defensive: spawn(2) usually reports missing executables asynchronously
        // via the 'error' event below. This branch covers the rare case where
        // spawn throws synchronously (e.g. invalid args).
        if (err && err.code === 'ENOENT') {
          reject(missingBinaryError(bin));
        } else {
          reject(new Error(`failed to spawn cloudflared at ${bin}: ${err.message}`));
        }
        return;
      }
      this.proc = proc;

      // Single-settlement guard: avoid double resolve/reject if URL match
      // and exit fire near-simultaneously or if the timeout races the spawn.
      let settled = false;
      let timer = null;
      const settleResolve = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Clear stale proc/url state on rejection so a retry from
        // start() can re-spawn. The early-return at the top of start()
        // would otherwise resolve the second call with this dead proc's
        // _handle() instead of spawning. Guarded by identity so a
        // concurrent start() that has already replaced this.proc is
        // not clobbered.
        if (this.proc === proc) {
          this.proc = null;
          this.url = null;
          this.host = null;
        }
        reject(err);
      };

      // Try to match the URL against a chunk of text. Used for both
      // complete lines and the trailing partial-line buffer.
      const tryMatch = (text) => {
        if (this.url || !text) return;
        const m = text.match(QUICK_TUNNEL_URL_RE);
        if (m) {
          this.url = m[0];
          try {
            this.host = new URL(this.url).host;
          } catch (_) {
            this.host = null;
          }
          settleResolve(this._handle());
        }
      };

      // Buffer stdout/stderr across chunks. On every chunk we both
      // (a) scan the completed lines (so URLs followed by '\n' work)
      // and (b) scan the trailing partial-line buffer (so a URL with
      // no trailing newline is detected before the next chunk arrives).
      const lineBuffers = { stdout: '', stderr: '' };
      const consumeLines = (stream) => (chunk) => {
        const buf = lineBuffers[stream] + chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        lineBuffers[stream] = lines.pop() || '';
        for (const line of lines) {
          if (line) this.log(line);
          tryMatch(line);
        }
        tryMatch(lineBuffers[stream]);
      };
      proc.stdout.on('data', consumeLines('stdout'));
      proc.stderr.on('data', consumeLines('stderr'));

      timer = setTimeout(() => {
        // Settle FIRST with the timeout message so the proc exit handler
        // (which may fire when SIGTERM drops the child) cannot override
        // it. The `settled` flag in settleReject makes this idempotent.
        const procToKill = this.proc;
        settleReject(
          new Error(
            `cloudflared did not print a trycloudflare.com URL within ${this.timeoutMs}ms`,
          ),
        );
        if (procToKill) {
          try {
            procToKill.kill('SIGTERM');
          } catch (_) {
            /* already gone */
          }
        }
      }, this.timeoutMs);

      proc.once('error', (err) => {
        // Primary ENOENT path: spawn(2) reports a missing executable
        // asynchronously via this event. Translate into an install hint so
        // the user gets actionable instructions instead of the raw spawn
        // error message. Other spawn errors (EACCES, EPERM, …) pass through.
        if (err && err.code === 'ENOENT') {
          settleReject(missingBinaryError(bin));
        } else {
          settleReject(new Error(`cloudflared spawn error: ${err.message}`));
        }
      });
      proc.once('exit', (code, signal) => {
        // Final drain: a URL may be sitting in the partial-line buffer
        // because the process exited without writing a trailing newline.
        tryMatch(lineBuffers.stdout);
        tryMatch(lineBuffers.stderr);
        if (!this.url && !settled) {
          settleReject(
            new Error(
              `cloudflared exited before publishing URL (code=${code} signal=${signal})`,
            ),
          );
        }
      });
    });
  }

  _handle() {
    return { url: this.url, host: this.host, process: this.proc };
  }

  /**
   * Stop the tunnel. Sends SIGTERM, then SIGKILL after 3s if the child
   * is still alive. Resolves immediately if the process has already
   * exited (covers the case where `exit` fired before stop() was called).
   */
  stop() {
    if (!this.proc) return Promise.resolve();
    const proc = this.proc;
    const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
    if (alreadyExited) {
      this.proc = null;
      this.url = null;
      this.host = null;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        if (this.proc === proc) {
          this.proc = null;
          this.url = null;
          this.host = null;
        }
        resolve();
      };
      proc.once('exit', done);
      try {
        proc.kill('SIGTERM');
      } catch (_) {
        /* already gone */
      }
      setTimeout(() => {
        if (this.proc === proc) {
          try {
            proc.kill('SIGKILL');
          } catch (_) {
            /* already gone */
          }
        }
      }, 3000).unref();
    });
  }
}

module.exports = {
  QuickTunnel,
  resolveCloudflared,
  QUICK_TUNNEL_URL_RE,
};
