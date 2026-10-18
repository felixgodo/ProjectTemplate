# ProjectTemplate

Ausgangspunkt für neue Projekte und Quelle des gemeinsamen `dev.sh` aller Projekte.

- **Lauffähige App:** Spring Boot 3.5 (Java 17, JPA, Flyway, Actuator) · React 19 + Vite + TypeScript +
  Tailwind 4 · MariaDB per Docker Compose · Release-Paket und Server-Installer (systemd, nginx/HestiaCP).
- **devkit:** `dev.sh` und `scripts/devkit/` sind in allen Projekten identisch. Was ein Projekt
  ausmacht, steht allein in seiner `dev.project.sh`.

## Neues Projekt

```bash
./new-project.sh InvoiceHub                 # legt ../InvoiceHub an
./new-project.sh InvoiceHub --group de.obenaus --prefix IH --backend-port 8105
cd ../InvoiceHub && ./dev.sh start
```

Kopiert das Template, benennt Paket, Artefakte, Dienst und Umgebungsvariablen um, wählt freie Ports
(nach den `dev.project.sh` der Nachbarprojekte) und trägt das Projekt in `devkit-projects.txt` ein.

## Einheitliche Befehle

| Befehl | |
|---|---|
| `./dev.sh start [dienst…] [--no-build]` | Infrastruktur, Build, dann alle Dienste im Vordergrund mit `[name]`-Präfix. Ctrl+C beendet alles. |
| `./dev.sh stop` | Infrastruktur anhalten, Reste eines früheren Starts beenden. Daten bleiben. |
| `./dev.sh status` · `logs [dienst]` | aus einem zweiten Terminal: Ports, Health, Version · Log mitlesen |
| `./dev.sh build [--tests]` · `test` · `clean` · `doctor` | |
| `./dev.sh version` | alle Stellen zeigen; Exit 1, wenn sie auseinanderlaufen |
| `./dev.sh version patch\|minor\|major\|release\|snapshot\|1.2.3` | überall setzen (POMs, package.json, …) |
| `./dev.sh release [--skip-tests] [--no-build] [--force]` | Paket bauen |
| `./dev.sh deploy [--host H] [--dry-run] [--yes] [--install] [--status\|--rollback\|--logs]` | auf den Server bringen |
| `./dev.sh self-update [--check]` | devkit aus diesem Template übernehmen |

Dazu kommen je Projekt eigene Befehle – `./dev.sh help` zeigt sie.

## devkit ändern und verteilen

```bash
# 1. hier in scripts/devkit/ ändern, scripts/devkit/VERSION hochzählen
./devkit-sync.sh              # Stand je Projekt
./devkit-sync.sh --apply      # in alle Projekte aus devkit-projects.txt übernehmen
# oder im einzelnen Projekt:  ./dev.sh self-update
```

Ein bestehendes Projekt mit eigenem `dev.sh` erstmals umstellen:

```bash
./devkit-sync.sh --adopt MeinProjekt   # sichert dessen dev.sh als dev.sh.vor-devkit, legt devkit + dev.sh an
# danach in ../MeinProjekt eine dev.project.sh schreiben und in devkit-projects.txt eintragen
```

`--apply` fasst nur Projekte an, die schon eine `dev.project.sh` haben, und überschreibt nie ein
`dev.sh`, das nicht aus dem devkit stammt.

Schnittstelle (Variablen, Hooks, Versions-Regeln): [scripts/devkit/README.md](scripts/devkit/README.md)

## Parallele Worker (beadskit)

Mehrere Claude-Sessions prüfen und verbessern ein Projekt über eine gemeinsame
[beads](https://github.com/gastownhall/beads)-Warteschlange (`bd`): Such-Worker legen Funde an,
Fix-Worker öffnen PRs, Verify-Worker prüfen und mergen, Regress-Worker prüfen den Ziel-Branch.
Ein Leitstand im Browser zeigt alle eingerichteten Projekte. Details: [scripts/beadskit/README.md](scripts/beadskit/README.md)

```bash
./beadskit-sync.sh --adopt MeinProjekt --base main --modules "backend frontend"
cd ../MeinProjekt && bd init --prefix meinprojekt     # einmalig, .beads/ bleibt lokal
scripts/beadskit/workers start fix=1 search=1 verify=1
node scripts/beadskit/leitstand/inbox.mjs            # http://127.0.0.1:3738, alle Projekte
./beadskit-sync.sh --apply                           # Kit-Änderungen verteilen (VERSION hochzählen)
```

## Aufbau

```
dev.sh · dev.project.sh · scripts/devkit/     Steuerung
pom.xml                                       Parent: Version, Node-Version, Plugins
backend/                                      Spring Boot – /api/ping, /api/version, Beispiel /api/notes
frontend/                                     React + Vite, Proxy /api → Backend
docker-compose.yml                            MariaDB für die Entwicklung
deploy/                                       setup.sh und Vorlagen fürs Release-Paket
scripts/beadskit/                             parallele Claude-Worker + Leitstand (optional je Projekt)
new-project.sh · devkit-sync.sh · beadskit-sync.sh   nur im Template
```

Die Template-App selbst läuft mit `./dev.sh start` auf http://localhost:5200 (Backend 8100, MariaDB 3310).
