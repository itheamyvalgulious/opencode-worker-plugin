#!/usr/bin/env bash
# install.sh — Install / update / uninstall opencode-worker-plugin
#   curl -fsSL https://raw.githubusercontent.com/itheamyvalgulious/opencode-worker-plugin/main/install.sh | bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REPO_OWNER="itheamyvalgulious"
REPO_NAME="opencode-worker-plugin"
DEFAULT_REF="main"
MIN_SIZE=1000
PLUGIN_FILENAME="worker-plugin.ts"
SENTINEL="WorkerPlugin"          # sanity-check string

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: install.sh [OPTIONS]

Install, update, or uninstall the opencode-worker-plugin.

Options:
  --uninstall          Remove the plugin instead of installing
  --local              Install into \$PWD/.opencode/plugins/ (instead of global)
  --ref <git-ref>      Git ref to download (tag/branch/commit; default: $DEFAULT_REF)
  --file <path>        Install from a local file (skip download)
  --help               Show this help and exit

Environment:
  WORKER_PLUGIN_REF    Git ref override (lower precedence than --ref)
  XDG_CONFIG_HOME      Global config root (default: \$HOME/.config)

Examples:
  curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh | bash
  curl -fsSL ... | WORKER_PLUGIN_REF=v0.2.0 bash
  curl -fsSL -o /tmp/install.sh https://... && bash /tmp/install.sh --local
  curl -fsSL ... | bash -s -- --uninstall
EOF
  exit 0
}

[[ "${1:-}" == "--help" ]] && usage

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
MODE="install"         # install | uninstall
LOCAL=false
REF="${WORKER_PLUGIN_REF:-$DEFAULT_REF}"
FILE_SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) MODE="uninstall"; shift ;;
    --local)     LOCAL=true; shift ;;
    --ref)       REF="${2:-}"; shift 2 ;;
    --file)      FILE_SRC="${2:-}"; shift 2 ;;
    --help)      usage ;;
    *)           echo "[opencode-worker-plugin] Unknown option: $1" >&2
                 echo "Usage: install.sh [--help]" >&2
                 exit 1 ;;
  esac
done

# --ref requires a value
if [[ -z "$REF" ]]; then
  echo "[opencode-worker-plugin] --ref requires a non-empty argument" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine destination directory
# ---------------------------------------------------------------------------
if $LOCAL; then
  TARGET_DIR="$PWD/.opencode/plugins"
else
  GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
  TARGET_DIR="$GLOBAL_CONFIG/opencode/plugins"
fi

TARGET_FILE="$TARGET_DIR/$PLUGIN_FILENAME"

# ---------------------------------------------------------------------------
# Uninstall mode
# ---------------------------------------------------------------------------
if [[ "$MODE" == "uninstall" ]]; then
  REMOVED=false

  if [[ -f "$TARGET_FILE" ]]; then
    rm -f "$TARGET_FILE"
    echo "[opencode-worker-plugin] Removed: $TARGET_FILE"
    REMOVED=true
  fi

  # Legacy singular dir (global mode only)
  if ! $LOCAL; then
    LEGACY_DIR="${GLOBAL_CONFIG:-$HOME/.config}/opencode/plugin"
    LEGACY_FILE="$LEGACY_DIR/$PLUGIN_FILENAME"
    if [[ -f "$LEGACY_FILE" ]]; then
      rm -f "$LEGACY_FILE"
      echo "[opencode-worker-plugin] Removed legacy copy: $LEGACY_FILE"
      REMOVED=true
    fi
  fi

  if ! $REMOVED; then
    echo "[opencode-worker-plugin] Plugin not installed — nothing to remove." >&2
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Install mode
# ---------------------------------------------------------------------------

# --- Resolve source --------------------------------------------------------
if [[ -n "$FILE_SRC" ]]; then
  # Local file install
  SRC="$FILE_SRC"
  # Validate early
  if [[ ! -f "$SRC" ]]; then
    echo "[opencode-worker-plugin] Local file not found: $SRC" >&2
    exit 1
  fi
  SIZE=$(wc -c < "$SRC" 2>/dev/null | tr -d ' ' || echo 0)
  if [[ "$SIZE" -lt $MIN_SIZE ]]; then
    echo "[opencode-worker-plugin] Local file too small ($SIZE bytes, need ≥$MIN_SIZE): $SRC" >&2
    exit 1
  fi
  if ! grep -qF "$SENTINEL" "$SRC" 2>/dev/null; then
    echo "[opencode-worker-plugin] Local file missing sentinel string '$SENTINEL': $SRC" >&2
    exit 1
  fi
  TEMP_SRC="$SRC"
