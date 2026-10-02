# ProjectTemplate

Spring Boot 3.5 (Java 17) · React 19 + Vite + TypeScript + Tailwind 4 · MariaDB.

## Entwickeln

Voraussetzungen: JDK 17, Maven, Node, Docker.

```bash
./dev.sh start        # MariaDB (Docker), Backend, Frontend – Ctrl+C beendet alles
./dev.sh help         # alle Befehle
```

| | |
|---|---|
| Oberfläche | http://localhost:5200 |
| Backend | http://localhost:8100 (`/api/…`, `/actuator/health`) |
| MariaDB | 127.0.0.1:3310, Datenbank/Benutzer/Passwort `projecttemplate` |

Ports überschreiben: `PTPL_BACKEND_PORT`, `PTPL_FRONTEND_PORT`, `PTPL_DB_PORT`.

Aus einem zweiten Terminal: `./dev.sh status`, `./dev.sh logs backend`.
Datenbank verwerfen: `./dev.sh reset-db`. Das Schema gehört Flyway (`backend/src/main/resources/db/migration`).

## Version

Eine Version für alles (POMs und `frontend/package.json`) – nie von Hand ändern.

```bash
./dev.sh version              # anzeigen, Gleichstand prüfen
./dev.sh version patch        # 0.1.0-SNAPSHOT → 0.1.1-SNAPSHOT
./dev.sh version release      # 0.1.1-SNAPSHOT → 0.1.1
./dev.sh version snapshot     # 0.1.1 → 0.1.2-SNAPSHOT
```

## Release und Deploy

```bash
./dev.sh version release
./dev.sh release              # Tests, Build, releases/projecttemplate-<version>.zip (+ .sha256)

cp deploy/deploy.conf.example deploy/deploy.conf     # einmalig: HOST, DOMAIN eintragen
./dev.sh deploy --install     # Erstinstallation
./dev.sh deploy               # Update
./dev.sh deploy --dry-run | --status | --rollback | --logs
```

Auf dem Server richtet `setup.sh` aus dem Paket alles ein: Systemuser, `/opt/projecttemplate/releases/<version>`,
`/etc/projecttemplate/projecttemplate.env`, Datenbank, systemd-Dienst und nginx (mit HestiaCP als Template der
Domain). Ein Update tauscht nur Jar und Oberfläche; schlägt der Health-Check fehl, wird zurückgestellt.
Auf dem Server selbst: `projecttemplate status | logs | restart | rollback`.

## dev.sh

`dev.sh` und `scripts/devkit/` sind in allen Projekten gleich und kommen aus dem ProjectTemplate
(`./dev.sh self-update`). Projektspezifisches steht in `dev.project.sh` – Schnittstelle:
[scripts/devkit/README.md](scripts/devkit/README.md).
