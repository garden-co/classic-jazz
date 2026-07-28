#!/usr/bin/env bash
#
# yardstick-compare.sh — run bench/cojson/e2eYardstick.bench.ts against the
# CURRENT worktree and a fresh origin/main worktree, then print a side-by-side
# table with multipliers. The numbers are the baseline for the "≥5x vs main"
# migration goal.
#
# Usage:
#   bench/cojson/yardstick-compare.sh [iterations]
#
# The bench file uses ONLY the cojson public API, so the SAME file runs on both
# branches. main lacks the file (it is new on the migration branch), so we copy
# the identical file into main's worktree. Any shape whose API is missing on a
# branch degrades to a skip rather than crashing the suite.
#
# Environment:
#   YARDSTICK_ITERATIONS   iteration cap (default 20, or $1)
#   YARDSTICK_SKIP_MAIN=1  skip the main build+run (current-only smoke)
#
# This is a LONG-RUNNING script (it builds main's native napi binding from
# Rust). Run it in the FOREGROUND:
#   bash bench/cojson/yardstick-compare.sh
# The first run compiles ~hundreds of crates (~minutes); later runs reuse a
# persistent cargo cache at $REPO_ROOT/.yardstick-cargo-target and rebuild only
# the workspace crates (~seconds).
#
# NOTE: changes from this script live only under bench/. The temp worktree and
# scratch dir are created inside the current worktree (the sandbox confines
# writes here) and removed on exit; the cargo cache is left in place for reuse.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BENCH_REL="bench/cojson/e2eYardstick.bench.ts"
MAIN_REF="origin/main"
ITERATIONS="${1:-${YARDSTICK_ITERATIONS:-20}}"
SKIP_MAIN="${YARDSTICK_SKIP_MAIN:-0}"
NODE_BIN="${NODE:-node}"

SCRATCH="$REPO_ROOT/.yardstick-scratch"
MAIN_WT="$REPO_ROOT/.yardstick-main-worktree"
CURRENT_JSON="$SCRATCH/current.json"
MAIN_JSON="$SCRATCH/main.json"

# Color helpers (no-op if not a TTY / NO_COLOR set)
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_CYN=$'\033[36m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'; C_BLD=$'\033[1m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""; C_DIM=""; C_RST=""; C_BLD=""
fi

log() { printf '%syardstick%s %s\n' "$C_CYN" "$C_RST" "$*"; }
err() { printf '%syardstick ERROR%s %s\n' "$C_RED" "$C_RST" "$*" >&2; }

mkdir -p "$SCRATCH"
cleanup() {
  local rc=$?
  log "cleaning up temp worktree..."
  git worktree remove --force "$MAIN_WT" 2>/dev/null || true
  rm -rf "$SCRATCH"
  exit $rc
}
trap cleanup EXIT INT TERM

run_bench() {
  # $1 = cwd (worktree root), $2 = output json file
  local cwd="$1"; local out="$2"; local attempt=0; local max=3
  while (( attempt < max )); do
    attempt=$((attempt + 1))
    (
      cd "$cwd"
      YARDSTICK_JSON=1 YARDSTICK_ITERATIONS="$ITERATIONS" \
        "$NODE_BIN" --experimental-strip-types --no-warnings "$BENCH_REL"
    ) >"$out" 2>"$SCRATCH/run.stderr"
    # The bench emits exactly one JSON line on stdout.
    if grep -q '^{' "$out"; then
      return 0
    fi
    err "no JSON produced (attempt $attempt/$max). Tail of stderr:"
    tail -n 20 "$SCRATCH/run.stderr" >&2 || true
  done
  return 1
}

# ---------------------------------------------------------------------------
# 1) Current worktree
# ---------------------------------------------------------------------------
log "ITERATIONS=$ITERATIONS  (override with \$1 or YARDSTICK_ITERATIONS)"
log "running yardstick in CURRENT worktree ($REPO_ROOT)..."
if ! run_bench "$REPO_ROOT" "$CURRENT_JSON"; then
  err "current-branch run failed; aborting."
  exit 1
fi
log "current-branch run done."

# ---------------------------------------------------------------------------
# 2) origin/main worktree
# ---------------------------------------------------------------------------
if [[ "$SKIP_MAIN" == "1" ]]; then
  log "YARDSTICK_SKIP_MAIN=1 -> skipping main build+run."
  MAIN_JSON="/dev/null"
