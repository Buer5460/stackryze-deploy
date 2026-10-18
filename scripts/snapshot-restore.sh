#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Snapshot restore (Fix 2 — public persistence without a paid disk).
#
# The dataset lives in the `data-snapshot` branch of this repository (see
# scripts/snapshot-push.sh). At build time we clone that branch and copy the
# snapshot into the runtime data directory so that writes survive redeploys
# on hosts with no persistent disk (Render free tier).
#
# Opt out with GS_SNAPSHOT_ENABLED=0 (falls back to a plain local file).
# The clone is anonymous: the repository is public and the snapshot branch
# contains no secrets (see FULL_MVP docs — real data must never be committed
# until a managed database is provisioned).
# ---------------------------------------------------------------------------
set -euo pipefail

if [ "${GS_SNAPSHOT_ENABLED:-1}" = "0" ]; then
  echo "[snapshot] disabled (GS_SNAPSHOT_ENABLED=0) — using a local data file"
  exit 0
fi

REPO_URL="${GS_SNAPSHOT_REPO_URL:-https://github.com/Buer5460/stackryze-deploy.git}"
BRANCH="${GS_SNAPSHOT_BRANCH:-data-snapshot}"
TARGET_DIR="${GS_DB_DIR:-/var/data}"
SNAPSHOT_FILE="${TARGET_DIR}/aethel.json"

mkdir -p "${TARGET_DIR}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "[snapshot] fetching ${BRANCH} from ${REPO_URL}"
if ! git clone --quiet --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${WORK_DIR}/snapshot" 2>/dev/null; then
  echo "[snapshot] branch not found or unreachable — starting from a fresh dataset"
  exit 0
fi

if [ ! -f "${WORK_DIR}/snapshot/data/db/aethel.json" ]; then
  echo "[snapshot] snapshot file missing in branch — starting from a fresh dataset"
  exit 0
fi

# Validate JSON before adopting it: a corrupt snapshot must never boot.
if ! node -e "JSON.parse(require('fs').readFileSync('${WORK_DIR}/snapshot/data/db/aethel.json','utf8'))" 2>/dev/null; then
  echo "[snapshot] snapshot is not valid JSON — keeping the existing dataset"
  exit 0
fi

# Never clobber an existing (newer) dataset written during this instance's life.
if [ -f "${SNAPSHOT_FILE}" ]; then
  echo "[snapshot] local dataset already present — keeping it"
  exit 0
fi

cp "${WORK_DIR}/snapshot/data/db/aethel.json" "${SNAPSHOT_FILE}"
echo "[snapshot] restored dataset into ${SNAPSHOT_FILE}"
