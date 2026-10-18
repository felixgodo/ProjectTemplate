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
