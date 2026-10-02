# shellcheck shell=bash
# devkit: eine Version für alles – lesen, prüfen, hochzählen, überall setzen.
#
# Stellen (aus dev.project.sh): VERSION_POM (Wurzel-POM samt Modulen), VERSION_NPM (package.json
# und package-lock.json je Verzeichnis), VERSION_FILES (einfache VERSION-Dateien). Weitere Stellen
# meldet der Hook project_version_extra show|set <version>.

DK_VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

dk_valid_version() { [[ "$1" =~ $DK_VERSION_RE ]]; }

# dk_bump <version> <patch|minor|major> – ein -SNAPSHOT bleibt erhalten, andere Suffixe (-rc1) fallen weg
dk_bump() {
  local v="$1" base suffix="" major minor patch
  base="${v%%-*}"
  case "$v" in *-SNAPSHOT) suffix="-SNAPSHOT" ;; esac
  IFS=. read -r major minor patch <<EOF
$base
EOF
  case "$2" in
    major) major=$((10#$major + 1)); minor=0; patch=0 ;;
    minor) minor=$((10#$minor + 1)); patch=0 ;;
    patch) patch=$((10#$patch + 1)) ;;
    *) die "Erwartet major, minor oder patch (bekam '$2')" ;;
  esac
  printf '%d.%d.%d%s' "$((10#$major))" "$((10#$minor))" "$((10#$patch))" "$suffix"
}

# dk_next_version <aktuell> <patch|minor|major|release|snapshot|x.y.z>
dk_next_version() {
  local cur="$1" arg="$2"
  case "$arg" in
    patch|minor|major) dk_bump "$cur" "$arg" ;;
    release)           printf '%s' "${cur%%-*}" ;;
    snapshot)
      case "$cur" in
        *-SNAPSHOT) printf '%s' "$cur" ;;
        *-*)        printf '%s-SNAPSHOT' "${cur%%-*}" ;;
        # Nach einem Release ist der nächste Arbeitsstand die nächste Patch-Version.
        *)          printf '%s-SNAPSHOT' "$(dk_bump "$cur" patch)" ;;
      esac ;;
    *) printf '%s' "${arg#v}" ;;
  esac
}

# ---------------------------------------------------------------- Lesen

# Erstes <feld> außerhalb des <parent>-Blocks – in der Wurzel-POM die Projektversion bzw. artifactId.
dk_pom_field() {
  awk -v f="$2" '
    /<parent>/ { p = 1 }
    /<\/parent>/ { p = 0; next }
    !p && index($0, "<" f ">") { gsub(".*<" f ">|</" f ">.*", ""); print; exit }' "$1"
}

# <feld> aus dem <parent>-Block eines Moduls
dk_pom_parent_field() {
  awk -v f="$2" '
    /<parent>/ { p = 1 }
    p && index($0, "<" f ">") { gsub(".*<" f ">|</" f ">.*", ""); print; exit }
    /<\/parent>/ { exit }' "$1"
}

dk_pom_version() { dk_pom_field "$1" version; }

# POMs der Module, die auf die Wurzel-POM als Parent verweisen (Pfade relativ zum Projekt-Root)
dk_pom_modules() {
  local pom="$1" dir root_id m f
  dir="$(dirname "$pom")"
  root_id="$(dk_pom_field "$pom" artifactId)"
  sed -n 's:.*<module>\(.*\)</module>.*:\1:p' "$pom" | while read -r m; do
    f="$dir/$m/pom.xml"
    [ -f "$f" ] || continue
    [ "$(dk_pom_parent_field "$f" artifactId)" = "$root_id" ] || continue
    # ../ und ./ aus dem Pfad nehmen, damit die Anzeige lesbar bleibt
    ( cd "$(dirname "$f")" && printf '%s/pom.xml\n' "${PWD#"$ROOT"/}" )
  done
}

