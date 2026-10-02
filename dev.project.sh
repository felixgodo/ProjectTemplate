# shellcheck shell=bash disable=SC2034
# Was dieses Projekt ausmacht – das Einzige, was dev.sh projektspezifisch braucht.
# Alle Befehle: ./dev.sh help      Schnittstelle (Variablen, Hooks): scripts/devkit/README.md

PROJECT_NAME="ProjectTemplate"
PROJECT_SLUG="projecttemplate"
JAVA_VERSION=17
DK_NEEDS="mvn node npm curl lsof"
DK_NPM_DIRS="frontend"
DK_COMPOSE=1

# Eigene Ports, damit andere Projekte parallel laufen können. Überschreibbar, z. B.
#   PTPL_BACKEND_PORT=9100 ./dev.sh start
BACKEND_PORT="${PTPL_BACKEND_PORT:-8100}"
FRONTEND_PORT="${PTPL_FRONTEND_PORT:-5200}"
DB_PORT="${PTPL_DB_PORT:-3310}"
export PTPL_DB_PORT="$DB_PORT"      # liest docker-compose.yml

PROJECT_HELP="Ports überschreiben
  PTPL_BACKEND_PORT ($BACKEND_PORT)  PTPL_FRONTEND_PORT ($FRONTEND_PORT)  PTPL_DB_PORT ($DB_PORT)

Deploy-Ziel: deploy/deploy.conf (Vorlage: deploy/deploy.conf.example)"

# ---------------------------------------------------------------- Dienste

dk_service backend  port="$BACKEND_PORT" health=/actuator/health
dk_service frontend port="$FRONTEND_PORT"

run_backend() {
  export SERVER_PORT="$BACKEND_PORT"
  export DB_URL="jdbc:mariadb://127.0.0.1:$DB_PORT/projecttemplate"
  exec mvn -q -pl backend spring-boot:run
}

run_frontend() {
  cd frontend || exit
  # Direkt vite statt "npm run dev": so endet mit dem Prozess auch wirklich der Dev-Server.
  BACKEND_URL="http://localhost:$BACKEND_PORT" exec ./node_modules/.bin/vite --port "$FRONTEND_PORT" --strictPort
}

# ---------------------------------------------------------------- Version, Release, Deploy

VERSION_POM="pom.xml"
VERSION_NPM="frontend"

DK_STD_RELEASE=1
DK_STD_DEPLOY=1
RELEASE_JAR="backend/target/projecttemplate.jar"
RELEASE_WEB="frontend/dist"
RELEASE_FILES="deploy"

# ---------------------------------------------------------------- Projektbefehle

dk_command reset-db "" "lokale Datenbank samt Volume verwerfen (Flyway migriert neu)"
cmd_reset_db() {
  dk_require_docker
  confirm "Wirklich alle lokalen Daten von $PROJECT_NAME löschen?" || { info "Abgebrochen."; return 0; }
  docker compose down -v
  ok "Datenbank entfernt. Beim nächsten Start migriert Flyway von V1 an neu."
}
