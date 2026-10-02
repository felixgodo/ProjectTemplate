# shellcheck shell=bash disable=SC2034
# devkit: Ausgabe, Werkzeugprüfung, Rückfrage.

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_BLUE=$'\033[1;34m'; C_MAGENTA=$'\033[1;35m'; C_CYAN=$'\033[1;36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_MAGENTA=''; C_CYAN=''
fi
C_OFF="$C_RESET"

step()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info()  { printf '    %s\n' "$*"; }
dim()   { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
warn()  { printf '%s  !%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { printf '%s  ✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()   { fail "$*"; exit 1; }
head1() { printf '\n%s%s%s\n\n' "$C_BOLD" "$*" "$C_RESET"; }

# need <werkzeug…> – bricht ab, wenn eines fehlt
need() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' wird benötigt, ist aber nicht installiert."
  done
}

# confirm <frage> – nur j/ja/y/yes gilt als Zustimmung
confirm() {
  local answer
  [ -t 0 ] || die "Keine Rückfrage möglich (kein Terminal). Mit --yes bestätigen."
  printf '\n%s%s%s [j/N] ' "$C_BOLD" "$1" "$C_RESET"
  read -r answer || answer=''
  case "$answer" in
    j|J|ja|Ja|y|Y|yes) return 0 ;;
    *)                 return 1 ;;
  esac
}
