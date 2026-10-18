---
name: {{SLUG}}-regress
description: Regressions-Worker der parallelen Pipeline – prüft den aktuellen Stand von {{BASE}} mit allen Prüfkommandos und meldet Regressionen als beads-Issues (P1, Label regression). Gedacht für /loop, z. B. „/loop 30m /{{SLUG}}-regress“. Ändert keinen Code.
---

# Regressions-Worker

Zuerst `.claude/skills/worker-regeln.md` lesen und befolgen. `bdw` = `scripts/beadskit/bdw`.
**Ändert keinen Code.**

## 1. Stand holen
Zuerst `drain`-Check (siehe `worker-regeln.md`, „Auslaufen“): Markierung da → „Drain aktiv,
kein Lauf“ melden und beenden.
```bash
git fetch origin
git switch --detach origin/{{BASE}}
git log --oneline -1
```
Ist der Commit derselbe wie beim letzten Lauf (steht in `bdw memories regress-last`, falls
vorhanden), sind keine neuen Merges da → nur kurz melden und beenden.

## 2. Alles prüfen
Abhängigkeiten aktualisieren, dann **alle** Prüfkommandos aus CLAUDE.md. Je Kommando Ergebnis
notieren.

## 3. Regressionen melden
Für jedes rote Kommando:
- Ursache eingrenzen: `git log --oneline <letzter-grüner-Commit>..HEAD`, betroffene Dateien,
  ggf. `git bisect run <kommando>` auf dem Detach-Stand.
- Dublette? `bdw list -l regression` und `bdw search "<Fehlermeldung>"`.
- Neu anlegen:
  ```bash
  bdw create "Regression: <Kommando> rot seit <commit>" -t bug -p 1 \
    -l phase:fix,regression,modul:<x> --parent <epic-id> --stdin --silent <<'EOF'
  Kommando, Fehlerausgabe (gekürzt), verursachender Merge/PR, betroffene Datei:Zeile.
  EOF
  ```
- Flaky (zweiter Lauf grün)? Als P2 mit Label `flaky` anlegen statt als Regression.

## 4. Merken und berichten
`bdw forget regress-last` (falls vorhanden), dann
`bdw remember --key regress-last "<commit> <grün|rot>"`. Kurzer Bericht: Commit, Kommandos
grün/rot, angelegte Issues.
