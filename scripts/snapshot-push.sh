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
  say "dry-run: validate the payload has no credential-shaped fields"
  say "dry-run: write ${SNAPSHOT_PATH} on branch '${BRANCH}' and push (no force)"
  exit 0
fi

say "exporting dataset from ${BASE_URL}"
HTTP_CODE="$(curl -sS -m 180 -o "${EXPORT_FILE}" -w '%{http_code}' \
  "${BASE_URL}/api/admin/snapshot/export" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}")"
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

# --- 4. Build the snapshot payload ----------------------------------------
node -e "
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync('${EXPORT_FILE}', 'utf8'));
if (!payload.ok || !payload.data) { console.error('unexpected export shape'); process.exit(1); }
const out = { version: payload.data.version, exported_at: payload.data.exported_at,
              backend: payload.data.backend, counts: payload.data.counts,
              data: payload.data.data };
fs.mkdirSync('$(dirname "${SNAPSHOT_FILE}")', { recursive: true });
fs.writeFileSync('${SNAPSHOT_FILE}', JSON.stringify(out, null, 2) + '\n');
const n = Object.values(out.counts).reduce((a, b) => a + b, 0);
console.log('[snapshot-push] snapshot holds ' + n + ' records across ' +
            Object.keys(out.counts).length + ' collections');
"

# --- 5. Commit onto the snapshot branch (orphan branch, dataset only) ------
ORIGINAL_REF="$(git rev-parse --abbrev-ref HEAD)"
ORIGINAL_SHA="$(git rev-parse HEAD)"

say "preparing branch '${BRANCH}'"
git stash list >/dev/null 2>&1 || true

if git rev-parse --verify "origin/${BRANCH}" >/dev/null 2>&1; then
  git checkout -q -B "${BRANCH}" "origin/${BRANCH}"
else
  git checkout -q --orphan "${BRANCH}"
  git rm -rf --cached . >/dev/null 2>&1 || true
fi

mkdir -p "$(dirname "${SNAPSHOT_PATH}")"
cp "${SNAPSHOT_FILE}" "${SNAPSHOT_PATH}"

git add "${SNAPSHOT_PATH}"
if git diff --cached --quiet; then
  say "snapshot unchanged — nothing to commit"
else
  git -c user.name="AETHEL EDU" -c user.email="dev@aethel.local" \
      commit -q -m "snapshot: dataset export $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  say "committed $(git rev-parse --short HEAD)"
fi

# --- 6. Push (never force) --------------------------------------------------
say "pushing origin/${BRANCH}"
git push -q origin "HEAD:refs/heads/${BRANCH}"

# --- 7. Restore the working branch exactly as it was -----------------------
git checkout -q "${ORIGINAL_REF}"
git reset -q --mixed "${ORIGINAL_SHA}"

say "done — the next deploy restores this dataset"
