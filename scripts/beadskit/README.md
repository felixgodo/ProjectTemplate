# beadskit

Parallele Claude-Worker über eine [beads](https://github.com/gastownhall/beads)-Warteschlange und
ein Leitstand für alle Projekte. In allen Projekten identisch; die Quelle liegt im
`ProjectTemplate`. **Nicht im Projekt ändern** – im Template ändern, `scripts/beadskit/VERSION`
hochzählen und mit `./beadskit-sync.sh --apply` verteilen.

```
beads.project.sh        im Projekt: Name, Slug, Ziel-Branch, Rollen, Module (das Einzige, was ein Projekt schreibt)
scripts/beadskit/
  bdw                   bd mit Worktree-Name als Actor
  workers               Worker starten/hinzufügen/auslaufen/stoppen, config (JSON für den Leitstand)
  leitstand/            Web-Leitstand (inbox.mjs + inbox.html), Tests, Fernzugang (leitstand-remote)
  ci/runner-server      eigene GitHub-Actions-Runner als Docker-Container auf dem Server
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
scripts/beadskit/workers start fix=2 search=1 verify=1     # Gesamtzahl je Rolle
scripts/beadskit/workers add fix                           # einen weiteren
scripts/beadskit/workers ls
scripts/beadskit/workers drain && scripts/beadskit/workers ls   # warten bis idle
scripts/beadskit/workers stop --all
```

**Leitstand:** `node scripts/beadskit/leitstand/inbox.mjs` (aus einem beliebigen eingerichteten
Projekt) → http://127.0.0.1:3738. Ein Prozess für alle Projekte; Umschalter oben. Die Liste steht
in `~/.config/beadskit/projects.txt` – `workers` trägt sein Projekt bei jedem Aufruf ein. Der
Leitstand zeigt Kennzahlen, Worker-Karten, „Wartet auf dich“ (Label `human`), Kanban mit Drag &
Drop und PRs mit CI-Stand; er steuert Issues und Worker als Actor `user`.
Tests: `node --test scripts/beadskit/leitstand/inbox.test.mjs`.

Fernzugang: `scripts/beadskit/leitstand/leitstand-remote` (Token-Login, SSH-Rückkanal, nginx mit
HTTPS und Basic-Auth; Hilfe im Kopf des Skripts). Token und Basic-Auth liegen in `~/.config/beadskit/`.

**CI-Runner:** `scripts/beadskit/ci/runner-server setup|status|logs|remove` (Label = `BK_SLUG`,
Repo aus `gh`). Der Workflow wählt sie mit `runs-on: [self-hosted, <slug>]`.

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
