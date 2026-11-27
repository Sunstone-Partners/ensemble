'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe bundle path: ${relative}`);
  }
  const dest = path.join(root, ...relative.split('/'));
  // Inspect every existing ancestor: existsSync alone misses dangling symlinks.
  let current = path.parse(dest).root;
  for (const part of dest.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in bundle path: ${current}`);
      if (current !== dest && !stat.isDirectory()) throw new Error(`Non-directory ancestor: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return dest;
}

function filesBelow(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.name.startsWith('.') || ['node_modules', 'tests', '__tests__', 'coverage'].includes(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Source symlink requires an explicit owner: ${path.join(root, entry.name)}`);
    if (entry.isDirectory()) files.push(...filesBelow(path.join(root, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

function writeFiles(root, files) {
  for (const [relative, bytes] of files) {
    const dest = safePath(root, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    if (bytes.fileMode !== undefined) fs.chmodSync(dest, bytes.fileMode);
  }
}

module.exports = { hash, safePath, filesBelow, writeFiles };
