#!/usr/bin/env bash
# Verbindet den Mac mit dem Linux-Rechner (nach setup-linux.sh dort): ssh-Zugang in beide
# Richtungen, hosts.conf auf beiden Rechnern (PC = Leitrechner), Zugang zur beads-Datenbank auf
# dem PC, Projekte ohne GitHub per rsync, Login-Daten des Leitstands, Befehl `pc`.
#
#   scripts/remote/setup-mac.sh [--mac-name <tailnet-name>]   alles einrichten (idempotent)
#   scripts/remote/setup-mac.sh --repos                       nur scripts/remote/repos.txt neu schreiben
#
# Die beads-Datenbanken zieht erst scripts/remote/migrate-beads.sh um, den Leitstand erst
# `pc leitstand install` (beides steht am Ende in der Ausgabe). Siehe scripts/remote/README.md.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TEMPLATE=$(cd "$HERE/../.." && pwd)
PROJECTS=$(dirname "$TEMPLATE")
CONF=${BEADSKIT_HOME:-$HOME/.config/beadskit}
# shellcheck source=versions.conf
. "$HERE/versions.conf"

c_ok=$'\033[32m' c_warn=$'\033[33m' c_head=$'\033[1m' c_off=$'\033[0m'
head1() { printf '\n%s== %s%s\n' "$c_head" "$*" "$c_off"; }
ok() { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die() { printf '  %s✗ %s%s\n' "$c_warn" "$*" "$c_off" >&2; exit 1; }

write_repos() {
  [ -f "$TEMPLATE/devkit-projects.txt" ] || die "devkit-projects.txt fehlt (Vorlage: devkit-projects.txt.example)"
  {
    echo "# Projekte für setup-linux.sh: <ordner> <github-repo> (owner/name), - ohne GitHub (setup-mac.sh kopiert per rsync)."
    echo "# Erzeugt aus devkit-projects.txt mit: scripts/remote/setup-mac.sh --repos"
    grep -v '^#' "$TEMPLATE/devkit-projects.txt" | while read -r p; do
      [ -n "$p" ] || continue
      url=$(git -C "$TEMPLATE/$p" remote get-url origin 2>/dev/null || true)
      repo=$(printf '%s' "$url" | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')
      { [ -n "$url" ] && [ "$repo" != "$url" ]; } || repo=-
      echo "$(basename "$p") $repo"
    done
  } >"$HERE/repos.txt"
  ok "scripts/remote/repos.txt (lokal, setup-mac.sh kopiert es auf den PC)"
}

mac_name=""
while [ $# -gt 0 ]; do
  case $1 in
    --repos) write_repos; exit 0 ;;
    --mac-name) mac_name=$2; shift ;;
    *) sed -n '6,7s/^# \{0,1\}//p' "$0" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname)" = Darwin ] || die "läuft auf dem Mac; auf dem Linux-Rechner: setup-linux.sh"
mkdir -p "$CONF" "$HOME/.ssh" "$HOME/.local/bin"

head1 "Tailscale"
ts=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
[ -x "$ts" ] || die "Tailscale fehlt: brew install --cask tailscale, starten, mit demselben Konto anmelden"
if [ -z "$mac_name" ]; then
  mac_name=$("$ts" status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | cut -d. -f1)
fi
[ -n "$mac_name" ] || die "Name des Macs im Tailnet unbekannt (Tailscale angemeldet?), sonst --mac-name <name>"
ok "Mac im Tailnet: $mac_name"

head1 "ssh Mac → $PC_NAME"
if ! grep -qE "^Host[[:space:]]+$PC_NAME([[:space:]]|$)" "$HOME/.ssh/config" 2>/dev/null; then
  pc_user=${PC_USER:-}
  [ -n "$pc_user" ] || read -r -p "  Benutzer auf $PC_NAME (bei der Ubuntu-Installation angelegt): " pc_user
  printf '\n# scripts/remote/setup-mac.sh: Linux-Rechner im Tailnet\nHost %s\n  HostName %s\n  User %s\n' \
    "$PC_NAME" "$PC_NAME" "$pc_user" >>"$HOME/.ssh/config"
  ok "~/.ssh/config: Host $PC_NAME"
