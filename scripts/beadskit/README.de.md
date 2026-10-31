# beadskit

[English](README.md) · **Deutsch**

Parallele Claude-Worker über eine [beads](https://github.com/gastownhall/beads)-Warteschlange und
ein Leitstand für alle Projekte. In allen Projekten identisch; die Quelle liegt im
`ProjectTemplate`. **Nicht im Projekt ändern** – im Template ändern, `scripts/beadskit/VERSION`
hochzählen und mit `./beadskit-sync.sh --apply` verteilen.

```
beads.project.sh        im Projekt: Name, Slug, Ziel-Branch, Rollen, Workspaces, Module, Repos
beads.leitstand.mjs     im Projekt, optional: Knöpfe, Zusatzlisten, Links und Texte für den Leitstand
scripts/beadskit/
  bdw                   bd mit Worktree-Name als Actor
  on-host               Einstieg für Befehle per ssh vom anderen Rechner (PATH, Projektordner)
  workers               Worker starten/hinzufügen/auslaufen/stoppen/neu starten, Chat (send),
                        drain-check, repo-for, config (JSON für den Leitstand); Tests workers.test.mjs
  leitstand/            Web-Leitstand (inbox.mjs + inbox.html), Tests, Fernzugang (leitstand-remote),
                        host-agent.mjs (Worker dieses Rechners für den Leitstand auf dem anderen)
  ci/runner-pool        gemeinsamer CI-Runner-Pool aller Projekte auf dem Server (Dienst: runner-pool-daemon)
  ci/runner-server      alte feste Runner je Repo (nur noch zum Abbauen: runner-server remove)
  ci/lib.sh             Runner-Image, CI-Slice und Messung für beide
  templates/            Vorlagen für --adopt: beads.project.sh, Skills, reviews/README.md
```

## Ablauf

| Rolle | Skill | macht |
|---|---|---|
| search | `/<slug>-search` | sucht Bugs, legt beads-Issues an (`phase:fix`), ändert keinen Code |
| fix | `/loop 10m /<slug>-fix` | claimt ein Issue, Branch `fix/<id>`, Test + Review-Datei, PR gegen `BK_BASE` → `phase:verify` |
| verify | `/loop 5m /<slug>-verify` | prüft PRs unabhängig → `phase:merge` oder zurück; merged seriell im Merge-Slot nach grüner CI |
| regress | `/loop 30m /<slug>-regress` | prüft `BK_BASE` mit allen Prüfkommandos, meldet Regressionen |

Was die Worker prüfen, steht in der `CLAUDE.md` des Projekts (Prüfkommandos, Review-Pflicht), die
Regeln in `.claude/skills/worker-regeln.md` (aus der Vorlage, Abschnitt „Projektspezifisch“ füllen).

## Einrichten

```bash
# im Template
./beadskit-sync.sh --adopt MeinProjekt --slug meinprojekt --base main --modules "backend frontend" --prefix mp
# im Projekt
bd init --prefix mp                                   # .beads/ lokal, nicht ins Git
for m in backend frontend tests; do scripts/beadskit/bdw create "Epic $m" -t epic --external-ref "epic:$m"; done
scripts/beadskit/workers start --dry-run
```

## Bedienen

```bash
scripts/beadskit/workers start fix=2 search=1 verify=1     # Gesamtzahl je Rolle (Workspace code)
scripts/beadskit/workers start --ws clubs                  # anderer Workspace, Vorgabe BK_WS_clubs_START
scripts/beadskit/workers add fix                           # einen weiteren
scripts/beadskit/workers ls
scripts/beadskit/workers drain && scripts/beadskit/workers ls   # warten bis idle
scripts/beadskit/workers stop --all
scripts/beadskit/workers restart fix-2                     # frischer Kontext, nur zwischen zwei Runden
scripts/beadskit/workers autorestart --over 200k           # macht der Leitstand dann selbst
scripts/beadskit/workers top                               # Live-Übersicht: Rechner (CPU, RAM, SSD …), Projekte, Worker
scripts/beadskit/workers screen fix-2                       # Bildschirm des Terminals (z. B. eine Rückfrage)
scripts/beadskit/workers press fix-2 2                     # Rückfrage mit Taste 2 beantworten (1–9, Escape, Enter)
scripts/beadskit/workers send fix-2 -- /compact            # Zeile ins Terminal tippen (iTerm-Tab, tmux-Fenster)
```

- `drain` lässt die Worker den laufenden Schritt fertig machen, sie claimen nichts Neues.
  `drain fix` lässt nur eine Rolle auslaufen, `drain fix --off` hebt das auf, `drain --off`
  (und `start`) hebt alles auf. `add` verweigert bei aktivem Drain.
- `stop` ohne Drain verweigert bei arbeitenden Workern, `--force` übergeht das.
- `add` nimmt die nächste freie Nummer und öffnet die Tabs im vordersten iTerm-Fenster; so arbeiten
  auch „+1“ und „Pipeline starten“ im Leitstand.
- `restart` nur zwischen zwei Runden: idle, ohne Claim, ohne Merge-Slot, nicht bei Drain
  (`--force` übergeht). iTerm-Worker bekommen SIGTERM, der Startbefehl wird per AppleScript in
  denselben Tab getippt. Ein Worker unter `/loop` sammelt sonst alle Runden in einer Session.
- Hintergrund-Worker (`--bg`) erreicht man nur über `workers attach <name>`, nicht über `send`.

Worker laufen im Terminal, Farbe je Rolle: auf dem Mac als iTerm-Tabs, unter Linux als Fenster
der tmux-Session `bk-<slug>` (`workers attach <name>`). `--term iterm|tmux|bg` bzw. `BK_TERM`
wählt selbst, `--bg` startet Hintergrund-Sessions; ohne steuerbares Terminal automatisch im
Hintergrund.

**Zwei Rechner** (`~/.config/beadskit/hosts.conf`, Einrichtung in
`ProjectTemplate/scripts/remote`): Worker heißen `<rolle>-<BK_HOST_BASE + n>` (Mac `fix-1`, PC
`fix-101`), Drain und Auto-Neustart liegen in `bd kv` der gemeinsamen Datenbank,
`workers drain --host <rechner>` lässt nur einen Rechner auslaufen, `HOST_<h>_ROLES` begrenzt, was
`start` dort ohne Angabe startet. Der Leitstand auf dem Leitrechner zeigt die Worker beider Rechner
(per ssh: `on-host` + `leitstand/host-agent.mjs`) und führt Aktionen auf dem Rechner des Workers aus.

**Leitstand:** `./leitstand.sh` im ProjectTemplate (oder `node scripts/beadskit/leitstand/inbox.mjs`
aus einem beliebigen eingerichteten Projekt) → http://127.0.0.1:3738, beenden mit Ctrl+C. Ein Prozess für alle Projekte; Umschalter oben (`#<slug>` in
der Adresse), daneben der Umschalter der Workspaces. Die Liste steht in
`~/.config/beadskit/projects.txt` – `workers` trägt sein Projekt bei jedem Aufruf ein. Der
Leitstand zeigt Kennzahlen (neben „bereit“ die Kachel „bereit: <erste Phase>“ = davon freigegeben, nur die claimen Worker), Worker-Karten mit Detail (Chat aus dem Transkript, Senden in den
iTerm-Tab, Neu starten), „Wartet auf dich“ (Label `human`; hängt ein Issue per `blocks` an einem anderen, zeigt die Kachel
„wartet auf <id>“ mit Link und Stand bzw. „Abhängigkeit erledigt“, das Board ein Badge ⏳; Mehrfachauswahl per Haken,
„alle“ oder „nur …“ (Split wie „zum Aktivieren“, Gruppe wie Stadt), dann Knopf-Aktion, Freigeben, Zurückstellen oder Schließen
für alle mit gemeinsamem Text: läuft je Issue über dieselben Endpunkte, höchstens 2 gleichzeitig, mit Fortschritt und Abbrechen;
eine Knopf-Aktion gilt nur für die Karten, an denen sie frei ist, Fehler bleiben an der Karte), Kanban mit Drag & Drop je Workspace,
PRs mit CI-Stand (aller Repos aus `BK_REPOS`) und die CI-Runner, wenn das Projekt welche nutzt.
Er steuert Issues und Worker als Actor `user` und startet mit `autorestart` Worker mit großem
Kontext selbst neu. Tests: `node --test scripts/beadskit/leitstand/*.test.mjs`.

