# shellcheck shell=bash
# devkit: die Standardbefehle von dev.sh. Was ein Projekt anders braucht, liefert es als Hook
# in dev.project.sh (project_build, project_test, project_release …).

# ---------------------------------------------------------------- gemeinsame Schritte

dk_preflight() {
  # shellcheck disable=SC2086
  [ -z "$DK_NEEDS" ] || need $DK_NEEDS
  dk_use_java
  dk_hook project_preflight
}

# dk_infra_up <dienste…> – der Hook erfährt, welche Dienste gleich starten
dk_infra_up() {
  if dk_has project_infra_up; then project_infra_up "$@"
  elif [ "$DK_COMPOSE" = 1 ]; then dk_compose_up
  fi
}

dk_infra_down() {
  if dk_has project_infra_down; then project_infra_down
  elif [ "$DK_COMPOSE" = 1 ]; then dk_compose_stop
  fi
}

# Bauen ohne Tests – Hook project_build, sonst ein Maven-Lauf über die Wurzel-POM
dk_run_build() {
  if dk_has project_build; then project_build "$@"; return; fi
  local a args="-DskipTests"
  for a in "$@"; do
    case "$a" in
      --tests) args="" ;;
      *) die "Unbekannte Option für build: $a" ;;
    esac
  done
  need mvn
  # shellcheck disable=SC2086
  ( cd "$ROOT" && mvn -B -q $args package ) || die "Maven-Build fehlgeschlagen."
}

dk_run_tests() {
  if dk_has project_test; then project_test "$@"; return; fi
  local d
  [ $# -eq 0 ] || die "test nimmt in diesem Projekt kein Ziel."
  need mvn
  step "Backend-Tests (mvn test)"
  ( cd "$ROOT" && mvn -B -q test ) || die "Backend-Tests fehlgeschlagen."
  for d in $DK_NPM_DIRS; do
    dk_npm_deps "$d"
    step "$d: Typecheck und Lint"
    ( cd "$ROOT/$d" && npm run -s typecheck --if-present && npm run -s lint --if-present ) \
      || die "$d: Typecheck oder Lint fehlgeschlagen."
  done
  ok "Tests grün."
}

# Dienste, die ein `start` in einem anderen Terminal gerade hält (Namen, durch Leerzeichen getrennt)
dk_running_services() {
  local file="$DEV_DIR/pids" name pg started now out=""
  [ -f "$file" ] || return 0
  while read -r name pg started; do
    [ -n "$pg" ] || continue
    now="$(ps -o lstart= -p "$pg" 2>/dev/null | tr -s ' ' '_')"
    if [ -n "$now" ] && [ "$now" = "$started" ]; then out="$out $name"; fi
  done <"$file"
  printf '%s' "${out# }"
}

# ---------------------------------------------------------------- start / stop / status / logs

dk_cmd_start() {
  local do_build=1 names="" a n
  for a in "$@"; do
    case "$a" in
      --no-build) do_build=0 ;;
      -*) die "Unbekannte Option für start: $a   (erlaubt: --no-build)" ;;
      *)  dk_svc "$a" || die "Unbekannter Dienst '$a'   (möglich: $(dk_all_services | tr '\n' ' '))"
          names="$names $a" ;;
    esac
  done
  [ -n "$names" ] || names="$(dk_default_services | tr '\n' ' ')"
  names="$(printf '%s' "$names" | xargs)"
  [ -n "$names" ] || die "Keine Dienste angemeldet (dk_service in dev.project.sh)."

  mkdir -p "$LOG_DIR"
  dk_preflight
  for n in $names; do
    dk_svc "$n"
    [ -z "$SVC_PORT" ] || require_free_port "$SVC_PORT" "$n"
  done
  # shellcheck disable=SC2086
  dk_infra_up $names
  if [ "$do_build" = 1 ]; then
    dk_npm_deps_all
    # shellcheck disable=SC2086
    dk_hook project_prepare $names
  fi

  step "Starte $names – Ctrl+C beendet alles"
  # shellcheck disable=SC2086
  dk_run_foreground $names
}

