#!/usr/bin/env bash
# Steuerskript für Entwicklung, Version, Release und Deploy – in allen Projekten identisch.
#
#   ./dev.sh help
#
# Nicht hier ändern: Projektspezifisches steht in dev.project.sh, der gemeinsame Kern in
# scripts/devkit/ (Quelle: ProjectTemplate, aktualisieren mit ./dev.sh self-update).
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ ! -f "$ROOT/scripts/devkit/devkit.sh" ]; then
  echo "scripts/devkit/ fehlt – aus dem ProjectTemplate kopieren." >&2
  exit 1
fi
# shellcheck source=scripts/devkit/devkit.sh
. "$ROOT/scripts/devkit/devkit.sh"

dk_load_project
dk_main "$@"