# Oberste "version" einer package.json oder package-lock.json (zwei Leerzeichen eingerückt)
dk_npm_version() {
  sed -nE 's/^  "version": *"([^"]*)".*/\1/p' "$1" 2>/dev/null | head -n1
}

# Erste nicht-leere, nicht-kommentierte Zeile
dk_file_version() {
  [ -f "$1" ] || return 0
  grep -v '^[[:space:]]*#' "$1" | grep -v '^[[:space:]]*$' | head -n1 | tr -d '[:space:]' || true
}

# Maßgebliche Version: Wurzel-POM, sonst erste VERSION-Datei, sonst erste package.json
dk_current_version() {
  local f
  if [ -n "$VERSION_POM" ]; then
    dk_pom_version "$ROOT/$VERSION_POM"
  elif [ -n "$VERSION_FILES" ]; then
    for f in $VERSION_FILES; do dk_file_version "$ROOT/$f"; return; done
  elif [ -n "$VERSION_NPM" ]; then
    for f in $VERSION_NPM; do dk_npm_version "$ROOT/$f/package.json"; return; done
  fi
}

dk_require_version() {
  local v
  v="$(dk_current_version)"
  [ -n "$v" ] || die "Keine Version gefunden – VERSION_POM, VERSION_FILES oder VERSION_NPM in dev.project.sh setzen."
  printf '%s' "$v"
}

# ---------------------------------------------------------------- Anzeigen und prüfen

DK_VER_EXPECT=""
DK_VER_OK=1
DK_VER_QUIET=0

# dk_version_row <stelle> <version> [erwartet] – eine Zeile der Übersicht; merkt sich Abweichungen.
#   [erwartet] für Stellen, die die Version in anderer Form tragen (z. B. ohne -SNAPSHOT).
dk_version_row() {
  local mark=""
  if [ "$2" != "${3:-$DK_VER_EXPECT}" ]; then DK_VER_OK=0; mark="  ${C_YELLOW}← weicht ab${C_RESET}"; fi
  [ "$DK_VER_QUIET" = 1 ] || printf '  %-46s %s%s\n' "$1" "${2:--}" "$mark"
}

dk_version_rows() {
  local f m
  if [ -n "$VERSION_POM" ]; then
    dk_version_row "$VERSION_POM" "$(dk_pom_version "$ROOT/$VERSION_POM")"
    for m in $(dk_pom_modules "$ROOT/$VERSION_POM"); do
      dk_version_row "$m (parent)" "$(dk_pom_parent_field "$ROOT/$m" version)"
    done
  fi
  for f in $VERSION_NPM; do
    dk_version_row "$f/package.json" "$(dk_npm_version "$ROOT/$f/package.json")"
    [ ! -f "$ROOT/$f/package-lock.json" ] \
      || dk_version_row "$f/package-lock.json" "$(dk_npm_version "$ROOT/$f/package-lock.json")"
  done
  for f in $VERSION_FILES; do
    dk_version_row "$f" "$(dk_file_version "$ROOT/$f")"
  done
  dk_hook project_version_extra show
}

# Rückgabe 0, wenn alle Stellen dieselbe Version tragen (ohne Ausgabe)
dk_versions_equal() {
  DK_VER_EXPECT="$(dk_require_version)"; DK_VER_OK=1; DK_VER_QUIET=1
  dk_version_rows
  DK_VER_QUIET=0
  [ "$DK_VER_OK" = 1 ]
}

dk_version_show() {
  DK_VER_EXPECT="$(dk_require_version)"; DK_VER_OK=1; DK_VER_QUIET=0
  printf '\n%sVersion %s%s\n\n' "$C_BOLD" "$DK_VER_EXPECT" "$C_RESET"
  dk_version_rows
  echo
  if [ "$DK_VER_OK" = 1 ]; then
    ok "Alle Stellen gleich."
  else
    warn "Die Versionen laufen auseinander. Angleichen mit:  ./dev.sh version $DK_VER_EXPECT"
    return 1
  fi
}

