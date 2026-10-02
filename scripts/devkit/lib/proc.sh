# shellcheck shell=bash
# devkit: Ports, Warten auf Dienste, Vordergrund-Start mit Präfix, sauberes Beenden.

# ---------------------------------------------------------------- Ports und HTTP

# Achtung: lsof endet mit 1, wenn nichts lauscht. Ohne das abschließende "true" würde
# pipefail diesen Normalfall zu einem Skriptabbruch machen.
port_pid()  { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n1 || true; }
port_busy() { [ -n "$(port_pid "$1")" ]; }

pid_name() { ps -o comm= -p "$1" 2>/dev/null | sed 's|.*/||' || echo unbekannt; }

# Bricht ab, wenn ein fremder Prozess den Port hält. Ohne diese Prüfung landet der Konflikt erst
# im Stacktrace des Dienstes – oder schlimmer, wir reden mit der falschen Anwendung.
require_free_port() {
  local port="$1" label="$2" holder
  holder="$(port_pid "$port")"
  [ -n "$holder" ] || return 0
  die "Port $port ist belegt (PID $holder: $(pid_name "$holder")) – $label kann dort nicht starten.
    Läuft das Projekt schon in einem anderen Terminal? Sonst beenden mit:  kill $holder"
}

# -k: Dev-Server mit lokalem mkcert-Zertifikat
http_ok() { curl -fsSk -o /dev/null --max-time 3 "$1" 2>/dev/null; }

# wait_for <sekunden> <beschriftung> <befehl…> – wartet, bis der Befehl gelingt
wait_for() {
  local timeout="$1" label="$2" waited=0
  shift 2
  while [ "$waited" -lt "$timeout" ]; do
    if "$@"; then
      [ ! -t 1 ] || printf '\r\033[K'
      return 0
    fi
    [ ! -t 1 ] || printf '\r    %s%s … %ss%s' "$C_DIM" "$label" "$waited" "$C_RESET"
    sleep 1
    waited=$((waited + 1))
  done
  [ ! -t 1 ] || printf '\r\033[K'
  return 1
}

# ---------------------------------------------------------------- Vordergrund-Start

DK_RUN_NAMES=()
DK_RUN_PGIDS=()
DK_PIDS_FILE=""

# Ausgabe zeilenweise mit Präfix versehen und zusätzlich ins Log schreiben. TERM/INT werden
# ignoriert, damit die letzten Zeilen des Herunterfahrens noch ankommen; awk endet mit der Pipe.
dk_prefix() {
  ( trap '' TERM INT
    exec awk -v p="$1" -v lf="$2" '{ print p " " $0; fflush(); if (lf != "") { print $0 >> lf; fflush(lf) } }' )
}

dk_group_alive() { kill -0 -- "-$1" 2>/dev/null; }

dk_svc_ready() {
  dk_svc "$1" || return 0
  if [ -n "$SVC_HEALTH" ]; then http_ok "$SVC_HEALTH"
  elif [ -n "$SVC_PORT" ]; then port_busy "$SVC_PORT"
  fi
}

# Beendet alle gestarteten Prozessgruppen: TERM, 10 s Frist, dann KILL. Wer danach noch lebt
# (z. B. ein hängender Shutdown-Hook), würde sonst den Port belegt halten.
dk_stop_foreground() {
  trap - INT TERM HUP EXIT
  local pg i=0 alive
  [ "${#DK_RUN_PGIDS[@]}" -gt 0 ] || return 0
  printf '\n'
  step "Beende ${DK_RUN_NAMES[*]} …"
  for pg in "${DK_RUN_PGIDS[@]}"; do kill -TERM -- "-$pg" 2>/dev/null || true; done
  while [ "$i" -lt 20 ]; do
    alive=""
    for pg in "${DK_RUN_PGIDS[@]}"; do
      if dk_group_alive "$pg"; then alive="$alive $pg"; fi
    done
    [ -n "$alive" ] || break
    sleep 0.5
    i=$((i + 1))
  done
  if [ -n "$alive" ]; then
    warn "Hängt noch nach 10 s – hart beenden:$alive"
    for pg in $alive; do kill -KILL -- "-$pg" 2>/dev/null || true; done
  fi
  wait 2>/dev/null || true
  rm -f "$DK_PIDS_FILE"
  DK_RUN_PGIDS=()
}

