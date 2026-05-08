#!/usr/bin/env bash
# setup-voice.sh — first-run automation for the voltras-mcp voice-listener.
#
# Verifies host prerequisites (sox, python3 >= 3.10), creates a Python
# virtualenv at voice-listener/.venv, installs the sidecar's pip deps,
# and runs a non-mic smoke test against listener.py to confirm the
# Python side boots cleanly.
#
# Idempotent — safe to re-run. Pass --clean to wipe the venv first.
#
# Usage:
#   scripts/setup-voice.sh             # set up (or refresh) the venv
#   scripts/setup-voice.sh --clean     # wipe .venv then set up from scratch
#   scripts/setup-voice.sh --no-smoke  # skip the smoke test (CI / offline)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_DIR="${REPO_ROOT}/voice-listener"
VENV_DIR="${VOICE_DIR}/.venv"
VENV_PYTHON="${VENV_DIR}/bin/python3"
REQUIREMENTS="${VOICE_DIR}/requirements.txt"
PYTHON_MIN_MAJOR=3
PYTHON_MIN_MINOR=10

CLEAN=0
RUN_SMOKE=1
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --no-smoke) RUN_SMOKE=0 ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "setup-voice: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[setup-voice] %s\n' "$*"; }
fail() { printf '[setup-voice] ERROR: %s\n' "$*" >&2; exit 1; }

require_sox() {
  if ! command -v sox >/dev/null 2>&1; then
    fail "sox not on PATH. Install it first:
    macOS:  brew install sox
    Debian/Ubuntu: sudo apt-get install sox
    Then re-run scripts/setup-voice.sh."
  fi
  log "sox found: $(command -v sox)"
}

require_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 not on PATH. Install Python >= ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} (macOS: brew install python@3.11)."
  fi
  local version major minor
  version="$(python3 -c 'import sys; print("{}.{}".format(sys.version_info[0], sys.version_info[1]))')"
  major="${version%%.*}"
  minor="${version##*.}"
  if [ "$major" -lt "$PYTHON_MIN_MAJOR" ] || { [ "$major" -eq "$PYTHON_MIN_MAJOR" ] && [ "$minor" -lt "$PYTHON_MIN_MINOR" ]; }; then
    fail "python3 version ${version} is below the required ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}."
  fi
  log "python3 found: $(command -v python3) (${version})"
}

clean_venv() {
  if [ -d "$VENV_DIR" ]; then
    log "removing existing venv at ${VENV_DIR}"
    rm -rf "$VENV_DIR"
  fi
}

create_venv() {
  if [ -x "$VENV_PYTHON" ]; then
    log "venv already exists at ${VENV_DIR} (skipping creation)"
    return 0
  fi
  log "creating venv at ${VENV_DIR}"
  python3 -m venv "$VENV_DIR"
}

install_requirements() {
  [ -f "$REQUIREMENTS" ] || fail "requirements file missing: ${REQUIREMENTS}"
  log "upgrading pip"
  "$VENV_PYTHON" -m pip install --quiet --upgrade pip
  log "installing requirements from ${REQUIREMENTS}"
  "$VENV_PYTHON" -m pip install --quiet -r "$REQUIREMENTS"
}

# openWakeWord ships its model registry as URLs, not bundled .onnx files.
# Without this step, listener.py crashes the first real run with
# "alexa_v0.1.onnx ... File doesn't exist". `download_models()` is idempotent.
download_wakeword_models() {
  log "downloading openWakeWord built-in models (~10 MB, idempotent)"
  "$VENV_PYTHON" -c 'from openwakeword.utils import download_models; download_models()' \
    || fail "openWakeWord model download failed (network?). Re-run scripts/setup-voice.sh."
}

run_smoke() {
  [ "$RUN_SMOKE" -eq 1 ] || { log "skipping smoke test (--no-smoke)"; return 0; }
  log "running listener.py --smoke"
  local output
  output="$("$VENV_PYTHON" "${VOICE_DIR}/listener.py" --smoke </dev/null)"
  printf '[setup-voice] smoke output: %s\n' "$output"
  printf '%s' "$output" | grep -q '"event":"ready"' \
    || fail "smoke test did not emit a 'ready' event. Got: ${output}"
  printf '%s' "$output" | grep -q '"smoke":true' \
    || fail "smoke test did not include 'smoke:true'. Got: ${output}"
  log "smoke test passed"
}

print_export_hint() {
  cat <<EOF

[setup-voice] Done. Wire the sidecar by exporting:

  export VOLTRAS_VOICE_PYTHON="${VENV_PYTHON}"

Or set it inline when launching voltras-mcp / Claude Code, e.g.:

  VOLTRAS_VOICE_PYTHON="${VENV_PYTHON}" claude

First-run reminder: macOS will prompt for Microphone access the first
time the Node host opens the input device (System Settings → Privacy &
Security → Microphone).
EOF
}

main() {
  log "voice-listener setup starting (worktree=${REPO_ROOT})"
  require_sox
  require_python
  if [ "$CLEAN" -eq 1 ]; then clean_venv; fi
  create_venv
  install_requirements
  download_wakeword_models
  run_smoke
  print_export_hint
}

main "$@"
