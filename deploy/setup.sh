#!/usr/bin/env bash
# Läuft auf dem Server (als root). Liegt im Release-Paket und nach der Installation unter
# /opt/projecttemplate/bin/setup.sh, erreichbar als Befehl `projecttemplate`.
#
#   setup.sh install --domain app.example.org [--hestia-user admin]   Erstinstallation aus diesem Paket
#   setup.sh update                    neue Version aus diesem Paket einspielen
#   setup.sh rollback                  vorheriges Release aktivieren
#   setup.sh status                    Version, Dienst, Health
#   setup.sh logs                      Log des Dienstes mitlesen
#   setup.sh restart                   Dienst neu starten
#
# Aufbau auf dem Server:
#   /opt/projecttemplate/releases/<version>/   Jar und public_html je Release
#   /opt/projecttemplate/current               Symlink auf das aktive Release
#   /etc/projecttemplate/projecttemplate.env   Konfiguration und Zugangsdaten (0600)
#   projecttemplate.service                    systemd-Dienst, lauscht nur auf 127.0.0.1
#
# Mit HestiaCP wird die Oberfläche ins public_html der Domain gelegt und ein Nginx-Template
# aktiviert; ohne HestiaCP eine eigene nginx-Site angelegt (nur HTTP – TLS z. B. mit certbot).
# Schlägt der Health-Check nach dem Neustart fehl, wird auf das vorherige Release zurückgestellt.
#
# Exit-Codes: 0 ok, 1 Fehler, 2 Env-Datei muss noch ausgefüllt werden.
set -euo pipefail

APP=projecttemplate
BASE=/opt/$APP
BIN=$BASE/bin
RELEASES=$BASE/releases
CURRENT=$BASE/current
CONF_DIR=/etc/$APP
ENV_FILE=$CONF_DIR/$APP.env
INSTALL_CONF=$CONF_DIR/install.conf
SERVICE=$APP
FIRST_PORT=8100
KEEP_RELEASES=5
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
HESTIA=/usr/local/hestia
HBIN=$HESTIA/bin

step() { echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "!   $*" >&2; }
die()  { echo "✗   $*" >&2; exit 1; }

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------- Helfer

env_get() { grep -E "^$1=" "${2:-$ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true; }

env_set() {
  local key="$1" value="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    # per awk statt sed, damit Sonderzeichen im Wert egal sind
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" >"$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" >"$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    echo "$key=$value" >>"$ENV_FILE"
  fi
}

random_password() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-20; }

next_free_port() {
  local port=$FIRST_PORT
  while [ -n "$(ss -ltnH "sport = :$port" 2>/dev/null)" ]; do port=$((port + 1)); done
  echo "$port"
}

load_port() {
  APP_PORT="$(env_get SERVER_PORT)"
  APP_PORT="${APP_PORT:-$FIRST_PORT}"
  HEALTH_URL="http://127.0.0.1:$APP_PORT/api/version"
}

load_install_conf() {
  DOMAIN=""; HESTIA_USER=""
  # shellcheck disable=SC1090
  [ ! -f "$INSTALL_CONF" ] || . "$INSTALL_CONF"
}

bundle_version() { sed -n 's/^version=//p' "$1/VERSION" 2>/dev/null | head -1; }
current_version() { [ -L "$CURRENT" ] && basename "$(readlink "$CURRENT")" || true; }
previous_version() { cat "$BASE/previous" 2>/dev/null || true; }

# Wartet, bis das Backend antwortet – und zwar mit genau der erwarteten Version
health_ok() {
  local want="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) body
  while [ $SECONDS -lt $deadline ]; do
    body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
    if [[ "$body" == *"\"version\":\"$want\""* ]]; then return 0; fi
    if systemctl is-failed --quiet "$SERVICE"; then return 1; fi
    sleep 2
  done
  return 1
}

switch_to() {
  ln -sfn "$RELEASES/$1" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
}

