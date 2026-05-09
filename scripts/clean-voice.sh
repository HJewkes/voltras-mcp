#!/usr/bin/env bash
# clean-voice.sh — wipe the voice-listener Python venv for a fresh re-install.
#
# After running this, `scripts/setup-voice.sh` will rebuild .venv from scratch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${REPO_ROOT}/voice-listener/.venv"

if [ -d "$VENV_DIR" ]; then
  echo "[clean-voice] removing ${VENV_DIR}"
  rm -rf "$VENV_DIR"
else
  echo "[clean-voice] nothing to clean (no venv at ${VENV_DIR})"
fi