else
  log "fetching $MAIN_REF..."
  git fetch origin main >/dev/null 2>&1 || git fetch origin >/dev/null 2>&1 || true

  if [[ -d "$MAIN_WT" ]]; then
    log "removing stale temp worktree..."
    git worktree remove --force "$MAIN_WT" 2>/dev/null || rm -rf "$MAIN_WT"
  fi

  log "creating temp worktree of $MAIN_REF at $MAIN_WT..."
  git worktree add --detach --force "$MAIN_WT" "$MAIN_REF" >/dev/null

  log "installing deps in main worktree (pnpm install)..."
  (cd "$MAIN_WT" && pnpm install >/dev/null 2>&1)

  log "building native napi binding in main worktree (Rust; isolated target)..."
  # Use a PERSISTENT, ISOLATED cargo target (not the current worktree's
  # crates/target — crates/ is edited concurrently by the migration agent, and
  # sharing it would cause cargo invalidation churn / lock contention). This
  # target lives outside crates/ and outside $SCRATCH, so it survives across
  # runs as a build cache (rebuilds after the first are ~seconds).
  (
    cd "$MAIN_WT"
    CARGO_TARGET_DIR="$REPO_ROOT/.yardstick-cargo-target" \
      pnpm --filter cojson-core-napi build:napi >/dev/null 2>&1
  )

  log "building cojson TypeScript in main worktree..."
  (cd "$MAIN_WT" && pnpm --filter cojson build >/dev/null 2>&1)

  log "copying the identical bench file into main worktree..."
  mkdir -p "$MAIN_WT/bench/cojson"
  cp "$REPO_ROOT/$BENCH_REL" "$MAIN_WT/$BENCH_REL"

  log "running yardstick in MAIN worktree ($MAIN_WT)..."
  if ! run_bench "$MAIN_WT" "$MAIN_JSON"; then
    err "main-branch run failed (API gap or build issue); showing current-only."
    MAIN_JSON="/dev/null"
  else
    log "main-branch run done."
  fi
fi

# ---------------------------------------------------------------------------
# 3) Render the side-by-side table
# ---------------------------------------------------------------------------
log "rendering comparison..."
cat > "$SCRATCH/_table.cjs" <<'RENDERER'
const fs = require("fs");
const curRaw = fs.readFileSync(process.argv[2], "utf8").trim();
const mainRaw = process.argv[3] && process.argv[3] !== "/dev/null"
  ? fs.readFileSync(process.argv[3], "utf8").trim()
  : "";
let cur, main;
try { cur = JSON.parse(curRaw); } catch { console.error("current JSON parse failed"); cur = {}; }
try { main = mainRaw ? JSON.parse(mainRaw) : {}; } catch { console.error("main JSON parse failed"); main = {}; }

const names = [...new Set([...Object.keys(cur), ...Object.keys(main)])];
names.sort();

const C = { red:"\x1b[31m", grn:"\x1b[32m", yel:"\x1b[33m", cyn:"\x1b[36m", dim:"\x1b[2m", bld:"\x1b[1m", rst:"\x1b[0m" };

function ops(v) {
  if (!v) return null;
  if (v.ok === false) return "FAIL";
  return v.ops_per_sec;
}
function fmt(o) {
  if (o === null) return C.dim + "  (absent)" + C.rst;
  if (o === "FAIL") return C.red + "    FAIL" + C.rst;
  if (o >= 100) return o.toFixed(0).padStart(8);
  if (o >= 1) return o.toFixed(2).padStart(8);
  return o.toExponential(1).padStart(8);
}

const W = 46;
const header = (t) => C.bld + t + C.rst;
console.log();
console.log(C.bld + "  cojson end-to-end yardstick — current branch vs origin/main" + C.rst);
console.log(C.dim + "  multiplier = current/main  ( >1 = current faster;  goal ≥ 5x )" + C.rst);
console.log();
const row = (c) => [
  c.padEnd(W), "current op/s", "main op/s", "mult", "note",
].join("  ");
console.log(C.dim + "  " + row("shape") + C.rst);

for (const n of names) {
  const co = ops(cur[n]); const mo = ops(main[n]);
  let mult = ""; let note = C.dim + "-" + C.rst; let multCell = C.dim + "   —".padEnd(6) + C.rst;
  if (typeof co === "number" && typeof mo === "number" && mo > 0) {
    const m = co / mo;
    if (m >= 5) { multCell = C.grn + m.toFixed(2).padStart(6) + "x" + C.rst; note = C.grn + "≥5x goal" + C.rst; }
    else if (m >= 1) { multCell = C.grn + m.toFixed(2).padStart(6) + "x" + C.rst; note = C.grn + "faster" + C.rst; }
    else { multCell = C.red + m.toFixed(2).padStart(6) + "x" + C.rst; note = C.red + "regression" + C.rst; }
  } else if (co === "FAIL" || mo === "FAIL") {
    note = C.yel + "errored" + C.rst;
  } else if (co === null || mo === null) {
    note = C.yel + "API gap" + C.rst;
  }
  const name = n.length > W - 1 ? n.slice(0, W - 2) + "…" : n.padEnd(W);
  console.log("  " + [name, fmt(co), fmt(mo), multCell, note].join("  "));
}

// Failures detail
const failed = [];
for (const n of names) {
  if (cur[n]?.ok === false) failed.push(`[current] ${n}: ${cur[n].error}`);
  if (main[n]?.ok === false) failed.push(`[main] ${n}: ${main[n].error}`);
}
if (failed.length) {
  console.log();
  console.log(C.yel + "  shape failures:" + C.rst);
  for (const f of failed) console.log(C.dim + "    " + f + C.rst);
}
console.log();
RENDERER

"$NODE_BIN" "$SCRATCH/_table.cjs" "$CURRENT_JSON" "$MAIN_JSON"

echo
log "done."
