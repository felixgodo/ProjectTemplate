#!/bin/sh
# Sichert die Issues aller beads-Projekte dieses Rechners als JSONL nach ~/beads-backup/<datum>/
# (bd export --all) und löscht Sicherungen, die älter als 14 Tage sind. Läuft täglich per
# beads-backup.timer (setup-linux.sh). Kein vollständiges Dolt-Backup (keine Historie), aber
# genug, um Issues nach einem Plattenschaden mit `bd import` zurückzuholen.
set -eu
env_file=${BEADSKIT_HOME:-$HOME/.config/beadskit}/env
# shellcheck source=/dev/null
[ ! -f "$env_file" ] || . "$env_file"
out=$HOME/beads-backup/$(date +%F)
mkdir -p "$out"
list=${BEADSKIT_HOME:-$HOME/.config/beadskit}/projects.txt
[ -f "$list" ] || exit 0
grep -v '^#' "$list" | while read -r root; do
  [ -f "$root/.beads/metadata.json" ] || continue
  name=$(basename "$root")
  if (cd "$root" && bd export --all -o "$out/$name.jsonl" >/dev/null 2>&1); then
    echo "$name: $(wc -l <"$out/$name.jsonl") Einträge"
  else
    echo "$name: Export fehlgeschlagen" >&2
  fi
done
find "$HOME/beads-backup" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