Die Seite hat fünf Tabs (oben, auf dem iPhone unten; `#<slug>/<tab>`, Tasten 1–5): **Entscheiden**
(Rückfragen und `human`), **Worker** (Kennzahlen, Steuerung, CI-Runner), **Board**, **PRs** und
**System** (`/api/system`: CPU gesamt und je Kern mit Verlauf, Load, RAM, Platte, Temperatur,
Dienste je Rechner aus hosts.conf, über `host-agent.mjs system`; dazu die `servers` aus
`beads.leitstand.mjs`, gemessen per ssh mit einem sh-Skript, ohne node und beadskit dort). Über Eingabefeldern stehen
Antworten zum Antippen (Entscheidung, Schließgrund, Chat, Titel-Vorlagen, Filter); auf Touch-Geräten
ersetzt der Knopf ⇄ an der Karte das Ziehen. Als Web-App auf den Home-Bildschirm legbar.

Fernzugang: `scripts/beadskit/leitstand/leitstand-remote` (Login mit Token oder Benutzer/Passwort
`leitstand-remote password [benutzer]`, zurück auf das Token mit `password --off`; Sperre je IP
nach 5 Fehlversuchen für 15 min; ist eine Token-Datei angelegt, verlangt auch der lokale Leitstand
den Login; SSH-Rückkanal, nginx mit HTTPS, Basic-Auth nur mit
`server-setup --basic-auth`; Hilfe im Kopf des Skripts). Token, Passwort und Basic-Auth liegen in
`~/.config/beadskit/`, Domain, SSH-Host usw. optional in `~/.config/beadskit/remote.conf`
(`LEITSTAND_PUBLIC_URL=…`). `install` übernimmt Token und Passwort eines früheren,
projekteigenen Leitstands (`<git-dir>/<slug>-leitstand-*`) und entfernt dessen launchd-Dienste.

