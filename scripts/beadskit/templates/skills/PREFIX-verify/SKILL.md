---
name: {{SLUG}}-verify
description: Verify-/Test-Worker der parallelen Pipeline – prüft offene Fix-PRs (beads-Label phase:verify) unabhängig und gibt sie zum Mergen frei (phase:merge) oder schickt sie mit Begründung zurück; merged freigegebene PRs nach {{BASE}} serialisiert nach grüner CI, sobald der Merge-Slot frei ist; ohne offene PRs schreibt er fehlende Tests (Label tests). Gedacht für /loop, z. B. „/loop 5m /{{SLUG}}-verify“. Verwenden bei „/{{SLUG}}-verify“, „Verify-Worker starten“, „PRs prüfen und mergen“.
---

# Verify- und Test-Worker

Zuerst `.claude/skills/worker-regeln.md` lesen und befolgen. `bdw` = `scripts/beadskit/bdw`.
Eigener Actor: der Name des Worktree-Ordners (z. B. `verify-2`). Ziel-Branch: `{{BASE}}`.

Befehle in diesem Skill einzeln aufrufen, wie sie dastehen: Die Sandbox lehnt `git` in Pipes,
`&&`/`||`-Ketten und `$(…)` ab (`worker-regeln.md`, „Session-Start“). Wo ein Schritt vom
Ergebnis des vorigen abhängt, erst dessen Ausgabe lesen.

Prüfen und Mergen sind getrennt: Prüfen läuft parallel ohne Slot, nur das Mergen ist
serialisiert. Auf den Merge-Slot wird **nie gewartet** – wer ihn nicht sofort bekommt, prüft
den nächsten PR. Gibt es noch keinen Slot (`bdw merge-slot check` meldet ihn als fehlend),
legt ihn der erste Verify-Worker mit `bdw merge-slot create` an.

## 1. Arbeit holen
Zuerst `drain`-Check (siehe `worker-regeln.md`, „Auslaufen“): Markierung da → Abschnitt 5,
aufhören. Hält der eigene Actor noch den Merge-Slot, vorher freigeben.

In dieser Reihenfolge:
1. **Mergen**, wenn `bdw ready -l phase:merge --json` etwas liefert und
   `bdw merge-slot acquire` (ohne `--wait`) sofort gelingt. `acquire` als eigenen Aufruf, nie
   im selben Schritt wie den Claim: Erst wenn die Ausgabe „Acquired merge slot“ zeigt,
   `bdw ready --claim -l phase:merge --json` → Abschnitt 3. Liefert der Claim nichts, Slot
   freigeben und weiter mit 2. Schlägt `acquire` fehl (nur „Hint: Use --wait …“), ist jemand
   anders am Mergen → weiter mit 2.
2. **Prüfen**: `bdw ready --claim -l phase:verify --json`. Gefunden → Abschnitt 2.
   Ist `metadata.fixer` der eigene Actor: `bdw unclaim <id>` und ein anderes nehmen – niemand
   prüft seinen eigenen Fix.
3. **Tests**: sonst Abschnitt 4.

Hat das Issue `metadata.repo` (weiteres Repo aus `BK_REPOS`), PR, CI und Merge dort prüfen
(`gh … -R <owner/name>`, Worktree im anderen Repo, siehe `worker-regeln.md`, „Mehrere Repos“).

## 2. Unabhängig prüfen
```bash
gh pr view <pr> --json title,body,headRefName,baseRefName,mergeable,statusCheckRollup
git fetch origin
git switch --detach origin/<headRefName>
git diff origin/{{BASE}}...HEAD
```
- Basis des PRs muss `{{BASE}}` sein, sonst zurück an Fix.
- Den Diff lesen wie ein Reviewer nach CLAUDE.md: Ursache wirklich behoben? Aufrufer,
  Regressionen, Edge Cases, Fehlerbehandlung, Sicherheit. Gibt es den Test, und schlägt er ohne
  den Fix fehl (kurz gegenprüfen, wenn machbar)?
- Prüfkommandos für die betroffenen Module selbst laufen lassen.
- Review-Datei des Fix-Workers unter `reviews/` vorhanden, ehrlich, Template vollständig?

**In Ordnung** → zum Mergen freigeben, ohne Slot:
```bash
bdw update <id> --remove-label phase:verify --add-label phase:merge --append-notes "<actor>: geprüft, ok"
bdw unclaim <id>
```

**Nicht in Ordnung** → zurück an die Fix-Worker:
```bash
gh pr comment <pr> --body "<konkrete Punkte>"
bdw update <id> --remove-label phase:verify --add-label phase:fix --append-notes "<actor>: abgelehnt – <Punkte>"
bdw unclaim <id>
```
Weiter mit Abschnitt 1.

## 3. Mergen (serialisiert, Slot kurz halten)
Der Slot ist aus Abschnitt 1 schon gehalten, das Issue (`phase:merge`) geclaimt. Im Slot nur
das Nötigste – jede Minute hier blockiert alle anderen Merges.

