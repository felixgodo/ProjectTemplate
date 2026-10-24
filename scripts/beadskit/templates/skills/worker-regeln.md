# Regeln für parallele Worker (gilt für alle `/{{SLUG}}-*`-Skills)

Mehrere Claude-Sessions arbeiten gleichzeitig. Die Warteschlange ist **beads** (`bd`), das
Protokoll sind die Review-Dateien unter `reviews/` (siehe CLAUDE.md), der Weg nach
`{{BASE}}` ist **PR + CI**.

## Session-Start
- Jede Session läuft in einem eigenen Worktree: `claude --worktree <rolle>-<n>` (z. B. `fix-1`).
  `scripts/beadskit/workers start …` bzw. `add …` startet die Sessions schon so.
  Ohne Worktree: `EnterWorktree` mit diesem Namen, bevor irgendetwas geändert wird.
- `bd` immer über `scripts/beadskit/bdw` aufrufen (im Folgenden `bdw`). Der Wrapper setzt den
  Worktree-Namen als Actor, sonst laufen alle Sessions unter demselben Namen.
- Die Datenbank liegt im Haupt-Checkout (`.beads/`), Worktrees finden sie selbst, der
  Dolt-Server startet bei Bedarf. Prüfen: `bdw context` zeigt `beads dir: …/.beads` des Haupt-Checkouts.
- Abhängigkeiten im Worktree nachinstallieren, bevor Prüfkommandos laufen (siehe CLAUDE.md).

## Status-Modell in beads
| Label | Bedeutung | Wer nimmt es |
|---|---|---|
| `phase:fix` | Problem bekannt, Fix fehlt (oder Verify hat abgelehnt) | `/{{SLUG}}-fix` |
| `phase:verify` | PR offen, wartet auf unabhängige Prüfung | `/{{SLUG}}-verify` |
| `phase:merge` | geprüft und freigegeben, wartet auf den Merge-Slot | `/{{SLUG}}-verify` (wer den Slot sofort bekommt) |
| `tests` | Testabdeckung/Test-Infrastruktur | `/{{SLUG}}-verify` (wenn kein Verify offen) |
| `human` | Nur mit Freigabe des Users lösbar (Server, Konsole, Recht, Entscheidung) | niemand |
| `modul:<{{MODULES_PIPE}}>` | betroffenes Modul | Filter |
| `regression` | von `/{{SLUG}}-regress` auf `{{BASE}}` gefunden | `/{{SLUG}}-fix` (P1) |

Epics: Jeder Fund hängt unter einem Epic je Modul (`external_ref` `epic:<modul>`, dazu
`epic:tests`). Die ID findet `bdw list -t epic --all`. Neue Issues mit `--parent <epic-id>`
anlegen. Epics tragen keine Labels (Kinder würden sie erben) und werden nie geclaimt.

Metadaten am Issue: `branch`, `pr`, `fixer` (Actor des Fix-Workers).

- Reservieren nur atomar: `bdw ready --claim …` oder `bdw update <id> --claim`. Scheitert das,
  hat eine andere Session den Punkt – nächsten nehmen, nie mit `--force` übernehmen.
- Während der Arbeit nach jedem größeren Schritt `bdw heartbeat <id>`, damit der Claim nicht
  als verwaist gilt.
- Abgeben: Labels/Notiz setzen, dann `bdw unclaim <id>`.
- Merge-Sperre (`bdw merge-slot acquire|release`): nur freigeben, was man selbst hält
  (`bdw merge-slot check` zeigt den Holder). `release` prüft den Holder **nicht**.