dk_cmd_stop() {
  local i=0 port holder
  dk_stop_leftovers
  dk_stop_legacy
  while [ "$i" -lt "${#DK_SVC_NAMES[@]}" ]; do
    port="${DK_SVC_PORTS[i]}"
    if [ -n "$port" ]; then
      holder="$(port_pid "$port")"
      # Nur melden statt blind beenden – es könnte ein fremder Dienst sein.
      [ -z "$holder" ] || warn "Auf Port $port (${DK_SVC_NAMES[i]}) lauscht noch PID $holder ($(pid_name "$holder")). Falls das ein Rest ist:  kill $holder"
    fi
    i=$((i + 1))
  done
  dk_infra_down
}

dk_cmd_status() {
  local i=0 rc=0 name port pid version
  head1 "$PROJECT_NAME – lokale Entwicklung"
  while [ "$i" -lt "${#DK_SVC_NAMES[@]}" ]; do
    name="${DK_SVC_NAMES[i]}"; port="${DK_SVC_PORTS[i]}"
    pid=""
    [ -z "$port" ] || pid="$(port_pid "$port")"
    if [ -n "$pid" ]; then
      if [ -z "${DK_SVC_HEALTH[i]}" ] || http_ok "${DK_SVC_HEALTH[i]}"; then
        printf '  %-12s %släuft%s      PID %-7s %s\n' "$name" "$C_GREEN" "$C_RESET" "$pid" "${DK_SVC_URLS[i]}"
      else
        printf '  %-12s %sfährt hoch%s PID %-7s %s antwortet noch nicht\n' "$name" "$C_YELLOW" "$C_RESET" "$pid" "${DK_SVC_HEALTH[i]}"
        rc=1
      fi
    else
      printf '  %-12s %sgestoppt%s%s\n' "$name" "$C_DIM" "$C_RESET" "${port:+   Port $port}"
      [ "${DK_SVC_DEFAULT[i]}" != 1 ] || rc=1
    fi
    i=$((i + 1))
  done

  if dk_has project_infra_status; then project_infra_status || rc=1
  elif [ "$DK_COMPOSE" = 1 ]; then dk_compose_status || rc=1
  fi

  version="$(dk_current_version)"
  echo
  [ -z "$version" ] || printf '  %-12s %s\n' "Version" "$version"
  dk_hook project_status_extra
  echo
  return "$rc"
}

dk_cmd_logs() {
  local name="" lines=100 follow=1 log
  while [ $# -gt 0 ]; do
    case "$1" in
      --lines|-n)  shift; [ $# -gt 0 ] || die "--lines erwartet eine Zahl"; lines="$1" ;;
      --no-follow) follow=0 ;;
      -*)          die "Unbekannte Option für logs: $1" ;;
      *)           name="$1" ;;
    esac
    shift
  done
  [ -n "$name" ] || name="${DK_SVC_NAMES[0]:-}"
  [ -n "$name" ] || die "Kein Dienst angegeben."

  if ! dk_svc "$name"; then
    # Kein Dienst von dev.sh – dann ist es ein Teil der Infrastruktur.
    if dk_has project_logs; then project_logs "$name" "$lines" "$follow"; return; fi
    [ "$DK_COMPOSE" = 1 ] || die "Unbekannter Dienst '$name'   (möglich: $(dk_all_services | tr '\n' ' '))"
    if [ "$follow" = 1 ]; then ( cd "$ROOT" && exec docker compose logs -f --tail "$lines" "$name" )
    else ( cd "$ROOT" && docker compose logs --tail "$lines" "$name" ); fi
    return
  fi
  log="$LOG_DIR/$name.log"
  [ -f "$log" ] || die "Kein Log für $name – noch nie gestartet? (./dev.sh start $name)"
  if [ "$follow" = 1 ]; then exec tail -n "$lines" -f "$log"; fi
  tail -n "$lines" "$log"
}

# ---------------------------------------------------------------- build / test / clean / doctor

dk_cmd_build() { dk_preflight; dk_run_build "$@"; ok "Gebaut."; }
dk_cmd_test()  { dk_preflight; dk_run_tests "$@"; }

