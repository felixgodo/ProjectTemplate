# shellcheck shell=bash
# devkit: Java wählen, npm-Abhängigkeiten, lokale Maven-Artefakte, Docker Compose.

# ---------------------------------------------------------------- Java und Maven

java_major() { java -version 2>&1 | head -n1 | sed -E 's/.*"([0-9]+).*/\1/' || true; }

# JAVA_HOME auf JAVA_VERSION setzen, falls mehrere JDKs installiert sind (macOS: java_home,
# Linux: /usr/lib/jvm/java-<version>-*), und prüfen, dass das aktive Java nicht älter ist.
dk_use_java() {
  [ -n "$JAVA_VERSION" ] || return 0
  local jh="" v d
  if [ -x /usr/libexec/java_home ]; then
    jh="$(/usr/libexec/java_home -v "$JAVA_VERSION" 2>/dev/null || true)"
  else
    for d in /usr/lib/jvm/java-"$JAVA_VERSION"-* /usr/lib/jvm/jdk-"$JAVA_VERSION"*; do
      if [ -x "$d/bin/java" ]; then jh="$d"; break; fi
    done
  fi
  if [ -n "$jh" ]; then export JAVA_HOME="$jh"; PATH="$jh/bin:$PATH"; export PATH; fi
  command -v java >/dev/null 2>&1 || die "Java nicht gefunden – das Projekt braucht JDK $JAVA_VERSION."
  v="$(java_major)"
  case "$v" in
    ''|*[!0-9]*) warn "Java-Version nicht erkannt – erwartet wird $JAVA_VERSION oder neuer." ;;
    *) [ "$v" -ge "$JAVA_VERSION" ] || die "Java $v gefunden, das Projekt braucht $JAVA_VERSION oder neuer." ;;
  esac
}

# dk_require_maven_artifact <groupId> <artifactId> <version> <hinweis>
#   Für Bibliotheken aus Nachbarprojekten, die nur im lokalen Maven-Repository liegen: fehlen sie,
#   scheitert Maven mit einer Meldung, der man nicht ansieht, was zu tun ist.
dk_require_maven_artifact() {
  local repo="${MAVEN_REPO:-$HOME/.m2/repository}" dir
  dir="$repo/$(printf '%s' "$1" | tr . /)/$2/$3"
  [ -d "$dir" ] || die "$2 $3 fehlt im lokalen Maven-Repository ($repo).
    $4"
}

# dk_npm_deps <verzeichnis> – npm install, wenn node_modules fehlt oder älter ist als das Lockfile
dk_npm_deps() {
  local dir="$ROOT/$1"
  [ -f "$dir/package.json" ] || die "$1/package.json fehlt."
  if [ ! -d "$dir/node_modules" ] \
     || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
    need npm
    step "$1: Abhängigkeiten installieren (npm install)"
    ( cd "$dir" && npm install --no-audit --no-fund ) || die "npm install in $1 fehlgeschlagen."
  fi
}

dk_npm_deps_all() {
  local d
  for d in $DK_NPM_DIRS; do dk_npm_deps "$d"; done
}

# ---------------------------------------------------------------- Docker Compose

dk_docker_running() { docker info >/dev/null 2>&1; }

dk_require_docker() {
  need docker
  dk_docker_running && return 0
  if [ "$(uname)" = Darwin ]; then die "Docker läuft nicht. Docker Desktop starten und erneut versuchen."; fi
  if docker info 2>&1 | grep -qi 'permission denied'; then
    die "Kein Zugriff auf Docker: Benutzer in die Gruppe docker (sudo usermod -aG docker \$USER), dann neu anmelden."
  fi
  die "Docker läuft nicht: sudo systemctl start docker"
}

# Startet die Compose-Dienste und wartet, bis sie bereit sind: mit Hook project_infra_ready, bis
# dieser gelingt; sonst auf die Healthchecks aus docker-compose.yml (--wait).
dk_compose_up() {
  dk_require_docker
  step "Infrastruktur starten (docker compose)"
  if dk_has project_infra_ready; then
    # shellcheck disable=SC2086
    ( cd "$ROOT" && docker compose up -d $DK_COMPOSE_SERVICES )
    wait_for "$DK_INFRA_TIMEOUT" "warte auf die Infrastruktur" project_infra_ready || {
      ( cd "$ROOT" && docker compose logs --tail 20 ) 2>&1 | sed 's/^/    /'
      die "Infrastruktur antwortet nach ${DK_INFRA_TIMEOUT}s nicht."
    }
  else
    # shellcheck disable=SC2086
    ( cd "$ROOT" && docker compose up -d --wait --wait-timeout "$DK_INFRA_TIMEOUT" $DK_COMPOSE_SERVICES ) \
      || die "Infrastruktur ist nicht hochgekommen (docker compose logs)."
  fi
  ok "Infrastruktur bereit."
}

dk_compose_stop() {
  command -v docker >/dev/null 2>&1 && dk_docker_running || { info "Docker läuft nicht."; return 0; }
  ( cd "$ROOT" && docker compose stop )
  ok "Container angehalten (Daten bleiben in den Volumes)."
}

dk_compose_status() {
  if ! command -v docker >/dev/null 2>&1 || ! dk_docker_running; then
    printf '  %-12s %sDocker läuft nicht%s\n' "Container" "$C_RED" "$C_RESET"
    return 1
  fi
  local lines
  lines="$( cd "$ROOT" && docker compose ps --format '{{.Service}}|{{.State}}|{{.Ports}}' 2>/dev/null || true )"
  if [ -z "$lines" ]; then
    printf '  %-12s %sgestoppt%s\n' "Container" "$C_DIM" "$C_RESET"
    return 1
  fi
  printf '%s\n' "$lines" | while IFS='|' read -r svc state ports; do
    if [ "$state" = running ]; then
      printf '  %-12s %släuft%s      %s\n' "$svc" "$C_GREEN" "$C_RESET" "$(printf '%s' "$ports" | cut -c1-60)"
    else
      printf '  %-12s %s%s%s\n' "$svc" "$C_YELLOW" "$state" "$C_RESET"
    fi
  done
}