**Schneller Weg (ohne Rebase, ohne neue CI)** – nur wenn `scripts/ci/modules.sh` existiert:
```bash
git fetch origin
# Branch aus dem PR, nicht aus metadata.branch – beide können abweichen
gh pr view <pr> --json headRefName --jq .headRefName
# Skript immer aus {{BASE}} nehmen; als Datei, keine Pipe
git show origin/{{BASE}}:scripts/ci/modules.sh > <scratchpad>/modules.sh
bash <scratchpad>/modules.sh disjoint origin/{{BASE}} origin/<headRefName>
gh pr view <pr> --json mergeable,statusCheckRollup \
  --jq '{mergeable, checks: [.statusCheckRollup[] | .conclusion // .state] | unique}'
```
`disjoint` endet mit exit 0, `mergeable` ist `MERGEABLE` und `checks` enthält nur
`SUCCESS`/`SKIPPED` → direkt mergen wie unten „Grün“. Ein leerer String `""` in `checks`
heißt „Job läuft noch“, ebenso `PENDING`, `QUEUED`, `IN_PROGRESS`: dann nicht mergen, sondern
den Lauf mit `gh run watch <run-id> --exit-status` abwarten.

**Langsamer Weg (Rebase + CI):**
```bash
git fetch origin
git switch --detach origin/<headRefName>
git rebase origin/{{BASE}}
```
Detached, nicht `git switch fix/<id>`: Der Branch ist oft im Worktree des Fix-Workers
ausgecheckt, dann scheitert `switch`, und ein folgendes `reset --hard`/`rebase` träfe den
gerade ausgecheckten Branch.
- **Konflikt** → nicht im Slot lösen. `git rebase --abort`, Slot freigeben, zurück an den
  Fix-Worker:
  ```bash
  gh pr comment <pr> --body "Rebase-Konflikt mit {{BASE}} in <Dateien>, bitte rebasen."
  bdw update <id> --remove-label phase:merge --add-label phase:fix --append-notes "<actor>: Rebase-Konflikt mit {{BASE}} – <Dateien>"
  bdw unclaim <id>
  ```
- Ohne Konflikt keine lokalen Prüfkommandos (die liefen in Abschnitt 2), die CI prüft den
  gerebasten Stand.
- Pushen erst, wenn die Rebase-Ausgabe „Successfully rebased“ zeigt, nie im selben Schritt
  wie den Rebase: Ein paralleler Push nach gescheitertem Rebase schiebt den Stand von
  `{{BASE}}` auf den PR-Branch, GitHub schließt den PR dann (kein Diff mehr). Lease ohne
  getippte SHA, gegen den frisch geholten Tracking-Ref:
  ```bash
  git push --force-with-lease=<headRefName> origin HEAD:refs/heads/<headRefName>
  ```
- CI des neuen Stands abwarten: `git rev-parse HEAD`, dann
  `gh run list --branch <headRefName> --limit 2 --json databaseId,headSha,status` und den Lauf
  mit genau dieser `headSha` per `gh run watch <run-id> --exit-status`. Nicht
  `gh pr checks --watch`, das zeigt kurz noch den alten Lauf. Rot → Ursache klären;
  Fix-Problem → Slot freigeben, dann wie „Nicht in Ordnung“ (Label `phase:merge` statt
  `phase:verify` entfernen).
- Grün: mergen ohne `--delete-branch` (gh würde danach lokal auf `{{BASE}}` wechseln, das im
  Haupt-Checkout ausgecheckt ist), den Remote-Branch danach einzeln löschen. Die Review-Datei
  für `close` aus `gh pr view <pr> --json files` nehmen, nicht aus dem Kopf. Vier Befehle,
  je einer:
  ```bash
  gh pr merge <pr> --merge
  git push origin --delete <headRefName>
  bdw close <id> --reason "PR #<pr> gemerged, reviews/<datei>"
  bdw merge-slot release
  ```
- Ist `{{BASE}}` zwischen Rebase und Merge weitergelaufen (Merge abgelehnt): Rebase
  wiederholen, Slot dabei behalten.

Slot **immer** freigeben, auch bei Abbruch – aber nur, wenn `bdw merge-slot check` den eigenen
Actor als Holder zeigt.

## 4. Tests schreiben (wenn kein Verify offen)
Vor dem Claim erneut den `drain`-Check.
`bdw ready --claim -l tests --exclude-label human,phase:verify,phase:merge --json`
- Wie ein Fix-Worker arbeiten (Branch `fix/<id>`, Test, Review-Datei, PR, Übergabe auf
  `phase:verify`, siehe `.claude/skills/{{SLUG}}-fix/SKILL.md` Schritte 2–4). Ein Test-Issue ist
  meist zu groß für einen PR: einen sinnvollen Teil abdecken, den Rest als Notiz am Issue
  lassen und das Issue mit `phase:fix,tests` offen halten statt zu schließen.
- Danach wieder Abschnitt 1 – Mergen und Prüfen haben Vorrang.
- Auch hier nichts → Abschnitt 5, Runde beenden.

## 5. Bericht
Am Ende der Runde: gemergte PRs, freigegebene, zurückgewiesene mit Grund (auch
Rebase-Konflikte), geschriebene Tests. Weder Claim noch Merge-Slot halten.
