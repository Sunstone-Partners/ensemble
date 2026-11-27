/**
 * Best-effort open-a-URL-in-the-default-browser helper.
 *
 * Used by the refinement-review server when `--collab` is used and `open: true`
 * is passed to `startServer`. The opener is called with a share URL that already
 * has the bearer token composed in (`${url}/?token=${encodeURIComponent(token)}`),
 * so the SPA can authenticate on first paint.
 *
 * This module is intentionally platform-narrow: macOS, Linux, Windows. It
 * returns a structured result so callers can decide whether to fall back to
 * the printed URL.
 *
 * NEVER spawns via a shell. Each platform uses a fixed argv so the unit
 * test can assert the exact command shape and the test mock can swap
 * `child_process.spawn` directly.
 */
'use strict';

const childProcess = require('child_process');

/**
 * Per-platform opener table. Order of args is what `spawn` receives.
 * @type {Record<NodeJS.Platform, { cmd: string, args: string[] } | undefined>}
 */
const OPENERS = {
  darwin: { cmd: 'open', args: [] },
  linux: { cmd: 'xdg-open', args: [] },
  // Windows: ShellExecute via rundll32. cmd.exe /c start must NOT be used:
  // cmd.exe expands %2F / %26 / %3F / %3D as environment-variable
  // references, corrupting the encoded bearer token in the share URL.
  // rundll32 is a binary, so it leaves the URL intact.
  win32: { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler'] },
  // Other platforms: not supported by this helper.
};

/**
 * Render an argv array as a single shell-style command string. Quoting is
 * minimal: only args containing whitespace or shell metacharacters are
 * wrapped in double quotes. The string is for logging only.
 * @param {string} cmd
 * @param {string[]} args
 */
function renderCommand(cmd, args) {
  const all = [cmd, ...args];
  return all
    .map((a) => (/[\s"&|<>^()\n\r]/.test(a) ? `"${a}"` : a))
    .join(' ');
}

/**
 * Attempt to open a URL in the user's default browser. Returns a Promise
 * that resolves with a structured result. The Promise resolves on the
 * first of {spawn-success, spawn-error, fallback-timeout}.
 *
 * The Promise contract lets `startServer` decide whether to block on
 * the result or fire-and-forget. The implementation never blocks Node's
 * event loop: the spawned child is detached and unref'd so the parent
 * process is free to exit even if the opener hangs.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts.platform=process.platform] - override for tests
 * @param {NodeJS.ProcessEnv} [opts.env] - reserved for future CI auto-suppress
 * @param {typeof require('child_process').spawn} [opts.spawn] - override for tests
 * @returns {Promise<{opened: boolean, reason?: string, command?: string, error?: string}>}
 */
function openUrl(url, opts = {}) {
  if (typeof url !== 'string' || !url) {
    return Promise.resolve({ opened: false, reason: 'invalid-url' });
  }
  const platform = opts.platform || process.platform;
  const opener = OPENERS[platform];
  if (!opener) {
    return Promise.resolve({ opened: false, reason: 'unsupported-platform' });
  }
  const doSpawn = opts.spawn || childProcess.spawn;
  const args = [...opener.args, url];
  const command = renderCommand(opener.cmd, args);

  return new Promise((resolve) => {
    let child;
    try {
      child = doSpawn(opener.cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      resolve({ opened: false, reason: 'spawn-error', error: e && e.message });
      return;
    }
    if (!child || typeof child.unref !== 'function') {
      resolve({ opened: false, reason: 'spawn-no-handle' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Surface post-spawn ENOENT and other spawn failures (e.g. macOS without
    // `/usr/bin/open` on a stripped image) as `{ opened: false }` instead
    // of silently leaving the user staring at a printed URL.
    child.once('error', (err) => {
      finish({ opened: false, reason: 'spawn-error', error: err && err.message });
    });
    child.once('spawn', () => {
      if (typeof child.unref === 'function') child.unref();
      finish({ opened: true, command });
    });

    // Safety net: if neither 'spawn' nor 'error' fires within 250ms (some
    // Node versions only emit 'spawn' for non-detached children), assume
    // success and move on. The timer is unref'd so it never holds the
    // event loop open by itself.
    const timer = setTimeout(() => {
      if (typeof child.unref === 'function') child.unref();
      finish({ opened: true, command });
    }, 250);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

module.exports = { openUrl, OPENERS, renderCommand };
