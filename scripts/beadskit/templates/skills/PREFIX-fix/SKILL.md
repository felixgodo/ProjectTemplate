---
name: {{SLUG}}-fix
description: Fix-Worker der parallelen Pipeline – reserviert das nächste freie beads-Issue (phase:fix), behebt es im eigenen Branch mit Test und Review-Datei und öffnet einen PR gegen {{BASE}} für den Verify-Worker. Merged nie selbst; löst Rebase-Konflikte von PRs, die der Verify-Worker zurückgibt. Gedacht für /loop, z. B. „/loop 10m /{{SLUG}}-fix“. Verwenden bei „/{{SLUG}}-fix“, „Fix-Worker starten“, „nächsten Punkt beheben“. Optionales Argument: beads-ID oder Modul.
---

# Fix-Worker

Zuerst `.claude/skills/worker-regeln.md` lesen und befolgen. `bdw` = `scripts/beadskit/bdw`.
Ziel-Branch: `{{BASE}}`.

## 1. Issue reservieren
- Zuerst `drain`-Check (siehe `worker-regeln.md`, „Auslaufen“): Markierung da → Bericht, aufhören.
- Mit ID: `bdw update <id> --claim`.
- Sonst: `bdw ready --claim -l phase:fix --exclude-label human,tests [-l modul:<x>] --json`.
- Leere Antwort → nichts zu tun, kurz melden und die Runde beenden. Unter `/loop` (so startet
  es `scripts/beadskit/workers`) kommt die nächste Runde von selbst und nimmt Ablehnungen,
  Rebase-Konflikte und Regressionen auf.
- `bdw show <id>` lesen. Steht in `metadata.branch` schon ein Branch und in den Notizen eine
  Ablehnung vom Verify-Worker: auf diesem Branch weiterarbeiten und genau die genannten Punkte
  beheben.
- Lautet die letzte Notiz „Rebase-Konflikt mit {{BASE}}“: Der Fix ist schon geprüft, nur die
  Basis fehlt. Auf dem Branch `git rebase origin/{{BASE}}`, Konflikte sorgfältig lösen,
  Prüfkommandos der betroffenen Module, `git push --force-with-lease` (eigener Fix-Branch, kein
  fremder), dann wie Schritt 4 übergeben – ohne neuen PR, Notiz „rebased, Konflikt in <Dateien>
  gelöst“. Der Verify-Worker prüft die Konfliktlösung erneut.

## 2. Branch
Gehören weitere Repos zum Projekt (`BK_REPOS`), zuerst `scripts/beadskit/workers repo-for <id>`:
nennt es ein anderes Repo, dort arbeiten (`worker-regeln.md`, „Mehrere Repos“).
```bash
git fetch origin
git switch -c fix/<id> origin/{{BASE}}
```
Bei Nacharbeit (der Branch kann von einem Worker auf dem anderen Rechner stammen, der lokale
Stand ist dann alt oder fehlt):
```bash
git fetch origin
git switch -C fix/<id> origin/fix/<id>
git rebase origin/{{BASE}}
```
Drei Einzelbefehle, die Sandbox lehnt `git … && git …` ab (`worker-regeln.md`, „Session-Start“).
`switch -C` setzt den lokalen Branch auf den Stand von `origin`.

## 3. Beheben
Nach CLAUDE.md, ohne Abkürzung:
- Ursache verstehen, Aufrufer und abhängige Module prüfen, minimal und sauber ändern.
- Test dazu (siehe CLAUDE.md, welche Testart je Modul). Geht es nicht, im Review begründen.
- Passende Prüfkommandos laufen lassen. Rot → beheben, nicht übergehen.
- Review-Datei `reviews/YYYY-MM-DD-HHMM-<id>.md` (siehe `worker-regeln.md`, „Review-Dateien“).
- Zwischendurch `bdw heartbeat <id>`.

Stellt sich heraus, dass das Issue nicht ohne den User lösbar ist (Server, Entscheidung):
```bash
bdw update <id> --add-label human --append-notes "<actor>: <warum>"
bdw unclaim <id>
```
Branch dann nicht pushen; nächstes Issue.

## 4. PR
```bash
git push -u origin fix/<id>
gh pr create --base {{BASE}} --title "<Modul>: <was>" --body "<Was, warum, Tests. beads: <id>>"
```
Dann übergeben (`<actor>` = Name des eigenen Worktree-Ordners, z. B. `fix-2`):
```bash
bdw update <id> --remove-label phase:fix --add-label phase:verify \
  --set-metadata branch=fix/<id> --set-metadata pr=<nummer> --set-metadata fixer=<actor> \
  --append-notes "<actor>: PR #<nummer>, <ein Satz zum Fix>"
bdw unclaim <id>
```

## 5. Weiter
Mit Schritt 1 das nächste Issue, bis `bdw ready` leer ist (Runde beenden), der `drain`-Check
anschlägt oder der User stoppt. Am Ende kurzer Bericht: bearbeitete Issues mit PR-Nummern,
abgegebene (`human`), neu angelegte Funde.
