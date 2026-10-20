#!/bin/sh
# Kept at its published URL so old install instructions explain the discontinuation.
set -eu

cat >&2 << 'MESSAGE'
The deco studio desktop app is discontinued.
Use deco studio in your browser: https://studio.decocms.com

To remove an existing install:
  macOS: brew uninstall --zap --cask deco-studio
  Linux: rm -rf ~/.local/bin/deco-studio \
           ~/.local/share/applications/deco-studio.desktop \
           ~/.local/share/icons/hicolor/256x256/apps/deco-studio.png \
           ~/.local/share/deco-studio
MESSAGE
exit 1
