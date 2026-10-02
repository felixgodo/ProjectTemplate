# shellcheck shell=bash
# devkit: Transport zum Server – eine SSH-Verbindung für alles, Upload mit Prüfsumme, und das
# generische Deploy für Projekte nach dem Template.

DK_SSH_HOST=""
DK_SSH_CTL=""
DK_SSH_OPTS=()
DK_SCP_OPTS=()
DK_SUDO=""

# Argumente so zitieren, dass sie die Remote-Shell unverändert erreichen
dk_q() { printf '%q ' "$@"; }

# Ein Schlüssel mit Passphrase scheitert im BatchMode, obwohl ssh von Hand klappt – dort fragt
# ssh nach, hier darf es nicht. Deshalb den Schlüssel einmal in den Agent laden.
dk_ssh_prime() {
  local host="$1" rc=0 key
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" true 2>/dev/null && return 0
  [ -t 0 ] && command -v ssh-add >/dev/null 2>&1 || return 0
  ssh-add -l >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ] || return 0      # 1 = Agent läuft, ist aber leer; 2 = kein Agent
  while read -r key; do
    key="${key/#\~/$HOME}"
    [ -f "$key" ] || continue
    info "Schlüssel $key in den SSH-Agent laden"
    ssh-add "$key" </dev/tty && break
  done < <(ssh -G "$host" 2>/dev/null | awk '$1 == "identityfile" { print $2 }')
}

# dk_remote_open <host> [port] – öffnet die Verbindung (ControlMaster) und klärt, ob sudo nötig ist
dk_remote_open() {
  local uid
  need ssh scp
  DK_SSH_HOST="$1"
  # Kurzer Pfad unter /tmp: macOS-$TMPDIR ist für SSH-Control-Sockets zu lang (max. 104 Zeichen)
  DK_SSH_CTL="$(mktemp -d /tmp/dk-ssh.XXXXXX)"
  DK_SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$DK_SSH_CTL/%C" -o ControlPersist=120 -o ConnectTimeout=10)
  DK_SCP_OPTS=(-o "ControlPath=$DK_SSH_CTL/%C")
  # Port nur mitgeben, wenn gesetzt – sonst gilt ~/.ssh/config (Host-Alias, Port, Schlüssel)
  if [ -n "${2:-}" ]; then
    DK_SSH_OPTS+=(-p "$2")
    DK_SCP_OPTS+=(-P "$2")
  fi
  dk_ssh_prime "$DK_SSH_HOST"
  uid="$(dk_remote 'id -u')" || die "SSH-Verbindung zu '$DK_SSH_HOST' fehlgeschlagen. Prüfen:  ssh $DK_SSH_HOST true"
  DK_SUDO=""
  [ "$uid" = 0 ] || DK_SUDO="sudo "
}

dk_remote_close() {
  [ -n "$DK_SSH_CTL" ] || return 0
  ssh "${DK_SSH_OPTS[@]}" -O exit "$DK_SSH_HOST" 2>/dev/null || true
  rm -rf "$DK_SSH_CTL"
  DK_SSH_CTL=""
}

dk_remote()     { ssh "${DK_SSH_OPTS[@]}" "$DK_SSH_HOST" "$@"; }
# Mit Pseudo-Terminal, damit Fortschrittsausgabe und sudo-Rückfrage live ankommen
dk_remote_tty() {
  if [ -t 0 ] && [ -t 1 ]; then ssh -t "${DK_SSH_OPTS[@]}" "$DK_SSH_HOST" "$@"
  else ssh "${DK_SSH_OPTS[@]}" "$DK_SSH_HOST" "$@"; fi
}

# dk_remote_upload <datei> <verzeichnis auf dem server> – lädt hoch und vergleicht die Prüfsumme
dk_remote_upload() {
  local file="$1" dir="$2" local_sum remote_sum
  local_sum="$(dk_sha256 "$file")"
  scp -q "${DK_SCP_OPTS[@]}" "$file" "$DK_SSH_HOST:$dir/"
  remote_sum="$(dk_remote "sha256sum $(dk_q "$dir/$(basename "$file")")" | cut -d' ' -f1)"
  [ "$remote_sum" = "$local_sum" ] || die "Prüfsumme stimmt nicht ($remote_sum) – Upload abgebrochen?"
}

# ---------------------------------------------------------------- generisches Deploy
#
# Für Projekte nach dem Template (DK_STD_DEPLOY=1). Lädt releases/<slug>-<version>.zip hoch und
# lässt auf dem Server das mitgelieferte setup.sh laufen; die eigentliche Arbeit – Release ablegen,
# aktivieren, Health-Check, Rollback – steckt dort. Ziel aus deploy/deploy.conf (nicht im Repo):
#   HOST=server            SSH-Alias aus ~/.ssh/config oder benutzer@host
#   SSH_PORT=              nur wenn nicht in ~/.ssh/config
#   DOMAIN=app.example.org
#   HESTIA_USER=admin      nur auf HestiaCP-Servern

