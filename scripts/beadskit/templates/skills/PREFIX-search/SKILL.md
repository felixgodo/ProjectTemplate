---
name: {{SLUG}}-search
description: Such-Worker der parallelen Pipeline – sucht Bugs, Sicherheitslücken und Fehlverhalten (Code-Analyse, lokal laufende Apps, Server nur lesend) und legt sie als beads-Issues an, ohne Code zu ändern. Verwenden bei „/{{SLUG}}-search“, „Such-Worker starten“, „Fehler suchen für die Worker“. Optionales Argument: Modul oder Bereich ({{MODULES_COMMA}}).
---

# Such-Worker

Zuerst `.claude/skills/worker-regeln.md` lesen und befolgen. `bdw` = `scripts/beadskit/bdw`.

**Ändert keinen Code, committet nichts, öffnet keine PRs.** Ergebnis sind beads-Issues.

## 1. Bereich festlegen
- Zuerst `drain`-Check (siehe `worker-regeln.md`, „Auslaufen“): Markierung da → Bericht, aufhören.
- Argument gegeben → dieses Modul. Sonst das Modul mit den wenigsten offenen Issues
  (`bdw count --by-label`).
- Arbeitsstand: `git fetch origin`, dann `git switch --detach origin/{{BASE}}` (zwei Befehle,
  siehe `worker-regeln.md`, „Session-Start“).

## 2. Suchen
- **Code-Analyse:** Einstiegspunkte (Endpoints, Services, Repositories, Komponenten, Hooks) lesen,
  Aufrufer verfolgen. Schwerpunkte: Auth-Filter, ungeprüfte Eingaben, Nullpfade,
  Ressourcen/Threads, geschluckte Fehler, Race Conditions, Zustand im Frontend.
- **Lokale Apps:** nur bereits laufende Dev-Server nutzen (keine eigenen auf Standardports
  starten – andere Sessions teilen sie). Läuft nichts: diesen Teil auslassen und im Bericht sagen.
- **Server (nur lesend):** Live-Seiten, Logs. Keine schreibenden Requests, keine Admin-Aktionen,
  kein Neustart.

## 3. Dubletten ausschließen
Vor jedem Anlegen:
- `bdw search "<Stichwort>"` (sucht in Titel und ID, inklusive geschlossener Issues) und
- `grep -rn "<Datei oder Stichwort>" reviews/`.
Ist es schon bekannt, aber mit neuer Erkenntnis: `bdw note <id> "…"` statt neuem Issue.

## 4. Anlegen
```bash
scripts/beadskit/bdw create "<Modul>: <Problem in einem Satz>" -t bug -p <0-3> \
  -l phase:fix,modul:<x>[,human] --parent <epic-id> --stdin --silent <<'EOF'
<Datei:Zeile>. Was passiert, mit konkretem Szenario (Eingabe → falsches Ergebnis).
Belegt durch: nur am Code gelesen | nachgestellt (wie) | live gesehen (wo, wann).
Vorschlag zur Behebung (optional, kurz).
EOF
```
- `<epic-id>`: Epic des Moduls aus `bdw list -t epic --all` (siehe `worker-regeln.md`).
- Priorität wie CLAUDE.md: 0 = 🔴 sofort, 1 = 🟠, 2 = 🟡, 3 = 🟢.
- `human`, wenn die Lösung einen Server, eine Konsole, eine rechtliche oder fachliche
  Entscheidung braucht.
- Abhängigkeit, wenn ein Fund erst nach einem anderen sinnvoll ist: `bdw dep add <neu> <vorher>`.
- Nur echte Probleme, keine Stilpräferenzen. Lieber wenige belegte als viele vermutete.

## 5. Abschluss
Kurzer Bericht: Bereich, angelegte Issues (ID, Prio, Titel), was nicht geprüft wurde. Danach –
wenn der User es so wollte – nächsten Bereich, vorher erneut der `drain`-Check.
