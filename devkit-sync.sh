#!/usr/bin/env bash
# Verteilt den devkit (scripts/devkit/ und dev.sh) aus diesem Template in die Projekte.
#
#   ./devkit-sync.sh                      Stand je Projekt zeigen
#   ./devkit-sync.sh --apply [projekt…]   übernehmen (ohne Namen: alle umgestellten)
#   ./devkit-sync.sh --adopt <projekt>    Projekt erstmals umstellen: sichert dessen eigenes dev.sh als
#                                         dev.sh.vor-devkit und legt devkit und dev.sh an. Danach fehlt
#                                         nur noch die dev.project.sh des Projekts.
#
# Ein Projekt ohne dev.project.sh gilt als nicht umgestellt und wird von --apply nie angefasst.
#
# Die Projekte stehen in devkit-projects.txt (ein Pfad je Zeile, relativ zu diesem Verzeichnis).
# Im einzelnen Projekt tut ./dev.sh self-update dasselbe.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/devkit/devkit.sh
. "$ROOT/scripts/devkit/devkit.sh"

LIST="$ROOT/devkit-projects.txt"
APPLY=0
ADOPT=0
ONLY=" "
for a in "$@"; do
  case "$a" in
    --apply)   APPLY=1 ;;
    --adopt)   ADOPT=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "Unbekannte Option: $a" ;;
    *)         ONLY="$ONLY$a " ;;
  esac
done
[ -f "$LIST" ] || die "devkit-projects.txt fehlt (lokal, nicht versioniert): cp devkit-projects.txt.example devkit-projects.txt"

same() { diff -rq "$ROOT/scripts/devkit" "$1/scripts/devkit" >/dev/null 2>&1 && cmp -s "$ROOT/dev.sh" "$1/dev.sh"; }

if [ "$ADOPT" = 1 ]; then
  [ "$ONLY" != " " ] || die "--adopt braucht einen Projektnamen."
  for name in $ONLY; do
    dir="$(cd "$ROOT/../$name" 2>/dev/null && pwd -P)" || die "Projekt nicht gefunden: ../$name"
    if [ -f "$dir/dev.sh" ] && ! grep -q 'scripts/devkit/devkit.sh' "$dir/dev.sh"; then
      [ ! -e "$dir/dev.sh.vor-devkit" ] || die "$name/dev.sh.vor-devkit existiert schon – erst klären."
      # cp -p und danach löschen statt mv: die Sicherung steht, bevor irgendetwas ersetzt wird.
      cp -p "$dir/dev.sh" "$dir/dev.sh.vor-devkit"
      chmod -x "$dir/dev.sh.vor-devkit"
      cmp -s "$dir/dev.sh" "$dir/dev.sh.vor-devkit" || die "Sicherung von $name/dev.sh fehlgeschlagen."
      rm -f "$dir/dev.sh"
      ok "$name: bisheriges dev.sh gesichert als dev.sh.vor-devkit"
    fi
    dk_devkit_install "$ROOT" "$dir"
    ok "$name: devkit $DK_VERSION angelegt – jetzt dev.project.sh schreiben"
  done
  exit 0
fi

rc=0
printf '%sdevkit %s%s\n\n' "$C_BOLD" "$DK_VERSION" "$C_RESET"
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in /*) dir="$line" ;; *) dir="$ROOT/$line" ;; esac
  name="$(basename "$dir")"
  [ "$ONLY" = " " ] || case "$ONLY" in *" $name "*) ;; *) continue ;; esac
  if [ ! -d "$dir" ]; then
    printf '  %-16s %snicht gefunden%s (%s)\n' "$name" "$C_YELLOW" "$C_RESET" "$line"
    continue
  fi
  # Noch nicht umgestellt (eigenes dev.sh, keine dev.project.sh): nie anfassen.
  if [ ! -f "$dir/dev.project.sh" ]; then
    printf '  %-16s %snicht umgestellt%s (keine dev.project.sh) – übersprungen\n' "$name" "$C_YELLOW" "$C_RESET"
    continue
  fi
  theirs="–"
  [ ! -f "$dir/scripts/devkit/VERSION" ] || theirs="$(tr -d '[:space:]' <"$dir/scripts/devkit/VERSION")"
  if same "$dir"; then
    printf '  %-16s %saktuell%s        %s\n' "$name" "$C_GREEN" "$C_RESET" "$theirs"
  elif [ "$APPLY" = 1 ]; then
    dk_devkit_install "$ROOT" "$dir"
    printf '  %-16s %sübernommen%s     %s → %s\n' "$name" "$C_GREEN" "$C_RESET" "$theirs" "$DK_VERSION"
  else
    printf '  %-16s %sweicht ab%s      %s\n' "$name" "$C_YELLOW" "$C_RESET" "$theirs"
    rc=1
  fi
done <"$LIST"

[ "$rc" = 0 ] || printf '\nÜbernehmen mit:  ./devkit-sync.sh --apply\n'
exit "$rc"
