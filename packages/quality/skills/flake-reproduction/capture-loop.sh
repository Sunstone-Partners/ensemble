#!/usr/bin/env bash
# Bounded flake capture loop. Stack-neutral: it runs the command you give it.
#
#   RUNS=150 STOP_AFTER=2 BURNERS=0 OUT_DIR=tmp/flake-capture ./capture-loop.sh -- <test command...>
#
# Environment (all optional):
#   RUNS        maximum number of runs                         (default 150)
#   STOP_AFTER  stop after this many captured failures         (default 2)
#   BURNERS     CPU burner processes held during the loop      (default 0; at most half the logical cores)
#   OUT_DIR     where logs and runs.tsv are written            (default flake-capture)
#   KEEP_PASS   1 keeps the output of passing runs too         (default 0)
#
# Every failing run keeps its FULL output in OUT_DIR/fail-<n>.log. runs.tsv has one row per run:
# run, exit code, seconds, load average, log file (failing runs only).
#
# Exit status: 0 no failure captured within the bound (this is not proof the test is fixed),
# 1 at least one failure captured, 2 usage error. No retries: each run is one run of the command.
set -u

RUNS=${RUNS:-150}
STOP_AFTER=${STOP_AFTER:-2}
BURNERS=${BURNERS:-0}
OUT_DIR=${OUT_DIR:-flake-capture}
KEEP_PASS=${KEEP_PASS:-0}

usage() { echo "usage: [RUNS=n] [STOP_AFTER=n] [BURNERS=n] [OUT_DIR=dir] $0 -- <command...>" >&2; exit 2; }

[ "${1:-}" = "--" ] || usage
shift
[ $# -gt 0 ] || usage
for v in RUNS STOP_AFTER BURNERS; do
  case "${!v}" in ''|*[!0-9]*) echo "$v must be a non-negative integer" >&2; exit 2 ;; esac
done
[ "$RUNS" -ge 1 ] && [ "$STOP_AFTER" -ge 1 ] || { echo "RUNS and STOP_AFTER must be at least 1" >&2; exit 2; }

cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
max_burners=$((cores / 2))
if [ "$BURNERS" -gt "$max_burners" ]; then
  echo "BURNERS=$BURNERS exceeds the bound of half the logical cores ($max_burners of $cores)" >&2
  exit 2
fi

mkdir -p "$OUT_DIR" || exit 2
printf 'run\texit\tseconds\tload\tlog\n' > "$OUT_DIR/runs.tsv"

burner_pids=""
stop_burners() {
  for pid in $burner_pids; do kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; done
  burner_pids=""
}
trap stop_burners EXIT INT TERM
i=0
while [ "$i" -lt "$BURNERS" ]; do
  ( while :; do :; done ) &
  burner_pids="$burner_pids $!"
  i=$((i + 1))
done

load() { uptime | sed 's/.*load averages*: *//; s/,//g'; }

failures=0
run=0
while [ "$run" -lt "$RUNS" ] && [ "$failures" -lt "$STOP_AFTER" ]; do
  run=$((run + 1))
  log="$OUT_DIR/run-$run.log"
  start=$(date +%s)
  "$@" > "$log" 2>&1
  code=$?
  secs=$(( $(date +%s) - start ))
  kept=""
  if [ "$code" -ne 0 ]; then
    failures=$((failures + 1))
    kept="$OUT_DIR/fail-$run.log"
    mv "$log" "$kept"
  elif [ "$KEEP_PASS" = "1" ]; then
    kept="$log"
  else
    rm -f "$log"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$run" "$code" "$secs" "$(load)" "$kept" >> "$OUT_DIR/runs.tsv"
done

echo "command: $*"
echo "runs: $run  failures: $failures  burners: $BURNERS  load: $(load)"
echo "log index: $OUT_DIR/runs.tsv"
if [ "$failures" -gt 0 ]; then
  echo "captured $failures failing run(s): see fail-*.log in $OUT_DIR (each has the full output, including the replay handle)"
  exit 1
fi
echo "no failure in $run runs: rate p is excluded at 95% only for p >= 3/$run; this does not show the test is fixed"
exit 0
