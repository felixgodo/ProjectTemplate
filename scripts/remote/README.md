# Two machines: Mac + Linux box

**English** · [Deutsch](README.de.md)

The PC (Ubuntu Server, always on) **leads**: it holds the shared beads database of all projects
and the Leitstand (control room). The Mac joins as a second worker machine whenever it is free.
Workers on both machines claim from the same queue; code goes through GitHub as usual (branch
`fix/<id>`, PR). Everything is operated from the Mac: the Leitstand in the browser, `pc …` in the terminal.

```
Mac                                      PC (leader, tailnet name pc)
  Worker fix-1, search-1 (iTerm)  ──┐      Worker fix-101, verify-101 … (tmux bk-<slug>)
  bd → pc:3307  ────────────────────┼───→  beads-dolt (dolt sql-server, all projects)
  http://127.0.0.1:3738 ── ssh -L ──┼───→  Leitstand :3738 ── ssh -R ──→ server (nginx, HTTPS)
  pc workers|attach|dev|forward ────┘      ↑ asks the Mac via ssh for its workers
```

| File | Where | |
|---|---|---|
| `setup-linux.sh` | PC | Tools, Tailscale, no sleep, ssh, firewall, beads-dolt, clone projects |
| `setup-mac.sh` | Mac | ssh in both directions, `hosts.conf` on both, database access, rsync, `pc` |
| `migrate-beads.sh` | Mac | beads databases Mac → PC (`--back`: back again) |
| `pc` | Mac | Run commands in the same project on the PC |
| `versions.conf`, `repos.txt` | – | Versions (bd/dolt must match on both!), projects with a GitHub repo (`repos.txt` local only, template `repos.txt.example`) |
| `beads-backup.sh` | PC | Daily backup of the issues as JSONL (timer) |

## Setup

**1. Install Ubuntu.** Ubuntu Server 24.04 LTS, server name `pc`, tick *Install OpenSSH
server* and *Import SSH key from GitHub* (`felixgodo`), no snaps. In the storage layout, grow
`ubuntu-lv` to the full size.

**2. On the PC** (via `ssh <user>@<ip>` from the Mac):
```bash
git clone https://github.com/felixgodo/ProjectTemplate ~/IdeaProjects/ProjectTemplate
~/IdeaProjects/ProjectTemplate/scripts/remote/setup-linux.sh
```
Along the way it asks you to log in twice (confirm the link or code in the Mac browser):
`tailscale up`, `gh auth login` (the projects are private). Afterwards start `claude` once and log in.
If the ssh key was missing: from the Mac run `ssh-copy-id <user>@<ip>`, then `setup-linux.sh ssh`.

**3. On the Mac:**
```bash
brew install --cask tailscale        # start it, log in with the same account
# System Settings → General → Sharing → Remote Login: on (the PC asks the Mac about its workers)
scripts/remote/setup-mac.sh
```
`devkit-projects.txt` and `repos.txt` are not versioned (the project names stay private):
`setup-mac.sh` writes `repos.txt`, copies both to the PC and clones the projects there.

**4. Move the databases** (once; first let the workers on the Mac drain and stop the
Leitstand there):
```bash
scripts/beadskit/workers drain          # per project, wait until workers ls shows all idle
scripts/beadskit/leitstand/leitstand-remote uninstall
scripts/remote/migrate-beads.sh --dry-run
scripts/remote/migrate-beads.sh
```

**5. Leitstand on the PC, only the link here:**
```bash
pc leitstand install                    # PC: Leitstand + back channel to the server, Mac: ssh -L 3738
pc doctor
```

## Usage

```bash
pc workers start                       # on the PC: fix-101, fix-102, search-101, verify-101
scripts/beadskit/workers start         # on the Mac: fix-1, fix-2, search-1 (HOST_mac_ROLES)
pc attach                              # tmux session of the PC workers (Ctrl+B D to detach, Ctrl+B n next window)
pc attach fix-101
pc dev start                           # ./dev.sh start on the PC …
pc forward 5200 8100                   # … and in the Mac browser http://localhost:5200
pc drain-host mac                      # before closing the lid: drain only the Mac workers
pc drain-host mac --off
pc leitstand                           # http://127.0.0.1:3738: workers of both machines, machine badge per card
beads-top                              # the same as a live overview in the terminal (Mac and PC, q quits)
```

In the Leitstand: at the top, one chip per machine (★ = leader, red = unreachable) with its own
"drain", next to it "New on" for start and +1. Send, restart and stop run on the worker's
machine.

## Rules

- **verify and regress on the PC.** A sleeping Mac holding the merge slot stalls every merge.
  Without arguments, `workers start` on the Mac starts only `HOST_mac_ROLES` (fix, search) and warns
  about other roles.
- **Run `pc drain-host mac` before closing the lid.** Otherwise leases expire, `bd reclaim` releases
  the issue, and when the Mac wakes up again you may end up with a duplicate PR.
- **PC off = Mac workers don't claim.** By design: there is only one database, never two
  diverging ones. For a longer period with just the Mac: `scripts/remote/migrate-beads.sh --back`,
  later run it again without `--back`.
- **Same bd and dolt version** on both machines (`versions.conf`, `pc doctor`).
- Docker data (the projects' MariaDB) is separate per machine.
- Docker publishes ports bypassing ufw: bind them in `docker-compose.yml` as `127.0.0.1:<port>:<port>`.

## How it works

- `~/.config/beadskit/hosts.conf` on both machines (written by `setup-mac.sh`): `LEADER`, `SELF`,
  `BK_HOST_BASE` (worker numbers: Mac 1…, PC 101…), and per machine `HOST_<h>_SSH`, `HOST_<h>_ROOT`,
  `HOST_<h>_ROLES`. Without the file everything behaves as with a single machine.
- `.beads/metadata.json` points to `dolt_server_host: pc`, port in `.beads/dolt-server.port`,
  password in `~/.config/beads/credentials` (`[pc:3307]`). Because the host is not localhost, bd
  never starts a server itself: if the PC is gone, bd fails instead of silently creating an empty database.
- Drain and auto-restart then live in `bd kv` (`beadskit.drain`, `.drain-<role>`,
  `.drain@<machine>`, `.autorestart`) instead of files in the Git directory, so both machines see them.
- The Leitstand calls the other machine via ssh (`scripts/beadskit/on-host` +
  `leitstand/host-agent.mjs` in the same project there); transcripts stay where the worker runs.
- On Linux, workers run as windows of the tmux session `bk-<slug>`, started in their own
  systemd scopes: restarting the Leitstand service does not kill them.