dk_std_deploy() {
  local conf="$ROOT/deploy/deploy.conf" HOST="" SSH_PORT="" DOMAIN="" HESTIA_USER=""
  local base="/opt/$PROJECT_SLUG" version zip name state tmp rc=0 args mode=update
  [ "${#DK_REST[@]}" -eq 0 ] || die "Unbekanntes Argument für deploy: ${DK_REST[0]}"
  # shellcheck source=/dev/null
  [ ! -f "$conf" ] || . "$conf"
  HOST="${DK_OPT_HOST:-$HOST}"
  DOMAIN="${DK_OPT_DOMAIN:-$DOMAIN}"
  [ -n "$HOST" ] || die "Kein Server angegeben: --host <alias> oder HOST in deploy/deploy.conf
    (Vorlage: cp deploy/deploy.conf.example deploy/deploy.conf)."

  dk_remote_open "$HOST" "$SSH_PORT"
  trap dk_remote_close EXIT
  state="$(dk_remote "if [ -x $base/bin/setup.sh ] && [ -e $base/current ]; then echo installed; else echo fresh; fi")"

  case "$DK_OPT_ACTION" in
    status|rollback)
      [ "$state" = installed ] || die "Auf '$HOST' ist $PROJECT_NAME noch nicht eingerichtet."
      dk_remote_tty "${DK_SUDO}$base/bin/setup.sh $DK_OPT_ACTION"
      return ;;
    logs)
      dk_remote_tty "${DK_SUDO}journalctl -u $PROJECT_SLUG -f -n 100"
      return ;;
  esac

  version="$(dk_release_version)"
  case "$version" in
    *-SNAPSHOT)
      [ "$DK_OPT_FORCE" = 1 ] || die "Die Version ist ein Arbeitsstand ($version).
    Erst freigeben:  ./dev.sh version release      Oder bewusst so deployen:  ./dev.sh deploy --force" ;;
  esac

  [ "$DK_OPT_INSTALL" = 0 ] || mode=install
  case "$state:$mode" in
    installed:update) ok "$HOST ist eingerichtet – Update auf $version" ;;
    fresh:install)    ok "$HOST ist neu – Erstinstallation von $version" ;;
    installed:install) die "Auf '$HOST' ist $PROJECT_NAME bereits eingerichtet. Ohne --install aufrufen." ;;
    *) die "Auf '$HOST' ist $PROJECT_NAME noch nicht eingerichtet.
    Erstinstallation:  ./dev.sh deploy --install --domain <fqdn>" ;;
  esac
  [ "$mode" = update ] || [ -n "$DOMAIN" ] || die "Für die Erstinstallation --domain <fqdn> angeben (oder DOMAIN in deploy/deploy.conf)."

  zip="$(dk_release_zip "$version")"
  if [ ! -f "$zip" ]; then
    [ "$DK_OPT_NO_BUILD" = 0 ] || die "$(basename "$zip") fehlt – ohne --no-build aufrufen oder erst ./dev.sh release."
    if [ "$DK_OPT_DRY_RUN" = 1 ]; then
      info "(dry-run) ./dev.sh release – $(basename "$zip") gibt es noch nicht"
    else
      dk_std_release
    fi
  fi
  name="$(basename "$zip" .zip)"

  args="$mode"
  if [ "$mode" = install ]; then
    args="$args --domain $(dk_q "$DOMAIN")"
    [ -z "$HESTIA_USER" ] || args="$args --hestia-user $(dk_q "$HESTIA_USER")"
  fi

  if [ "$DK_OPT_DRY_RUN" = 1 ]; then
    step "Dry-run – es wird nichts hochgeladen und nichts verändert"
    info "scp ${zip#"$ROOT"/} $HOST:<temporäres Verzeichnis>/   (mit Prüfsummenvergleich)"
    info "ssh $HOST: unzip $name.zip && ${DK_SUDO}$name/setup.sh $args"
    info "danach das temporäre Verzeichnis löschen und den Stand zeigen"
    return 0
  fi
  [ "$DK_OPT_YES" = 1 ] || confirm "$PROJECT_NAME $version jetzt auf $HOST einspielen ($mode)?" \
    || { info "Abgebrochen – es wurde nichts verändert."; return 0; }

  step "Hochladen nach $HOST"
  tmp="$(dk_remote "mktemp -d /tmp/$PROJECT_SLUG-deploy-XXXXXX")"
  dk_remote_upload "$zip" "$tmp"
  dk_remote "command -v unzip >/dev/null || { ${DK_SUDO}apt-get update -qq && ${DK_SUDO}apt-get install -y -qq unzip >/dev/null; }"
  dk_remote "cd $(dk_q "$tmp") && unzip -q $(dk_q "$name.zip")"
  ok "hochgeladen, Prüfsumme stimmt"

  step "Einspielen ($mode)"
  dk_remote_tty "cd $(dk_q "$tmp/$name") && ${DK_SUDO}./setup.sh $args" || rc=$?
  dk_remote "rm -rf $(dk_q "$tmp")" || warn "Aufräumen in $HOST:$tmp fehlgeschlagen."

  case "$rc" in
    0) ok "Deploy abgeschlossen: $PROJECT_NAME $version auf $HOST" ;;
    2) warn "Erstinstallation vorbereitet – die Env-Datei auf dem Server braucht noch Werte (siehe oben)."
       warn "Danach erneut:  ./dev.sh deploy --install"
       return 2 ;;
    *) die "Deploy fehlgeschlagen (Exit $rc). Log:  ./dev.sh deploy --logs    Zurück:  ./dev.sh deploy --rollback" ;;
  esac
}
