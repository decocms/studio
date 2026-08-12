#!/usr/bin/env sh
# Install the deco Studio self-host skill into your Claude Code skills dir.
#
# One-liner (public repo):
#   curl -fsSL https://raw.githubusercontent.com/decocms/studio/main/selfhost/skills/install.sh | sh
#
# Then open Claude Code and say "install Studio". The skill interviews you and
# writes an install directory you keep — an umbrella chart with pinned OCI
# dependencies plus your values — which installs the same way on a laptop
# cluster and on a managed one.
#
# This script is a convenience for Claude Code only. The skill itself is plain
# markdown served from the URL below, so any coding agent can follow it; point
# yours at that file instead of running this.
#
# Re-run any time to update: it overwrites SKILL.md in place.
set -eu

RAW="${STUDIO_RAW:-https://raw.githubusercontent.com/decocms/studio/main}"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$SKILLS_DIR/self-host-studio"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

mkdir -p "$DEST"
curl -fsSL "$RAW/selfhost/skills/self-host-studio/SKILL.md" -o "$DEST/SKILL.md"

echo "✓ self-host-studio skill installed → $DEST/SKILL.md"
echo ""
echo "Next: open Claude Code in an empty directory and say  \"install Studio\""
echo "(or /self-host-studio). No clone of the studio repo is needed — the Helm"
echo "charts are public OCI artifacts and the skill pulls them for you."
echo ""
echo "Using a different agent? Point it at:"
echo "  $RAW/selfhost/skills/self-host-studio/SKILL.md"
