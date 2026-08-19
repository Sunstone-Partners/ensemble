#!/usr/bin/env bash
# scripts/wiki-publish.sh — Publish staged wiki content to the live Sunstone/ensemble wiki.
#
# Stages drafts in .wiki-staging/ at the repo root, then publishes to
# https://github.com/Sunstone-Partners/ensemble.wiki.git (branch: master).
#
# Handles both ADD (new page) and UPDATE (existing page differs) cases:
#   - Adds: copy straight from staging; no live state to preserve.
#   - Updates: print live-vs-staged diff, require explicit confirmation before overwrite.
#   - Sidebar: idempotent awk insertion; staged sidebar is a reference snapshot
#     (NOT copied wholesale); missing entries are inserted before "## Training".
#
# Idempotent: re-running with no changes is a no-op (exits 0 silently).
#
# Historical context: this script supersedes the procedure in
# .wiki-staging/HANDOFF.md, which only handled additive page adds and aborted
# on existing-page differences.
#
# Usage:
#   scripts/wiki-publish.sh                  # interactive (prompts on updates)
#   scripts/wiki-publish.sh --yes            # non-interactive (REQUIRE_CONFIRM=0)
#   REQUIRE_CONFIRM=0 scripts/wiki-publish.sh
#   COMMIT_MSG="custom" scripts/wiki-publish.sh

set -euo pipefail

# --- Config (override via env) ---
WIKI_REPO="${WIKI_REPO:-https://github.com/Sunstone-Partners/ensemble.wiki.git}"
WIKI_BRANCH="${WIKI_BRANCH:-master}"
STAGING_DIR="${STAGING_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)/.wiki-staging}"
GIT_USER_NAME="${GIT_USER_NAME:-ensemble-assistant}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-assistant@sunstone.local}"
COMMIT_MSG_DEFAULT="${COMMIT_MSG_DEFAULT:-docs(wiki): publish staged pages}"
# Files matching this pattern in the staging dir are NOT published.
# Defensive: prevents local-only docs (e.g., HANDOFF.md, README.md) from leaking
# into the live wiki. Override via EXCLUDE_PATTERN env var if needed.
EXCLUDE_PATTERN="${EXCLUDE_PATTERN:-^(HANDOFF|README|LICENSE)\.md$|^\.|/_}"
REQUIRE_CONFIRM=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) REQUIRE_CONFIRM=0; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

# --- Colors ---
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi
info() { printf "${BLUE}==>${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}==>${NC} %s\n" "$*"; }
err()  { printf "${RED}==>${NC} %s\n" "$*" >&2; }
ok()   { printf "${GREEN}==>${NC} %s\n" "$*"; }

