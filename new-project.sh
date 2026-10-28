#!/usr/bin/env bash
# Erzeugt aus diesem Template ein neues Projekt.
#
#   ./new-project.sh <Name> [Optionen]
#
#   <Name>                 Projektname, z. B. InvoiceHub (Buchstaben und Ziffern, beginnt mit Buchstabe)
#   --dir <pfad>           Zielverzeichnis (Standard: ../<Name>)
#   --group <groupId>      Maven-groupId und Java-Paketwurzel (Standard: de.obenaus)
#   --prefix <KÜRZEL>      Präfix der Umgebungsvariablen, z. B. IH → IH_BACKEND_PORT (Standard: Name in Großbuchstaben)
#   --backend-port <n>     Standard: nächster freier nach den Nachbarprojekten, ab 8101
#   --frontend-port <n>    ab 5201
#   --db-port <n>          ab 3311
#   --no-git               kein `git init`
#
# Kopiert alles außer Build-Ergebnissen, benennt Dateien, Pakete, Artefakte und Ports um und trägt
# das Projekt in devkit-projects.txt ein. Danach im neuen Projekt:  ./dev.sh start
set -euo pipefail

TEMPLATE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/devkit/lib/log.sh
. "$TEMPLATE/scripts/devkit/lib/log.sh"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

NAME=""; DIR=""; GROUP="de.obenaus"; PREFIX=""; BACKEND_PORT=""; FRONTEND_PORT=""; DB_PORT=""; GIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)           DIR="${2:?--dir braucht einen Wert}"; shift 2 ;;
    --group)         GROUP="${2:?--group braucht einen Wert}"; shift 2 ;;
    --prefix)        PREFIX="${2:?--prefix braucht einen Wert}"; shift 2 ;;
    --backend-port)  BACKEND_PORT="${2:?}"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="${2:?}"; shift 2 ;;
    --db-port)       DB_PORT="${2:?}"; shift 2 ;;
    --no-git)        GIT=0; shift ;;
    -h|--help)       usage; exit 0 ;;
    -*)              die "Unbekannte Option: $1" ;;
    *)               [ -z "$NAME" ] || die "Nur ein Projektname erlaubt."; NAME="$1"; shift ;;
  esac
done

[ -n "$NAME" ] || { usage; exit 1; }
[[ "$NAME" =~ ^[A-Za-z][A-Za-z0-9]*$ ]] || die "Ungültiger Name '$NAME' – nur Buchstaben und Ziffern, beginnt mit einem Buchstaben."
[[ "$GROUP" =~ ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$ ]] || die "Ungültige groupId '$GROUP' – z. B. de.obenaus"
SLUG="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')"
[ "$SLUG" != projecttemplate ] || die "Der Name ist dem Template vorbehalten."
[ -n "$PREFIX" ] || PREFIX="$(printf '%s' "$NAME" | tr '[:lower:]' '[:upper:]')"
[[ "$PREFIX" =~ ^[A-Z][A-Z0-9]*$ ]] || die "Ungültiges Präfix '$PREFIX' – nur Großbuchstaben und Ziffern."
[ -n "$DIR" ] || DIR="$TEMPLATE/../$NAME"
[ ! -e "$DIR" ] || die "$DIR existiert schon."
need rsync perl

# Ports, die Nachbarprojekte in ihrer dev.project.sh schon vergeben haben
USED=" $(grep -hoE 'PORT:-[0-9]+' "$TEMPLATE"/../*/dev.project.sh 2>/dev/null | sed 's/.*:-//' | tr '\n' ' ') "
free_port() {
  local p="$1"
  while [[ "$USED" == *" $p "* ]]; do p=$((p + 1)); done
  echo "$p"
}
[ -n "$BACKEND_PORT" ]  || BACKEND_PORT="$(free_port 8101)"
[ -n "$FRONTEND_PORT" ] || FRONTEND_PORT="$(free_port 5201)"
[ -n "$DB_PORT" ]       || DB_PORT="$(free_port 3311)"
for p in "$BACKEND_PORT" "$FRONTEND_PORT" "$DB_PORT"; do
  [[ "$p" =~ ^[0-9]{4,5}$ ]] || die "Ungültiger Port '$p'."
done

step "Neues Projekt $NAME in $DIR"
info "groupId $GROUP · Paket $GROUP.$SLUG · Präfix ${PREFIX}_ · Ports $BACKEND_PORT / $FRONTEND_PORT / $DB_PORT"

mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd -P)"
rsync -a \
  --exclude '.git/' --exclude '.idea/' --exclude '*.iml' --exclude '.DS_Store' \
  --exclude 'node_modules/' --exclude 'target/' --exclude 'dist/' --exclude '*.tsbuildinfo' \
  --exclude '.dev/' --exclude '/releases/' --exclude '/deploy/deploy.conf' \
  --exclude '/new-project.sh' --exclude '/devkit-sync.sh' --exclude '/beadskit-sync.sh' --exclude '/leitstand.sh' --exclude '/devkit-projects.txt*' \
  --exclude '/scripts/remote/repos.txt' --exclude '/README.md' --exclude '/README.de.md' --exclude '/LICENSE' \
  "$TEMPLATE/" "$DIR/"
mv "$DIR/README.project.md" "$DIR/README.md"

# Java-Paketverzeichnisse: de/obenaus/projecttemplate → <group>/<slug>
GROUP_PATH="$(printf '%s' "$GROUP" | tr . /)"
for base in backend/src/main/java backend/src/test/java; do
  [ -d "$DIR/$base/de/obenaus/projecttemplate" ] || continue
  mkdir -p "$DIR/$base/.new/$GROUP_PATH"
  mv "$DIR/$base/de/obenaus/projecttemplate" "$DIR/$base/.new/$GROUP_PATH/$SLUG"
  rm -rf "${DIR:?}/$base/de"
  # .new erst jetzt auflösen: die neue Paketwurzel kann wieder mit "de" beginnen
  ( cd "$DIR/$base/.new" && find . -mindepth 1 -maxdepth 1 -exec mv {} .. \; )
  rmdir "$DIR/$base/.new"
done

# Dateien, die den Projektnamen tragen (deploy/conf/projecttemplate.service …)
find "$DIR" -depth -name '*projecttemplate*' -not -path '*/scripts/devkit/*' | while IFS= read -r f; do
  mv "$f" "$(dirname "$f")/$(basename "$f" | sed "s/projecttemplate/$SLUG/g")"
done

# Inhalte. Der devkit bleibt unberührt – er ist in allen Projekten identisch.
export NP_GROUP="$GROUP" NP_SLUG="$SLUG" NP_NAME="$NAME" NP_PREFIX="$PREFIX"
find "$DIR" -type f -not -path '*/scripts/devkit/*' -not -name 'dev.sh' | while IFS= read -r f; do
  grep -Iq . "$f" 2>/dev/null || continue
  perl -pi -e '
    s/de\.obenaus\.projecttemplate/$ENV{NP_GROUP}.$ENV{NP_SLUG}/g;
    s{<groupId>de\.obenaus</groupId>}{<groupId>$ENV{NP_GROUP}</groupId>}g;
    s/ProjectTemplate/$ENV{NP_NAME}/g;
    s/projecttemplate/$ENV{NP_SLUG}/g;
    s/PTPL/$ENV{NP_PREFIX}/g;
  ' "$f"
done

# Ports nur dort, wo sie wirklich stehen (nicht in package-lock.json: dort sind es Prüfsummen)
export NP_BP="$BACKEND_PORT" NP_FP="$FRONTEND_PORT" NP_DP="$DB_PORT"
for f in dev.project.sh docker-compose.yml frontend/vite.config.ts backend/src/main/resources/application.yml \
         "deploy/conf/$SLUG.env.example" deploy/setup.sh README.md; do
  [ -f "$DIR/$f" ] || continue
  perl -pi -e 's/\b8100\b/$ENV{NP_BP}/g; s/\b5200\b/$ENV{NP_FP}/g; s/\b3310\b/$ENV{NP_DP}/g' "$DIR/$f"
done

chmod +x "$DIR/dev.sh" "$DIR/deploy/setup.sh"

if [ "$GIT" = 1 ] && command -v git >/dev/null 2>&1; then
  git -C "$DIR" init -q
  ok "git init"
fi

# Für ./devkit-sync.sh merken
REL="../$(basename "$DIR")"
[ "$(cd "$DIR/.." && pwd -P)" = "$(cd "$TEMPLATE/.." && pwd -P)" ] || REL="$DIR"
if ! grep -qxF "$REL" "$TEMPLATE/devkit-projects.txt" 2>/dev/null; then
  printf '%s\n' "$REL" >>"$TEMPLATE/devkit-projects.txt"
fi

ok "$NAME angelegt."
info "cd $DIR && ./dev.sh start"