**CI-Runner-Pool:** Ein Runner unter einem persönlichen GitHub-Konto gilt immer nur für ein Repo.
Deshalb teilen sich alle Projekte einen Pool: Der Dienst `beadskit-runner-pool` auf dem Server
startet für jeden wartenden Job einen Einmal-Runner (JIT) für genau dieses Repo und nimmt dabei die
ältesten Jobs zuerst, über alle Repos. Höchstens `SLOTS` laufen gleichzeitig (Vorgabe 4). Nach dem
Job wird der Container gelöscht, ein Runner ohne Job nach 10 min. Workflows:
`runs-on: [self-hosted, <slug>, "run-${{ github.run_id }}"]`. Das Run-Label ist optional, ohne es
geht alles wie bisher; erst damit nimmt ein Runner nur Jobs seines Laufs und ein einzelner PR lässt
sich vorziehen. Erst `runner-pool setup` (Dienst ab 1.7.0), dann die Workflows umstellen: Ein
älterer Dienst startet Runner ohne das Label, die Jobs blieben „Queued“.
- Alle Container laufen in der systemd-Slice `beadskit-ci.slice` mit Gesamtdeckel
  (`RUNNER_CI_CPUS` Kerne, `RUNNER_CI_MEM`) und niedrigem CPU- und IO-Gewicht.
- Je Platz gibt es Volumes für `_work/_tool` und `~/.cache`.
- Die CI-MySQL (Host `mysql`) läuft, sobald ein Projekt `RUNNER_MYSQL` setzt, die CI-MariaDB (Host
  `mariadb`) bei `RUNNER_MARIADB`. Beide halten ihre Daten im RAM (root-Passwort `ci`), Tests legen
  sich je Lauf eine eigene Datenbank an. Pool-Runner haben kein Docker, Testcontainers geht dort nicht.
- Befehle: `scripts/beadskit/ci/runner-pool setup|set-token|status|size <n>|start|stop|logs|remove`,
  dazu `start|stop mysql|mariadb`.
- Je Projekt (Label): `runner-pool limit <label> <1–8|off>` begrenzt die gleichzeitigen Runner des
  Projekts, `pause|resume <label>` lässt es keine neuen Runner bekommen (freie enden sofort, laufende
  Jobs laufen zu Ende). Steht in `/etc/beadskit-ci/projects.json` auf dem Server, `setup` lässt sie
  stehen und wirkt ab der nächsten Runde.