else
  # Download from GitHub
  DOWNLOAD_URL="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REF}/${PLUGIN_FILENAME}"

  # Create temp dir
  TMPDIR=$(mktemp -d) && trap 'rm -rf "$TMPDIR"' EXIT
  TEMP_FILE="$TMPDIR/$PLUGIN_FILENAME"

  # Download helper: prefer curl, fall back to wget
  download() { # $1=url $2=dest
    if command -v curl &>/dev/null; then
      curl -fsSL "$1" -o "$2"
    elif command -v wget &>/dev/null; then
      wget -qO "$2" "$1"
    else
      echo "[opencode-worker-plugin] Neither curl nor wget found. Install one of them and retry." >&2
      exit 1
    fi
  }

  echo "[opencode-worker-plugin] Downloading ref '${REF}' …"
  download "$DOWNLOAD_URL" "$TEMP_FILE" || {
    echo "[opencode-worker-plugin] Download failed. Ref '${REF}' may not exist or network issue." >&2
    exit 1
  }

  # Validate
  if [[ ! -f "$TEMP_FILE" ]]; then
    echo "[opencode-worker-plugin] Download produced no file." >&2
    exit 1
  fi
  SIZE=$(wc -c < "$TEMP_FILE" | tr -d ' ' || echo 0)
  if [[ "$SIZE" -lt $MIN_SIZE ]]; then
    echo "[opencode-worker-plugin] Downloaded file too small ($SIZE bytes, need ≥$MIN_SIZE)." >&2
    echo "[opencode-worker-plugin] Ref '${REF}' may point to an invalid or empty file." >&2
    exit 1
  fi
  if ! grep -qF "$SENTINEL" "$TEMP_FILE" 2>/dev/null; then
    echo "[opencode-worker-plugin] Downloaded file missing sentinel string '$SENTINEL'." >&2
    echo "[opencode-worker-plugin] Ref '${REF}' may point to an unexpected file." >&2
    exit 1
  fi

  TEMP_SRC="$TEMP_FILE"
fi

# --- Writeability check ----------------------------------------------------
if [[ -d "$TARGET_DIR" ]] && [[ ! -w "$TARGET_DIR" ]]; then
  echo "[opencode-worker-plugin] Destination directory not writable: $TARGET_DIR" >&2
  exit 1
fi

# --- Install ---------------------------------------------------------------
mkdir -p "$TARGET_DIR"
cp "$TEMP_SRC" "$TARGET_FILE"
chmod 0644 "$TARGET_FILE"

# --- Legacy migration (global mode only) ------------------------------------
if ! $LOCAL; then
  LEGACY_DIR="${GLOBAL_CONFIG:-$HOME/.config}/opencode/plugin"
  LEGACY_FILE="$LEGACY_DIR/$PLUGIN_FILENAME"
  if [[ -f "$LEGACY_FILE" ]]; then
    rm -f "$LEGACY_FILE"
    echo "[opencode-worker-plugin] Removed legacy copy at $LEGACY_FILE (migrated to avoid double-loading)."
  fi
fi

# --- Post-install message ----------------------------------------------------
cat <<EOF

[opencode-worker-plugin] Installed successfully.
  Path:   $TARGET_FILE
  Ref:    $REF

Restart opencode to activate. The following will appear automatically:

  Tools       — worker_spawn, worker_send, worker_read,
                worker_list, worker_interrupt, worker_shutdown,
                models(), set_timer, notify_parent
  Agents      — worker, designer
  Variants    — required worker_spawn parameter:
                low / medium / high / xhigh / max
                (agy workers: xhigh/max are clamped to high)

To pin a specific version (e.g. v0.2.0):
  curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh \\
    | WORKER_PLUGIN_REF=v0.2.0 bash

EOF