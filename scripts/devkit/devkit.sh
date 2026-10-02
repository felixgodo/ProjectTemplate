# shellcheck shell=bash disable=SC2034
# devkit – gemeinsamer Kern von dev.sh (wird per `source` eingebunden).
#
# In allen Projekten identisch; die Quelle liegt im ProjectTemplate. Nie im Projekt von Hand
# ändern, sondern dort – und mit ./dev.sh self-update übernehmen.
# Muss mit der Bash 3.2 von macOS laufen: keine assoziativen Arrays, kein mapfile.

DK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${ROOT:=$(cd "$DK_DIR/../.." && pwd)}"
DK_VERSION="$(tr -d '[:space:]' <"$DK_DIR/VERSION" 2>/dev/null || echo '?')"

DEV_DIR="$ROOT/.dev"
LOG_DIR="$DEV_DIR/logs"

# shellcheck source=lib/log.sh
. "$DK_DIR/lib/log.sh"
# shellcheck source=lib/proc.sh
. "$DK_DIR/lib/proc.sh"
# shellcheck source=lib/version.sh
. "$DK_DIR/lib/version.sh"
# shellcheck source=lib/infra.sh
. "$DK_DIR/lib/infra.sh"
# shellcheck source=lib/pack.sh
. "$DK_DIR/lib/pack.sh"
# shellcheck source=lib/remote.sh
. "$DK_DIR/lib/remote.sh"
# shellcheck source=commands.sh
. "$DK_DIR/commands.sh"

# ---------------------------------------------------------------- Projekt laden

# Vorgaben, die dev.project.sh überschreibt.
dk_defaults() {
  PROJECT_NAME="$(basename "$ROOT")"
  PROJECT_SLUG=""
  PROJECT_HELP=""          # freier Text am Ende der Hilfe (Ports, Umgebungsvariablen, Zugänge)
  JAVA_VERSION=""          # z. B. 17: JAVA_HOME wählen und Mindestversion prüfen
  DK_NEEDS=""              # Werkzeuge, die start/build brauchen, z. B. "mvn npm docker"
  DK_NPM_DIRS=""           # Verzeichnisse mit package.json, deren node_modules vor dem Start da sein müssen
  DK_COMPOSE=0             # 1: Infrastruktur per docker compose (docker-compose.yml im Root)
  DK_COMPOSE_SERVICES=""   # nur diese Compose-Dienste starten (leer: alle)
  DK_INFRA_TIMEOUT=60
  DK_LEGACY_PIDS=""        # PID-Dateien eines früheren Hintergrund-Startskripts, die `stop` noch abräumt

  VERSION_POM=""           # Wurzel-POM, deren Version maßgeblich ist
  VERSION_POM_MODE="mvn"   # mvn: versions:set · awk: POMs direkt umschreiben (schnell, ohne Maven-Lauf)
  VERSION_NPM=""           # Verzeichnisse mit package.json (und package-lock.json)
  VERSION_FILES=""         # einfache VERSION-Dateien (eine Zeile)

  DK_STD_RELEASE=0         # 1: generisches Release (lib/pack.sh), sonst Hook project_release
  DK_STD_DEPLOY=0          # 1: generisches Deploy (lib/remote.sh), sonst Hook project_deploy
}

dk_load_project() {
  dk_defaults
  [ -f "$ROOT/dev.project.sh" ] || die "dev.project.sh fehlt in $ROOT – dort steht, was dieses Projekt ausmacht."
  # shellcheck source=/dev/null
  . "$ROOT/dev.project.sh"
  [ -n "$PROJECT_SLUG" ] || PROJECT_SLUG="$(printf '%s' "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
}

# Ruft einen Hook aus dev.project.sh auf, falls er definiert ist; ohne Hook passiert nichts.
dk_has() { declare -F "$1" >/dev/null 2>&1; }
dk_hook() {
  local fn="$1"; shift
  dk_has "$fn" || return 0
  "$fn" "$@"
}

# ---------------------------------------------------------------- Dienste und Projektbefehle

