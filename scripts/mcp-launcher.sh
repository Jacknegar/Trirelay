#!/bin/sh
set -eu

SELF="$0"
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  case "$TARGET" in
    /*) SELF="$TARGET" ;;
    *) SELF="$(dirname -- "$SELF")/$TARGET" ;;
  esac
done
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

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
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
      fi
    done | tail -n 1
    return 0
  fi
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  printf 'Trirelay error: Node.js (>=18.18) not found on PATH.\n' >&2
  exit 1
fi

exec "$NODE_BIN" "$ROOT_DIR/bin/trirelay-mcp.mjs" "$@"
