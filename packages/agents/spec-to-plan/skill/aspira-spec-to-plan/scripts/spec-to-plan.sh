#!/bin/bash
# Launch the spec-to-plan agent without keeping the caller's tool invocation open.
set -euo pipefail

die() { echo "spec-to-plan: $*" >&2; exit 1; }
agent_dir() {
  local here candidate
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  for candidate in "${SPEC_TO_PLAN_AGENT_DIR:-}" "${ASPIRA_KIT:+$ASPIRA_KIT/packages/agents/spec-to-plan}" "$here/../../.."; do
    [ -n "$candidate" ] || continue
    if grep -qs '"name": "@aspiralabs/spec-to-plan"' "$candidate/package.json"; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  die "cannot find spec-to-plan; set ASPIRA_KIT or SPEC_TO_PLAN_AGENT_DIR"
}
absolute_file() {
  [ -f "$1" ] || die "no such file: $1"
  echo "$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
}
cmd_start() {
  local spec="" guidelines="" repo="" out=""
  while [ $# -gt 0 ]; do
    case $1 in
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a path"; guidelines=$2; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a path"; repo=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; out=$2; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$spec" ] || die "one spec at a time"; spec=${1#@}; shift ;;
    esac
  done
  [ -n "$spec" ] || die "usage: spec-to-plan.sh start <spec.md> [--guidelines FILE] [--repo DIR] [--output DIR]"
  spec=$(absolute_file "$spec")
  [ -z "$guidelines" ] || guidelines=$(absolute_file "$guidelines")
  repo=$(git -C "${repo:-$PWD}" rev-parse --show-toplevel) || die "run inside a Git repo or pass --repo"
  local feature_dir
  feature_dir="$(dirname "$spec")"
  if [ "$(basename "$feature_dir")" = spec.reviewed ]; then feature_dir="$(dirname "$feature_dir")"; fi
  out=${out:-"$feature_dir/plan.review"}
  [[ $out = /* ]] || out="$PWD/$out"
  local agent run prompt
  agent=$(agent_dir)
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$agent/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing agent .env.local or AI_GATEWAY_API_KEY"
  run=$(mktemp -d "${TMPDIR:-/tmp}/spec-to-plan.XXXXXX")
  prompt="Plan implementation of the business spec at $spec against the local repository $repo. Write results directly to $out. Use load-knowledge for the required guidelines, then call create-plan once. Report status, plan.reviewed.md, run-analysis.md and trace/checks.md paths."
  printf '%s\n' "$out" > "$run/output"
  date +%s > "$run/started"
  cat > "$run/run.sh" <<'RUNNER'
#!/bin/bash
if [ -n "$GUIDELINES" ]; then
  pnpm -C "$AGENT" plan "$SPEC" "$REPO" "$GUIDELINES" "$OUTPUT" > "$RUN/log" 2>&1
else
  pnpm -C "$AGENT" exec eve invoke "$PROMPT" > "$RUN/log" 2>&1
fi
code=$?
printf '%s\n' "$code" > "$RUN/exit"
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$agent" SPEC="$spec" REPO="$repo" GUIDELINES="$guidelines" OUTPUT="$out" PROMPT="$prompt" RUN="$run" screen -dmS "spec-to-plan-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nspec: %s\nrepo: %s\noutput: %s\n' "$run" "$spec" "$repo" "$out"
}
cmd_status() {
  local run=${1:?usage: spec-to-plan.sh status RUN} elapsed
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  printf 'finished (%ss), exit %s\noutput: %s\n' "$elapsed" "$(cat "$run/exit")" "$(cat "$run/output")"
  tail -n 40 "$run/log"
  printf 'Output paths (if this run exported):\nChecks: %s/trace/checks.md\nRun analysis: %s/run-analysis.md\nPlan: %s/plan.reviewed.md\n' "$(cat "$run/output")" "$(cat "$run/output")" "$(cat "$run/output")"
}
cmd_wait() {
  local run=${1:?usage: spec-to-plan.sh wait RUN [--max SECONDS]} max=30 deadline
  if [ "${2:-}" = --max ]; then max=${3:?}; fi
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] && [ "$max" -le 60 ] || die "--max must be 1..60 seconds"
  [ -f "$run/started" ] || die "not a run directory: $run"
  deadline=$(( $(date +%s) + max ))
  while [ ! -f "$run/exit" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
  cmd_status "$run"
}
case ${1:-} in
  start) shift; cmd_start "$@" ;;
  status) shift; cmd_status "$@" ;;
  wait|watch) shift; cmd_wait "$@" ;;
  *) die "usage: spec-to-plan.sh start SPEC [--guidelines FILE] [--repo DIR] [--output DIR] | status RUN | wait RUN [--max SECONDS]" ;;
esac
