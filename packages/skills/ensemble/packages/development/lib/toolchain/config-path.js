'use strict';

/**
 * XDG-compliant configuration path resolution for the Ensemble toolchain config
 * (TRD-2026-8d825f54 TRD-003, PRD REQ-009).
 *
 * Mirrors the resolution algorithm of `packages/core/lib/config-path.js`'s
 * `getEnsembleConfigRoot()` without importing it, so this package stays self-contained. The
 * root lookup accepts an injectable `env` object (defaulting to `process.env`) so callers
 * (notably `resolveCategory()` in `./config.js`) can resolve a user-level config path for a
 * given environment without mutating the real `process.env`.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Get the root configuration directory for Ensemble, mirroring
 * `packages/core/lib/config-path.js#getEnsembleConfigRoot()`:
 * 1. `$XDG_CONFIG_HOME/ensemble` if `XDG_CONFIG_HOME` is set.
 * 2. `~/.config/ensemble` if `~/.config` exists.
 * 3. `~/.ensemble` fallback.
 *
 * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`; injectable for tests.
 * @returns {string} Absolute path to the config root
 */
function getEnsembleConfigRoot(env = process.env) {
  // Priority 1: XDG_CONFIG_HOME if set
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'ensemble');
  }

  // Priority 2: ~/.config/ensemble if ~/.config exists
  const homeDir = os.homedir();
  const xdgDefault = path.join(homeDir, '.config', 'ensemble');
  const configDir = path.join(homeDir, '.config');

  if (fs.existsSync(configDir)) {
    return xdgDefault;
  }

  // Priority 3: ~/.ensemble fallback
  return path.join(homeDir, '.ensemble');
}

/**
 * Get the absolute path to the user-level `toolchain.yaml` config file.
 *
 * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`; injectable for tests.
 * @returns {string} Absolute path to `<config root>/toolchain.yaml`
 */
function getUserToolchainConfigPath(env = process.env) {
  return path.join(getEnsembleConfigRoot(env), 'toolchain.yaml');
}

module.exports = { getUserToolchainConfigPath };
