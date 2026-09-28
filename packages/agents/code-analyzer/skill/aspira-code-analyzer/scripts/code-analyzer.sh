#!/bin/bash
# Launch the official code-analyzer without keeping the caller's tool invocation open.
set -euo pipefail

die() { echo "code-analyzer: $*" >&2; exit 1; }
agent_dir() {
  local here candidate
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  for candidate in "${CODE_ANALYZER_AGENT_DIR:-}" "${STATIC_ANALYSIS_AGENT_DIR:-}" "${ASPIRA_KIT:+$ASPIRA_KIT/packages/agents/code-analyzer}" "$here/../../.."; do
    [ -n "$candidate" ] || continue
    if grep -qs '"name": "@aspiralabs/code-analyzer"' "$candidate/package.json"; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  die "cannot find code-analyzer; set ASPIRA_KIT or CODE_ANALYZER_AGENT_DIR"
}
# owner/name from a GitHub URL, git@ URL or shorthand; empty when the source is not remote.
remote_slug() {
  printf '%s' "$1" | sed -nE 's#^(https?://(www\.)?github\.com/|git@github\.com:)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?$#\3/\4#p' | sed -E 's/\.git$//'
}
cmd_start() {
  local source="" push="" ref="" out="" rounds="" warnings=""
  while [ $# -gt 0 ]; do
    case $1 in
      --push) push=1; shift ;;
      --fix-warnings) warnings=1; shift ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a branch"; ref=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; out=$2; shift 2 ;;
      --max-rounds) [ $# -ge 2 ] || die "--max-rounds needs a number"; rounds=$2; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$source" ] || die "one repository at a time"; source=${1#@}; shift ;;
    esac
  done
  [ -n "$source" ] || die "usage: code-analyzer.sh start <repo-path | github-url | owner/name> [--push] [--ref BRANCH] [--output DIR] [--max-rounds N] [--fix-warnings]"
  local agent run mode slug prompt
  agent=$(agent_dir)
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$agent/.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing agent .env.local or AI_GATEWAY_API_KEY"
  if [ -d "$source" ]; then
    mode=local
    source=$(git -C "$source" rev-parse --show-toplevel) || die "not a git repository: $source"
    [ -z "$push" ] || die "--push applies to remote repositories only"
    [ -z "$ref" ] || die "--ref applies to remote repositories only"
    out=${out:-"$source/.static-analysis"}
  else
    slug=$(remote_slug "$source")
    [ -n "$slug" ] || die "not a directory or a GitHub repository: $source"
    mode=remote
    out=${out:-"${TMPDIR:-/tmp}/static-analysis/${slug//\//-}"}
  fi
  [[ $out = /* ]] || out="$PWD/$out"
  run=$(mktemp -d "${TMPDIR:-/tmp}/code-analyzer.XXXXXX")
  prompt="Run static analysis on the repository $source and fix everything it reports. Call static-analysis once with source exactly \"$source\" and outputDir \"$out\"."
  [ -z "$ref" ] || prompt="$prompt Use ref \"$ref\"."
  [ -z "$push" ] || prompt="$prompt Push the branch and open a pull request (push: true)."
  [ -z "$rounds" ] || prompt="$prompt Cap it at $rounds rounds."
  [ -z "$warnings" ] || prompt="$prompt Also fix warnings (fixWarnings: true)."
  prompt="$prompt Report the status, counts, edited files and the report path."
  printf '%s\n' "$out" > "$run/output"
  date +%s > "$run/started"
  cat > "$run/run.sh" <<'RUNNER'
#!/bin/bash
if [ "$MODE" = local ]; then
  args=("$SOURCE" --output "$OUTPUT")
  [ -z "$ROUNDS" ] || args+=(--max-rounds "$ROUNDS")
  [ -z "$WARNINGS" ] || args+=(--fix-warnings)
  pnpm -C "$AGENT" analyze "${args[@]}" > "$RUN/log" 2>&1
else
  pnpm -C "$AGENT" exec eve invoke "$PROMPT" > "$RUN/log" 2>&1
fi
code=$?
printf '%s\n' "$code" > "$RUN/exit"
RUNNER
  chmod +x "$run/run.sh"
  MODE="$mode" AGENT="$agent" SOURCE="$source" OUTPUT="$out" ROUNDS="$rounds" WARNINGS="$warnings" PROMPT="$prompt" RUN="$run" screen -dmS "static-analysis-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nmode: %s\nsource: %s\noutput: %s\n' "$run" "$mode" "$source" "$out"
}
cmd_status() {
  local run=${1:?usage: code-analyzer.sh status RUN} elapsed
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  printf 'finished (%ss), exit %s\noutput: %s\n' "$elapsed" "$(cat "$run/exit")" "$(cat "$run/output")"
  tail -n 40 "$run/log"
  printf 'Report: %s/report.md\nRemaining diagnostics: %s/diagnostics.json\n' "$(cat "$run/output")" "$(cat "$run/output")"
}
cmd_wait() {
  local run=${1:?usage: code-analyzer.sh wait RUN [--max SECONDS]} max=30 deadline
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
  *) die "usage: code-analyzer.sh start SOURCE [--push] [--ref BRANCH] [--output DIR] [--max-rounds N] [--fix-warnings] | status RUN | wait RUN [--max SECONDS]" ;;
esac
