#!/usr/bin/env bash
# Zieht die beads-Datenbank von Projekten vom Mac in die gemeinsame Datenbank auf dem PC um
# (beads-dolt, setup-linux.sh) und stellt .beads/ auf beiden Rechnern darauf um. Danach claimen
# Worker beider Rechner aus derselben Warteschlange. Läuft auf dem Mac nach setup-mac.sh.
#
#   migrate-beads.sh [--dry-run] [--force] [projekt…]   Mac → PC (Standard: alle aus projects.txt mit .beads)
#   migrate-beads.sh --back [--dry-run] [--force] [projekt…]   PC → Mac: wieder nur auf dem Mac
#
# Vorher Worker auslaufen lassen: ohne --force bricht es ab, solange Issues in Arbeit sind oder der
# Merge-Slot gehalten wird. Die alte Datenbank bleibt als .beads/dolt.vor-pc liegen (--back legt
# die auf dem PC als ~/beads-dolt/<db>.zurueck-<datum> ab, damit dort niemand mehr darauf arbeitet).
# Projektnamen sind Ordner unter ~/IdeaProjects (wie in projects.txt).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CONF=${BEADSKIT_HOME:-$HOME/.config/beadskit}
# shellcheck source=versions.conf
. "$HERE/versions.conf"

c_ok=$'\033[32m' c_warn=$'\033[33m' c_head=$'\033[1m' c_off=$'\033[0m'
head1() { printf '\n%s== %s%s\n' "$c_head" "$*" "$c_off"; }
ok() { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die() { printf '  %s✗ %s%s\n' "$c_warn" "$*" "$c_off" >&2; exit 1; }

back=0 dry=0 force=0 names=()
for a in "$@"; do
  case $a in
    --back) back=1 ;;
    --dry-run) dry=1 ;;
    --force) force=1 ;;
    -*) sed -n '6,7s/^# \{0,1\}//p' "$0" >&2; exit 2 ;;
    *) names+=("$a") ;;
  esac
done
[ -f "$CONF/hosts.conf" ] || die "erst scripts/remote/setup-mac.sh"
conf() { sed -n "s/^$1=//p" "$CONF/hosts.conf" | tr -d '"' | head -n 1; }
mac_root=$(conf HOST_mac_ROOT)
pc_root=$(conf "HOST_${PC_NAME}_ROOT")
[ -n "$mac_root" ] && [ -n "$pc_root" ] || die "HOST_mac_ROOT/HOST_${PC_NAME}_ROOT fehlen in $CONF/hosts.conf"

run() { if [ "$dry" = 1 ]; then printf '    $ %s\n' "$*"; else "$@"; fi; }
on_pc() { if [ "$dry" = 1 ]; then printf '    $ ssh %s %s\n' "$PC_NAME" "$*"; else ssh "$PC_NAME" ". ~/.config/beadskit/env; $*"; fi; }

