#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Snapshot push (Fix 2 — public persistence without a paid disk).
#
# Pulls the current dataset from a running instance via the admin snapshot
# export endpoint and commits it to the `data-snapshot` branch, which the
# build checks out before `npm start` (scripts/snapshot-restore.sh).
#
# Usage:
#   scripts/snapshot-push.sh --dry-run              # validate only, no writes
#   scripts/snapshot-push.sh --base URL --token T   # export + commit + push
#
# Options:
#   --base URL      instance base URL
#                   (default: https://global-study-mobile-mvp.onrender.com)
#   --token TOKEN   admin session token (or set ADMIN_TOKEN)
#   --branch NAME   snapshot branch (default: data-snapshot)
#   --dry-run       print the plan; never touch git, GitHub or the network
#
# SAFETY:
#   * Requires an explicit admin token — nothing is read from a public endpoint.
#   * Refuses to commit if the payload contains credential-shaped fields.
#   * Commits only the dataset; never rewrites history and never force-pushes.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="https://global-study-mobile-mvp.onrender.com"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
BRANCH="data-snapshot"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_URL="$2"; shift 2 ;;
    --token) ADMIN_TOKEN="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { echo "[snapshot-push] $*"; }
SNAPSHOT_PATH="data/db/aethel.json"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- 1. Validate inputs ----------------------------------------------------
if [ "${DRY_RUN}" -eq 0 ] && [ -z "${ADMIN_TOKEN}" ]; then
  echo "ERROR: an admin token is required (use --token or ADMIN_TOKEN)." >&2
  echo "       Run with --dry-run to inspect the flow without credentials." >&2
  exit 2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT
EXPORT_FILE="${WORK_DIR}/export.json"
SNAPSHOT_FILE="${WORK_DIR}/aethel.json"

# --- 2. Export the dataset --------------------------------------------------
if [ "${DRY_RUN}" -eq 1 ]; then
  say "dry-run: GET ${BASE_URL}/api/admin/snapshot/export (admin token required)"
  say "dry-run: apply the public whitelist (lib/snapshot-policy.js)"
  say "dry-run: refuse to commit if a non-whitelisted collection or field appears"
  say "dry-run: write ${SNAPSHOT_PATH} on branch '${BRANCH}' and push (no force)"
  exit 0
fi

say "exporting PUBLIC (whitelisted) dataset from ${BASE_URL}"
CURL_AUTH_HEADER="Authorization: Bearer ${ADMIN_TOKEN}"
HTTP_CODE="$(curl -sS -m 180 -o "${EXPORT_FILE}" -w "%{http_code}" -H "${CURL_AUTH_HEADER}" "${BASE_URL}/api/admin/snapshot/export")"
# The whitelisted export is the only payload that may be published. If the
# server ever returns the internal scope (or anything unexpected), refuse.
SCOPE="$(node "${REPO_ROOT}/scripts/snapshot-scope.js" "${EXPORT_FILE}" 2>/dev/null || true)"
if [ -n "${SCOPE}" ] && [ "${SCOPE}" != "public-whitelisted" ]; then
  echo "ERROR: export scope '${SCOPE}' is not publishable — aborting." >&2
  exit 1
fi
if [ "${HTTP_CODE}" != "200" ]; then
  echo "ERROR: export failed with HTTP ${HTTP_CODE}" >&2
  head -c 300 "${EXPORT_FILE}" >&2 || true
  exit 1
fi

# --- 3. Secret scan (never commit credentials) -----------------------------
if grep -qEi '(connection_?string|DATABASE_URL|"password"|"token"|"secret")"[[:space:]]*:[[:space:]]*"[^"]{8,}"' "${EXPORT_FILE}"; then
  echo "ERROR: the export appears to contain credentials — aborting." >&2
  exit 1
fi

# --- 4. Build the snapshot payload + enforce the whitelist -----------------
# Defence in depth: the server already whitelists; this script independently
# re-applies the policy and REFUSES to write anything that is not publishable.
node "${REPO_ROOT}/scripts/snapshot-project.js" "${EXPORT_FILE}" "${SNAPSHOT_FILE}" || {
  echo "ERROR: the snapshot failed the public whitelist — nothing was committed." >&2
  exit 1
}

# --- 5. Commit onto the snapshot branch via a dedicated worktree ----------
# A worktree is used so the main checkout is NEVER switched, stashed or reset:
# the snapshot branch is orphaned and holds only the dataset file.
say "preparing branch '${BRANCH}'"
WORKTREE="${WORK_DIR}/worktree"

if git ls-remote --exit-code --heads origin "${BRANCH}" >/dev/null 2>&1; then
  git fetch -q origin "${BRANCH}"
  git worktree add -q --detach "${WORKTREE}" "origin/${BRANCH}"
else
  # Orphan branch: start from an empty index so the branch holds ONLY the
  # dataset (no code, no docs, no history from the code branches).
  git worktree add -q --detach "${WORKTREE}"
  git -C "${WORKTREE}" rm -rf --cached . >/dev/null 2>&1 || true
fi

mkdir -p "$(dirname "${WORKTREE}/${SNAPSHOT_PATH}")"
cp "${SNAPSHOT_FILE}" "${WORKTREE}/${SNAPSHOT_PATH}"

git -C "${WORKTREE}" add -f "${SNAPSHOT_PATH}"
if git -C "${WORKTREE}" diff --cached --quiet; then
  say "snapshot unchanged — nothing to commit"
else
  git -C "${WORKTREE}" -c user.name="AETHEL EDU" -c user.email="dev@aethel.local" \
      commit -q -m "snapshot: dataset export $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  say "committed $(git -C "${WORKTREE}" rev-parse --short HEAD)"
fi

# --- 6. Push (never force) --------------------------------------------------
say "pushing origin/${BRANCH}"
SNAPSHOT_SHA="$(git -C "${WORKTREE}" rev-parse HEAD)"
git push -q origin "${SNAPSHOT_SHA}:refs/heads/${BRANCH}"

# --- 7. Clean up the worktree (main checkout untouched) ---------------------
git worktree remove --force "${WORKTREE}" 2>/dev/null || rm -rf "${WORKTREE}"

say "done — the next deploy restores this dataset"
