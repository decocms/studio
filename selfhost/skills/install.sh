#!/usr/bin/env sh
# Install the deco Studio self-host skill into your Claude Code skills dir.
#
# One-liner (public repo):
#   curl -fsSL https://raw.githubusercontent.com/decocms/studio/main/selfhost/skills/install.sh | sh
#
# Then open Claude Code and say "install Studio" — the skill interviews you and
# drives the install. It works from a clone of the studio repo (it needs the
# Helm charts + scripts); if you're not in one, the skill offers to clone it.
set -eu

RAW="${STUDIO_RAW:-https://raw.githubusercontent.com/decocms/studio/main}"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$SKILLS_DIR/self-host-studio"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

mkdir -p "$DEST"
curl -fsSL "$RAW/selfhost/skills/self-host-studio/SKILL.md" -o "$DEST/SKILL.md"

echo "✓ self-host-studio skill installed → $DEST/SKILL.md"
echo ""
echo "Next: open Claude Code and say  \"install Studio\"  (or /self-host-studio)."
echo "The skill needs the studio repo (charts + scripts). If you're not in a clone,"
echo "it will offer to run:  git clone https://github.com/decocms/studio.git"
