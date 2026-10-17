# devkit

Gemeinsamer Kern von `dev.sh`. In allen Projekten identisch; die Quelle liegt im `ProjectTemplate`.
**Nicht im Projekt ändern** – im Template ändern, `scripts/devkit/VERSION` hochzählen und mit
`./dev.sh self-update` (im Projekt) oder `./devkit-sync.sh --apply` (im Template) verteilen.

Läuft mit der Bash 3.2 von macOS: keine assoziativen Arrays, kein `mapfile`.

```
dev.sh              identisch überall: lädt devkit und dev.project.sh
dev.project.sh      das Einzige, was ein Projekt selbst schreibt
scripts/devkit/
  devkit.sh         Vorgaben, Dienste, Projektbefehle, Hilfe, Dispatch
  commands.sh       start, stop, status, logs, build, test, clean, doctor, release, deploy, self-update
  lib/log.sh        step ok info dim warn fail die head1 · need · confirm
  lib/proc.sh       port_pid, require_free_port, http_ok, wait_for · Vordergrund-Start
  lib/version.sh    Version lesen, prüfen, hochzählen, überall setzen
  lib/infra.sh      Java wählen, npm-Abhängigkeiten, lokale Maven-Artefakte, docker compose
  lib/pack.sh       Prüfsummen, VERSION-Datei, Zip · generisches Release
  lib/remote.sh     SSH (eine Verbindung, Anmeldung per Schlüssel oder einmal per Passwort;
                    DK_SSH_CTL ist exportiert, aufgerufene Skripte benutzen sie mit),
                    Upload mit Prüfsumme · generisches Deploy
```

## dev.project.sh

### Variablen

| Variable | Bedeutung |
|---|---|
| `PROJECT_NAME`, `PROJECT_SLUG` | Anzeigename; Kleinname für Paket, Dienst und Verzeichnisse |
| `PROJECT_HELP` | freier Text am Ende von `./dev.sh help` (Ports, Zugänge) |
| `JAVA_VERSION` | z. B. `17`: wählt `JAVA_HOME` (macOS) und prüft die Mindestversion |
| `DK_NEEDS` | Werkzeuge, die vorhanden sein müssen, z. B. `"mvn npm curl lsof"` |
| `DK_NPM_DIRS` | Verzeichnisse mit `package.json`; `start` installiert bei Bedarf `node_modules` |
| `DK_COMPOSE=1` | Infrastruktur per `docker compose` (`docker-compose.yml` im Root) |
| `DK_COMPOSE_SERVICES` | nur diese Compose-Dienste starten |
| `DK_LEGACY_PIDS` | PID-Dateien eines früheren Hintergrund-Startskripts; `stop` beendet deren Prozesse noch |
| `VERSION_POM` | Wurzel-POM; ihre Version ist maßgeblich, Module werden mitgeführt |
| `VERSION_POM_MODE` | `mvn` (versions:set) oder `awk` (POMs direkt umschreiben, ohne Maven-Lauf) |
| `VERSION_NPM` | Verzeichnisse mit `package.json` / `package-lock.json` |
| `VERSION_FILES` | einfache `VERSION`-Dateien |
| `DK_STD_RELEASE=1` | generisches Release; braucht `RELEASE_JAR`, `RELEASE_WEB`, optional `RELEASE_FILES`, `RELEASE_DIR` |
| `DK_STD_DEPLOY=1` | generisches Deploy; Ziel aus `deploy/deploy.conf` |

### Dienste

```bash
dk_service backend  port="$BACKEND_PORT" health=/actuator/health
dk_service frontend port="$FRONTEND_PORT" scheme=https
dk_service worker   default=0            # nur mit ./dev.sh start worker

run_backend() { exec mvn -q -pl backend spring-boot:run; }
```

`start` ruft `run_<name>` im Projekt-Root auf, je Dienst als eigene Prozessgruppe. Die Funktion
sollte mit `exec` enden. Ausgabe: Terminal mit `[name]`-Präfix und `.dev/logs/<name>.log`.
Ein Dienst gilt als bereit, wenn `health` antwortet (sonst: wenn der Port lauscht).

### Hooks (alle optional)

| Hook | Wann |
|---|---|
| `project_preflight` | vor start, build, test, release – z. B. lokale Maven-Artefakte prüfen |
| `project_infra_up <dienste…>` / `project_infra_down` | statt `docker compose` (eigene Container, lokale Dienste) |
| `project_infra_ready` | mit `DK_COMPOSE=1`: gilt die Infrastruktur als bereit? (Rückgabe 0) |
| `project_infra_status` | Zeilen für `status` |
| `project_prepare <dienste…>` | vor dem Start, entfällt mit `--no-build` – z. B. Jar bauen |
| `project_started` | sobald alle Dienste bereit sind – z. B. Login anzeigen |
| `project_build [args]`, `project_test [args]`, `project_clean` | ersetzen den Standard |
| `project_status_extra`, `project_doctor` | zusätzliche Zeilen bzw. Prüfungen |
| `project_logs <name> <zeilen> <folgen>` | Logs von Infrastruktur, die kein Compose-Dienst ist |
| `project_version_extra show` | weitere Stellen melden: `dk_version_row <stelle> <version> [erwartet]` |
| `project_version_extra set <version>` | weitere Stellen schreiben |
| `project_release [args]`, `project_deploy [args]` | eigenes Release bzw. Deploy |

`release` und `deploy` lesen die einheitlichen Optionen vorab in `DK_OPT_SKIP_TESTS`,
`DK_OPT_NO_BUILD`, `DK_OPT_FORCE`, `DK_OPT_HOST`, `DK_OPT_DOMAIN`, `DK_OPT_DRY_RUN`, `DK_OPT_YES`,
`DK_OPT_INSTALL`, `DK_OPT_ACTION` (`status`, `rollback`, `logs`); alles Übrige bekommt der Hook als
Argumente. Was ein Projekt nicht umsetzen kann, lehnt es mit `dk_opt_unsupported --dry-run …` ab,
statt es stillschweigend zu ignorieren.

### Projektbefehle

```bash
dk_command reset-db "" "lokale Datenbank verwerfen"
cmd_reset_db() { … }
```

## Versions-Regeln

| Befehl | 1.0.3-SNAPSHOT | 1.0.3 |
|---|---|---|
| `version patch` | 1.0.4-SNAPSHOT | 1.0.4 |
| `version minor` | 1.1.0-SNAPSHOT | 1.1.0 |
| `version release` | 1.0.3 | 1.0.3 |
| `version snapshot` | 1.0.3-SNAPSHOT | 1.0.4-SNAPSHOT |
| `version patch --release` | 1.0.4 | 1.0.4 |

`./dev.sh version --short` gibt nur die Nummer aus (für Skripte).