fi
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$PC_NAME" true 2>/dev/null; then
  die "ssh $PC_NAME ohne Passwort geht nicht. Einmal: ssh-copy-id $PC_NAME, dann auf $PC_NAME: setup-linux.sh ssh"
fi
pc_root=$(ssh "$PC_NAME" 'test -d "$HOME/IdeaProjects/ProjectTemplate" && printf %s "$HOME/IdeaProjects"' || true)
[ -n "$pc_root" ] || die "auf $PC_NAME fehlt ~/IdeaProjects/ProjectTemplate (erst setup-linux.sh dort)"
ok "ssh $PC_NAME, Projekte in $pc_root"

head1 "ssh $PC_NAME → Mac (für den Leitstand auf dem PC)"
if ! nc -z -G 3 127.0.0.1 22 >/dev/null 2>&1; then
  die "Entfernte Anmeldung ist aus: Systemeinstellungen → Allgemein → Teilen → Entfernte Anmeldung einschalten"
fi
pub=$(ssh "$PC_NAME" 'cat ~/.ssh/id_ed25519.pub')
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
grep -qxF "$pub" "$HOME/.ssh/authorized_keys" || { printf '%s\n' "$pub" >>"$HOME/.ssh/authorized_keys"; ok "Schlüssel von $PC_NAME in ~/.ssh/authorized_keys"; }
mac_ssh="$(id -un)@$mac_name"
ssh "$PC_NAME" "ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new $mac_ssh true" ||
  die "$PC_NAME erreicht den Mac nicht per ssh ($mac_ssh)"
ok "$PC_NAME → $mac_ssh"

head1 "hosts.conf (Leitrechner $PC_NAME)"
hosts() {
  printf '%s\n' "# scripts/remote/setup-mac.sh: zwei Rechner, $PC_NAME leitet (beads-Datenbank, Leitstand)" \
    "LEADER=$PC_NAME" "HOSTS=\"mac $PC_NAME\"" "SELF=$1" "BK_HOST_BASE=$2" \
    "HOST_mac_SSH=$mac_ssh" "HOST_mac_ROOT=$PROJECTS" "HOST_mac_ROLES=\"$MAC_ROLES\"" \
    "HOST_${PC_NAME}_SSH=$PC_NAME" "HOST_${PC_NAME}_ROOT=$pc_root"
}
hosts mac "$MAC_HOST_BASE" >"$CONF/hosts.conf"
hosts "$PC_NAME" "$PC_HOST_BASE" | ssh "$PC_NAME" 'mkdir -p ~/.config/beadskit && cat > ~/.config/beadskit/hosts.conf'
ok "$CONF/hosts.conf und $PC_NAME:~/.config/beadskit/hosts.conf"
# PATH für Befehle, die der PC per ssh hier ausführt (on-host)
printf '%s\n' '# scripts/remote/setup-mac.sh: PATH für Befehle per ssh (scripts/beadskit/on-host)' \
  "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH\"" >"$CONF/env"
ok "$CONF/env"

head1 "beads-Datenbank auf $PC_NAME"
pw=$(ssh "$PC_NAME" 'cat ~/.config/beadskit/dolt-password') || die "kein Datenbank-Passwort auf $PC_NAME (setup-linux.sh dolt)"
mkdir -p "$HOME/.config/beads"
cred=$HOME/.config/beads/credentials
touch "$cred"
chmod 600 "$cred"
# eigenen Abschnitt [pc:3307] ersetzen, andere stehen lassen
awk -v s="[$PC_NAME:$DOLT_PORT]" '$0 == s { skip = 1; next } /^\[/ { skip = 0 } !skip' "$cred" >"$cred.tmp"
printf '[%s:%s]\npassword = %s\n' "$PC_NAME" "$DOLT_PORT" "$pw" >>"$cred.tmp"
mv "$cred.tmp" "$cred"
chmod 600 "$cred"
nc -z -G 5 "$PC_NAME" "$DOLT_PORT" >/dev/null 2>&1 && ok "$PC_NAME:$DOLT_PORT erreichbar, Zugang in ~/.config/beads/credentials" ||
  warn "$PC_NAME:$DOLT_PORT nicht erreichbar (auf $PC_NAME: systemctl --user status beads-dolt)"