# dk_run_foreground <dienst…>
#   Startet run_<dienst> je als eigene Prozessgruppe (set -m), damit sich die ganze Gruppe beenden
#   lässt – inklusive der JVM unter Maven und vite unter npm. Kehrt zurück, sobald ein Dienst endet.
dk_run_foreground() {
  local name fn width=0 n=0 pg log color label i dead="" ready="" all_ready=0 running
  local colors=("$C_GREEN" "$C_MAGENTA" "$C_CYAN" "$C_BLUE" "$C_YELLOW")
  mkdir -p "$LOG_DIR"
  DK_PIDS_FILE="$DEV_DIR/pids"
  : >"$DK_PIDS_FILE"
  for name in "$@"; do
    [ "${#name}" -le "$width" ] || width=${#name}
    dk_has "run_$(dk_fn "$name")" || die "run_$(dk_fn "$name") fehlt in dev.project.sh."
  done

  trap 'dk_stop_foreground; exit 130' INT
  trap 'dk_stop_foreground; exit 143' TERM HUP
  trap 'dk_stop_foreground' EXIT

  for name in "$@"; do
    fn="run_$(dk_fn "$name")"
    log="$LOG_DIR/$name.log"
    [ ! -f "$log" ] || mv -f "$log" "$log.1"
    color="${colors[$((n % ${#colors[@]}))]}"
    label="$(printf '%s[%-*s]%s' "$color" "$width" "$name" "$C_RESET")"
    set -m
    ( cd "$ROOT" && "$fn" ) </dev/null 2>&1 | dk_prefix "$label" "$log" &
    set +m
    pg="$(jobs -p | tail -n1)"
    DK_RUN_NAMES[n]="$name"
    DK_RUN_PGIDS[n]="$pg"
    # Startzeit des Gruppenführers: daran erkennt `stop`, dass die PID noch derselbe Prozess ist.
    printf '%s %s %s\n' "$name" "$pg" "$(ps -o lstart= -p "$pg" 2>/dev/null | tr -s ' ' '_')" >>"$DK_PIDS_FILE"
    n=$((n + 1))
  done

  while :; do
    running="$(jobs -rp | tr '\n' ' ')"
    i=0
    while [ "$i" -lt "$n" ]; do
      case " $running " in
        *" ${DK_RUN_PGIDS[i]} "*) ;;
        *) dead="${DK_RUN_NAMES[i]}"; break ;;
      esac
      i=$((i + 1))
    done
    [ -z "$dead" ] || break

    if [ "$all_ready" = 0 ]; then
      all_ready=1
      for name in "$@"; do
        case " $ready " in *" $name "*) continue ;; esac
        if dk_svc_ready "$name"; then
          ready="$ready $name"
          dk_svc "$name" && ok "$name bereit${SVC_URL:+ – $SVC_URL}"
        else
          all_ready=0
        fi
      done
      if [ "$all_ready" = 1 ]; then
        dk_hook project_started
        ok "Alles läuft. Ctrl+C beendet alle Dienste."
      fi
    fi
    sleep 1
  done

  fail "$dead hat sich beendet – Log: .dev/logs/$dead.log"
  dk_stop_foreground
  return 1
}

# Beendet Reste eines früheren `start` (Terminal geschlossen, Absturz). Nur Gruppen, deren
# Führer nachweislich noch derselbe Prozess ist – eine wiederverwendete PID bleibt unberührt.
dk_stop_leftovers() {
  local file="$DEV_DIR/pids" name pg started now i
  [ -f "$file" ] || return 0
  while read -r name pg started; do
    [ -n "$pg" ] || continue
    now="$(ps -o lstart= -p "$pg" 2>/dev/null | tr -s ' ' '_')"
    [ -n "$now" ] && [ "$now" = "$started" ] || continue
    kill -TERM -- "-$pg" 2>/dev/null || true
    i=0
    while dk_group_alive "$pg" && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
    if dk_group_alive "$pg"; then
      warn "$name reagiert nicht auf TERM – KILL"
      kill -KILL -- "-$pg" 2>/dev/null || true
    fi
    ok "$name beendet (Rest eines früheren Starts)"
  done <"$file"
  rm -f "$file"
  return 0
}

# Beendet Prozesse, die ein früheres Hintergrund-Startskript hinterlassen hat. DK_LEGACY_PIDS nennt
# dessen PID-Dateien (relativ zum Projekt-Root). Übergangshilfe für Projekte, die von einem
# Hintergrund- auf den Vordergrund-Start gewechselt sind; danach sind die Dateien weg.
dk_stop_legacy() {
  local f pid i
  for f in ${DK_LEGACY_PIDS:-}; do
    [ -f "$ROOT/$f" ] || continue
    pid="$(tr -cd '0-9' <"$ROOT/$f")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # erst die ganze Prozessgruppe, sonst der Prozess allein
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      i=0
      while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.5; i=$((i + 1)); done
      if kill -0 "$pid" 2>/dev/null; then
        warn "PID $pid ($f) reagiert nicht auf TERM – KILL"
        kill -KILL "$pid" 2>/dev/null || true
      fi
      ok "Altprozess beendet (PID $pid aus $f)"
    fi
    rm -f "$ROOT/$f"
  done
}
