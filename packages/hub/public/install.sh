#!/bin/sh
# vibegram installer. Served by the hub, so the address below is the hub that
# handed you this script.
#
#   curl -fsSL __HUB__/install.sh | sh -s -- <join-code> --nick claude-name
#
# Run it from the repository the room belongs to: a room is keyed to a
# repository and joining from anywhere else is refused.
set -eu

HUB="__HUB__"
CLIENT_DIR="${VIBEGRAM_CLIENT_DIR:-$HOME/.vibegram/client}"
BIN_DIR="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
die() { printf '! %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node 22 or newer is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

# The client is plain TypeScript run by node itself — no build, no dependencies,
# but the runtime has to be new enough to strip types on its own.
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || die "node $major is too old — 22 or newer is required"

# Taken from the hub rather than from git: the repository is usually private,
# and the hub is the one thing everyone in the room can already reach.
say "fetching the client into $CLIENT_DIR"
rm -rf "$CLIENT_DIR"
mkdir -p "$CLIENT_DIR"
curl -fsSL "$HUB/client.tar.gz" | tar -xz -C "$CLIENT_DIR" || die "could not fetch the client from $HUB"

CLI="$CLIENT_DIR/packages/client/src/cli.ts"
[ -f "$CLI" ] || die "the client looks broken: $CLI is missing"

mkdir -p "$BIN_DIR"
printf '#!/bin/sh\nexec node %s "$@"\n' "$CLI" > "$BIN_DIR/vibegram"
chmod +x "$BIN_DIR/vibegram"
say "installed $BIN_DIR/vibegram"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  # Said once, plainly: a launcher nobody can call is worse than none, because
  # every hint the agent gets will name a command that does not exist.
  *) say "! $BIN_DIR is not on PATH — add it, or call the full path" ;;
esac

if [ "$#" -eq 0 ]; then
  say ""
  say "now join, from the repository the room belongs to:"
  say "  vibegram join $HUB/<join-code> --nick <codename> --yes"
  say "add --no-hooks if the agent does not run from that repository"
  exit 0
fi

# A bare code is enough: this script came from the hub, so the hub is known.
target="$1"
shift
case "$target" in
  http://*|https://*) ;;
  -*) die "expected a join code or a hub link, got the flag $target" ;;
  *) target="$HUB/$target" ;;
esac

say ""
exec node "$CLI" join "$target" "$@"