- Vorziehen: `runner-pool prio <owner/repo> <run-id>` stellt einen Lauf an den Anfang der
  Warteschlange (`--off <owner/repo> <run-id>` nimmt ihn heraus, `--clear` alle). Steht in
  `/etc/beadskit-ci/prio`, abgeschlossene Läufe entfernt der Dienst selbst. Ein Runner mit Run-Label,
  dessen Lauf nichts mehr wartet (abgebrochen), endet nach 60 s statt nach 10 min.
- `setup` liest alle Projekte aus `~/.config/beadskit/projects.txt`, deren Workflows `self-hosted`
  nutzen, und vereint ihre `RUNNER_APT` in einem Image. Nach jeder Änderung daran `setup` erneut.
- Token: Fine-grained PAT für diese Repos mit Administration (Read and write) und Actions (Read),
  einzugeben mit `runner-pool set-token`. Er liegt nur auf dem Server.
- Hängen Jobs in „Queued“, zuerst `runner-pool status` und `runner-pool logs` prüfen. Der Dienst
  bedient auch Läufe, die GitHub auf „pending“ stehen lässt, obwohl ihre Jobs warten; ein Lauf, der
  länger als `STALE` wartet (pool.conf, Vorgabe 1800 s), steht in `status` mit „wartet seit …“ (und
  „Lauf pending“) und im Leitstand als „lange wartend“, auch wenn der Pool nur voll ist. Abgebrochen
  wird nie automatisch: läuft er trotzdem nicht an, `gh run cancel <run-id>`.
- Zweiter Rechner: `runner-pool setup --host pc` (vom Mac) richtet auf dem PC einen user-Dienst ein,
  ohne sudo außer einmalig für die Slice (CPUQuota 800 %, MemoryMax 18G) und die Netztrennung
  (`beadskit-ci-net`: CI-Container erreichen das Internet, aber nicht Rechner, Heimnetz oder Tailnet);
  den einen sudo-Befehl nennt das Kommando. Jeder Rechner hat einen eigenen Dienst, GitHub ist die
  gemeinsame Wahrheit: Der Plan zählt die Runner des anderen mit (versorgte Jobs, Grenzen je Projekt),
  angefasst werden nur eigene. Der Server bleibt die Zentrale und braucht keinen Zugang zum PC; der PC
  holt je Runde `projects.json`, `prio` und `hosts.json` und legt dort seinen Zustand ab, fällt er aus,
  läuft der Server allein weiter. `runner-pool drain <host> [--off]` und `size <n> --host <h>`
  (`/etc/beadskit-ci/hosts.json`): keine neuen Runner, freie enden sofort, laufende Jobs laufen zu Ende.
  `runner-pool stop` stoppt nur den Dienst auf dem Server.
- Der Leitstand zeigt im Tab „CI“ (für alle Projekte gleich, Taste 6) die Plätze, je Projekt Runner,
  wartende Jobs, Grenze −/+ und Pausieren/Fortsetzen, die Runner mit Projekt und Job, CPU/RAM, die
  CI-Datenbanken und das Log des Dienstes, mit Plätze −/+ und Pool an/aus. Darunter die
  Warteschlange aller Projekte je Lauf (PR, Jobs, seit wann) in der Reihenfolge des Dienstes, mit
  „Vorziehen“ und „Zurück“. Der Worker-Tab zeigt nur noch eine Zeile dazu.

## beads.project.sh

