# devkit

**English** · [Deutsch](README.de.md)

Shared core of `dev.sh`. Identical in every project; the source lives in `ProjectTemplate`.
**Do not change it inside a project** – change it in the template, bump `scripts/devkit/VERSION` and
distribute it with `./dev.sh self-update` (in the project) or `./devkit-sync.sh --apply` (in the template).

Runs on the macOS Bash 3.2: no associative arrays, no `mapfile`.

```
dev.sh              identical everywhere: loads devkit and dev.project.sh
dev.project.sh      the only thing a project writes itself
scripts/devkit/
  devkit.sh         defaults, services, project commands, help, dispatch
  commands.sh       start, stop, status, logs, build, test, clean, doctor, release, deploy, self-update
  lib/log.sh        step ok info dim warn fail die head1 · need · confirm
  lib/proc.sh       port_pid, require_free_port, http_ok, wait_for · foreground start
  lib/version.sh    read, check, bump and set the version everywhere
  lib/infra.sh      choose Java, npm dependencies, local Maven artifacts, docker compose
  lib/pack.sh       checksums, VERSION file, zip · generic release
  lib/remote.sh     SSH (one connection, login by key or once by password;
                    DK_SSH_CTL is exported, scripts called from it reuse it),
                    upload with checksum · generic deploy
```

## dev.project.sh

### Variables

| Variable | Meaning |
|---|---|
| `PROJECT_NAME`, `PROJECT_SLUG` | display name; lowercase name for package, service and directories |
| `PROJECT_HELP` | free text at the end of `./dev.sh help` (ports, credentials) |
| `JAVA_VERSION` | e.g. `17`: selects `JAVA_HOME` (macOS) and checks the minimum version |
| `DK_NEEDS` | tools that must be present, e.g. `"mvn npm curl lsof"` |
| `DK_NPM_DIRS` | directories with a `package.json`; `start` installs `node_modules` when needed |
| `DK_COMPOSE=1` | infrastructure via `docker compose` (`docker-compose.yml` in the root) |
| `DK_COMPOSE_SERVICES` | start only these Compose services |
| `DK_LEGACY_PIDS` | PID files of an earlier background start script; `stop` still terminates their processes |
| `VERSION_POM` | root POM; its version is authoritative, modules follow along |
| `VERSION_POM_MODE` | `mvn` (versions:set) or `awk` (rewrite POMs directly, without running Maven) |
| `VERSION_NPM` | directories with `package.json` / `package-lock.json` |
| `VERSION_FILES` | plain `VERSION` files |
| `DK_STD_RELEASE=1` | generic release; needs `RELEASE_JAR`, `RELEASE_WEB`, optionally `RELEASE_FILES`, `RELEASE_DIR` |
| `DK_STD_DEPLOY=1` | generic deploy; target from `deploy/deploy.conf` |

### Services

```bash
dk_service backend  port="$BACKEND_PORT" health=/actuator/health
dk_service frontend port="$FRONTEND_PORT" scheme=https
dk_service worker   default=0            # only with ./dev.sh start worker

run_backend() { exec mvn -q -pl backend spring-boot:run; }
```

`start` calls `run_<name>` in the project root, each service in its own process group. The function
should end with `exec`. Output: terminal with a `[name]` prefix and `.dev/logs/<name>.log`.
A service counts as ready when `health` responds (otherwise: when the port is listening).

### Hooks (all optional)

| Hook | When |
|---|---|
| `project_preflight` | before start, build, test, release – e.g. check local Maven artifacts |
| `project_infra_up <services…>` / `project_infra_down` | instead of `docker compose` (own containers, local services) |
| `project_infra_ready` | with `DK_COMPOSE=1`: is the infrastructure considered ready? (return 0) |
| `project_infra_status` | lines for `status` |
| `project_prepare <services…>` | before the start, skipped with `--no-build` – e.g. build the jar |
| `project_started` | as soon as all services are ready – e.g. show the login |
| `project_build [args]`, `project_test [args]`, `project_clean` | replace the default |
| `project_status_extra`, `project_doctor` | additional lines or checks, respectively |
| `project_logs <name> <lines> <follow>` | logs of infrastructure that is not a Compose service |
| `project_version_extra show` | report further locations: `dk_version_row <location> <version> [expected]` |
| `project_version_extra set <version>` | write further locations |
| `project_release [args]`, `project_deploy [args]` | custom release or deploy |
| `project_backup <run\|list\|status> [args]` | custom route for `./dev.sh backup` (default: `backup-agent` on the server, target `BACKUP_TARGET` or the project name) |

`release` and `deploy` parse the common options up front into `DK_OPT_SKIP_TESTS`,
`DK_OPT_NO_BUILD`, `DK_OPT_FORCE`, `DK_OPT_HOST`, `DK_OPT_DOMAIN`, `DK_OPT_DRY_RUN`, `DK_OPT_YES`,
`DK_OPT_INSTALL`, `DK_OPT_ACTION` (`status`, `rollback`, `logs`); everything else is passed to the hook
as arguments. Whatever a project cannot implement, it rejects with `dk_opt_unsupported --dry-run …`
instead of silently ignoring it.

### Project commands

```bash
dk_command reset-db "" "discard local database"
cmd_reset_db() { … }
```

## Version rules

| Command | 1.0.3-SNAPSHOT | 1.0.3 |
|---|---|---|
| `version patch` | 1.0.4-SNAPSHOT | 1.0.4 |
| `version minor` | 1.1.0-SNAPSHOT | 1.1.0 |
| `version release` | 1.0.3 | 1.0.3 |
| `version snapshot` | 1.0.3-SNAPSHOT | 1.0.4-SNAPSHOT |
| `version patch --release` | 1.0.4 | 1.0.4 |

`./dev.sh version --short` prints only the number (for scripts).