# Mit HestiaCP liegt die Oberfläche im public_html der Domain; ohne zeigt nginx direkt auf current/.
sync_frontend() {
  [ -n "$HESTIA_USER" ] || return 0
  local web_root="/home/$HESTIA_USER/web/$DOMAIN/public_html"
  step "Oberfläche $1 → $web_root"
  mkdir -p "$web_root/assets"
  # Erst die neuen Assets dazulegen, dann index.html tauschen – so zeigt index.html nie ins Leere.
  # Alte Assets bleiben 14 Tage liegen, für noch offene Browser-Tabs.
  if [ -d "$RELEASES/$1/public_html/assets" ]; then
    rsync -a --no-times "$RELEASES/$1/public_html/assets/" "$web_root/assets/"
  fi
  rsync -a -c --delete --exclude '/.well-known' --exclude '/assets/' "$RELEASES/$1/public_html/" "$web_root/"
  find "$web_root/assets" -type f -mtime +14 -delete
  chown -R "$HESTIA_USER:$HESTIA_USER" "$web_root"
}

# Startet die angegebene Version und prüft sie. Bei Fehler: zurück auf $2 (falls vorhanden).
start_version() {
  local version="$1" fallback="${2:-}"
  switch_to "$version"
  step "Starte $SERVICE $version"
  systemctl restart "$SERVICE"
  if health_ok "$version"; then
    info "Health-Check ok ($HEALTH_URL)"
    return 0
  fi
  warn "Health-Check für $version fehlgeschlagen. Letzte Log-Zeilen:"
  journalctl -u "$SERVICE" -n 50 --no-pager >&2 || true
  if [ -n "$fallback" ] && [ -d "$RELEASES/$fallback" ]; then
    warn "Stelle zurück auf $fallback"
    switch_to "$fallback"
    systemctl restart "$SERVICE"
    if health_ok "$fallback"; then warn "$fallback läuft wieder."
    else warn "Auch $fallback startet nicht – bitte prüfen: journalctl -u $SERVICE -e"; fi
  fi
  exit 1
}

# Legt das Release aus dem Paket ab und aktiviert es
place_and_activate() {
  local bundle="$1" version="$2" prev fallback="" old keep_prev
  prev="$(current_version)"
  step "Lege Release $version ab"
  rm -rf "$RELEASES/$version.new"
  mkdir -p "$RELEASES/$version.new"
  cp "$bundle/VERSION" "$bundle/$APP.jar" "$RELEASES/$version.new/"
  cp -R "$bundle/public_html" "$RELEASES/$version.new/public_html"
  chmod -R a+rX "$RELEASES/$version.new"
  rm -rf "${RELEASES:?}/${version:?}"
  mv "$RELEASES/$version.new" "$RELEASES/$version"

  # Erst das Backend starten, die Oberfläche nur bei erfolgreichem Health-Check umschalten
  [ "$prev" = "$version" ] || fallback="$prev"
  start_version "$version" "$fallback"
  sync_frontend "$version"
  if [ -n "$prev" ] && [ "$prev" != "$version" ]; then echo "$prev" >"$BASE/previous"; fi

  # Alte Releases aufräumen (aktives und vorheriges bleiben immer)
  keep_prev="$(previous_version)"
  # shellcheck disable=SC2012
  ls -1t "$RELEASES" | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
    if [ "$old" = "$version" ] || [ "$old" = "$keep_prev" ]; then continue; fi
    info "Entferne altes Release $old"
    rm -rf "${RELEASES:?}/$old"
  done
}

print_status() {
  echo "Aktiv:      $(current_version)"
  echo "Vorherige:  $(previous_version)"
  # shellcheck disable=SC2012
  echo "Releases:   $(ls -1t "$RELEASES" 2>/dev/null | tr '\n' ' ')"
  echo "Backend:    $(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || echo 'keine Antwort') (Port $APP_PORT)"
  [ -z "$DOMAIN" ] || echo "Domain:     $DOMAIN${HESTIA_USER:+ (HestiaCP-Benutzer $HESTIA_USER)}"
  echo
  systemctl --no-pager status "$SERVICE" 2>/dev/null | head -12 || true
}

require_installed() {
  [ -f "$ENV_FILE" ] && [ -f "/etc/systemd/system/$SERVICE.service" ] \
    || die "$APP ist auf diesem Server noch nicht eingerichtet – erst: setup.sh install --domain <fqdn>"
}