dk_cmd_clean() {
  local running d
  running="$(dk_running_services)"
  [ -z "$running" ] || die "Läuft noch: $running – erst beenden (Ctrl+C im Start-Terminal oder ./dev.sh stop)."
  step "Aufräumen"
  if dk_has project_clean; then
    project_clean
  else
    if [ -f "$ROOT/pom.xml" ] && command -v mvn >/dev/null 2>&1; then ( cd "$ROOT" && mvn -B -q clean ) || true; fi
    for d in $DK_NPM_DIRS; do rm -rf "${ROOT:?}/$d/dist"; done
  fi
  # Nur Logs und PIDs: unter .dev/ können Projekte eigene Laufzeitdaten ablegen.
  rm -rf "$LOG_DIR" "$DEV_DIR/pids"
  ok "Build-Ergebnisse und .dev/logs entfernt."
}

dk_cmd_doctor() {
  local rc=0 c i=0 port holder v src seen=" "
  head1 "Werkzeuge"
  # shellcheck disable=SC2086
  for c in $DK_NEEDS $([ "$DK_COMPOSE" = 1 ] && echo docker) git curl lsof zip; do
    case "$seen" in *" $c "*) continue ;; esac
    seen="$seen$c "
    if command -v "$c" >/dev/null 2>&1; then ok "$c"; else warn "$c fehlt"; rc=1; fi
  done
  if [ -n "$JAVA_VERSION" ]; then
    ( dk_use_java ) >/dev/null 2>&1 && { dk_use_java; ok "Java $(java_major) (gebraucht: $JAVA_VERSION)"; } \
      || { warn "Java $JAVA_VERSION oder neuer fehlt"; rc=1; }
  fi
  if [ "$DK_COMPOSE" = 1 ]; then
    if command -v docker >/dev/null 2>&1 && dk_docker_running; then ok "Docker läuft"; else warn "Docker läuft nicht"; rc=1; fi
  fi

  head1 "Ports"
  while [ "$i" -lt "${#DK_SVC_NAMES[@]}" ]; do
    port="${DK_SVC_PORTS[i]}"
    if [ -n "$port" ]; then
      holder="$(port_pid "$port")"
      if [ -z "$holder" ]; then ok "${DK_SVC_NAMES[i]}: $port frei"
      else info "${DK_SVC_NAMES[i]}: $port belegt von PID $holder ($(pid_name "$holder"))"; fi
    fi
    i=$((i + 1))
  done

  head1 "Version"
  v="$(dk_current_version)"
  if [ -z "$v" ]; then warn "keine Version eingerichtet"
  elif dk_versions_equal; then ok "$v an allen Stellen"
  else warn "Versionen laufen auseinander (./dev.sh version)"; rc=1; fi

  head1 "devkit"
  src="${DEVKIT_SOURCE:-$ROOT/../ProjectTemplate}"
  if [ ! -f "$src/scripts/devkit/devkit.sh" ]; then info "devkit $DK_VERSION (Quelle $src nicht gefunden)"
  elif dk_devkit_same "$src"; then ok "devkit $DK_VERSION – Stand der Quelle"
  else warn "devkit $DK_VERSION weicht von der Quelle ab (./dev.sh self-update)"; fi

  if dk_has project_doctor; then project_doctor || rc=1; fi
  echo
  return "$rc"
}

# ---------------------------------------------------------------- release / deploy

DK_OPT_SKIP_TESTS=0; DK_OPT_NO_BUILD=0; DK_OPT_FORCE=0
DK_OPT_HOST=""; DK_OPT_DOMAIN=""; DK_OPT_DRY_RUN=0; DK_OPT_YES=0; DK_OPT_INSTALL=0; DK_OPT_ACTION=""
DK_REST=()

# dk_opt_unsupported <option…> – für Hooks: bricht ab, wenn eine der einheitlichen Optionen
# gesetzt ist, die das Projekt nicht umsetzen kann. Stillschweigend ignorieren wäre schlimmer.
dk_opt_unsupported() {
  local o set
  for o in "$@"; do
    set=0
    case "$o" in
      --skip-tests) [ "$DK_OPT_SKIP_TESTS" = 0 ] || set=1 ;;
      --no-build)   [ "$DK_OPT_NO_BUILD" = 0 ] || set=1 ;;
      --force)      [ "$DK_OPT_FORCE" = 0 ] || set=1 ;;
      --host)       [ -z "$DK_OPT_HOST" ] || set=1 ;;
      --domain)     [ -z "$DK_OPT_DOMAIN" ] || set=1 ;;
      --dry-run)    [ "$DK_OPT_DRY_RUN" = 0 ] || set=1 ;;
      --yes)        [ "$DK_OPT_YES" = 0 ] || set=1 ;;
      --install)    [ "$DK_OPT_INSTALL" = 0 ] || set=1 ;;
      --status|--rollback|--logs) [ "$DK_OPT_ACTION" != "${o#--}" ] || set=1 ;;
    esac
    [ "$set" = 0 ] || die "$o gibt es in $PROJECT_NAME nicht."
  done
}