# --- Preflight ---
shopt -s nullglob
STAGED_FILES=( "$STAGING_DIR"/*.md )
[[ ${#STAGED_FILES[@]} -gt 0 ]] || { err "No staged .md files in $STAGING_DIR"; exit 2; }

# --- Clone live wiki to tempdir with cleanup trap ---
WIKI=$(mktemp -d -t ensemble.wiki.XXXXXX)
info "Cloning $WIKI_REPO (branch: $WIKI_BRANCH) to $WIKI"
if ! git clone --depth=1 --branch "$WIKI_BRANCH" "$WIKI_REPO" "$WIKI" 2>/dev/null; then
  err "Failed to clone wiki — check network/credentials for $WIKI_REPO"
  rm -rf "$WIKI"
  exit 3
fi
git -C "$WIKI" config user.name "$GIT_USER_NAME"
git -C "$WIKI" config user.email "$GIT_USER_EMAIL"

cleanup() { rm -rf "$WIKI" 2>/dev/null || true; }
trap cleanup EXIT

cd "$WIKI"

# --- Per-page processing ---
PAGES_ADDED=()
PAGES_UPDATED=()
PAGES_SKIPPED=()
SIDEBAR_CHANGED=0
for staged in "${STAGED_FILES[@]}"; do
  [[ -f "$staged" ]] || continue
  name=$(basename "$staged")
  [[ "$name" =~ $EXCLUDE_PATTERN ]] && { info "$name: excluded by pattern — skipping"; continue; }
  [[ "$name" == "_Sidebar.md" ]] && continue
  # Sidebar is handled separately below (reference snapshot, not wholesale copy)

  if [[ -f "$name" ]]; then
    if diff -q "$staged" "$name" >/dev/null 2>&1; then
      info "$name: identical — skipping"
      PAGES_SKIPPED+=("$name")
      continue
    fi
    warn "$name: live differs from staged — review diff below"
    echo "----- DIFF (live → staged) -----"
    diff --color=always "$name" "$staged" || true
    echo "----- END DIFF -----"
    if [[ "$REQUIRE_CONFIRM" == "1" ]]; then
      read -r -p "Accept this update and overwrite live? [y/N] " ans
      [[ "$ans" =~ ^[Yy]$ ]] || { err "Aborted by user at $name"; exit 4; }
    fi
    cp "$staged" "$name"
    PAGES_UPDATED+=("$name")
  else
    info "$name: new page — copying"
    cp "$staged" "$name"
    PAGES_ADDED+=("$name")
  fi
done

# --- Sidebar reconciliation ---
# Read every list-item entry from the staged sidebar; insert any not already
# in live sidebar before the "## Training" heading (or at EOF if absent).
if [[ -f "$STAGING_DIR/_Sidebar.md" ]]; then
  info "Reconciling sidebar from staged reference snapshot"
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    # Match by URL substring (titles can drift; URLs are stable)
    url=$(printf '%s' "$entry" | grep -oE 'https?://[^)]+' | head -1 || true)
    if [[ -n "$url" ]] && grep -qF "$url" _Sidebar.md; then
      info "  sidebar entry present: $url"
      continue
    fi
    awk -v entry="$entry" '
      /^## Training/ {
        print entry
        print ""
        print
        found_training = 1
        next
      }
      END {
        if (!found_training) print entry
      }
      { print }
    ' _Sidebar.md > _Sidebar.md.new
    mv _Sidebar.md.new _Sidebar.md
    info "  sidebar entry inserted: $url"
    SIDEBAR_CHANGED=1
  done < <(grep -E '^\s*-\s*\[' "$STAGING_DIR/_Sidebar.md" || true)
fi

# --- Stage all changes ---
git add -A

# --- Short-circuit on no-op ---
if git diff --cached --quiet; then
  ok "No staged changes — wiki already in the desired state. Nothing to commit."
  exit 0
fi

# --- Final review gate ---
echo "----- STAGED DIFF (full) -----"
git diff --cached --stat
echo "----- DETAIL -----"
git diff --cached
echo "----- END STAGED DIFF -----"

if [[ "$REQUIRE_CONFIRM" == "1" ]]; then
  read -r -p "Commit and push to $WIKI_BRANCH? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { err "Aborted by user before push"; exit 5; }
fi

# --- Commit + push ---
COMMIT_MSG="${COMMIT_MSG:-$COMMIT_MSG_DEFAULT}"
git commit -m "$COMMIT_MSG"
ok "Committed: $COMMIT_MSG"

info "Pushing to origin/$WIKI_BRANCH"
git push origin "$WIKI_BRANCH"
ok "Pushed to $WIKI_REPO ($WIKI_BRANCH)"

echo
ok "Summary"
printf '  %-10s %s\n' "added:"   "${PAGES_ADDED[*]:-none}"
printf '  %-10s %s\n' "updated:" "${PAGES_UPDATED[*]:-none}"
printf '  %-10s %s\n' "skipped:" "${PAGES_SKIPPED[*]:-none}"
printf '  %-10s %s\n' "sidebar:" "$([[ $SIDEBAR_CHANGED -eq 1 ]] && echo changed || echo unchanged)"
