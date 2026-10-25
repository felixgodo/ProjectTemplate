#!/usr/bin/env bash
# Richtet einen Ubuntu-Rechner (Server 24.04) als Leitrechner für devkit und beadskit ein:
# Werkzeuge (Docker, Node, Java, Maven, gh, claude, bd, dolt, tmux), Tailscale, kein Ruhezustand,
# Dienste ohne Anmeldung, ssh nur mit Schlüssel, Firewall, die gemeinsame beads-Datenbank
# (dolt sql-server als systemd-User-Dienst beads-dolt) und alle Projekte aus devkit-projects.txt.
#
#   git clone https://github.com/felixgodo/ProjectTemplate ~/IdeaProjects/ProjectTemplate
#   ~/IdeaProjects/ProjectTemplate/scripts/remote/setup-linux.sh [schritt…]
#
# Ohne Angabe alle Schritte der Reihe nach; einzelne mit Namen (z. B. `setup-linux.sh dolt clone`).
# Jeder Schritt prüft erst, ob er schon erledigt ist; ein zweiter Lauf ändert nichts mehr.
# Braucht sudo. Interaktiv sind nur die Anmeldungen (tailscale up, gh auth login): sie zeigen einen
# Link bzw. Code, den man im Browser auf dem Mac bestätigt. Danach auf dem Mac:
# scripts/remote/setup-mac.sh (siehe scripts/remote/README.md).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TEMPLATE=$(cd "$HERE/../.." && pwd)
PROJECTS=$(dirname "$TEMPLATE")
CONF=${BEADSKIT_HOME:-$HOME/.config/beadskit}
BIN=$HOME/.local/bin
# shellcheck source=versions.conf
. "$HERE/versions.conf"
STEPS="apt docker node gh tailscale claude beads nosleep ssh firewall env dolt clone"

