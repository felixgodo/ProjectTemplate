# beadskit

**English** · [Deutsch](README.de.md)

![Leitstand with demo data](https://raw.githubusercontent.com/felixgodo/ProjectTemplate/main/docs/images/leitstand.png)

Parallel Claude workers fed by a [beads](https://github.com/gastownhall/beads) queue, plus a
Leitstand (control room, a web dashboard) for all projects. Identical in every project; the source
lives in `ProjectTemplate`. **Do not change it inside a project** – change it in the template, bump
`scripts/beadskit/VERSION` and distribute it with `./beadskit-sync.sh --apply`.

```
beads.project.sh        in the project: name, slug, target branch, roles, workspaces, modules, repos
beads.leitstand.mjs     in the project, optional: buttons, extra lists, links and texts for the Leitstand
scripts/beadskit/
  bdw                   bd with the worktree name as actor
  on-host               entry point for commands via ssh from the other machine (PATH, project folder)
  workers               start/add/drain/stop/restart workers, chat (send),
                        drain-check, repo-for, config (JSON for the Leitstand); tests workers.test.mjs
  leitstand/            web Leitstand (inbox.mjs + inbox.html), tests, remote access (leitstand-remote),
                        host-agent.mjs (this machine's workers for the Leitstand on the other one)
  ci/runner-pool        shared CI runner pool for all projects on the server (service: runner-pool-daemon)
  ci/runner-server      old fixed runners per repo (only for tearing down: runner-server remove)
  ci/lib.sh             runner image, CI slice and measurement for both
  templates/            templates for --adopt: beads.project.sh, skills, reviews/README.md
```

## Workflow

| Role | Skill | does |
|---|---|---|
| search | `/<slug>-search` | looks for bugs, files beads issues (`phase:fix`), changes no code |
| fix | `/loop 10m /<slug>-fix` | claims an issue, branch `fix/<id>`, test + review file, PR against `BK_BASE` → `phase:verify` |
| verify | `/loop 5m /<slug>-verify` | checks PRs independently → `phase:merge` or back; merges serially in the merge slot after green CI |
| regress | `/loop 30m /<slug>-regress` | checks `BK_BASE` with all check commands, reports regressions |

What the workers check is defined in the project's `CLAUDE.md` (check commands, mandatory review);
the rules are in `.claude/skills/worker-regeln.md` (from the template; fill in the section
„Projektspezifisch“ (project-specific)).

## Setup

```bash
# in the template
./beadskit-sync.sh --adopt MyProject --slug myproject --base main --modules "backend frontend" --prefix mp
# in the project
bd init --prefix mp                                   # .beads/ local, not in Git
for m in backend frontend tests; do scripts/beadskit/bdw create "Epic $m" -t epic --external-ref "epic:$m"; done
scripts/beadskit/workers start --dry-run
```

## Usage

```bash
scripts/beadskit/workers start fix=2 search=1 verify=1     # total per role (workspace code)
scripts/beadskit/workers start --ws clubs                  # other workspace, default BK_WS_clubs_START
scripts/beadskit/workers add fix                           # one more
scripts/beadskit/workers ls
scripts/beadskit/workers drain && scripts/beadskit/workers ls   # wait until idle
scripts/beadskit/workers stop --all
scripts/beadskit/workers restart fix-2                     # fresh context, only between two rounds
scripts/beadskit/workers autorestart --over 200k           # the Leitstand then does this on its own
scripts/beadskit/workers top                               # live overview: machines (CPU, RAM, SSD …), projects, workers
scripts/beadskit/workers screen fix-2                       # the terminal's screen (e.g. a prompt waiting for input)
scripts/beadskit/workers press fix-2 2                     # answer a prompt with key 2 (1–9, Escape, Enter)
scripts/beadskit/workers send fix-2 -- /compact            # type a line into the terminal (iTerm tab, tmux window)
```

- `drain` lets the workers finish their current step; they claim nothing new.
  `drain fix` drains only one role, `drain fix --off` cancels that, `drain --off`
  (and `start`) cancels everything. `add` refuses while a drain is active.
- `stop` without a drain refuses while workers are busy; `--force` overrides that.
- `add` takes the next free number and opens the tabs in the frontmost iTerm window; this is also
  how „+1“ and „Pipeline starten“ (start pipeline) work in the Leitstand.
- `restart` only between two rounds: idle, no claim, no merge slot, not during a drain
  (`--force` overrides). iTerm workers get SIGTERM, and the start command is typed into the same
  tab via AppleScript. Otherwise a worker under `/loop` accumulates all rounds in one session.
- Background workers (`--bg`) can only be reached via `workers attach <name>`, not via `send`.

Workers run in a terminal, colored by role: on the Mac as iTerm tabs, on Linux as windows of the
tmux session `bk-<slug>` (`workers attach <name>`). `--term iterm|tmux|bg` or `BK_TERM` chooses
explicitly, `--bg` starts background sessions; without a controllable terminal they run in the
background automatically.

**Two machines** (`~/.config/beadskit/hosts.conf`, setup in
`ProjectTemplate/scripts/remote`): workers are named `<role>-<BK_HOST_BASE + n>` (Mac `fix-1`, PC
`fix-101`), drain and auto-restart live in `bd kv` of the shared database,
`workers drain --host <machine>` drains only one machine, `HOST_<h>_ROLES` limits what
`start` launches there when no roles are given. The Leitstand on the main machine shows the workers
of both machines (via ssh: `on-host` + `leitstand/host-agent.mjs`) and runs actions on the worker's
machine.

**Leitstand:** `./leitstand.sh` in ProjectTemplate (or `node scripts/beadskit/leitstand/inbox.mjs`
from any set-up project) → http://127.0.0.1:3738, quit with Ctrl+C. One process for all projects;
project switcher at the top (`#<slug>` in the address), next to it the workspace switcher. The list
is in `~/.config/beadskit/projects.txt` – `workers` registers its project on every call. The
Leitstand shows metrics (next to „bereit“ (ready) the tile „bereit: <erste Phase>“ (ready: <first
phase>) = the released ones among them, which are the only ones workers claim), worker cards with
details (chat from the transcript, sending into the iTerm tab, restart), „Wartet auf dich“ (waiting
for you; label `human`; if an issue depends on another via `blocks`, the tile shows „wartet auf
<id>“ (waiting for <id>) with a link and status, or „Abhängigkeit erledigt“ (dependency done), and
the board shows a ⏳ badge; multi-select via checkboxes, „alle“ (all) or „nur …“ (only …) (a split
like „zum Aktivieren“ (to activate), a group like city), then a button action, „Freigeben“
(release), „Zurückstellen“ (defer) or „Schließen“ (close) for all of them with a shared text: runs
per issue through the same endpoints, at most 2 at a time, with progress and cancel; a button
action applies only to the cards where it is available, errors stay on the card), a kanban board
with drag & drop per workspace, PRs with CI status (of all repos from `BK_REPOS`) and the CI
runners, if the project uses any.
It controls issues and workers as actor `user` and uses `autorestart` to restart workers with a
large context on its own. Tests: `node --test scripts/beadskit/leitstand/*.test.mjs`.

The page has five tabs (at the top, at the bottom on the iPhone; `#<slug>/<tab>`, keys 1–5):
**Entscheiden** (decide: prompts and `human`), **Worker** (metrics, controls, CI runners),
**Board**, **PRs** and **System** (`/api/system`: total and per-core CPU with history, load, RAM,
disk, temperature, services per machine from hosts.conf, via `host-agent.mjs system`; plus the
`servers` from `beads.leitstand.mjs`, measured via ssh with an sh script, without node or beadskit
there). Above input fields there are tap-to-use answers (decision, close reason, chat, title
templates, filters); on touch devices the ⇄ button on the card replaces dragging. Can be added to
the home screen as a web app.

Remote access: `scripts/beadskit/leitstand/leitstand-remote` (login with a token or user/password
`leitstand-remote password [user]`, back to the token with `password --off`; per-IP lockout for
15 min after 5 failed attempts; once a token file exists, the local Leitstand also requires the
login; SSH reverse tunnel, nginx with HTTPS, Basic Auth only with
`server-setup --basic-auth`; help in the script's header). Token, password and Basic Auth live in
`~/.config/beadskit/`, domain, SSH host etc. optionally in `~/.config/beadskit/remote.conf`
(`LEITSTAND_PUBLIC_URL=…`). `install` takes over the token and password of an earlier,
project-specific Leitstand (`<git-dir>/<slug>-leitstand-*`) and removes its launchd services.

**CI runner pool:** A runner under a personal GitHub account always serves only one repo.
That is why all projects share one pool: the `beadskit-runner-pool` service on the server starts a
one-off runner (JIT) for each waiting job, for exactly that repo, taking the oldest jobs first
across all repos. At most `SLOTS` run at the same time (default 4). After the job the container is
deleted; a runner without a job after 10 min. Workflows:
`runs-on: [self-hosted, <slug>, "run-${{ github.run_id }}"]`. The run label is optional; without it
everything works as before. Only with it does a runner take just the jobs of its own run, and a
single PR can be moved to the front. Run `runner-pool setup` first (service 1.7.0 or later), then
switch the workflows: an older service starts runners without the label, and the jobs would stay
„Queued“.
- All containers run in the systemd slice `beadskit-ci.slice` with an overall cap
  (`RUNNER_CI_CPUS` cores, `RUNNER_CI_MEM`) and low CPU and IO weight.
- Each slot has volumes for `_work/_tool` and `~/.cache`.
- The CI MySQL (host `mysql`) runs as soon as a project sets `RUNNER_MYSQL`, the CI MariaDB (host
  `mariadb`) with `RUNNER_MARIADB`. Both keep their data in RAM (root password `ci`); tests create
  their own database per run. Pool runners have no Docker, so Testcontainers does not work there.
- Commands: `scripts/beadskit/ci/runner-pool setup|set-token|status|size <n>|start|stop|logs|remove`,
  plus `start|stop mysql|mariadb`.
- Per project (label): `runner-pool limit <label> <1–8|off>` limits the project's concurrent
  runners, `pause|resume <label>` stops it from getting new runners (idle ones end immediately,
  running jobs finish). Stored in `/etc/beadskit-ci/projects.json` on the server; `setup` leaves it
  in place, and changes take effect from the next round.
- Moving to the front: `runner-pool prio <owner/repo> <run-id>` puts a run at the head of the
  queue (`--off <owner/repo> <run-id>` removes it, `--clear` all). Stored in
  `/etc/beadskit-ci/prio`; the service removes finished runs itself. A runner with a run label
  whose run has nothing left waiting (cancelled) ends after 60 s instead of 10 min.
- `setup` reads all projects from `~/.config/beadskit/projects.txt` whose workflows use
  `self-hosted`, and merges their `RUNNER_APT` into one image. Run `setup` again after every change.
- Token: fine-grained PAT for these repos with Administration (Read and write) and Actions (Read),
  entered with `runner-pool set-token`. It is stored only on the server.
- If jobs hang in „Queued“, check `runner-pool status` and `runner-pool logs` first. The service also
  serves runs that GitHub leaves on „pending“ although their jobs are queued; a run waiting longer than
  `STALE` (pool.conf, default 1800 s) is flagged in `status` („wartet seit …“, plus „Lauf pending“) and
  in the dashboard („lange wartend“), also when the pool is simply full. It is never cancelled
  automatically: if it still does not start, cancel it with `gh run cancel <run-id>`.
- The Leitstand's „CI“ tab (the same for all projects, key 6) shows the slots; per project the
  runners, waiting jobs, limit −/+ and pause/resume; the runners with project and job, CPU/RAM, the
  CI databases and the service log, with slots −/+ and pool on/off. Below that, the queue of all
  projects per run (PR, jobs, waiting since) in the service's order, with „Vorziehen“ (move to
  front) and „Zurück“ (back). The worker tab now shows only one line about it.

## beads.project.sh

| Variable | Meaning | Default |
|---|---|---|
| `BK_NAME` | display name in the Leitstand | folder name |
| `BK_SLUG` | drain file `.git/<slug>-workers-drain`, project in the Leitstand, runner label | from `BK_NAME` |
| `BK_BASE` | target branch of the PRs | `main` |
| `BK_SKILL_PREFIX` | skills `/<prefix>-<role>` | `BK_SLUG` |
| `BK_ROLES` | roles (a-z only) | `fix search verify regress` |
| `BK_MODULES` | values for `modul:<x>` | empty |
| `BK_START` | default for `workers start` | `fix=2 search=1 verify=1 regress=0` |
| `bk_prompt <role>` | custom start command per role (function, optional) | `/loop … /<prefix>-<role>` |
| `BK_PHASES` | phases of code; workers claim the first one | `fix verify merge` |
| `BK_WORKSPACES` | additional workspaces (a-z only), issues with label `ws:<name>` | empty |
| `BK_WS_<ws>_NAME` / `_ROLES` / `_START` / `_PHASES` | display name, roles, default, phases (`key:Title`) | – |
| `bk_color <role>` | iTerm tab color `"r g b"` (function, optional) | per role |
| `BK_REPOS` | additional repos `<key>:<path>`; label `modul:<key>` → work there | empty |
| `RUNNER_APT`, `RUNNER_MYSQL`, `RUNNER_MARIADB` | extra packages in the pool image (merged across all projects), version of the CI MySQL or CI MariaDB | empty |
| `RUNNER_CPUS`, `RUNNER_MEM` (environment of `runner-pool setup`) | limits per pool runner | `2`, `6g` |
| `RUNNER_CI_CPUS`, `RUNNER_CI_MEM` (likewise) | cap for all CI containers together (slice `beadskit-ci.slice`) | `4`, `24G` |

Roles consist of a-z and `-` (`club-add`). A worker `<role>-<n>` belongs to the workspace of
its role; `start` starts exactly one workspace and cancels only that workspace's drain.

## beads.leitstand.mjs

Optional in the project root, an ES module with `export default { … }`. The Leitstand reloads it
whenever it changes; errors in it only disable the extensions (with a note in the log).

```js
export default {
  // texts and extra columns per workspace (all optional)
  workspaces: {
    clubs: {
      roleLabels: { 'club-add': 'Anlegen' },
      colors: { 'club-add': '#e6781e' },                       // CSS color for the page
      cols: { settings: { title: 'Settings', color: '#1ea0aa', hint: 'SiteSetting einrichten' } },
      split: [{ key: 'activate', label: 'aktivieren', title: 'zum Aktivieren' }],  // human + label → own column
      group: { prefix: 'stadt:', all: 'alle Städte' },         // filter and card tag instead of modul:
      create: { type: 'task', title: 'Neuer Club', fields: [{ name: 'stadt', label: 'Stadt', prefix: 'stadt:' }] },
      humanHint: 'HTML-Hinweis über „Wartet auf dich“', release: 'Freigeben', prs: false,
      // tap-to-use answers (at most 12 each, 120 characters each); if a list is missing, the default applies
      quick: { decide: ['Ja, aktivieren', 'Nein'], close: ['Kein Club', 'Duplikat'], chat: ['Weiter'] },
    },
  },
  // extra details per card: logo, links (http/https only), tags
  card: (issue) => ({ logo: issue.metadata?.logo_url, links: [{ href: '…', text: 'Admin' }], tags: [] }),
  // buttons on issues (inbox and detail). primary replaces „Freigeben“. run gets exec (no shell,
  // cwd = project) and returns bdw steps that the Leitstand runs afterwards.
  actions: [{
    key: 'activate', title: 'Aktivieren', primary: true, confirm: 'Wirklich aktivieren?',
    applies: (it) => it.labels.includes('human') && it.labels.includes('aktivieren'),
    check: (it) => (it.metadata?.place_id ? null : 'Metadatum place_id fehlt'),
    run: async ({ issue, exec }) => { await exec('node', ['scripts/x.mjs', String(issue.metadata.place_id)]);
      return [['close', issue.id, '--reason', 'aktiviert']]; },
  }],
  // extra lists below the board: items(issues, now) → [{ id, title, text, href, linkText, at }]
  panels: [{ key: 'cities', title: 'Neue Städte', ws: 'clubs', items: (issues, now) => [] }],
  // servers without beadskit in the System tab (Linux, at most 4): ssh target without options, services =
  // systemd units (at most 12), read-only via /proc, df, docker ps and systemctl is-active
  servers: [{ name: 'prod', ssh: 'server', services: ['nginx', 'mysql'] }],
};
```
