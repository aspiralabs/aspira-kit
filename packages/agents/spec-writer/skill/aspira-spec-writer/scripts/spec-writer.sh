#!/bin/bash
# Launch the official spec writer without keeping the caller's tool invocation open (start/status/wait),
# or step a --local run whose model work runs in the calling Claude Code session (local).
set -euo pipefail

die() { echo "spec-writer: $*" >&2; exit 1; }
agent_dir() {
  local here candidate
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  for candidate in "${SPEC_WRITER_AGENT_DIR:-}" "${ASPIRA_KIT:+$ASPIRA_KIT/packages/agents/spec-writer}" "$here/../../.."; do
    [ -n "$candidate" ] || continue
    if grep -qs '"name": "@aspiralabs/spec-writer"' "$candidate/package.json"; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  die "cannot find spec-writer; set ASPIRA_KIT or SPEC_WRITER_AGENT_DIR"
}
absolute_file() {
  [ -f "$1" ] || die "no such file: $1"
  echo "$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
}
# Shared argument parsing: sets idea, guidelines, repo, out, finish.
parse() {
  idea="" guidelines="" repo="" out="" finish=""
  while [ $# -gt 0 ]; do
    case $1 in
      --guidelines) [ $# -ge 2 ] || die "--guidelines needs a path"; guidelines=$2; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a path"; repo=$2; shift 2 ;;
      --output) [ $# -ge 2 ] || die "--output needs a path"; out=$2; shift 2 ;;
      --finish) finish=--finish; shift ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$idea" ] || die "one idea at a time"; idea=${1#@}; shift ;;
    esac
  done
  [ -n "$idea" ] || die "usage: spec-writer.sh start|local <idea.md> [--guidelines FILE] [--repo DIR] [--output DIR]"
  idea=$(absolute_file "$idea")
  repo=$(git -C "${repo:-$PWD}" rev-parse --show-toplevel) || die "run inside a Git repo or pass --repo"
  out=${out:-"$(dirname "$idea")/spec.written"}
  [[ $out = /* ]] || out="$PWD/$out"
}
cmd_start() {
  parse "$@"
  [ -z "$finish" ] || die "--finish only applies to local"
  [ -z "$guidelines" ] || guidelines=$(absolute_file "$guidelines")
  local agent run prompt
  agent=$(agent_dir)
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v screen >/dev/null || die "screen is not installed"
  [ -e "$agent/.env.local" ] || [ -e "$agent/../.env.local" ] || [ -n "${AI_GATEWAY_API_KEY:-}" ] || die "missing agent .env.local or AI_GATEWAY_API_KEY"
  run=$(mktemp -d "${TMPDIR:-/tmp}/spec-writer.XXXXXX")
  prompt="Write a spec from the idea at $idea for the local repository $repo. Write results directly to $out. Use load-knowledge for the required guidelines, then call write-spec once. Report status, spec.md, spec.draft.md, run-analysis.md and open author decisions."
  printf '%s\n' "$out" > "$run/output"
  date +%s > "$run/started"
  cat > "$run/run.sh" <<'RUNNER'
#!/bin/bash
if [ -n "$GUIDELINES" ]; then
  pnpm -C "$AGENT" write "$IDEA" "$REPO" "$GUIDELINES" "$OUTPUT" > "$RUN/log" 2>&1
else
  pnpm -C "$AGENT" exec eve invoke "$PROMPT" > "$RUN/log" 2>&1
fi
code=$?
printf '%s\n' "$code" > "$RUN/exit"
RUNNER
  chmod +x "$run/run.sh"
  AGENT="$agent" IDEA="$idea" REPO="$repo" GUIDELINES="$guidelines" OUTPUT="$out" PROMPT="$prompt" RUN="$run" screen -dmS "spec-writer-$(basename "$run")" "$run/run.sh"
  printf 'started\nrun: %s\nidea: %s\nrepo: %s\noutput: %s\n' "$run" "$idea" "$repo" "$out"
}
# One synchronous step of a --local run: no model calls here, so no screen, gateway key or wait.
# Prints the pending phases (prompt + output file each) or the finished report as JSON.
cmd_local() {
  parse "$@"
  # Without --guidelines, the session writes REQUIRED.md from Notion into the local work directory.
  guidelines=${guidelines:-"$out.local/REQUIRED.md"}
  [ -f "$guidelines" ] || die "no guidelines snapshot at $guidelines; write REQUIRED.md there from Notion (Agent Instructions + Review Verification) or pass --guidelines"
  guidelines=$(absolute_file "$guidelines")
  command -v pnpm >/dev/null || die "pnpm is not installed"
  pnpm -C "$(agent_dir)" --silent write:local "$idea" "$repo" "$guidelines" "$out" $finish
}
cmd_status() {
  local run=${1:?usage: spec-writer.sh status RUN} elapsed output
  [ -f "$run/started" ] || die "not a run directory: $run"
  elapsed=$(( $(date +%s) - $(cat "$run/started") ))
  if [ ! -f "$run/exit" ]; then
    printf 'running (%ss)\nlog: %s/log\n' "$elapsed" "$run"
    [ ! -f "$run/log" ] || tail -n 3 "$run/log"
    return
  fi
  output=$(cat "$run/output")
  printf 'finished (%ss), exit %s\noutput: %s\n' "$elapsed" "$(cat "$run/exit")" "$output"
  tail -n 40 "$run/log"
  printf 'Spec: %s/spec.md (only if the review produced valid edits)\nDraft: %s/spec.draft.md\nDecisions: %s/trace/decisions.md\nRun analysis: %s/run-analysis.md\n' "$output" "$output" "$output" "$output"
}
cmd_wait() {
  local run=${1:?usage: spec-writer.sh wait RUN [--max SECONDS]} max=30 deadline
  if [ "${2:-}" = --max ]; then max=${3:?}; fi
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] && [ "$max" -le 60 ] || die "--max must be 1..60 seconds"
  [ -f "$run/started" ] || die "not a run directory: $run"
  deadline=$(( $(date +%s) + max ))
  while [ ! -f "$run/exit" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 1; done
  cmd_status "$run"
}
case ${1:-} in
  start) shift; cmd_start "$@" ;;
  local) shift; cmd_local "$@" ;;
  status) shift; cmd_status "$@" ;;
  wait|watch) shift; cmd_wait "$@" ;;
  *) die "usage: spec-writer.sh start IDEA [--guidelines FILE] [--repo DIR] [--output DIR] | status RUN | wait RUN [--max SECONDS] | local IDEA [--guidelines FILE] [--repo DIR] [--output DIR] [--finish]" ;;
esac
