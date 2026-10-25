# shellcheck shell=sh disable=SC2034
# Was die beads-Pipeline dieses Projekts ausmacht – das Einzige, was der beadskit
# (scripts/beadskit/, aus dem ProjectTemplate) projektspezifisch braucht.
# Regeln für die Worker: .claude/skills/worker-regeln.md

BK_NAME="{{NAME}}"
# Kurzname: Drain-Markierung .git/<slug>-workers-drain, Projekt-Kennung im Leitstand, Runner-Label
BK_SLUG="{{SLUG}}"
# Ziel-Branch der Fix-PRs und Stand, den search/regress prüfen
BK_BASE="{{BASE}}"
# Skills heißen /<prefix>-<rolle> (.claude/skills/<prefix>-<rolle>/SKILL.md)
BK_SKILL_PREFIX="{{SLUG}}"
BK_ROLES="fix search verify regress"
# Werte für das Label modul:<x> (Formular im Leitstand, Filter)
BK_MODULES="{{MODULES}}"
# Vorgabe für `workers start` ohne Anzahlen
BK_START="fix=2 search=1 verify=1 regress=0"

# Startbefehl je Rolle anders als die Vorgabe (/loop 10m /<prefix>-fix …)? Leer = Vorgabe.
# bk_prompt() {
#   case $1 in
#     verify) echo "/loop 3m /{{SLUG}}-verify" ;;
#   esac
# }

# Weitere Workspaces neben code (eigene Rollen, Phasen und Skills), z. B. clubs:
# BK_WORKSPACES="clubs"
# BK_WS_clubs_NAME="Clubs"
# BK_WS_clubs_ROLES="club-search club-add"          # Rollen a-z und -
# BK_WS_clubs_START="club-search=1 club-add=1"
# BK_WS_clubs_PHASES="place:Anlegen settings test"  # erste = die, die Worker claimen; :Titel optional
# Phasen von code (Standard fix verify merge):
# BK_PHASES="fix verify merge"

# iTerm-Tabfarbe je Rolle ("r g b"), sonst die Vorgabe
# bk_color() { case $1 in club-add) echo "230 120 30" ;; esac; }

# Weitere Repos des Projekts als <schlüssel>:<pfad> (relativ zu diesem Repo). Issues mit Label
# modul:<schlüssel> werden dort bearbeitet; der Leitstand zeigt deren PRs mit.
# BK_REPOS="site:../MeineSite"

# CI-Runner: Nutzt ein Workflow runs-on [self-hosted, <slug>], läuft er im gemeinsamen Pool aller
# Projekte (ci/runner-pool setup). Der Leitstand zeigt dann den Abschnitt CI-Runner-Pool.
# Zusätzliche apt-Pakete im Pool-Image, MySQL für DB-Tests (Host mysql):
# RUNNER_APT=${RUNNER_APT:-ffmpeg}
# RUNNER_MYSQL=${RUNNER_MYSQL:-8.0}
# RUNNER_MARIADB=${RUNNER_MARIADB:-11}   # CI-MariaDB (Host mariadb) statt Testcontainers

# Leitstand: Knöpfe, Zusatzlisten, Links an Karten und Texte je Workspace kommen aus der
# optionalen beads.leitstand.mjs (siehe scripts/beadskit/README.md).