| Variable | Bedeutung | Vorgabe |
|---|---|---|
| `BK_NAME` | Anzeigename im Leitstand | Ordnername |
| `BK_SLUG` | Drain-Datei `.git/<slug>-workers-drain`, Projekt im Leitstand, Runner-Label | aus `BK_NAME` |
| `BK_BASE` | Ziel-Branch der PRs | `main` |
| `BK_SKILL_PREFIX` | Skills `/<prefix>-<rolle>` | `BK_SLUG` |
| `BK_ROLES` | Rollen (nur a-z) | `fix search verify regress` |
| `BK_MODULES` | Werte für `modul:<x>` | leer |
| `BK_START` | Vorgabe für `workers start` | `fix=2 search=1 verify=1 regress=0` |
| `bk_prompt <rolle>` | eigener Startbefehl je Rolle (Funktion, optional) | `/loop … /<prefix>-<rolle>` |
| `BK_PHASES` | Phasen von code; die erste claimen Worker | `fix verify merge` |
| `BK_WORKSPACES` | weitere Workspaces (nur a-z), Issues mit Label `ws:<name>` | leer |
| `BK_WS_<ws>_NAME` / `_ROLES` / `_START` / `_PHASES` | Anzeigename, Rollen, Vorgabe, Phasen (`key:Titel`) | – |
| `bk_color <rolle>` | iTerm-Tabfarbe `"r g b"` (Funktion, optional) | je Rolle |
| `BK_REPOS` | weitere Repos `<schlüssel>:<pfad>`; Label `modul:<schlüssel>` → dort bearbeiten | leer |
| `RUNNER_APT`, `RUNNER_MYSQL`, `RUNNER_MARIADB` | Zusatzpakete im Pool-Image (alle Projekte vereint), Version der CI-MySQL bzw. CI-MariaDB | leer |
| `RUNNER_CPUS`, `RUNNER_MEM` (Umgebung von `runner-pool setup`) | Grenzen je Pool-Runner | `2`, `6g` |
| `RUNNER_CI_CPUS`, `RUNNER_CI_MEM` (ebenso) | Deckel für alle CI-Container zusammen (Slice `beadskit-ci.slice`) | `4`, `24G` |

Rollen bestehen aus a-z und `-` (`club-add`). Ein Worker `<rolle>-<n>` gehört zum Workspace
seiner Rolle; `start` startet genau einen Workspace und hebt nur dessen Drain auf.

## beads.leitstand.mjs

Optional im Projekt-Root, ein ES-Modul mit `export default { … }`. Der Leitstand lädt es neu,
sobald es sich ändert; Fehler darin schalten nur die Erweiterungen ab (Hinweis im Log).

```js
export default {
  // Texte und Zusatzspalten je Workspace (alles optional)
  workspaces: {
    clubs: {
      roleLabels: { 'club-add': 'Anlegen' },
      colors: { 'club-add': '#e6781e' },                       // CSS-Farbe für die Seite
      cols: { settings: { title: 'Settings', color: '#1ea0aa', hint: 'SiteSetting einrichten' } },
      split: [{ key: 'activate', label: 'aktivieren', title: 'zum Aktivieren' }],  // human + Label → eigene Spalte
      group: { prefix: 'stadt:', all: 'alle Städte' },         // Filter und Karten-Tag statt modul:
      create: { type: 'task', title: 'Neuer Club', fields: [{ name: 'stadt', label: 'Stadt', prefix: 'stadt:' }] },
      humanHint: 'HTML-Hinweis über „Wartet auf dich“', release: 'Freigeben', prs: false,
      // Antworten zum Antippen (je höchstens 12, je 120 Zeichen); fehlt eine Liste, gilt die Vorgabe
      quick: { decide: ['Ja, aktivieren', 'Nein'], close: ['Kein Club', 'Duplikat'], chat: ['Weiter'] },
    },
  },
  // Zusatzangaben je Karte: Logo, Links (nur http/https), Tags
  card: (issue) => ({ logo: issue.metadata?.logo_url, links: [{ href: '…', text: 'Admin' }], tags: [] }),
  // Knöpfe an Issues (Inbox und Detail). primary ersetzt „Freigeben“. run bekommt exec (ohne Shell,
  // cwd = Projekt) und gibt bdw-Schritte zurück, die der Leitstand danach ausführt.
  actions: [{
    key: 'activate', title: 'Aktivieren', primary: true, confirm: 'Wirklich aktivieren?',
    applies: (it) => it.labels.includes('human') && it.labels.includes('aktivieren'),
    check: (it) => (it.metadata?.place_id ? null : 'Metadatum place_id fehlt'),
    run: async ({ issue, exec }) => { await exec('node', ['scripts/x.mjs', String(issue.metadata.place_id)]);
      return [['close', issue.id, '--reason', 'aktiviert']]; },
  }],
  // Zusatzlisten unter dem Board: items(issues, now) → [{ id, title, text, href, linkText, at }]
  panels: [{ key: 'cities', title: 'Neue Städte', ws: 'clubs', items: (issues, now) => [] }],
  // Server ohne beadskit im Tab System (Linux, höchstens 4): ssh-Ziel ohne Optionen, Dienste =
  // systemd-Units (höchstens 12), nur lesend über /proc, df, docker ps und systemctl is-active
  servers: [{ name: 'prod', ssh: 'server', services: ['nginx', 'mysql'] }],
};
```
