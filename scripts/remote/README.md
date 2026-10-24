# Zwei Rechner: Mac + Linux-PC

Der PC (Ubuntu Server, läuft immer) **leitet**: Er hält die gemeinsame beads-Datenbank aller
Projekte und den Leitstand. Der Mac klinkt sich als zweiter Worker-Rechner ein, wenn er frei ist.
Worker beider Rechner claimen aus derselben Warteschlange; Code geht wie immer über GitHub (Branch
`fix/<id>`, PR). Bedient wird alles vom Mac aus: Leitstand im Browser, `pc …` im Terminal.

```
Mac                                      PC (Leitrechner, Tailnet-Name pc)
  Worker fix-1, search-1 (iTerm)  ──┐      Worker fix-101, verify-101 … (tmux bk-<slug>)
  bd → pc:3307  ────────────────────┼───→  beads-dolt (dolt sql-server, alle Projekte)
  http://127.0.0.1:3738 ── ssh -L ──┼───→  Leitstand :3738 ── ssh -R ──→ server (nginx, HTTPS)
  pc workers|attach|dev|forward ────┘      ↑ fragt den Mac per ssh nach dessen Workern
```

| Datei | Wo | |
|---|---|---|
| `setup-linux.sh` | PC | Werkzeuge, Tailscale, kein Ruhezustand, ssh, Firewall, beads-dolt, Projekte klonen |
| `setup-mac.sh` | Mac | ssh in beide Richtungen, `hosts.conf` auf beiden, Datenbank-Zugang, rsync, `pc` |
| `migrate-beads.sh` | Mac | beads-Datenbanken Mac → PC (`--back`: zurück) |
| `pc` | Mac | Befehle im selben Projekt auf dem PC |
| `versions.conf`, `repos.txt` | – | Versionen (bd/dolt gleich auf beiden!), Projekte mit GitHub-Repo |
| `beads-backup.sh` | PC | tägliche Sicherung der Issues als JSONL (Timer) |

## Einrichten

**1. Ubuntu installieren.** Ubuntu Server 24.04 LTS, Servername `pc`, Häkchen bei *Install OpenSSH
server* und *Import SSH key from GitHub* (`felixgodo`), keine Snaps. Bei der Speicheraufteilung
`ubuntu-lv` auf die volle Größe stellen.

**2. Auf dem PC** (per `ssh <benutzer>@<ip>` vom Mac):
```bash
git clone https://github.com/felixgodo/ProjectTemplate ~/IdeaProjects/ProjectTemplate
~/IdeaProjects/ProjectTemplate/scripts/remote/setup-linux.sh
```
Unterwegs fragt es zweimal nach einer Anmeldung (Link bzw. Code im Mac-Browser bestätigen):
`tailscale up`, `gh auth login` (die Projekte sind privat). Danach einmal `claude` starten und anmelden.
Fehlte der ssh-Schlüssel: vom Mac `ssh-copy-id <benutzer>@<ip>`, dann `setup-linux.sh ssh`.

**3. Auf dem Mac:**
```bash
brew install --cask tailscale        # starten, mit demselben Konto anmelden
# Systemeinstellungen → Allgemein → Teilen → Entfernte Anmeldung: an (der PC fragt den Mac nach seinen Workern)
scripts/remote/setup-mac.sh
```

**4. Datenbanken umziehen** (einmal; vorher Worker auf dem Mac auslaufen lassen und den
Leitstand dort anhalten):
```bash
scripts/beadskit/workers drain          # je Projekt, warten bis workers ls alle idle zeigt
scripts/beadskit/leitstand/leitstand-remote uninstall
scripts/remote/migrate-beads.sh --dry-run
scripts/remote/migrate-beads.sh
```

**5. Leitstand auf den PC, hier nur der Link:**
```bash
pc leitstand install                    # PC: Leitstand + Rückkanal zum Server, Mac: ssh -L 3738
pc doctor
```

## Bedienen

```bash
pc workers start                       # auf dem PC: fix-101, fix-102, search-101, verify-101
scripts/beadskit/workers start         # auf dem Mac: fix-1, fix-2, search-1 (HOST_mac_ROLES)
pc attach                              # tmux-Session der PC-Worker (Ctrl+B D zurück, Ctrl+B n nächstes Fenster)
pc attach fix-101
pc dev start                           # ./dev.sh start auf dem PC …
pc forward 5200 8100                   # … und im Mac-Browser http://localhost:5200
pc drain-host mac                      # vor dem Zuklappen: nur die Mac-Worker auslaufen lassen
pc drain-host mac --off
pc leitstand                           # http://127.0.0.1:3738: Worker beider Rechner, Rechner-Badge je Karte
```

Im Leitstand: oben je Rechner ein Chip (★ = Leitrechner, rot = nicht erreichbar) mit eigenem
„auslaufen“, daneben „Neue auf“ für Starten und +1. Senden, Neu starten und Stoppen laufen auf dem
Rechner des Workers.

## Regeln

- **verify und regress auf dem PC.** Ein schlafender Mac mit dem Merge-Slot hält jedes Mergen
  an. `workers start` startet auf dem Mac ohne Angabe nur `HOST_mac_ROLES` (fix, search) und warnt bei
  anderen Rollen.
- **Vor dem Zuklappen `pc drain-host mac`.** Sonst laufen Leases ab, `bd reclaim` gibt das Issue
  frei, und wacht der Mac wieder auf, entsteht womöglich ein doppelter PR.
- **PC aus = Mac-Worker claimen nicht.** Gewollt: Es gibt nur eine Datenbank, nie zwei
  auseinanderlaufende. Für eine längere Zeit nur mit dem Mac: `scripts/remote/migrate-beads.sh --back`,
  später wieder ohne `--back`.
- **bd und dolt gleiche Version** auf beiden Rechnern (`versions.conf`, `pc doctor`).
- Docker-Daten (MariaDB der Projekte) sind je Rechner getrennt.
- Docker veröffentlicht Ports an ufw vorbei: in `docker-compose.yml` als `127.0.0.1:<port>:<port>` binden.

## Wie es funktioniert

- `~/.config/beadskit/hosts.conf` auf beiden Rechnern (schreibt `setup-mac.sh`): `LEADER`, `SELF`,
  `BK_HOST_BASE` (Worker-Nummern: Mac 1…, PC 101…), je Rechner `HOST_<h>_SSH`, `HOST_<h>_ROOT`,
  `HOST_<h>_ROLES`. Ohne die Datei verhält sich alles wie mit einem Rechner.
- `.beads/metadata.json` zeigt auf `dolt_server_host: pc`, Port in `.beads/dolt-server.port`,
  Passwort in `~/.config/beads/credentials` (`[pc:3307]`). Weil der Host nicht localhost ist, startet
  bd nie selbst einen Server: Ist der PC weg, scheitert bd, statt still eine leere Datenbank anzulegen.
- Drain und Auto-Neustart stehen dann in `bd kv` (`beadskit.drain`, `.drain-<rolle>`,
  `.drain@<rechner>`, `.autorestart`) statt in Dateien im Git-Verzeichnis, damit beide Rechner sie sehen.
- Der Leitstand ruft den anderen Rechner per ssh auf (`scripts/beadskit/on-host` +
  `leitstand/host-agent.mjs` im selben Projekt dort); die Transkripte bleiben, wo der Worker läuft.
- Unter Linux laufen Worker als Fenster der tmux-Session `bk-<slug>`, gestartet in eigenen
  systemd-Scopes: Ein Neustart des Leitstand-Dienstes beendet sie nicht.
