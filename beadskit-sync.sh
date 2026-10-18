#!/usr/bin/env bash
# Verteilt den beadskit (scripts/beadskit/: bdw, workers, Leitstand, CI-Runner, Vorlagen) aus diesem
# Template in die Projekte – Gegenstück zu devkit-sync.sh für die parallelen Claude-Worker.
#
#   ./beadskit-sync.sh                      Stand je Projekt zeigen
#   ./beadskit-sync.sh --apply [projekt…]   übernehmen (ohne Namen: alle eingerichteten)
#   ./beadskit-sync.sh --adopt <projekt> [--slug s] [--base branch] [--modules "a b"] [--prefix p]
#                                           Projekt erstmals einrichten: Kit, beads.project.sh,
#                                           Skills (.claude/skills/<slug>-*), reviews/README.md.
#                                           Vorhandene Dateien bleiben unangetastet.
#
# Eingerichtet ist ein Projekt mit beads.project.sh; nur solche fasst --apply an. Die Projekte
# stehen in devkit-projects.txt. beads selbst (bd init, Epics) richtet der User ein, siehe README.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/devkit/devkit.sh
. "$ROOT/scripts/devkit/devkit.sh"

KIT="$ROOT/scripts/beadskit"
LIST="$ROOT/devkit-projects.txt"
BK_VER="$(tr -d '[:space:]' <"$KIT/VERSION")"
APPLY=0
ADOPT=0
ONLY=" "
SLUG="" BASE="" MODULES="" PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=1 ;;
    --adopt)   ADOPT=1 ;;
    --slug)    SLUG="${2:?}"; shift ;;
    --base)    BASE="${2:?}"; shift ;;
    --modules) MODULES="${2:?}"; shift ;;
    --prefix)  PREFIX="${2:?}"; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "Unbekannte Option: $1" ;;
    *)         ONLY="$ONLY$1 " ;;
  esac
  shift
done
[ -f "$LIST" ] || die "devkit-projects.txt fehlt."
need rsync

same() { diff -rq "$KIT" "$1/scripts/beadskit" >/dev/null 2>&1; }
install_kit() { mkdir -p "$1/scripts"; rsync -a --delete "$KIT/" "$1/scripts/beadskit/"; }

# Vorlage nach Ziel kopieren und Platzhalter ersetzen; vorhandenes Ziel bleibt.
render() {
  local src="$1" dst="$2"
  if [ -e "$dst" ]; then dim "vorhanden, unverändert: ${dst#"$DIR"/}"; return; fi
  mkdir -p "$(dirname "$dst")"
  local pipe comma
  pipe="$(printf '%s' "$MODULES" | tr ' ' '|')"
  comma="$(printf '%s' "$MODULES" | sed 's/ /, /g')"
  # Trenner # statt |: die Modul-Liste mit | ist selbst ein Ersatztext
  sed -e "s#{{NAME}}#$NAME#g" -e "s#{{SLUG}}#$SLUG#g" -e "s#{{BASE}}#$BASE#g" \
      -e "s#{{MODULES}}#$MODULES#g" -e "s#{{MODULES_PIPE}}#$pipe#g" -e "s#{{MODULES_COMMA}}#$comma#g" \
      -e "s#{{ISSUE_PREFIX}}#$PREFIX#g" "$src" >"$dst"
  ok "angelegt: ${dst#"$DIR"/}"
}

if [ "$ADOPT" = 1 ]; then
  [ "$ONLY" != " " ] || die "--adopt braucht einen Projektnamen."
  for name in $ONLY; do
    DIR="$(cd "$ROOT/../$name" 2>/dev/null && pwd -P)" || die "Projekt nicht gefunden: ../$name"
    git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1 || die "$name ist kein Git-Repository."
    NAME="$name"
    [ -n "$SLUG" ] || SLUG="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/-$//')"
    [ -n "$BASE" ] || BASE="$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
    [ -n "$BASE" ] || BASE=main
    [ -n "$PREFIX" ] || PREFIX="$SLUG"
    case "$SLUG" in *[!a-z0-9-]*|'') die "Slug nur a-z, 0-9, -: $SLUG" ;; esac
    case "$NAME$BASE$MODULES$PREFIX" in *'#'*) die "Kein # in Name, Branch, Modulen oder Präfix" ;; esac
    step "$name einrichten (Slug $SLUG, Ziel-Branch $BASE)"
    install_kit "$DIR"
    ok "beadskit $BK_VER nach scripts/beadskit/"
    T="$KIT/templates"
    render "$T/beads.project.sh" "$DIR/beads.project.sh"
    render "$T/skills/worker-regeln.md" "$DIR/.claude/skills/worker-regeln.md"
    for role in fix search verify regress; do
      render "$T/skills/PREFIX-$role/SKILL.md" "$DIR/.claude/skills/$SLUG-$role/SKILL.md"
    done
    render "$T/reviews/README.md" "$DIR/reviews/README.md"
    grep -qxF "../$name" "$LIST" || { echo "../$name" >>"$LIST"; ok "in devkit-projects.txt eingetragen"; }
    echo
    info "Weiter (siehe README, Abschnitt 'Parallele Worker'):"
    info "  cd $DIR && bd init --prefix $PREFIX        # beads lokal, .beads/ nicht ins Git"
    info "  Epics je Modul anlegen, CLAUDE.md um Prüfkommandos und Review-Regeln ergänzen"
    info "  .claude/skills/worker-regeln.md → Abschnitt 'Projektspezifisch' füllen"
    info "  scripts/beadskit/workers start --dry-run"
  done
  exit 0
fi

rc=0
printf '%sbeadskit %s%s\n\n' "$C_BOLD" "$BK_VER" "$C_RESET"
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in /*) dir="$line" ;; *) dir="$ROOT/$line" ;; esac
  name="$(basename "$dir")"
  [ "$ONLY" = " " ] || case "$ONLY" in *" $name "*) ;; *) continue ;; esac
  [ -d "$dir" ] || continue
  # Nicht eingerichtet: nie anfassen und nicht aufzählen (die meisten Projekte haben keine Worker).
  [ -f "$dir/beads.project.sh" ] || continue
  theirs="–"
  [ ! -f "$dir/scripts/beadskit/VERSION" ] || theirs="$(tr -d '[:space:]' <"$dir/scripts/beadskit/VERSION")"
  if same "$dir"; then
    printf '  %-16s %saktuell%s        %s\n' "$name" "$C_GREEN" "$C_RESET" "$theirs"
  elif [ "$APPLY" = 1 ]; then
    install_kit "$dir"
    printf '  %-16s %sübernommen%s     %s → %s\n' "$name" "$C_GREEN" "$C_RESET" "$theirs" "$BK_VER"
  else
    printf '  %-16s %sweicht ab%s      %s\n' "$name" "$C_YELLOW" "$C_RESET" "$theirs"
    rc=1
  fi
done <"$LIST"

[ "$rc" = 0 ] || printf '\nÜbernehmen mit:  ./beadskit-sync.sh --apply\n'
exit "$rc"