dk_cmd_release() {
  DK_OPT_SKIP_TESTS=0; DK_OPT_NO_BUILD=0; DK_OPT_FORCE=0; DK_REST=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip-tests) DK_OPT_SKIP_TESTS=1 ;;
      --no-build)   DK_OPT_NO_BUILD=1 ;;
      --force)      DK_OPT_FORCE=1 ;;
      *)            DK_REST[${#DK_REST[@]}]="$1" ;;
    esac
    shift
  done
  if dk_has project_release; then project_release ${DK_REST[@]+"${DK_REST[@]}"}
  elif [ "$DK_STD_RELEASE" = 1 ]; then
    [ "${#DK_REST[@]}" -eq 0 ] || die "Unbekanntes Argument für release: ${DK_REST[0]}"
    dk_std_release
  else die "release ist für $PROJECT_NAME nicht eingerichtet (project_release in dev.project.sh)."
  fi
}

dk_cmd_deploy() {
  DK_OPT_HOST=""; DK_OPT_DOMAIN=""; DK_OPT_DRY_RUN=0; DK_OPT_YES=0; DK_OPT_INSTALL=0; DK_OPT_ACTION=""
  DK_OPT_SKIP_TESTS=0; DK_OPT_NO_BUILD=0; DK_OPT_FORCE=0; DK_REST=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --host)     shift; [ $# -gt 0 ] || die "--host erwartet einen Wert"; DK_OPT_HOST="$1" ;;
      --host=*)   DK_OPT_HOST="${1#*=}" ;;
      --domain)   shift; [ $# -gt 0 ] || die "--domain erwartet einen Wert"; DK_OPT_DOMAIN="$1" ;;
      --domain=*) DK_OPT_DOMAIN="${1#*=}" ;;
      --dry-run)  DK_OPT_DRY_RUN=1 ;;
      --yes|-y)   DK_OPT_YES=1 ;;
      --no-build) DK_OPT_NO_BUILD=1 ;;
      --skip-tests) DK_OPT_SKIP_TESTS=1 ;;
      --install)  DK_OPT_INSTALL=1 ;;
      --force)    DK_OPT_FORCE=1 ;;
      --status|--rollback|--logs) DK_OPT_ACTION="${1#--}" ;;
      *)          DK_REST[${#DK_REST[@]}]="$1" ;;
    esac
    shift
  done
  if dk_has project_deploy; then project_deploy ${DK_REST[@]+"${DK_REST[@]}"}
  elif [ "$DK_STD_DEPLOY" = 1 ]; then dk_std_deploy
  else die "deploy ist für $PROJECT_NAME nicht eingerichtet (project_deploy in dev.project.sh)."
  fi
}

# ---------------------------------------------------------------- backup

# ./dev.sh backup [run|list|status] [--host H] [--target T] [--tag T]
# Spricht den backup-agent auf dem Server an (eingerichtet von LicenseHub). Das Ziel heisst wie das
# Projekt, sonst BACKUP_TARGET in dev.project.sh; der Server kommt aus --host, deploy/deploy.conf
# oder BACKUP_HOST.
dk_cmd_backup() {
  local action=run host="" target="${BACKUP_TARGET:-$PROJECT_SLUG}" tag=manual
  local conf="$ROOT/deploy/deploy.conf" HOST="" SSH_PORT=""
  DK_REST=()
  while [ $# -gt 0 ]; do
    case "$1" in
      run|list|status) action="$1" ;;
      --host)   shift; [ $# -gt 0 ] || die "--host erwartet einen Wert"; host="$1" ;;
      --target) shift; [ $# -gt 0 ] || die "--target erwartet einen Wert"; target="$1" ;;
      --tag)    shift; [ $# -gt 0 ] || die "--tag erwartet einen Wert"; tag="$1" ;;
      *)        DK_REST[${#DK_REST[@]}]="$1" ;;
    esac
    shift
  done
  if dk_has project_backup; then project_backup "$action" ${DK_REST[@]+"${DK_REST[@]}"}; return; fi
  [ "${#DK_REST[@]}" -eq 0 ] || die "Unbekanntes Argument für backup: ${DK_REST[0]}"
  # shellcheck source=/dev/null
  [ ! -f "$conf" ] || . "$conf"
  host="${host:-${HOST:-${BACKUP_HOST:-}}}"
  [ -n "$host" ] || die "Kein Server: --host <alias>, HOST in deploy/deploy.conf oder BACKUP_HOST in dev.project.sh."

  dk_remote_open "$host" "$SSH_PORT"
  trap dk_remote_close EXIT
  dk_remote 'command -v backup-agent >/dev/null' \
    || die "Auf '$host' ist kein backup-agent eingerichtet (LicenseHub: /opt/licensehub/backup-agent/install.sh)."
  case "$action" in
    run)    dk_remote_tty "${DK_SUDO}backup-agent run $(printf %q "$target") --tag $(printf %q "$tag")" ;;
    list)   dk_remote_tty "${DK_SUDO}backup-agent snapshots $(printf %q "$target")" ;;
    status) dk_remote_tty "${DK_SUDO}backup-agent status" ;;
  esac
}