## Auslaufen (drain)
`scripts/beadskit/workers drain` legt eine Markierung für alle Worker an, `drain <rolle>` eine nur
für eine Rolle (z. B. `drain fix`). Danach hören die betroffenen Worker nach dem laufenden
Schritt auf. **Vor jedem neuen Claim** (und vor jeder neuen Such- oder Prüfrunde) prüfen, die
Rolle kommt aus dem Worktree-Namen (`fix-2` → `fix`):
```bash
scripts/beadskit/workers drain-check
```
Ein einzelner Befehl, damit die Sandbox ihn ohne Rückfrage erlaubt. Die Ausgabe beginnt mit
`DRAIN` oder lautet `kein Drain`, der Exit-Code ist immer 0.
- `DRAIN` → nichts Neues claimen, kurzen Bericht ausgeben, aufhören. Keine weitere Frage an
  den User. Unter `/loop` die Schleife beenden, wenn das geht; sonst endet jede weitere Runde
  sofort an dieser Prüfung.
- Laufende Arbeit wird **nie** wegen der Markierung abgebrochen, sondern zu einem sauberen
  Stand gebracht: PR offen und Übergabe auf `phase:verify` erledigt, oder Merge abgeschlossen
  und Merge-Slot freigegeben, oder mit Notiz `bdw unclaim <id>`. Ein Worker hält beim
  Aufhören weder einen Claim noch den Merge-Slot.
- Mitten in der Arbeit nicht nach der Markierung schauen, nur an den genannten Stellen.

## Harte Grenzen
- Kein Deploy, kein Neustart, keine Änderung auf Servern. Server nur lesend.
- Nie direkt nach `{{BASE}}` pushen, nie fremde Branches force-pushen. Nur der Verify-Worker
  merged. Ausnahmen: der Fix-Worker nach einem Rebase seines Fix-Branches, der Verify-Worker
  beim Rebase im Merge-Slot (beide `--force-with-lease`).
- Auf den Merge-Slot nie warten (`acquire` ohne `--wait`): belegt → andere Arbeit.
- Kein `bd config`, `bd init`, `bd setup`, `bd dolt remote …`, `bd delete`: `bd config` committet
  `.beads/config.yaml` ungefragt in den aktuellen Branch; die Einrichtung macht nur der User.
- Projektspezifische Grenzen: siehe unten.

## Review-Dateien
Jeder Branch legt nur **seine eigene** Datei an, gemeinsame Dateien fasst keiner an:
- Review als neue Datei `reviews/YYYY-MM-DD-HHMM-<beads-id>.md`, Template und Regeln in
  `reviews/README.md`. In der Zeile `Behebt:` die beads-ID.
- Neue Funde ohne Bezug zur Änderung als beads-Issue anlegen (`bdw create … -l
  phase:fix,modul:…`) und im Review unter „Offene Punkte“ mit der beads-ID nennen.

## Prüfkommandos
Wie in CLAUDE.md, passend zum Modul. Vor jedem Push und nach jedem Rebase erneut.

## Projektspezifisch
<!-- Hier die Grenzen und Eigenheiten des Projekts eintragen (Server, Testgeräte, Commit-Stil, …). -->

## Mehrere Repos (BK_REPOS)
Gehören zum Projekt weitere Repos (`BK_REPOS` in `beads.project.sh`), legt das Label
`modul:<schlüssel>` fest, in welchem Repo ein Issue bearbeitet wird. Den Pfad liefert
`scripts/beadskit/workers repo-for <id>`. Ist es nicht dieses Repo:
- Branch, Commits, Prüfkommandos und PR im anderen Repo, in einem eigenen Worktree dort:
  `git -C <pfad> worktree add <pfad>/.claude/worktrees/<worker>-<id> -b fix/<id> origin/<ziel>`.
  `<ziel>` ist der Standard-Branch des anderen Repos
  (`git -C <pfad> rev-parse --abbrev-ref origin/HEAD`, ohne `origin/`).
- Beim Übergeben zusätzlich `--set-metadata repo=<schlüssel>`. Verify und Merge arbeiten dann
  mit `gh … -R <owner/name>` bzw. im Worktree des anderen Repos.
- Prüfkommandos und Review-Pflicht des anderen Repos gelten dort (dessen `CLAUDE.md`).
- Den Worktree im anderen Repo nach dem Merge entfernen (`git -C <pfad> worktree remove …`).