DK_SVC_NAMES=(); DK_SVC_PORTS=(); DK_SVC_HEALTH=(); DK_SVC_URLS=(); DK_SVC_DEFAULT=()
DK_CMD_NAMES=(); DK_CMD_ARGS=(); DK_CMD_DESC=()

# dk_service <name> [port=N] [health=/pfad|URL] [url=URL] [scheme=https] [default=0]
#   Meldet einen Dienst an, den `start` im Vordergrund laufen lässt. Gestartet wird die Funktion
#   run_<name> aus dev.project.sh (Bindestriche als Unterstrich); sie läuft im Projekt-Root und
#   sollte mit `exec` enden. default=0: nur auf ausdrücklichen Wunsch (./dev.sh start <name>).
dk_service() {
  local name="$1" kv port="" health="" url="" scheme="http" default=1
  shift
  for kv in "$@"; do
    case "$kv" in
      port=*)    port="${kv#*=}" ;;
      health=*)  health="${kv#*=}" ;;
      url=*)     url="${kv#*=}" ;;
      scheme=*)  scheme="${kv#*=}" ;;
      default=*) default="${kv#*=}" ;;
      *) die "dk_service $name: unbekannte Angabe '$kv'" ;;
    esac
  done
  [ -n "$url" ] || { [ -z "$port" ] || url="$scheme://localhost:$port"; }
  case "$health" in /*) health="$scheme://localhost:$port$health" ;; esac
  # Ein zweiter Aufruf mit demselben Namen ersetzt den Eintrag – etwa wenn sich erst beim
  # Vorbereiten zeigt, dass der Dienst HTTPS spricht.
  local i=0
  while [ "$i" -lt "${#DK_SVC_NAMES[@]}" ] && [ "${DK_SVC_NAMES[i]}" != "$name" ]; do i=$((i + 1)); done
  DK_SVC_NAMES[i]="$name"; DK_SVC_PORTS[i]="$port"; DK_SVC_HEALTH[i]="$health"
  DK_SVC_URLS[i]="$url"; DK_SVC_DEFAULT[i]="$default"
}

# dk_svc <name> – setzt SVC_PORT, SVC_HEALTH, SVC_URL; Rückgabe 1, wenn unbekannt
dk_svc() {
  local i=0
  while [ "$i" -lt "${#DK_SVC_NAMES[@]}" ]; do
    if [ "${DK_SVC_NAMES[i]}" = "$1" ]; then
      SVC_PORT="${DK_SVC_PORTS[i]}"; SVC_HEALTH="${DK_SVC_HEALTH[i]}"; SVC_URL="${DK_SVC_URLS[i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

dk_all_services()     { printf '%s\n' ${DK_SVC_NAMES[@]+"${DK_SVC_NAMES[@]}"}; }
dk_default_services() {
  local i=0
  while [ "$i" -lt "${#DK_SVC_NAMES[@]}" ]; do
    [ "${DK_SVC_DEFAULT[i]}" = 1 ] && printf '%s\n' "${DK_SVC_NAMES[i]}"
    i=$((i + 1))
  done
  return 0
}

# dk_command <name> <argumente> <beschreibung>
#   Meldet einen Projektbefehl an: ./dev.sh <name> ruft cmd_<name> (Bindestriche als Unterstrich).
dk_command() {
  local i=${#DK_CMD_NAMES[@]}
  DK_CMD_NAMES[i]="$1"; DK_CMD_ARGS[i]="${2:-}"; DK_CMD_DESC[i]="${3:-}"
}

dk_fn() { printf '%s' "$1" | tr '-' '_'; }

# ---------------------------------------------------------------- Hilfe und Dispatch

dk_help_line() { printf '  %s%-56s%s %s\n' "$C_BOLD" "./dev.sh $1" "$C_RESET" "$2"; }

dk_usage() {
  local i=0 names
  printf '%s%s%s – Entwicklung, Version, Release, Deploy   %s(devkit %s)%s\n\n' \
    "$C_BOLD" "$PROJECT_NAME" "$C_RESET" "$C_DIM" "$DK_VERSION" "$C_RESET"

  names="$(dk_all_services | tr '\n' '|' | sed 's/|$//')"
  echo "Lokal entwickeln"
  dk_help_line "start [${names:-dienst}] [--no-build]" "im Vordergrund starten, Ctrl+C beendet alles"
  dk_help_line "stop" "Infrastruktur anhalten, Reste beenden (Daten bleiben)"
  dk_help_line "status" "was läuft, auf welchem Port, welche Version"
  dk_help_line "logs [dienst] [-n N] [--no-follow]" "Log eines Dienstes mitlesen (.dev/logs/)"
  dk_help_line "build [--tests]" "bauen"
  dk_help_line "test [ziel]" "Tests und Typecheck"
  dk_help_line "clean" "Build-Ergebnisse und .dev/logs entfernen"
  dk_help_line "doctor" "Werkzeuge, Ports, Versionen prüfen"
  echo
  echo "Version"
  dk_help_line "version" "alle Stellen zeigen, Gleichstand prüfen"
  dk_help_line "version patch|minor|major" "hochzählen (-SNAPSHOT bleibt)"
  dk_help_line "version release | snapshot" "-SNAPSHOT entfernen | nächster Arbeitsstand"
  dk_help_line "version 1.2.3[-SNAPSHOT]" "fest setzen"
  echo
  echo "Ausliefern"
  dk_help_line "release [--skip-tests] [--no-build] [--force]" "Paket bauen"
  dk_help_line "deploy [--host H] [--dry-run] [--yes] [--install]" "Paket auf den Server bringen"

  if [ "${#DK_CMD_NAMES[@]}" -gt 0 ]; then
    echo
    echo "Projektbefehle"
    while [ "$i" -lt "${#DK_CMD_NAMES[@]}" ]; do
      dk_help_line "${DK_CMD_NAMES[i]}${DK_CMD_ARGS[i]:+ ${DK_CMD_ARGS[i]}}" "${DK_CMD_DESC[i]}"
      i=$((i + 1))
    done
  fi

  echo
  echo "Sonstiges"
  dk_help_line "self-update [--check]" "devkit aus dem ProjectTemplate übernehmen"

  if [ "${#DK_SVC_NAMES[@]}" -gt 0 ]; then
    echo
    echo "Dienste"
    i=0
    while [ "$i" -lt "${#DK_SVC_NAMES[@]}" ]; do
      printf '  %-12s %s%s\n' "${DK_SVC_NAMES[i]}" "${DK_SVC_URLS[i]:--}" \
        "$([ "${DK_SVC_DEFAULT[i]}" = 1 ] || printf '   (nur auf Wunsch)')"
      i=$((i + 1))
    done
  fi
  if [ -n "$PROJECT_HELP" ]; then printf '\n%s\n' "$PROJECT_HELP"; fi
}

dk_main() {
  local cmd="${1:-help}" i=0
  [ $# -eq 0 ] || shift
  case "$cmd" in
    start)       dk_cmd_start "$@" ;;
    stop)        dk_cmd_stop "$@" ;;
    status)      dk_cmd_status "$@" ;;
    logs)        dk_cmd_logs "$@" ;;
    build)       dk_cmd_build "$@" ;;
    test)        dk_cmd_test "$@" ;;
    clean)       dk_cmd_clean "$@" ;;
    doctor)      dk_cmd_doctor "$@" ;;
    version)     dk_cmd_version "$@" ;;
    set)         # ./dev.sh set version … (Schreibweise aus spot-mm)
                 [ "${1:-}" = version ] || die "Nach 'set' kommt 'version':  ./dev.sh set version patch"
                 shift; dk_cmd_version "$@" ;;
    release)     dk_cmd_release "$@" ;;
    deploy)      dk_cmd_deploy "$@" ;;
    self-update) dk_cmd_self_update "$@" ;;
    help|-h|--help) dk_usage ;;
    *)
      while [ "$i" -lt "${#DK_CMD_NAMES[@]}" ]; do
        if [ "${DK_CMD_NAMES[i]}" = "$cmd" ]; then
          "cmd_$(dk_fn "$cmd")" "$@"
          return
        fi
        i=$((i + 1))
      done
      fail "Unbekannter Befehl: $cmd"
      echo >&2
      dk_usage >&2
      exit 1 ;;
  esac
}