require_bundle() {
  BUNDLE="$(cd "$(dirname "$0")" && pwd)"
  [ -f "$BUNDLE/VERSION" ] && [ -f "$BUNDLE/$APP.jar" ] && [ -d "$BUNDLE/public_html" ] \
    || die "Kein Release-Paket in $BUNDLE (VERSION, $APP.jar, public_html/ erwartet)."
  VERSION="$(bundle_version "$BUNDLE")"
  [[ "$VERSION" =~ ^[0-9A-Za-z.+-]+$ ]] || die "Ungültige Version '$VERSION' im Paket."
}

# ---------------------------------------------------------------- Installation

install_packages() {
  local missing=() java_major
  command -v rsync >/dev/null || missing+=(rsync)
  command -v curl >/dev/null || missing+=(curl)
  command -v openssl >/dev/null || missing+=(openssl)
  java_major="$(java -version 2>&1 | awk -F'"' '/version/ { split($2, v, "."); print v[1]; exit }' || true)"
  if [ -z "$java_major" ] || [ "$java_major" -lt 17 ]; then missing+=(openjdk-17-jre-headless); fi
  [ ${#missing[@]} -gt 0 ] || return 0
  command -v apt-get >/dev/null || die "Bitte von Hand installieren: ${missing[*]}"
  step "Installiere Pakete: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
}

create_env_file() {
  [ ! -f "$ENV_FILE" ] || return 0
  step "Erzeuge $ENV_FILE"
  mkdir -p "$CONF_DIR"
  install -m 600 -o root -g root "$BUNDLE/conf/$APP.env.example" "$ENV_FILE"
  env_set SERVER_PORT "$(next_free_port)"
  env_set APP_BASE_URL "https://$DOMAIN"
}

# Datenbank anlegen, falls das Passwort noch nicht eingetragen ist
create_database() {
  [ "$(env_get DB_PASSWORD)" = CHANGE_ME ] || return 0
  local pw db
  pw="$(random_password)"
  if [ -n "$HESTIA_USER" ]; then
    # Hestia stellt "<benutzer>_" voran
    db="${HESTIA_USER}_$APP"
    if "$HBIN/v-list-database" "$HESTIA_USER" "$db" >/dev/null 2>&1; then
      warn "Datenbank $db existiert schon, Passwort unbekannt → DB_PASSWORD in $ENV_FILE eintragen."
      return 0
    fi
    step "Lege Datenbank $db an (HestiaCP)"
    "$HBIN/v-add-database" "$HESTIA_USER" "$APP" "$APP" "$pw" mysql localhost utf8mb4 \
      || { warn "Datenbank konnte nicht angelegt werden."; return 0; }
  else
    db="$APP"
    local client=""
    command -v mariadb >/dev/null && client=mariadb
    [ -n "$client" ] || { command -v mysql >/dev/null && client=mysql; }
    if [ -z "$client" ] || ! "$client" -e 'SELECT 1' >/dev/null 2>&1; then
      warn "Kein lokaler MariaDB/MySQL-Zugang als root → Datenbank von Hand anlegen und DB_* in $ENV_FILE eintragen."
      return 0
    fi
    step "Lege Datenbank $db an"
    "$client" -e "CREATE DATABASE IF NOT EXISTS \`$db\` CHARACTER SET utf8mb4;
      CREATE USER IF NOT EXISTS '$db'@'localhost' IDENTIFIED BY '$pw';
      ALTER USER '$db'@'localhost' IDENTIFIED BY '$pw';
      GRANT ALL PRIVILEGES ON \`$db\`.* TO '$db'@'localhost';
      FLUSH PRIVILEGES;"
  fi
  env_set DB_URL "jdbc:mariadb://localhost:3306/$db?allowPublicKeyRetrieval=true"
  env_set DB_USER "$db"
  env_set DB_PASSWORD "$pw"
}

hestia_conf() { grep -oP "^$1='\K[^']*" "$HESTIA/conf/hestia.conf" 2>/dev/null || true; }
web_domain_field() {
  grep "^DOMAIN='$DOMAIN'" "$HESTIA/data/users/$HESTIA_USER/web.conf" 2>/dev/null | grep -oP "\b$1='\K[^']*" || true
}

setup_nginx_hestia() {
  local tpl_dir tpl_field tpl_cmd tpl_filter ext new changed=false
  if [ "$(hestia_conf PROXY_SYSTEM)" = nginx ]; then
    tpl_dir="$HESTIA/data/templates/web/nginx"; tpl_field=PROXY; tpl_cmd=v-change-web-domain-proxy-tpl
    tpl_filter='cat'
  elif [ "$(hestia_conf WEB_SYSTEM)" = nginx ]; then
    # Nginx ohne Apache: Web-Template statt Proxy-Template, Port-Variablen umbenennen
    tpl_dir="$HESTIA/data/templates/web/nginx/php-fpm"; tpl_field=TPL; tpl_cmd=v-change-web-domain-tpl
    tpl_filter="sed -e s/%proxy_ssl_port%/%web_ssl_port%/g -e s/%proxy_port%/%web_port%/g"
  else
    die "Kein Nginx in HestiaCP gefunden."
  fi
  for ext in tpl stpl; do
    new="$(mktemp)"
    $tpl_filter "$BUNDLE/conf/hestia/$APP.$ext" | sed "s/@APP_PORT@/$APP_PORT/g" >"$new"
    if ! cmp -s "$new" "$tpl_dir/$APP.$ext"; then
      install -m 644 "$new" "$tpl_dir/$APP.$ext"
      changed=true
    fi
    rm -f "$new"
  done
  if $changed || [ "$(web_domain_field "$tpl_field")" != "$APP" ]; then
    step "Aktiviere Nginx-Template '$APP' für $DOMAIN"
    "$HBIN/$tpl_cmd" "$HESTIA_USER" "$DOMAIN" "$APP"
  fi
}

setup_nginx_plain() {
  local target new
  command -v nginx >/dev/null || { warn "nginx ist nicht installiert → Site von Hand einrichten (conf/nginx-$APP.conf)."; return 0; }
  if [ -d /etc/nginx/sites-available ]; then target="/etc/nginx/sites-available/$APP"
  else target="/etc/nginx/conf.d/$APP.conf"; fi
  new="$(mktemp)"
  sed -e "s/@APP_PORT@/$APP_PORT/g" -e "s/@DOMAIN@/$DOMAIN/g" "$BUNDLE/conf/nginx-$APP.conf" >"$new"
  if ! cmp -s "$new" "$target"; then
    step "Richte nginx-Site für $DOMAIN ein ($target)"
    install -m 644 "$new" "$target"
    [ ! -d /etc/nginx/sites-enabled ] || ln -sfn "$target" "/etc/nginx/sites-enabled/$APP"
    nginx -t && systemctl reload nginx
  fi
  rm -f "$new"
}

cmd_install() {
  DOMAIN=""; HESTIA_USER=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain)      DOMAIN="${2:?--domain braucht einen Wert}"; shift 2 ;;
      --hestia-user) HESTIA_USER="${2:?--hestia-user braucht einen Wert}"; shift 2 ;;
      --yes)         shift ;;
      *) die "Unbekannte Option für install: $1" ;;
    esac
  done
  require_bundle
  [ -n "$DOMAIN" ] || die "--domain <fqdn> angeben."
  if [ -x "$HBIN/v-list-web-domain" ]; then
    HESTIA_USER="${HESTIA_USER:-admin}"
    "$HBIN/v-list-user" "$HESTIA_USER" >/dev/null 2>&1 || die "Hestia-Benutzer '$HESTIA_USER' existiert nicht."
    "$HBIN/v-list-web-domain" "$HESTIA_USER" "$DOMAIN" >/dev/null 2>&1 \
      || die "Web-Domain $DOMAIN existiert nicht. In HestiaCP anlegen (mit Let's Encrypt SSL) und erneut ausführen."
  else
    [ -z "$HESTIA_USER" ] || die "--hestia-user angegeben, aber HestiaCP ist hier nicht installiert."
  fi
  step "Installiere $APP $VERSION für $DOMAIN${HESTIA_USER:+ (HestiaCP-Benutzer $HESTIA_USER)}"

  install_packages
  if ! id "$APP" >/dev/null 2>&1; then
    step "Lege Systemuser $APP an"
    useradd -r -s /usr/sbin/nologin -d "$BASE" "$APP"
  fi
  mkdir -p "$BASE/data" "$RELEASES" "$BIN" "$CONF_DIR"
  chown "$APP:$APP" "$BASE/data"
  install -m 750 "$BUNDLE/setup.sh" "$BIN/setup.sh"
  ln -sfn "$BIN/setup.sh" "/usr/local/bin/$APP"
  printf 'DOMAIN=%q\nHESTIA_USER=%q\n' "$DOMAIN" "$HESTIA_USER" >"$INSTALL_CONF"

  create_env_file
  create_database
  local open_keys k
  open_keys="$(grep -E '=CHANGE_ME' "$ENV_FILE" | cut -d= -f1 || true)"
  if [ -n "$open_keys" ]; then
    warn "In $ENV_FILE fehlen noch Werte:"
    for k in $open_keys; do warn "  - $k"; done
    warn "Ausfüllen und die Installation erneut starten."
    exit 2
  fi
  load_port

  if [ -n "$HESTIA_USER" ]; then setup_nginx_hestia; else setup_nginx_plain; fi

  if ! cmp -s "$BUNDLE/conf/$APP.service" "/etc/systemd/system/$SERVICE.service"; then
    step "Installiere systemd-Unit $SERVICE.service"
    install -m 644 "$BUNDLE/conf/$APP.service" "/etc/systemd/system/$SERVICE.service"
    systemctl daemon-reload
  fi
  systemctl is-enabled --quiet "$SERVICE" 2>/dev/null || systemctl enable --quiet "$SERVICE"

  place_and_activate "$BUNDLE" "$VERSION"
  echo "✓   $APP $VERSION läuft für $DOMAIN (Port $APP_PORT). Verwaltung: $APP status | logs | restart | rollback"
}

cmd_update() {
  [ $# -eq 0 ] || die "update nimmt keine Optionen."
  require_bundle
  require_installed
  load_install_conf
  load_port
  step "Aktualisiere $APP $(current_version) → $VERSION"
  # Skript und Vorlagen mitziehen, Konfiguration und Daten bleiben unangetastet
  install -m 750 "$BUNDLE/setup.sh" "$BIN/setup.sh"
  if [ -n "$HESTIA_USER" ]; then setup_nginx_hestia; fi
  if ! cmp -s "$BUNDLE/conf/$APP.service" "/etc/systemd/system/$SERVICE.service"; then
    install -m 644 "$BUNDLE/conf/$APP.service" "/etc/systemd/system/$SERVICE.service"
    systemctl daemon-reload
  fi
  place_and_activate "$BUNDLE" "$VERSION"
  echo "✓   $APP $VERSION läuft."
}

cmd_rollback() {
  require_installed
  load_install_conf
  load_port
  local cur prev
  cur="$(current_version)"
  prev="$(previous_version)"
  [ -n "$prev" ] && [ -d "$RELEASES/$prev" ] || die "Kein vorheriges Release vorhanden."
  [ "$prev" != "$cur" ] || die "$prev ist bereits aktiv."
  step "Rollback $cur → $prev"
  start_version "$prev" "$cur"
  sync_frontend "$prev"
  [ -z "$cur" ] || echo "$cur" >"$BASE/previous"
  echo "✓   Rollback auf $prev abgeschlossen."
}

# ---------------------------------------------------------------- Einstieg

cmd="${1:-}"
[ $# -eq 0 ] || shift
case "$cmd" in
  help|-h|--help|'') usage; exit 0 ;;
esac
[ "$(id -u)" -eq 0 ] || die "setup.sh muss als root laufen."
case "$cmd" in
  install)  cmd_install "$@" ;;
  update)   cmd_update "$@" ;;
  rollback) cmd_rollback ;;
  status)   require_installed; load_install_conf; load_port; print_status ;;
  logs)     exec journalctl -u "$SERVICE" -f -n 100 ;;
  restart)  require_installed; systemctl restart "$SERVICE"; echo "✓   $SERVICE neu gestartet." ;;
  *) usage >&2; die "Unbekannter Befehl: $cmd" ;;
esac
