# ProjectTemplate

**English** · [Deutsch](README.de.md)

![CI](https://github.com/felixgodo/ProjectTemplate/actions/workflows/ci.yml/badge.svg)
![Java 17](https://img.shields.io/badge/Java-17-orange)
![Spring Boot 3.5](https://img.shields.io/badge/Spring%20Boot-3.5-6db33f)
![React 19](https://img.shields.io/badge/React-19-61dafb)
![License: MIT](https://img.shields.io/badge/License-MIT-blue)

A ready-to-run full-stack starter (Spring Boot + React + MariaDB) with one `dev.sh` that works the same
in every project – and an optional kit that lets several Claude Code sessions find, fix and verify
issues in parallel.

## What's inside

- **App skeleton** – Spring Boot 3.5 (Java 17, JPA, Flyway, Actuator) · React 19 + Vite + TypeScript +
  Tailwind 4 · MariaDB via Docker Compose. Includes a release package and a server installer
  (systemd, nginx/HestiaCP) with health check and automatic rollback.
- **devkit** – `dev.sh` and `scripts/devkit/` are identical in all projects: start, test, version,
  release, deploy. What makes a project different lives in its `dev.project.sh` alone.
  Changes are rolled out to every project with one command.
- **beadskit** (optional) – parallel Claude Code workers sharing a [beads](https://github.com/gastownhall/beads)
  issue queue, plus a browser dashboard (*Leitstand*) across all projects.

> The detailed docs in `scripts/*/README.md` are in German.

## Prerequisites

JDK 17, Maven, Node, Docker. For beadskit additionally [`bd`](https://github.com/gastownhall/beads)
and [Claude Code](https://claude.com/claude-code).

## Quick start

```bash
git clone https://github.com/felixgodo/ProjectTemplate
cd ProjectTemplate
./dev.sh start        # MariaDB (Docker), backend, frontend – Ctrl+C stops everything
```

Open http://localhost:5200 (backend on 8100, MariaDB on 3310). `./dev.sh help` lists all commands.

## Create a new project

```bash
./new-project.sh InvoiceHub                 # creates ../InvoiceHub
./new-project.sh InvoiceHub --group com.example --prefix IH --backend-port 8105
cd ../InvoiceHub && ./dev.sh start
```

Copies the template and renames package, artifacts, service and environment variables. Free ports are
picked by looking at the `dev.project.sh` of neighbouring projects, and the project is added to
`devkit-projects.txt`.

## Commands

| Command | |
|---|---|
| `./dev.sh start [service…] [--no-build]` | Infrastructure, build, then all services in the foreground with a `[name]` prefix. Ctrl+C stops all. |
| `./dev.sh stop` | Stop infrastructure and leftovers of an earlier start. Data is kept. |
| `./dev.sh status` · `logs [service]` | From a second terminal: ports, health, version · follow a log |
| `./dev.sh build [--tests]` · `test` · `clean` · `doctor` | |
| `./dev.sh version` | Show every place the version lives; exit 1 if they diverge |
| `./dev.sh version patch\|minor\|major\|release\|snapshot\|1.2.3` | Set it everywhere (POMs, package.json, …) |
| `./dev.sh release [--skip-tests] [--no-build] [--force]` | Build the release package |
| `./dev.sh deploy [--host H] [--dry-run] [--yes] [--install] [--status\|--rollback\|--logs]` | Ship it to the server |
| `./dev.sh backup [run\|list\|status]` | Back up to the storage box |
| `./dev.sh self-update [--check]` | Pull the devkit from this template |

Projects add their own commands – `./dev.sh help` shows them. Release and deploy in detail:
[README.project.md](README.project.md).

## Sharing the devkit across projects

`devkit-projects.txt` lists the projects that use the devkit. It stays local (not versioned):
`cp devkit-projects.txt.example devkit-projects.txt`.

```bash
# 1. change scripts/devkit/ here, bump scripts/devkit/VERSION
./devkit-sync.sh              # status per project
./devkit-sync.sh --apply      # roll out to all projects in devkit-projects.txt
# or inside a single project:  ./dev.sh self-update
```

Switching an existing project with its own `dev.sh`:

```bash
./devkit-sync.sh --adopt MyProject   # backs up its dev.sh as dev.sh.vor-devkit, installs devkit + dev.sh
# then write a dev.project.sh in ../MyProject and add it to devkit-projects.txt
```

`--apply` only touches projects that already have a `dev.project.sh` and never overwrites a `dev.sh`
that doesn't come from the devkit. Interface (variables, hooks, version rules):
[scripts/devkit/README.md](scripts/devkit/README.md).

## Parallel workers (beadskit)

Several Claude Code sessions work on one project through a shared beads queue (`bd`), each in a role:

- **search** workers review the code and file findings,
- **fix** workers pick them up and open pull requests,
- **verify** workers review and merge those PRs,
- **regress** workers check the target branch afterwards.

The *Leitstand* (control room) in the browser shows queues, workers and PRs of all set-up projects.

```bash
./beadskit-sync.sh --adopt MyProject --base main --modules "backend frontend"
cd ../MyProject && bd init --prefix myproject      # once, .beads/ stays local
scripts/beadskit/workers start fix=1 search=1 verify=1
./leitstand.sh                                     # http://127.0.0.1:3738, all projects
./beadskit-sync.sh --apply                         # roll out kit changes (bump VERSION)
```

Details: [scripts/beadskit/README.md](scripts/beadskit/README.md)

## Two machines (optional)

A Linux box (Ubuntu Server) can take over workers, builds and Docker and host the shared beads
database and the Leitstand, while a Mac joins in when it's free. Setup:
[scripts/remote/README.md](scripts/remote/README.md).

## Layout

```
dev.sh · dev.project.sh · scripts/devkit/     control
pom.xml                                       parent: version, Node version, plugins
backend/                                      Spring Boot – /api/ping, /api/version, example /api/notes
frontend/                                     React + Vite, proxy /api → backend
docker-compose.yml                            MariaDB for development
deploy/                                       setup.sh and templates for the release package
scripts/beadskit/                             parallel Claude workers + Leitstand (optional per project)
scripts/remote/                               second machine (Linux box): setup, pc command
new-project.sh · devkit-sync.sh · beadskit-sync.sh · leitstand.sh   template only
```

## License

[MIT](LICENSE)