for v in "bd version" "dolt version"; do
  # || true: head schließt die Pipe vor dem Ende der Ausgabe, mit pipefail bräche das Skript sonst ab
  here=$($v 2>/dev/null | head -n 1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)
  there=$(ssh "$PC_NAME" ". ~/.config/beadskit/env; $v" 2>/dev/null | head -n 1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)
  [ "$here" = "$there" ] && ok "${v% *} $here auf beiden" || warn "${v% *}: Mac $here, $PC_NAME ${there:-fehlt} (versions.conf, setup-linux.sh beads)"
done

head1 "Projektlisten und Klone auf $PC_NAME"
# Beide Listen sind nicht versioniert (Projektnamen bleiben privat): von hier kopieren, dann klonen.
write_repos
scp -q "$TEMPLATE/devkit-projects.txt" "$PC_NAME:$pc_root/ProjectTemplate/devkit-projects.txt"
scp -q "$HERE/repos.txt" "$PC_NAME:$pc_root/ProjectTemplate/scripts/remote/repos.txt"
ok "devkit-projects.txt, repos.txt → $PC_NAME"
ssh "$PC_NAME" "$pc_root/ProjectTemplate/scripts/remote/setup-linux.sh clone" ||
  warn "Klonen auf $PC_NAME fehlgeschlagen (dort: scripts/remote/setup-linux.sh clone)"

head1 "Projekte ohne GitHub (rsync)"
grep -v '^#' "$HERE/repos.txt" | while read -r dir repo; do
  [ "$repo" = - ] && [ -d "$PROJECTS/$dir" ] || continue
  rsync -a --exclude node_modules --exclude target --exclude dist --exclude .dev --exclude .claude/worktrees \
    --exclude .beads "$PROJECTS/$dir/" "$PC_NAME:$pc_root/$dir/"
  ok "$dir"
done

head1 "Leitstand-Login"
for f in leitstand-token leitstand-password leitstand-basicauth; do
  [ -s "$CONF/$f" ] || continue
  ssh "$PC_NAME" "umask 077; cat > ~/.config/beadskit/$f" <"$CONF/$f"
  ok "$f → $PC_NAME"
done
[ -f "$CONF/remote.conf" ] && scp -q "$CONF/remote.conf" "$PC_NAME:.config/beadskit/remote.conf" && ok "remote.conf → $PC_NAME"
if ! ssh "$PC_NAME" 'ssh -o BatchMode=yes -o ConnectTimeout=8 server true' 2>/dev/null; then
  warn "$PC_NAME erreicht den Server (Host server) nicht: für den öffentlichen Leitstand ~/.ssh/config und den"
  warn "  Schlüssel von $PC_NAME dort eintragen (ssh $PC_NAME cat .ssh/id_ed25519.pub)"
fi

head1 "Befehl pc"
ln -sf "$HERE/pc" "$HOME/.local/bin/pc"
ok "~/.local/bin/pc → scripts/remote/pc (pc help)"
ln -sf "$TEMPLATE/scripts/beadskit/leitstand/top.mjs" "$HOME/.local/bin/beads-top"
ok "~/.local/bin/beads-top → Live-Übersicht aller Worker (q beendet)"

head1 "Weiter"
cat <<EOF
  1. Worker auf dem Mac auslaufen lassen (je Projekt: scripts/beadskit/workers drain, warten bis idle)
  2. beads-Datenbanken auf $PC_NAME umziehen:  scripts/remote/migrate-beads.sh --dry-run, dann ohne --dry-run
  3. Leitstand auf $PC_NAME, hier nur der Link:  pc leitstand install
  4. Prüfen:  pc doctor
EOF