# ---------------------------------------------------------------- self-update

# Stimmt dieses Projekt mit der Quelle überein?
dk_devkit_same() {
  diff -rq "$1/scripts/devkit" "$ROOT/scripts/devkit" >/dev/null 2>&1 && cmp -s "$1/dev.sh" "$ROOT/dev.sh"
}

# dk_devkit_install <quelle> <ziel> – kopiert scripts/devkit/ und dev.sh. dev.sh wird über eine
# neue Datei getauscht (mv), weil die Bash das laufende Skript stückweise liest.
dk_devkit_install() {
  local src="$1" dst="$2"
  need rsync
  # Niemals ein fremdes dev.sh überschreiben: ein Projekt, das noch sein eigenes Skript hat, wird
  # von Hand umgestellt (dev.project.sh schreiben), nicht vom Sync.
  if [ -f "$dst/dev.sh" ] && ! grep -q 'scripts/devkit/devkit.sh' "$dst/dev.sh"; then
    die "$dst/dev.sh ist kein devkit-Skript – nicht überschrieben. Erst das Projekt umstellen."
  fi
  mkdir -p "$dst/scripts/devkit"
  rsync -a --delete "$src/scripts/devkit/" "$dst/scripts/devkit/"
  cp "$src/dev.sh" "$dst/dev.sh.new"
  chmod +x "$dst/dev.sh.new"
  mv -f "$dst/dev.sh.new" "$dst/dev.sh"
}

dk_cmd_self_update() {
  local src="${DEVKIT_SOURCE:-$ROOT/../ProjectTemplate}" check=0 theirs
  case "${1:-}" in
    --check) check=1 ;;
    '') ;;
    *) die "Unbekannte Option für self-update: $1   (erlaubt: --check)" ;;
  esac
  [ -f "$src/scripts/devkit/devkit.sh" ] || die "Quelle nicht gefunden: $src
    Anderer Ort:  DEVKIT_SOURCE=/pfad/zum/ProjectTemplate ./dev.sh self-update"
  src="$(cd "$src" && pwd -P)"
  if [ "$src" = "$ROOT" ]; then ok "Dies ist die Quelle des devkit ($DK_VERSION)."; return 0; fi
  theirs="$(tr -d '[:space:]' <"$src/scripts/devkit/VERSION")"
  if dk_devkit_same "$src"; then ok "devkit $DK_VERSION ist auf dem Stand der Quelle."; return 0; fi
  if [ "$check" = 1 ]; then
    warn "devkit weicht ab: hier $DK_VERSION, Quelle $theirs ($src)"
    diff -rq "$src/scripts/devkit" "$ROOT/scripts/devkit" 2>&1 | sed 's/^/    /' || true
    cmp -s "$src/dev.sh" "$ROOT/dev.sh" || info "dev.sh unterscheidet sich"
    return 1
  fi
  dk_devkit_install "$src" "$ROOT"
  ok "devkit $DK_VERSION → $theirs übernommen (scripts/devkit/, dev.sh). Prüfen mit:  git diff --stat"
}