# Projekte: genannte Ordner oder alle aus projects.txt, die eine beads-Datenbank haben
roots=()
if [ ${#names[@]} -gt 0 ]; then
  for n in "${names[@]}"; do roots+=("$mac_root/$n"); done
else
  while read -r r; do [ -f "$r/.beads/metadata.json" ] && roots+=("$r"); done < <(grep -v '^#' "$CONF/projects.txt")
fi
[ ${#roots[@]} -gt 0 ] || die "keine Projekte mit .beads/ (projects.txt)"

# Bricht ab, solange Issues in Arbeit sind oder der Merge-Slot gehalten wird
check_idle() {
  local r=$1 claims slot
  [ "$force" = 0 ] || return 0
  claims=$(cd "$r" && scripts/beadskit/bdw list --status in_progress --json 2>/dev/null | jq -r 'map(.id) | join(" ")') ||
    die "$(basename "$r"): beads antwortet nicht (oder --force)"
  [ -z "$claims" ] || die "$(basename "$r"): noch in Arbeit: $claims (erst workers drain, warten; oder --force)"
  slot=$(cd "$r" && scripts/beadskit/bdw merge-slot check --json 2>/dev/null | jq -r 'if .available then "" else .holder end') || slot=""
  [ -z "$slot" ] || die "$(basename "$r"): Merge-Slot gehalten von $slot (oder --force)"
}

# metadata.json für die gemeinsame Datenbank auf dem PC
to_pc_meta() { jq --arg h "$PC_NAME" '.dolt_mode = "server" | .dolt_server_host = $h | .dolt_server_user = "beads" | del(.dolt_server_port)' "$1"; }

to_pc() {
  local r=$1 name meta db src there
  name=$(basename "$r")
  meta=$r/.beads/metadata.json
  db=$(jq -r '.dolt_database // empty' "$meta")
  [ -n "$db" ] || die "$name: dolt_database fehlt in $meta"
  head1 "$name (Datenbank $db) → $PC_NAME"
  if [ "$(jq -r '.dolt_server_host // ""' "$meta")" = "$PC_NAME" ]; then ok "schon auf $PC_NAME"; return; fi
  src=""
  for d in "$r/.beads/dolt/$db" "$r/.beads/embeddeddolt/$db"; do [ -d "$d/.dolt" ] && src=$d && break; done
  [ -n "$src" ] || die "$name: Datenbank $db nicht gefunden (.beads/dolt/$db bzw. .beads/embeddeddolt/$db)"
  there=$pc_root${r#"$mac_root"}
  ssh "$PC_NAME" "test -d '$there/.git'" || die "$name: auf $PC_NAME fehlt $there (setup-linux.sh clone)"
  ssh "$PC_NAME" "test ! -e ~/beads-dolt/$db" || die "$name: ~/beads-dolt/$db gibt es auf $PC_NAME schon (anderes Projekt mit derselben Datenbank?)"
  check_idle "$r"
  # Server dieses Projekts anhalten, damit die Dateien in sich stimmig kopiert werden
  (cd "$r" && run bd dolt stop >/dev/null 2>&1) || true
  run rsync -a "$src/" "$PC_NAME:beads-dolt/$db/"
  on_pc "systemctl --user restart beads-dolt"
  # PC: .beads/ mit Verweis auf die gemeinsame Datenbank
  on_pc "mkdir -p -m 700 '$there/.beads'"
  if [ "$dry" = 0 ]; then
    to_pc_meta "$meta" | ssh "$PC_NAME" "cat > '$there/.beads/metadata.json'"
    [ ! -f "$r/.beads/config.yaml" ] || ssh "$PC_NAME" "cat > '$there/.beads/config.yaml'" <"$r/.beads/config.yaml"
    echo "$DOLT_PORT" | ssh "$PC_NAME" "cat > '$there/.beads/dolt-server.port'"
  else
    printf '    (metadata.json, config.yaml, dolt-server.port nach %s:%s/.beads)\n' "$PC_NAME" "$there"
  fi
  # Mac: gleiche Verweise, alte Datenbank zur Seite
  if [ "$dry" = 0 ]; then
    to_pc_meta "$meta" >"$meta.tmp" && mv "$meta.tmp" "$meta"
    echo "$DOLT_PORT" >"$r/.beads/dolt-server.port"
    rm -f "$r/.beads"/dolt-server.{pid,lock,log} "$r/.beads/dolt-server-config.yaml"
    mv "$(dirname "$src")" "$r/.beads/$(basename "$(dirname "$src")").vor-pc"
  else
    printf '    (metadata.json → %s, %s → %s.vor-pc)\n' "$PC_NAME" "$(dirname "$src")" "$(dirname "$src")"
  fi
  [ "$dry" = 1 ] && return
  sleep 2
  local here_n there_n
  here_n=$(cd "$r" && bd count 2>/dev/null | tr -dc 0-9) || here_n=""
  there_n=$(ssh "$PC_NAME" ". ~/.config/beadskit/env; cd '$there' && bd count" 2>/dev/null | tr -dc 0-9) || there_n=""
  if [ -n "$here_n" ] && [ "$here_n" = "$there_n" ]; then ok "$here_n Issues, auf beiden Rechnern gleich"
  else warn "Mac ${here_n:-keine Antwort}, $PC_NAME ${there_n:-keine Antwort}: bd dolt test auf beiden prüfen"; fi
  # beim Leitstand auf dem PC anmelden (workers trägt das Projekt in projects.txt ein)
  ssh "$PC_NAME" "'$pc_root/ProjectTemplate/scripts/beadskit/on-host' '$there' scripts/beadskit/workers config" >/dev/null 2>&1 ||
    warn "$name: workers config auf $PC_NAME fehlgeschlagen (beadskit dort aktuell? ./beadskit-sync.sh --apply)"
}

back_to_mac() {
  local r=$1 name meta db there stamp
  name=$(basename "$r")
  meta=$r/.beads/metadata.json
  db=$(jq -r '.dolt_database // empty' "$meta")
  head1 "$name (Datenbank $db) → Mac"
  [ "$(jq -r '.dolt_server_host // ""' "$meta")" = "$PC_NAME" ] || { ok "liegt schon auf dem Mac"; return; }
  check_idle "$r"
  stamp=$(date +%Y%m%d-%H%M)
  [ ! -e "$r/.beads/dolt" ] || run mv "$r/.beads/dolt" "$r/.beads/dolt.alt-$stamp"
  run mkdir -p "$r/.beads/dolt"
  # kurz anhalten (alle Projekte auf dem PC), damit die Kopie in sich stimmig ist
  on_pc "systemctl --user stop beads-dolt"
  run rsync -a "$PC_NAME:beads-dolt/$db/" "$r/.beads/dolt/$db/"
  on_pc "mv ~/beads-dolt/$db ~/beads-dolt/$db.zurueck-$stamp && systemctl --user start beads-dolt"
  if [ "$dry" = 0 ]; then
    jq 'del(.dolt_server_host, .dolt_server_user, .dolt_server_port) | .dolt_mode = "server"' "$meta" >"$meta.tmp" && mv "$meta.tmp" "$meta"
    rm -f "$r/.beads/dolt-server.port"
  fi
  ok "wieder auf dem Mac (bd startet den Server selbst); auf $PC_NAME findet bd die Datenbank nicht mehr"
}

# Der Leitstand hier fragt beads alle paar Sekunden und würde den Dolt-Server des Projekts
# mitten im Kopieren wieder starten
if [ "$force" = 0 ] && [ "$dry" = 0 ] && pgrep -f 'leitstand/inbox\.mjs' >/dev/null; then
  die "Leitstand läuft auf dem Mac: erst anhalten (scripts/beadskit/leitstand/leitstand-remote uninstall bzw. Ctrl+C), oder --force"
fi
for r in "${roots[@]}"; do
  [ -f "$r/.beads/metadata.json" ] || { warn "$(basename "$r"): keine .beads/metadata.json, übersprungen"; continue; }
  if [ "$back" = 1 ]; then back_to_mac "$r"; else to_pc "$r"; fi
done
[ "$dry" = 0 ] || echo; [ "$dry" = 0 ] || echo "  (--dry-run: nichts geändert)"
