# Reviews

Eine Datei je Review. Vorgehen und Regeln: [`CLAUDE.md`](../CLAUDE.md), Abschnitt
„Fortlaufendes Code-Review“. Offene Arbeit steht nur in beads.

Jeder Branch legt nur seine eigene Datei an und ändert keine fremde. Deshalb entstehen beim
Rebase paralleler Branches keine Konflikte im Protokoll.

## Dateiname

`YYYY-MM-DD-HHMM-<slug>.md`, slug = beads-ID (`{{ISSUE_PREFIX}}-gkq`) oder ein kurzes Thema in
Kleinbuchstaben mit Bindestrichen (`review-dateien`). Sortiert nach Name ist das chronologisch.

## Prioritäten und Status

🔴 Critical (sofort) · 🟠 High (zeitnah) · 🟡 Medium (mittelfristig) · 🟢 Low (kleine
Verbesserung / technische Schuld)

Review-Status: ✅ Reviewed · ⚠️ Reviewed with open issues · ❌ Critical issues found

## Template

```markdown
## Review – YYYY-MM-DD HH:MM

Behebt: <beads-ID> | –

<Ein, zwei Sätze: Anlass der Änderung.>

### Änderungen
- …

### Geprüfte Dateien
- …

### Gefundene Probleme

#### 🔴 Critical
- Keine.

#### 🟠 High
- Keine.

#### 🟡 Medium
- Keine.

#### 🟢 Low
- Keine.

### Verbesserungen
- …

### Architektur
- …

### Security
- …

### Performance
- …

### Tests
- Ausgeführt: …
- **Nicht geprüft:** …

### Offene Punkte
- Funde ohne Bezug zur Änderung als beads-Issue: `{{ISSUE_PREFIX}}-xxx` – …

### Review-Status
✅ Reviewed
```
