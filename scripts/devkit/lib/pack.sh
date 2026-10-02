# shellcheck shell=bash
# devkit: Release-Paket schnüren – Prüfsummen, VERSION-Datei, Zip und das generische Release.

# sha256sum unter Linux, shasum unter macOS – das Ausgabeformat ist dasselbe.
dk_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# dk_checksum <datei> – legt <datei>.sha256 daneben (prüfbar mit sha256sum -c)
dk_checksum() {
  ( cd "$(dirname "$1")" && printf '%s  %s\n' "$(dk_sha256 "$(basename "$1")")" "$(basename "$1")" >"$(basename "$1").sha256" )
}

dk_git_dirty_warn() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null | head -n1)" ]; then
    warn "Es gibt nicht committete Änderungen – gebaut wird der Arbeitsstand."
  fi
}

# dk_write_version_file <datei> <version>
dk_write_version_file() {
  local commit
  commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  {
    printf 'version=%s\n' "$2"
    printf 'gebaut=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    [ -z "$commit" ] || printf 'commit=%s\n' "$commit"
  } >"$1"
}

# dk_zip_dir <elternverzeichnis> <ordnername> <zieldatei> – packt den Ordner und legt die Prüfsumme daneben
dk_zip_dir() {
  need zip
  mkdir -p "$(dirname "$3")"
  rm -f "$3" "$3.sha256"
  ( cd "$1" && zip -qr -X "$3" "$2" -x '*.DS_Store' )
  dk_checksum "$3"
}

# ---------------------------------------------------------------- generisches Release
#
# Für Projekte nach dem Template (DK_STD_RELEASE=1). Paket: releases/<slug>-<version>.zip
#   <slug>-<version>/
#     <slug>.jar        RELEASE_JAR   ausführbares Spring-Boot-Jar
#     public_html/      RELEASE_WEB   gebautes Frontend
#     VERSION
#     …                 Inhalt von RELEASE_FILES (setup.sh, conf/ …)

dk_release_zip() { printf '%s/%s-%s.zip' "${RELEASE_DIR:-$ROOT/releases}" "$PROJECT_SLUG" "$1"; }

dk_std_release() {
  local version name zip stage jar="$ROOT/${RELEASE_JAR:-}" web="$ROOT/${RELEASE_WEB:-}" files="$ROOT/${RELEASE_FILES:-deploy}"
  [ -n "${RELEASE_JAR:-}" ] && [ -n "${RELEASE_WEB:-}" ] || die "RELEASE_JAR und RELEASE_WEB in dev.project.sh setzen."
  version="$(dk_release_version)"
  name="$PROJECT_SLUG-$version"
  zip="$(dk_release_zip "$version")"

  if [ -e "$zip" ] && [ "$DK_OPT_FORCE" = 0 ]; then
    die "$(basename "$zip") existiert schon. Version erhöhen (./dev.sh version patch) oder mit --force neu bauen."
  fi
  step "Release $version"
  dk_git_dirty_warn

  if [ "$DK_OPT_NO_BUILD" = 1 ]; then
    info "Bauen übersprungen (--no-build) – vorhandene Ergebnisse werden gepackt."
  else
    dk_preflight
    if [ "$DK_OPT_SKIP_TESTS" = 0 ]; then
      step "Tests"
      dk_run_tests
    fi
    step "Bauen"
    dk_run_build
  fi

  [ -f "$jar" ] || die "$RELEASE_JAR fehlt – ohne --no-build bauen."
  # grep -c statt -q: -q bricht beim ersten Treffer ab, unzip bekommt SIGPIPE und pipefail
  # macht daraus fälschlich einen Fehlschlag.
  [ "$(unzip -l "$jar" 2>/dev/null | grep -c 'BOOT-INF/' || true)" -gt 0 ] \
    || die "$RELEASE_JAR enthält kein BOOT-INF/ – das ist nicht das ausführbare Spring-Boot-Jar."
  [ -f "$web/index.html" ] || die "$RELEASE_WEB/index.html fehlt – Frontend nicht gebaut."

  step "Paket schnüren"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/devkit-release.XXXXXX")"
  mkdir -p "$stage/$name"
  cp "$jar" "$stage/$name/$PROJECT_SLUG.jar"
  cp -R "$web" "$stage/$name/public_html"
  [ ! -d "$files" ] || cp -R "$files"/. "$stage/$name"/
  # Lokale Zugangsdaten (deploy.conf) gehören nicht ins Paket.
  rm -f "$stage/$name/deploy.conf" "$stage/$name/deploy.conf.example"
  [ ! -f "$stage/$name/setup.sh" ] || chmod +x "$stage/$name/setup.sh"
  dk_write_version_file "$stage/$name/VERSION" "$version"
  dk_zip_dir "$stage" "$name" "$zip"
  rm -rf "$stage"

  ok "${zip#"$ROOT"/} ($(du -h "$zip" | cut -f1))"
  dim "SHA-256 $(dk_sha256 "$zip")"
  info "Auf den Server bringen:  ./dev.sh deploy"
}