c_ok=$'\033[32m' c_warn=$'\033[33m' c_head=$'\033[1m' c_off=$'\033[0m'
head1() { printf '\n%s== %s%s\n' "$c_head" "$*" "$c_off"; }
ok() { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die() { printf '  %s✗ %s%s\n' "$c_warn" "$*" "$c_off" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
LATER=()
later() { LATER+=("$*"); }

[ "$(id -u)" != 0 ] || die "nicht als root starten, sondern als der Benutzer, unter dem die Worker laufen (sudo fragt selbst)"
[ -r /etc/os-release ] && . /etc/os-release
[ "${ID:-}" = ubuntu ] || warn "gedacht für Ubuntu 24.04, gefunden: ${PRETTY_NAME:-unbekannt}"
ARCH=$(dpkg --print-architecture)
export PATH="$BIN:$PATH"
mkdir -p "$BIN" "$CONF"

apt_install() { sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null; }

step_apt() {
  head1 "Pakete"
  sudo apt-get update -qq
  apt_install git curl jq tmux rsync perl zip unzip lsof openssh-server ufw ca-certificates gnupg \
    build-essential openjdk-17-jdk-headless maven
  ok "git jq tmux rsync lsof zip ufw build-essential openjdk-17 maven"
}

step_docker() {
  head1 "Docker"
  if ! have docker; then
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME:-noble} stable" |
      sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -qq
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  sudo systemctl enable --now docker >/dev/null 2>&1
  if ! id -nG | tr ' ' '\n' | grep -qx docker; then
    sudo usermod -aG docker "$USER"
    later "Docker ohne sudo: einmal ab- und wieder anmelden (Gruppe docker)"
  fi
  ok "$(docker --version 2>/dev/null || echo docker)"
}

step_node() {
  head1 "Node $NODE_MAJOR"
  if [ "$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')" != "$NODE_MAJOR" ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
    apt_install nodejs
  fi
  ok "node $(node -v)"
}

step_gh() {
  head1 "GitHub CLI"
  if ! have gh; then
    sudo mkdir -p -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg |
      sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" |
      sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update -qq
    apt_install gh
  fi
  # Die Projekte sind privat, und die Worker öffnen PRs: einmal anmelden (Code im Mac-Browser bestätigen)
  if ! gh auth status >/dev/null 2>&1; then
    echo "  GitHub-Anmeldung: Code unten auf https://github.com/login/device eingeben"
    gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth setup-git >/dev/null
  ok "gh angemeldet als $(gh api user -q .login 2>/dev/null || echo ?)"
  if [ -z "$(git config --global user.name || true)" ]; then
    git config --global user.name "$(gh api user -q '.name // .login')"
    git config --global user.email "$(gh api user -q '"\(.id)+\(.login)@users.noreply.github.com"')"
    ok "git user: $(git config --global user.name) <$(git config --global user.email)> (ändern: git config --global user.email …)"
  fi
}

step_tailscale() {
  head1 "Tailscale"
  have tailscale || curl -fsSL https://tailscale.com/install.sh | sh
  if ! tailscale status >/dev/null 2>&1; then
    echo "  Anmeldung: den Link unten im Browser öffnen (gleiches Konto wie auf dem Mac)"
    sudo tailscale up --hostname="$PC_NAME"
  fi
  ok "im Tailnet als $(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // "?"' | sed 's/\.$//')"
}

step_claude() {
  head1 "Claude Code"
  have claude || curl -fsSL https://claude.ai/install.sh | bash
  ok "claude $(claude --version 2>/dev/null | head -n 1)"
  later "Claude anmelden: claude (einmal starten, Link im Mac-Browser öffnen, /exit)"
}

# Lädt ein Release-Archiv von GitHub und legt die Datei $3 nach ~/.local/bin
install_release() {
  local repo=$1 tag=$2 bin=$3 pattern=$4 url tmp f
  url=$(curl -fsSL "https://api.github.com/repos/$repo/releases/tags/$tag" |
    jq -r --arg p "$pattern" '.assets[] | select(.name | test($p)) | .browser_download_url' | head -n 1 || true)
  [ -n "$url" ] || die "$repo $tag: kein Archiv für linux/$ARCH gefunden"
  tmp=$(mktemp -d)
  curl -fsSL "$url" | tar -xz -C "$tmp"
  f=$(find "$tmp" -type f -name "$bin" | head -n 1)
  [ -n "$f" ] || die "$repo $tag: $bin nicht im Archiv"
  install -m 755 "$f" "$BIN/$bin"
  rm -rf "$tmp"
}

step_beads() {
  head1 "bd $BD_VERSION und dolt $DOLT_VERSION (gleich wie auf dem Mac)"
  bd version 2>/dev/null | grep -q "$BD_VERSION" ||
    install_release gastownhall/beads "v$BD_VERSION" bd "^beads_${BD_VERSION}_linux_${ARCH}\\.tar\\.gz$"
  dolt version 2>/dev/null | head -n 1 | grep -q "$DOLT_VERSION" ||
    install_release dolthub/dolt "v$DOLT_VERSION" dolt "^dolt-linux-${ARCH}\\.tar\\.gz$"
  ok "$(bd version | head -n 1)"
  ok "$(dolt version | head -n 1)"
}

step_nosleep() {
  head1 "Dauerbetrieb"
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1
  ok "Ruhezustand aus (systemctl unmask … hebt das auf)"
  # User-Dienste (Leitstand, beads-dolt, Worker in tmux) laufen ohne Anmeldung und nach dem Abmelden weiter
  sudo loginctl enable-linger "$USER"
  ok "Dienste ohne Anmeldung (linger)"
}

step_ssh() {
  head1 "ssh"
  sudo systemctl enable --now ssh >/dev/null 2>&1
  if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "$USER@$PC_NAME" -f "$HOME/.ssh/id_ed25519"
    ok "Schlüssel ~/.ssh/id_ed25519 angelegt (für ssh zum Mac und zum Server)"
  fi
  # Passwort-Login erst abschalten, wenn ein Schlüssel hinterlegt ist, sonst sperrt man sich aus
  if [ -s "$HOME/.ssh/authorized_keys" ]; then
    printf '%s\n' '# scripts/remote/setup-linux.sh: nur Schlüssel' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' |
      sudo tee /etc/ssh/sshd_config.d/10-beadskit.conf >/dev/null
    sudo systemctl reload ssh
    ok "Anmeldung nur mit Schlüssel"
  else
    warn "noch kein Schlüssel in ~/.ssh/authorized_keys: Passwort-Login bleibt an (vom Mac: ssh-copy-id $USER@<ip>, dann erneut: setup-linux.sh ssh)"
  fi
}

step_firewall() {
  head1 "Firewall"
  # Tailnet ganz, ssh zusätzlich aus dem Heimnetz (Einrichtung, Notfall); alles andere zu
  sudo ufw allow in on tailscale0 >/dev/null
  for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do sudo ufw allow from "$net" to any port 22 proto tcp >/dev/null; done
  sudo ufw default deny incoming >/dev/null
  sudo ufw default allow outgoing >/dev/null
  sudo ufw --force enable >/dev/null
  ok "ufw: eingehend nur Tailnet und ssh aus dem Heimnetz"
  later "Docker veröffentlicht Ports an ufw vorbei: in docker-compose.yml Ports als 127.0.0.1:<port>:<port> binden"
}

step_env() {
  head1 "Umgebung für ssh-Befehle"
  # on-host (scripts/beadskit) lädt dies: ssh ohne Login-Shell kennt ~/.local/bin nicht
  printf '%s\n' '# scripts/remote/setup-linux.sh: PATH für Befehle per ssh (scripts/beadskit/on-host)' \
    "export PATH=\"\$HOME/.local/bin:\$PATH\"" >"$CONF/env"
  ok "$CONF/env"
  if [ ! -f "$CONF/hosts.conf" ]; then
    # vorläufig, setup-mac.sh schreibt die endgültige Fassung mit dem Mac
    printf '%s\n' "LEADER=$PC_NAME" "HOSTS=\"$PC_NAME\"" "SELF=$PC_NAME" "BK_HOST_BASE=$PC_HOST_BASE" \
      "HOST_${PC_NAME}_ROOT=$PROJECTS" >"$CONF/hosts.conf"
    ok "$CONF/hosts.conf (vorläufig, setup-mac.sh ergänzt den Mac)"
  fi
}

step_dolt() {
  head1 "beads-Datenbank (dolt sql-server, Port $DOLT_PORT)"
  local data=$HOME/beads-dolt unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user pwfile=$CONF/dolt-password pw
  mkdir -p "$data" "$unit_dir"
  dolt config --global --get user.name >/dev/null 2>&1 || dolt config --global --add user.name "beads@$PC_NAME" >/dev/null
  dolt config --global --get user.email >/dev/null 2>&1 || dolt config --global --add user.email "beads@$PC_NAME" >/dev/null
  cat >"$data/config.yaml" <<EOF
# scripts/remote/setup-linux.sh: eine Datenbank je Projekt (Name wie dolt_database in .beads/metadata.json)
log_level: warning
listener:
  host: 0.0.0.0
  port: $DOLT_PORT
data_dir: $data
EOF
  cat >"$unit_dir/beads-dolt.service" <<EOF
[Unit]
Description=beads-Datenbank für Mac und PC (dolt sql-server, scripts/remote/setup-linux.sh)
After=network-online.target

[Service]
WorkingDirectory=$data
ExecStart=$BIN/dolt sql-server --config $data/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now beads-dolt.service >/dev/null 2>&1
  local n=0
  until (exec 3<>"/dev/tcp/127.0.0.1/$DOLT_PORT") 2>/dev/null; do
    n=$((n + 1)); [ "$n" -lt 30 ] || die "beads-dolt antwortet nicht (journalctl --user -u beads-dolt)"; sleep 1
  done
  ok "beads-dolt läuft ($data)"
  # Benutzer beads mit Passwort für beide Rechner; das Passwort steht nur in Dateien (0600)
  if [ ! -s "$pwfile" ]; then
    (umask 077 && openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-32 >"$pwfile")
  fi
  pw=$(cat "$pwfile")
  printf "CREATE USER IF NOT EXISTS 'beads'@'%%' IDENTIFIED BY '%s';\nALTER USER 'beads'@'%%' IDENTIFIED BY '%s';\nGRANT ALL ON *.* TO 'beads'@'%%';\n" "$pw" "$pw" |
    (cd "$data" && dolt --host 127.0.0.1 --port "$DOLT_PORT" --no-tls -u root -p '' sql >/dev/null)
  mkdir -p "$HOME/.config/beads"
  (umask 077 && printf '[%s:%s]\npassword = %s\n' "$PC_NAME" "$DOLT_PORT" "$pw" >"$HOME/.config/beads/credentials")
  ok "Benutzer beads, Zugang in ~/.config/beads/credentials ([$PC_NAME:$DOLT_PORT])"
  # Auch hier über den Namen, nicht 127.0.0.1: bd startet sonst bei Ausfall selbst eine leere Datenbank
  getent hosts "$PC_NAME" >/dev/null || warn "$PC_NAME ist hier nicht auflösbar (/etc/hosts bzw. Tailscale MagicDNS)"
  # tägliche Sicherung aller Issues als JSONL (bd export), 14 Tage
  cat >"$unit_dir/beads-backup.service" <<EOF
[Unit]
Description=beads: Issues aller Projekte als JSONL sichern (scripts/remote/setup-linux.sh)

[Service]
Type=oneshot
ExecStart=$HERE/beads-backup.sh
EOF
  cat >"$unit_dir/beads-backup.timer" <<'EOF'
[Unit]
Description=beads: tägliche Sicherung

[Timer]
OnCalendar=*-*-* 03:30
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now beads-backup.timer >/dev/null 2>&1
  ok "Sicherung täglich 03:30 nach ~/beads-backup (beads-backup.timer)"
}

step_clone() {
  head1 "Projekte nach $PROJECTS"
  local dir repo
  while read -r dir repo; do
    case $dir in ''|'#'*) continue ;; esac
    if [ -d "$PROJECTS/$dir/.git" ]; then ok "$dir (schon da)"; continue; fi
    if [ "$repo" = - ]; then warn "$dir: kein GitHub-Repo, kommt per rsync von setup-mac.sh"; continue; fi
    gh repo clone "$repo" "$PROJECTS/$dir" -- -q && ok "$dir ← $repo" || warn "$dir: Klonen von $repo fehlgeschlagen"
  done <"$HERE/repos.txt"
}

steps=${*:-$STEPS}
for s in $steps; do
  case " $STEPS " in *" $s "*) "step_$s" ;; *) die "unbekannter Schritt: $s ($STEPS)" ;; esac
done

head1 "Fertig"
for l in "${LATER[@]}"; do warn "$l"; done
echo "  Weiter auf dem Mac: scripts/remote/setup-mac.sh (scripts/remote/README.md)"
