#!/bin/sh
set -eu

REPO_URL="${TRIRELAY_REPO_URL:-https://github.com/Jacknegar/Trirelay.git}"
SELF="$0"
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  case "$TARGET" in
    /*) SELF="$TARGET" ;;
    *) SELF="$(dirname -- "$SELF")/$TARGET" ;;
  esac
done
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
CANDIDATE_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
APPLY_FLAG="--dry-run"
HOST_ARG="all"

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY_FLAG="--apply" ;;
    --dry-run) APPLY_FLAG="--dry-run" ;;
    --host=*) HOST_ARG="${arg#--host=}" ;;
  esac
done

find_node() {
  if [ -n "${TRIRELAY_NODE_BIN:-}" ] && [ -x "$TRIRELAY_NODE_BIN" ]; then
    printf '%s\n' "$TRIRELAY_NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /home/linuxbrew/.linuxbrew/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    /usr/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  printf 'Trirelay error: Node.js (>=18.18) is required.\n' >&2
  exit 1
fi

NODE_OK="$("$NODE_BIN" -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.stdout.write(maj > 18 || (maj === 18 && min >= 18) ? "1" : "0")')"
if [ "$NODE_OK" != "1" ]; then
  printf 'Trirelay error: Node.js >=18.18 required (found %s).\n' "$("$NODE_BIN" -v)" >&2
  exit 1
fi

if [ -f "$CANDIDATE_ROOT/bin/trirelay.mjs" ] && [ -f "$CANDIDATE_ROOT/plugin.json" ]; then
  ROOT_DIR="$CANDIDATE_ROOT"
else
  INSTALL_DIR="${TRIRELAY_INSTALL_DIR:-$HOME/.local/share/trirelay}"
  if [ "$APPLY_FLAG" != "--apply" ]; then
    printf 'Dry-run preview: would clone/update %s into %s and run `trirelay install --host %s --apply`.\n' "$REPO_URL" "$INSTALL_DIR" "$HOST_ARG"
    printf 'Re-run with `--apply` to install.\n'
    exit 0
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" pull --ff-only
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  ROOT_DIR="$INSTALL_DIR"
fi

if [ "$APPLY_FLAG" = "--apply" ]; then
  chmod +x \
    "$ROOT_DIR/bin/trirelay.mjs" \
    "$ROOT_DIR/bin/trirelay-mcp.mjs" \
    "$ROOT_DIR/scripts/mcp-launcher.sh" \
    "$ROOT_DIR/scripts/hook-launcher.sh" \
    "$ROOT_DIR/scripts/session-hook.mjs" \
    "$ROOT_DIR/scripts/install.sh"
fi

printf 'Trirelay root: %s\n' "$ROOT_DIR"
"$NODE_BIN" "$ROOT_DIR/bin/trirelay.mjs" doctor --json || true
"$NODE_BIN" "$ROOT_DIR/bin/trirelay.mjs" install --host "$HOST_ARG" "$APPLY_FLAG" --json
