# shellcheck shell=sh
# Gemeinsame Teile von ci/runner-server und ci/runner-pool: Runner-Image, CI-Slice, Messung.
# Teil des beadskit aus dem ProjectTemplate – nicht im Projekt ändern.
# Version des actions-runner-Images (Basis für runner-server und runner-pool)
# shellcheck disable=SC2034
RUNNER_VERSION=2.337.0

# Erwartet: VERSION, EXTRA_APT (dockerfile), SLICE, CI_CPUS, CI_MEM (slice_script), SLICE, DIR (usage_script).

dockerfile() {
  cat <<EOF
# Erzeugt von beadskit ci (runner-server/runner-pool) – nicht von Hand ändern.
FROM ghcr.io/actions/actions-runner:$VERSION
USER root
# Was ubuntu-latest vorinstalliert hat und CIs meist brauchen: maven, rsync + shellcheck,
# unzip/xz/jq, fontconfig + eine Systemschrift (AWT-Textrasterung; ohne sie wirft der
# JDK-FontManager "Fontconfig head is null"); dazu RUNNER_APT des Projekts bzw. aller Projekte des Pools.
# _work/_tool und ~/.cache gehören runner, damit leere Volumes dort beschreibbar sind (Pool).
RUN apt-get update \\
 && apt-get install -y --no-install-recommends maven rsync shellcheck unzip zip xz-utils jq \\
    fontconfig fonts-dejavu-core $EXTRA_APT \\
 && rm -rf /var/lib/apt/lists/* \\
 && rm -f /etc/sudoers.d/* \\
 && mkdir -p /home/runner/_work/_tool /home/runner/.cache \\
 && chown -R runner:runner /home/runner/_work /home/runner/.cache
USER runner
EOF
}

# systemd-Slice für alle CI-Container auf dem Server (gemeinsam für alle Projekte, der letzte
# `setup` bestimmt die Werte). set-property übernimmt sie sofort, auch bei laufenden Containern.
slice_script() {
  cat <<EOF
cat >/etc/systemd/system/$SLICE <<'SLICE'
# Erzeugt von beadskit ci (runner-server/runner-pool) – nicht von Hand ändern.
[Unit]
Description=CI-Runner (beadskit), gemeinsamer Deckel für CPU und RAM

[Slice]
CPUQuota=${CI_CPUS}00%
CPUWeight=20
IOWeight=20
MemoryHigh=$(mem_high)
MemoryMax=$CI_MEM
SLICE
systemctl daemon-reload
systemctl start $SLICE
systemctl set-property --runtime $SLICE CPUQuota=${CI_CPUS}00% CPUWeight=20 IOWeight=20 MemoryHigh=$(mem_high) MemoryMax=$CI_MEM
EOF
}

# MemoryHigh (ab hier drosselt der Kernel) = 90 % von RUNNER_CI_MEM
mem_high() {
  n=${CI_MEM%[KMGT]}
  u=${CI_MEM#"$n"}
  case $u in
    G) echo "$((n * 1024 * 9 / 10))M" ;;
    T) echo "$((n * 1024 * 9 / 10))G" ;;
    M) echo "$((n * 9 / 10))M" ;;
    K) echo "$((n * 9 / 10))K" ;;
    *) echo "$((n * 9 / 10))" ;;
  esac
}

# Auslastung auf dem Server als JSON: {containers: {runner-1|pool-…|mysql: {cpu, mem}}, slice: {cpuPct, cpus, mem}}.
# Mit DIR die Container der compose.yml dort (runner-server), sonst die des Pools (runner-pool).
# cpu in % eines Kerns. Die Slice wird über die Dauer von `docker stats` gemessen (zwei Lesungen
# von usage_usec), cpus ist die Quota in Kernen (null ohne Slice).
usage_script() {
  printf 'slice=%s\ndir=%s\n' "$SLICE" "${DIR-}"
  cat <<'EOF'
# Bindestriche im Namen sind für systemd Hierarchie (beadskit.slice/beadskit-ci.slice)
cg=/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$slice" 2>/dev/null)
[ "$cg" != /sys/fs/cgroup ] || cg=/nicht-vorhanden
u() { sed -n 's/^usage_usec //p' "$cg/cpu.stat" 2>/dev/null; }
t0=$(date +%s%N) u0=$(u)
if [ -n "$dir" ]; then
  ids=$(cd "$dir" 2>/dev/null && docker compose ps -q 2>/dev/null || true)
else
  ids=$(docker ps -q --filter label=beadskit.pool; docker ps -q --filter name='^beadskit-ci-(mysql|mariadb)$')
fi
stats=$([ -n "$ids" ] && docker stats --no-stream --format '{{.Name}}	{{.CPUPerc}}	{{.MemUsage}}' $ids 2>/dev/null || true)
t1=$(date +%s%N) u1=$(u)
quota=$(cut -d' ' -f1 "$cg/cpu.max" 2>/dev/null)
mem=$(cat "$cg/memory.current" 2>/dev/null)
printf '%s\n' "$stats" | awk -F'\t' -v u0="$u0" -v u1="$u1" -v t0="$t0" -v t1="$t1" -v q="$quota" -v m="$mem" '
  function bytes(s,  n, u) {
    n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
    return (n * (u == "KiB" ? 1024 : u == "MiB" ? 1048576 : u == "GiB" ? 1073741824 : u == "TiB" ? 1099511627776 : 1))
  }
  BEGIN { printf "{\"containers\":{"; sep = "" }
  NF >= 3 {
    if ($1 ~ /-mysql-[0-9]+$/ || $1 == "beadskit-ci-mysql") svc = "mysql"
    else if ($1 == "beadskit-ci-mariadb") svc = "mariadb"
    else if (match($1, /runner-[0-9]+-[0-9]+$/)) { svc = substr($1, RSTART, RLENGTH); sub(/-[0-9]+$/, "", svc) }
    else if ($1 ~ /^pool-/) svc = $1
    else next
    split($3, mm, " / "); cpu = $2; sub(/%/, "", cpu)
    printf "%s\"%s\":{\"cpu\":%.1f,\"mem\":%.0f}", sep, svc, cpu + 0, bytes(mm[1]); sep = ","
  }
  END {
    printf "},\"slice\":{"
    if (u0 != "" && u1 != "" && t1 > t0) printf "\"cpuPct\":%.1f,", (u1 - u0) * 100000 / (t1 - t0); else printf "\"cpuPct\":null,"
    if (q ~ /^[0-9]+$/) printf "\"cpus\":%.2f,", q / 100000; else printf "\"cpus\":null,"
    if (m ~ /^[0-9]+$/) printf "\"mem\":%.0f", m; else printf "\"mem\":null"
    print "}}"
  }'
EOF
}