# Version für Release und Deploy: bricht ab, wenn die Stellen auseinanderlaufen
dk_release_version() {
  dk_versions_equal || die "Die Versionen laufen auseinander – erst angleichen:  ./dev.sh version $(dk_require_version)"
  printf '%s' "$DK_VER_EXPECT"
}

# ---------------------------------------------------------------- Schreiben

dk_rewrite() {  # dk_rewrite <datei> <awk-programm> <version>
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/devkit-version.XXXXXX")"
  awk -v v="$3" "$2" "$1" >"$tmp" && cat "$tmp" >"$1"
  rm -f "$tmp"
}

# POMs direkt umschreiben: Projektversion der Wurzel-POM und <parent><version> der Module.
dk_pom_set_awk() {
  local pom="$ROOT/$VERSION_POM" new="$1" m
  for m in $(dk_pom_modules "$pom"); do
    dk_rewrite "$ROOT/$m" '
      /<parent>/ { p = 1 }
      p && /<version>/ { sub(/<version>[^<]*<\/version>/, "<version>" v "</version>") }
      /<\/parent>/ { p = 0 }
      { print }' "$new"
  done
  dk_rewrite "$pom" '
    /<parent>/ { p = 1 }
    !p && !done && /<version>/ { sub(/<version>[^<]*<\/version>/, "<version>" v "</version>"); done = 1 }
    /<\/parent>/ { p = 0 }
    { print }' "$new"
}

dk_pom_set_mvn() {
  need mvn
  # Aktualisiert Wurzel-POM und <parent><version> aller Module in einem Zug.
  ( cd "$(dirname "$ROOT/$VERSION_POM")" \
    && mvn -q -B versions:set -DnewVersion="$1" -DprocessAllModules=true -DgenerateBackupPoms=false ) \
    || die "mvn versions:set fehlgeschlagen."
}

dk_version_write() {
  local new="$1" f
  if [ -n "$VERSION_POM" ]; then
    case "$VERSION_POM_MODE" in
      awk) dk_pom_set_awk "$new" ;;
      *)   dk_pom_set_mvn "$new" ;;
    esac
  fi
  if [ -n "$VERSION_NPM" ]; then
    need npm
    for f in $VERSION_NPM; do
      ( cd "$ROOT/$f" && npm version "$new" --no-git-tag-version --allow-same-version >/dev/null ) \
        || die "npm version in $f fehlgeschlagen."
    done
  fi
  for f in $VERSION_FILES; do printf '%s\n' "$new" >"$ROOT/$f"; done
  dk_hook project_version_extra set "$new"
}

# ---------------------------------------------------------------- Befehl

dk_cmd_version() {
  local target="" kind="" cur new arg
  for arg in "$@"; do
    case "$arg" in
      --short)    dk_require_version; echo; return 0 ;;
      --release)  kind=release ;;
      --snapshot) kind=snapshot ;;
      set)        ;;   # ./dev.sh version set 1.2.3 (Schreibweise aus LicenseHub)
      -*)         die "Unbekannte Option für version: $arg" ;;
      *)          [ -z "$target" ] || die "version erwartet höchstens ein Ziel: patch, minor, major, release, snapshot oder 1.2.3"
                  target="$arg" ;;
    esac
  done

  if [ -z "$target" ] && [ -z "$kind" ]; then
    dk_version_show
    return
  fi

  cur="$(dk_require_version)"
  new="$cur"
  [ -z "$target" ] || new="$(dk_next_version "$cur" "$target")"
  case "$kind" in
    release)  new="${new%%-*}" ;;
    snapshot) new="${new%%-*}-SNAPSHOT" ;;
  esac
  dk_valid_version "$new" || die "Ungültige Version '$new' – erwartet 1.2.3, 1.2.3-SNAPSHOT oder 1.2.3-rc1."

  if [ "$new" = "$cur" ] && dk_versions_equal; then
    ok "Version bleibt $cur."
    return 0
  fi
  step "Version $cur → $new"
  dk_version_write "$new"
  dk_version_show
}
