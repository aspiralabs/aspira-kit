# @aspiralabs/ai

The `kit` CLI and the Aspira agents, in one package, installed globally once per engineer. `kit` puts a project on the kit: it installs `@aspiralabs/ui` and `@aspiralabs/config`, wires them in, copies the `/aspira-*` skills and the hooks into `.claude/`, scaffolds shared features like auth, and reports drift. `@aspiralabs/ai` itself is never a project dependency.

```bash
pnpm add -g @aspiralabs/ai                   # once per engineer
kit init --stack next --board <Feature Board URL>
kit add auth                                 # base Better Auth setup
kit doctor                                   # what version you're on, what's wired
kit next NOM-4                               # what to run next for a ticket
```

In a repository where the app is not the root (no root `package.json`; the Next app, its `package.json` and `node_modules` are in `apps/web`; Claude Code runs at the root), run `init` at the root with `--app`:

```bash
kit init --stack next --app apps/web --board <Feature Board URL>   # at the repository root
kit doctor                                   # the app is read from aspira.json, from the root or inside the app
```

Installing needs a GitHub Packages token in `~/.npmrc`; see the [repo README](../../README.md#use-the-kit-in-an-app).

Setting up a new project end to end (the Notion teamspace, Feature Board and Releases page, `aspira.json`, the environment, `AGENTS.md`, the first run) is on Notion: [New Project Setup](https://app.notion.com/p/4023e59b2258812189cdfb82a603cb7d), under Engineering Central › AI-DLC.

## Global install

```bash
pnpm add -g @aspiralabs/ai
```

puts `kit` on your PATH. That one install is what every project uses: the `/aspira-*` skills and the hooks live in `~/.claude` (written by `kit update`, and by `kit init` when missing), run the agents from it, and need nothing from the project's `node_modules`. The kit's files in a project are git-ignored through the global ignore, `aspira.json` among them (it is never committed: each engineer keeps a local copy), and `kit init` removes an earlier per-project harness (`.claude/hooks/aspira/`, the project's `aspira-*` skill folders, the hook entries in `.claude/settings.json`).

- **Not a project dependency.** `kit init` installs only `@aspiralabs/ui` and `@aspiralabs/config` in the project, and removes an `@aspiralabs/ai` an earlier kit added to `package.json` (it would win over the global install). `kit doctor` fails while one is declared.
- **The skills are pinned.** Each global skill records the version it came from in `.kit-version`. When the global install is a different version, a skill stops before it starts and says to run `kit update`, which rewrites them once for every project. Nothing to commit in a project.
- **Version notice.** At most once every 24 hours `kit` (and, separately, the session-start hook) checks the registry for a newer `@aspiralabs/ai` and prints one line when there is one. It never blocks a command. It names the upgrade: `pnpm add -g @aspiralabs/ai@latest`, then `kit update`.
- **Moving a project off a project install.** `pnpm remove @aspiralabs/ai` in the app (or just `kit init`, which does it), then `kit init` from the global install, which also removes the project's old `.claude/` kit files; commit `package.json`, the lockfile and that removal.
- **Moving a project to the global harness.** `/aspira-upgrade` (or `kit update`, then `kit upgrade`) removes the skills, hooks, hook entries, managed `AGENTS.md` block and `.gitignore` lines an earlier kit committed, stops tracking `aspira.json` and prints the one commit to make. It touches nothing else: no install, no eslint, prettier, tsconfig, css or `.npmrc` change, so a project that tuned those keeps them.

## Commands

| Command | What it does |
|---|---|
| `kit init --stack next` | Installs the kit packages and wires the project to them; `--board <url>` also writes `aspira.json`; `--app <dir>` for a repository whose app is not the root |
| `kit init --board <url>` | Writes or updates `aspira.json` (the Feature Board, and `--releases <url>`) in a project already on the kit |
| `kit add auth` | Writes a base Better Auth setup the project then owns |
| `kit doctor` | Prints the kit versions in use and checks the wiring, including `aspira.json` and the agent skills; `--app <dir>` (or `app` in `aspira.json`) names the app |
| `kit next [<ticket>]` | Prints the ticket's Status and the Playbook step, command and owner that come next |
| `kit cleanup [--yes] [--only <path>...]` | Lists every `.work/` folder and `.worktrees/<TYPE>-<ID>` ticket worktree with its card's live Status, and on confirmation deletes those whose card is Released or Dropped, first tearing down each worktree's isolation |
| `kit worktree <ticket>` | Creates (or reuses) the ticket's worktree at `.worktrees/<TYPE>-<ID>` on its GIT-001 branch from `origin/main`, links `.env.local` and the git-ignored `aspira.json`, isolates it when `aspira.json` asks (see [Worktree isolation](#worktree-isolation)), then installs and builds |
| `kit db migrate --name <n> [prisma args]` | Runs `prisma migrate dev` against the worktree's own Neon branch |
| `kit dev` | Runs `dev.command` on the worktree's own `PORT`, with its Cloudflare tunnel beside it |
| `kit upgrade [--dry-run]` | Moves a repository an earlier kit set up to the global harness and does nothing else: writes `~/.claude` when it is behind, removes the harness the repository still commits, stops tracking `aspira.json` (the file stays) and restores one a pull deleted, then prints the commit to make; it commits nothing and says so when the repository is already on the global harness |
| `kit map-codebase [--check | brief <target>... | notes]` | Builds or refreshes the codebase map of the git repository you are in, reports its freshness, prints a bounded brief for a target, or drives the notes (see [`kit map-codebase`](#kit-map-codebase)) |
| `kit playbook` | Prints the Playbook section of From Idea to Release as markdown, from the same table `kit next` reads (`common/lib/playbook.json` in this package) |

Every command takes `--cwd <path>` to run against another directory. `init`, `add` and `upgrade` take `--dry-run`, which prints the plan and changes nothing. `init`, `doctor`, `next`, `cleanup`, `worktree`, `upgrade`, `db migrate` and `dev` take `--app <dir>`, the app that owns `package.json` and `node_modules` when it is not the root (see [`--app`](#--app-a-repository-whose-app-is-not-the-root)); `doctor` and `next` read it from `aspira.json` once `init` has recorded it.

Every command is safe to re-run. Each line of output starts with what happened to one thing:

| Verb | Meaning |
|---|---|
| `write` | Created a file |
| `update` | Changed a file that already existed |
| `keep` | Left a file as it was: it exists, or already has what the kit needs |
| `run` | Ran an install command |
| `skip` | Couldn't find what to change; do it by hand |
| `note`, `warn` | Something for you to act on |
| `next` | Steps left for you after the command finishes |

Exit codes: `0` success, `1` a failed step or `doctor` found problems, `2` bad arguments.

## `kit init --stack next`

```bash
kit init --stack next [--app <dir>] [--board <Feature Board URL>] [--releases <Releases page URL>] [--dry-run] [--cwd <path>]
```

Puts a Next.js project on the kit. `next` is the only stack so far. Without `--app`, every step below runs in the project root. With `--app <dir>`, the package steps (`.npmrc`, the install, `eslint.config.mjs`, `prettier.config.mjs`, `tsconfig.json`, `globals.css`) run in `<dir>` and the rest at the root.

| Step | Result |
|---|---|
| `.npmrc` | Maps `@aspiralabs` to GitHub Packages. Warns if `~/.npmrc` has no token |
| Install | `@aspiralabs/ui`; dev: `@aspiralabs/config`, `eslint`, `prettier`, `typescript`. Removes `@aspiralabs/ai` first when an earlier kit declared it (it is installed globally). Uses the project's package manager (pnpm, npm or yarn, from the lockfile) |
| `eslint.config.mjs` | `@aspiralabs/config/eslint/next`, if the file doesn't exist |
| `prettier.config.mjs` | `@aspiralabs/config/prettier`, if the file doesn't exist |
| `tsconfig.json` | `extends` the kit's `next.json`; adds `paths: { "@/*": ["./*"] }` if there are none |
| `globals.css` | Adds the `tokens.css` import and the `@source` lines Tailwind needs to scan the package. Looks in `app/`, `src/app/`, `styles/` |
| `AGENTS.md` | Writes or replaces the block between `<!-- aspiralabs:begin -->` and `<!-- aspiralabs:end -->`. Everything outside it is yours and is kept |
| `CLAUDE.md` | `@AGENTS.md`, if the file doesn't exist |
| `.mcp.json` | Registers the `aspiralabs-ui` docs server (`npx --no aspiralabs-ui-mcp`; with `--app`, `node <app>/node_modules/@aspiralabs/ui/bin/mcp.js`), merged into your servers. The kit's entry is replaced on a re-run, yours are kept |
| `.claude/hooks/aspira/` | Not written. The hooks are global (`~/.claude/hooks/aspira/`, written by `kit update`); `init` removes a project copy an earlier kit made |
| `.claude/settings.json` | Not written for the kit. The hook entries live in `~/.claude/settings.json`; `init` removes the kit's entries (including ones pointing into `node_modules/@aspiralabs/ai/hooks/` or the retired `@aspiralabs/config/agent/hooks/`) from the project's file and keeps yours |
| project skill folders `aspira-<agent>` | Not written. One folder per agent (groomer, spec-writer, spec-reviewer, planner, implementor, code-analyzer, pr-reviewer) is written globally to `~/.claude/skills/aspira-<agent>/` (`SKILL.md`, `scripts/`, `.kit-version`) by `kit update`; `init` removes a project copy |
| project skill folders `aspira-{cleanup,map-codebase,next,upgrade,worktree}` | Not written. The five kit-owned skills are global too (`~/.claude/skills/`). Each is a launcher that runs the matching `kit` command and relays it: `/aspira-cleanup` lists, confirms in chat and reruns with `--yes --only`; `/aspira-next` offers to run the next command on a yes; `/aspira-upgrade` runs `kit update`, lists `kit upgrade --dry-run`, upgrades on a yes and commits on a second yes; `/aspira-worktree` moves the session into the new worktree; `/aspira-map-codebase` runs `kit map-codebase` in any git repository and hands its notes steps to subagents |
| `.gitignore` | Adds `.env.local` unless `git check-ignore` already reports it ignored (a `.env*.local` glob counts), and `.env.development.local` when `aspira.json` isolates worktrees. The harness folders (`.work/`, `.aspira/`, `.worktrees/`) and `aspira.json` are in the global git ignore `kit update` writes, not here; the lines an earlier kit added for them are removed |
| `aspira.json` | With `--board`: the project's Feature Board URL and, with `--releases`, its Releases page. The `/aspira-*` skills and `kit next` read it. With `--app`: `"app": "<dir>"`, which `kit doctor`, `kit next` and the skill launchers read to find the app's packages. Without `--board` the board is left as it is, and a project without one has no board: every skill then needs `--no-ticket`. Add `"knowledge": "<Agent Instructions URL>"` by hand so a build-feature run builds the guidelines without `KNOWLEDGE_PAGE` in its environment. Add `"models"` by hand to try other models or reasoning effort (see [Models](#models-per-stage-and-phase)). Add `"gates"` by hand (`[{ "cwd": "apps/web", "command": "pnpm check" }, ...]`) to fix the commands the build-feature gate runs: an explicit list is the reliable way. Without it the gate reads `AGENTS.md` (the per-change sentence, such as "Shipping to dev needs ...", when there is one), skips commands it marks as release-only or for another app, and falls back to the package.json `check`, `test` and `test:integration` scripts. The file is git-ignored (the global ignore lists it) and never committed: `init` stops tracking one an earlier kit committed (`git rm --cached`, so the file stays, then prints the commit to make) and restores one a pull of that commit deleted, from the last commit that had it; it never overwrites one that is there |

### `--app`: a repository whose app is not the root

nomnomzz is the case: the Next app with its `package.json` and `node_modules` is `apps/web`, there is no root `package.json`, and Claude Code runs at the repository root, where it reads `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and `.claude/`. Run `init` at the root with `--app <dir>`, where `<dir>` is the app, relative to the root:

```bash
kit init --stack next --app apps/web --board <Feature Board URL>
```

| Where | What |
|---|---|
| `apps/web/` | `.npmrc`, the install (`pnpm add` runs there, with its lockfile), `eslint.config.mjs`, `prettier.config.mjs`, `tsconfig.json`, `app/globals.css` |
| the root | `AGENTS.md` (managed block, plus one line naming the app), `CLAUDE.md`, `.mcp.json`, `.gitignore` (`.env.local`), `aspira.json` with `"app": "apps/web"` (git-ignored) |

The MCP server points into the app, relative to the root where Claude Code runs it: `node apps/web/node_modules/@aspiralabs/ui/bin/mcp.js`. The hooks and skills are global (`~/.claude`) and the agents run from the global `@aspiralabs/ai`; the launchers in `~/.claude/skills/` read `app` from the root's `aspira.json`, and the app's `.env.local` is the one they load. `kit doctor` and `kit next` read `app` from `aspira.json` too, so they need no flag after `init`, and run from inside the app they find the root that wired it. One app per repository: `--app` names the app the kit packages are installed in; other apps keep their own tooling.

The `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and settings templates ship in this package (`templates/agent/`), and the hooks in `hooks/`, so re-running `init` after an upgrade brings them up to that version. The managed `AGENTS.md` block and the session-start hook only point at the rules in Notion; they restate none.

### The agent skills

### Models per stage and phase

`aspira.json` `models` sets which model, and how much reasoning, each part of a run gets. It is for experiments: a key left out keeps the kit's default, so an empty map changes nothing. Two kinds of key:

- **A build-feature role**: `groomer`, `spec-writer`, `planner`, `implementor`, `code-analyzer`, `pr-reviewer`, `pr-reviewer-verifier`, `fix`, `knowledge`, `notion-push`, `orchestrator`. It sets the step's own subagent.
- **`<step>.<phase>`**: one kind of task a step prints. The phases are `groomer.round` and `groomer.summary`; `spec-writer.explore`, `spec-writer.draft`, `spec-writer.research`, `spec-writer.specialists` and `spec-writer.reconciliation`; `planner.explore`, `planner.research`, `planner.planning` and `planner.repair`; `implementor.orchestrator` and `implementor.worker`; `code-analyzer.fix`; and `pr-reviewer.<seat>`.

A value is a model (`fable`, `opus`, `sonnet`, `haiku`) or `{ "model": …, "effort": … }`, either field optional. `effort` is the Agent tool's reasoning effort: `low`, `medium`, `high`, `xhigh` or `max`. `low` is the closest to reasoning off. A build-feature run refuses an unknown role, step, model or effort before its first step. The defaults: explorers (`spec-writer.explore`, `planner.explore`) on haiku, review specialists, repair passes and implementor workers on sonnet, draft, research, planning and reconciliation on opus.

```json
{
  "board": "https://app.notion.com/p/…",
  "models": {
    "planner": "opus",
    "planner.planning": { "model": "opus", "effort": "medium" },
    "planner.repair": { "model": "sonnet", "effort": "low" },
    "spec-writer.explore": "sonnet"
  }
}
```

`@aspiralabs/ai`, installed globally, brings every agent (the folders `groomer`, `spec-writer`, `spec-reviewer`, `planner`, `implementor`, `code-analyzer`, `pr-reviewer`, `build-feature`, `visual-verify` and `common`) at the kit's version. Each agent's skill is written to `~/.claude/skills/aspira-<agent>/` by `kit update`, so `/aspira-planner` and friends run the agent from the global install, never a source checkout. The launcher resolves its agent as `<AGENT>_AGENT_DIR` (kit development only; the run says so), then the global kit (`kit package-dir`, from the `kit` on PATH); `$ASPIRA_KIT` is not consulted. Agent environment comes from the project's `.env.local` (`AI_GATEWAY_API_KEY`, `NOTION_TOKEN`, `KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`), then the agent's own folder.

Updating an agent is a kit release, `pnpm add -g @aspiralabs/ai@latest` and `kit update`; `kit doctor` fails until the skills match the installed version. Each run reports the agent package and version it ran, and writes `trace/agent-version.json` into its export.

**Removing the old `~/.claude/skills` symlinks.** `kit update` replaces them with real folders; to do it by hand: Before this, the skills were symlinks from `~/.claude/skills/aspira-*` into one kit checkout, and `ASPIRA_KIT` pointed the launchers at it. Those links now shadow nothing useful and can point at a stale checkout, so remove them once per machine:

```bash
for a in groomer spec-writer spec-reviewer planner implementor code-analyzer pr-reviewer; do
  [ -L ~/.claude/skills/aspira-$a ] && rm ~/.claude/skills/aspira-$a
done
# and drop `export ASPIRA_KIT=...` from your shell profile; the launchers no longer read it
```

## `kit add auth`

```bash
kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
```

Writes the Better Auth setup that every product had converged on. The files are a starting point the product owns, not a package: edit them freely. The kit never overwrites them, so re-running only adds what's missing.

**You get:**

- Email and password sign-up, verified with a 6-digit emailed code
- Password reset by email
- Passkeys (unless `--no-passkey`)
- Google sign-in, turned on only when `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are set
- Sessions and rate limits stored in Redis, with tighter limits on sign-in, sign-up and password reset
- Suspended users blocked from signing in, and `lastLoginAt` recorded on each sign-in

**Options:**

| Flag | Effect |
|---|---|
| `--no-passkey` | Leaves out the passkey plugin, its client and its env keys |
| `--expo <scheme>` | Adds the Expo plugin and trusts `<scheme>://` (plus `exp://` in development) for a mobile app. The scheme must be lowercase, like `myapp` |

**Files** (under `src/` if the project has `src/app/`):

| File | Contents |
|---|---|
| `lib/auth.ts` | The Better Auth server config |
| `lib/auth/auth.client.ts` | The browser client: `authClient`, `signIn`, `signUp`, `signOut`, `useSession` |
| `lib/auth/session.ts` | `getSession`, `requireSession` (throws `Unauthorized`), `refreshSession` for server code |
| `lib/auth/email.ts` | Verification-code and password-reset emails, sent through Resend as plain HTML |
| `lib/redis.ts` | `getRedis()`, a shared Redis client that connects on first use |
| `lib/prisma.ts` | `prisma`, one client per process |
| `app/api/auth/[...all]/route.ts` | The route handler Better Auth serves from |
| `.env.example` | Adds the keys below that it doesn't already have |

If you already have `lib/prisma.ts` or `lib/redis.ts`, they're kept. The command warns if they don't export `prisma` and `getRedis`, which `lib/auth.ts` imports.

**Installs** whatever the project is missing: `better-auth`, `@better-auth/passkey` or `@better-auth/expo` when those options are on, `ioredis`, `resend`, `@prisma/client`, and `prisma` (dev). The templates are written and tested against Better Auth `^1.6.22`.

**Env:**

| Key | |
|---|---|
| `BETTER_AUTH_SECRET` | Required. `openssl rand -base64 32` |
| `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL` | The app's URL |
| `NEXT_PUBLIC_APP_NAME` | Used in emails and as the passkey name |
| `REDIS_URL` | Required at runtime |
| `RESEND_API_KEY`, `RESEND_DOMAIN` | For sending the auth emails |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Optional. Google sign-in is off without them |
| `PASSKEY_RP_ID`, `PASSKEY_ORIGIN` | Optional. Override the passkey domain when it differs from the app URL |

**After running it:**

1. Fill in `.env` from `.env.example`.
2. Run `npx @better-auth/cli generate` to add the auth models to `schema.prisma`, then migrate.
3. Add the product's own pieces to `lib/auth.ts`: its user fields, anything that runs when a user is created (organization, billing), and its own email templates in `lib/auth/email.ts`.

**One rule:** any user field the server controls, such as a role, an organization or a plan, must be declared with `input: false`. Without it, Better Auth lets any signed-in user set that field through sign-up or `POST /api/auth/update-user`.

## `kit doctor`

```bash
kit doctor [--app <dir>] [--cwd <path>]
```

Prints the version of each kit package the project declares and has installed (`@aspiralabs/ui`, `config`, `kit` and `agents`), then checks each part of the `init` wiring: ESLint, `tsconfig.json`, the tokens import, the `AGENTS.md` block, the MCP server, the global hooks, `.env.local` as `git check-ignore` sees it (skipped outside a git repository), `aspira.json` (present, with a Notion URL as `board`, an `app` directory that has a `package.json` when set, and not tracked by git: a tracked one fails, naming `kit upgrade`), and each `~/.claude/skills/aspira-<agent>/` folder (present, complete, and its `.kit-version` equal to the installed `@aspiralabs/ai` version) and each kit-owned skill (`aspira-cleanup`, `aspira-map-codebase`, `aspira-next`, `aspira-upgrade`, `aspira-worktree`, checked against the installed `@aspiralabs/ai` version). When `aspira.json` isolates worktrees it also checks that `.env.development.local` is git-ignored, and warns (without failing) when `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `cloudflared`, `~/.cloudflared/cert.pem` or the Stripe CLI is missing, and for each Stripe endpoint tagged `aspira_worktree` whose worktree folder is gone. It also prints one information line with the codebase map status (fresh, stale or missing, and the map root) that never changes the exit code. It exits `1` if anything is missing and names the fix: `kit update` for the global harness, `kit upgrade` for what an earlier kit left committed, `kit init` for the project wiring.

With an app (`--app <dir>`, or `app` in `aspira.json`), one run checks both places: the package-level items (`package.json`, `node_modules`, ESLint, `tsconfig.json`, `globals.css`) in the app, and the Claude-facing items at the root, where the hooks and the MCP server must point into `<app>/node_modules`. Run from inside the app with no `--cwd`, it works on the root whose `aspira.json` names that app.

## `kit map-codebase`

```bash
kit map-codebase                       # build or refresh the map of the repo you are in
kit map-codebase --check               # fresh (exit 0), stale or missing (exit 1)
kit map-codebase brief <target>... [--json] [--kind path|package|env|symbol] [--changed]
kit map-codebase notes                 # step driver: subagents propose candidate notes
kit map-codebase notes accept <note-id>
kit map-codebase notes retire <note-id>
```

A per-repo map that agents query for blast radius: what a change touches and what depends on it. It scans the repo's tracked and untracked-not-ignored files (never a `.env*` file or a symlink), resolves TypeScript and JavaScript imports with the TypeScript compiler against each repo's own `tsconfig.json` (relative, `paths` aliases such as `@/`, workspace packages, `import type`, re-exports, dynamic `import()`), and stores the graph in one `node:sqlite` file. Other files are nodes without import edges. It runs on Node, makes no network call and needs no API key.

- **Layout.** By default `<repo>/.codebase-map/map/` (generated, in the global git ignore `kit update` writes) and `<repo>/.codebase-map/notes/` (authored, committed, one `<note-id>.json` per note). Add `"codebaseMaps": "<folder>"` to the nearest `aspira.json` at or above the repo (a path relative to that file, for example a client harness folder) and the pair goes to `<folder>/<repo directory name>/map/` and `.../notes/` instead; nothing is written into the repo. A linked git worktree shares its main checkout's notes and keeps its own map under `worktrees/<worktree name>/map/`. `kit map-codebase` reads only that key; `kit doctor` validates the rest of a client-root file (see [Client harness](#client-harness)). Outside a git repository the command lists the repositories below the current folder and writes nothing.
- **Fresh or stale.** `--check` compares the manifest with the repo now: commit, changed files, file hashes and scanner version. Writing, accepting or retiring a note never makes the map stale. `brief` refuses a missing or stale map and says to run `kit map-codebase`.
- **Brief.** A bounded packet for a path, package, symbol, env var name or the changed files: read-first paths, impact paths (importers, nearest first), focused tests, validation commands from the package scripts, accepted notes, stale-note warnings and what the bound left out. It is orientation only: verify with source reads. From code, import `brief` from `@aspiralabs/ai/codebase-map`.
- **Notes.** `notes` prints one step for a subagent of your session and, on the next run, stores what it wrote as candidate notes. A candidate shows in no brief until a person runs `notes accept`. An accepted note whose cited file changes is marked stale on the next build. Every note is passed through `redactSecrets` before it is written.
- **Agents.** The map is optional for the agents. With `"useCodebaseMap": true` in the nearest `aspira.json` (off when absent), the in-session spec writer, planner and pr-reviewer build a missing or stale map at the start of a run and give their prompts its brief; a failed build means the run goes on without it, and the report says whether the map was used. Map or no map, the pr-reviewer turns a changed file outside the spec's Blast radius into one low finding that never blocks the merge. `--cloud` runs never use the map.
- **`/aspira-map-codebase`** runs the same command from a session and drives the notes steps; it never accepts a note.

The design and parts of the code are adapted from [cartographer](https://github.com/kingbootoshi/cartographer) (Apache-2.0); `THIRD_PARTY_NOTICES` ships with the package.

## `kit next` and `kit playbook`

```bash
kit next [<ticket>] [--app <dir>] [--cwd <path>]
kit playbook
```

`kit next` answers "what is the next step" for a ticket. It reads the board (and the app) from `aspira.json`, resolves the ticket (an ID such as `NOM-4`, a Notion page URL, or, with no argument, the one folder under `.work/` that holds a `ticket.md`; two is an error naming them) through the agents installed under the app's `node_modules` with `NOTION_TOKEN` from `.env.local` (the root's, then the app's, which wins), and prints its Status, the Playbook step for that Status, the exact command to run with the ID filled in, and who acts. When the board does not answer, the Status as pulled into the working folder stands in and the output says so.

The mapping is `src/playbook.ts`, the one source of the Status table. `kit playbook` renders it as the markdown of the "Playbook: what to run next" section of From Idea to Release in Notion; paste its output there when the table changes, so the page and the command stay in step.

## Client harness

A client project runs the agents from a client root: a folder above the client's repositories, not itself a git repository, holding one `aspira.json` that every repository under it finds by walking up. Onboarding a client needs no kit release, only that file and a guidelines folder. A missing key keeps today's behaviour, so a product's `aspira.json` is unchanged.

| Key | What it does |
| --- | --- |
| `repos` | Maps each card Area tag to a repository folder relative to the file; a run at the client root uses the one repository the card's tags name. An entry may carry the per-repo keys (`app`, `gates`, the isolation keys, `baseBranch`). Its presence makes the folder a client root for `kit doctor`. |
| `statusFlow` | `false` turns off the column workflow: no Status gates or moves, no Dev, no release row. Stage pages are still pushed to the ticket. |
| `pullRequest` | `false` pushes no branch and opens no PR; the run ends after the review-fix loop and the review runs on the local ticket branch. |
| `guidelines` | A folder of markdown files, every one required and joined in file-name order, that replaces the Notion engineering guidelines; it must carry the Review Verification rules (REV-001). |
| `workRoot` | Where `.work/` lives, relative to the file. |
| `extend` | Per stage, extra instruction files appended to that stage's prompts. The stages are `groomer`, `spec-writer`, `planner`, `implementor` and `pr-reviewer`; any other stage name is refused. |

Every path key must stay inside the folder of `aspira.json`, and `guidelines`, `workRoot` and `extend` may not point inside a client repository. A client run reads `NOTION_TOKEN` and the other launcher keys from the process environment, then the client root's `.env.local`, never a repository's. `/aspira-build-feature` follows the harness and refuses `--cloud` and `--autonomous`; the groomer offers "needs follow-up" answers that either block the build or let it go on. `kit doctor` at a client root checks these keys and files and fails when an Aspira file inside a mapped repository is tracked or not ignored, and skips the package checks.

## `kit cleanup`, `kit worktree`, `kit db migrate` and `kit dev`

```bash
kit cleanup [--yes] [--only <path>...] [--app <dir>] [--cwd <path>]
kit worktree <ticket> [--install] [--app <dir>] [--cwd <path>]
kit db migrate --name <n> [prisma args] [--app <dir>] [--cwd <path>]
kit dev [--app <dir>] [--cwd <path>]
```

`kit cleanup` lists every working folder under `.work/` (in the main checkout and in each ticket worktree) and every ticket worktree at `.worktrees/<TYPE>-<ID>` (TYPE `FEATURE`, `BUG` or `CHORE`) with the card's **live** Status, and marks for deletion only those whose card is Released or Dropped. On a terminal it asks `Delete N folders and remove M worktrees? [y/N]`; `--yes` skips the question, `--only <path>...` (with `--yes`) deletes only the listed paths that are still marked, and without a terminal and `--yes` it lists and deletes nothing. A worktree with uncommitted or unpushed work (commits not on any remote-tracking branch after `git fetch --prune`) is kept, even with `--yes`; before a worktree is removed its isolation is torn down (only what the kit marked: the `wt/<ticket>` Neon branch, the `wt-<name>` tunnel and its DNS record, the Stripe endpoints tagged with the worktree), and a failed teardown keeps the folder; worktrees are removed without `--force` and their local branch with `git branch -d`, never a remote branch. The main checkout, worktrees outside `.worktrees/` and folders it cannot match to a card are never touched, and every skip says why. It exits `0` when every marked item was deleted, `1` when there is no board or a deletion failed, `2` for a bad argument.

`kit worktree <ticket>` resolves the card, refuses a Released or Dropped card or one without a Feature, Bug or Chore Type, and creates `.worktrees/<TYPE>-<ID>` at the repository root on `<feat|fix|chore>/<id>-<slug>` from `origin/main` (after a fetch), reusing the ticket's branch or worktree when one exists. It links the main checkout's `.env.local` files into the worktree, and its `aspira.json` when the branch does not commit one (the file is git-ignored, so a new worktree has none) and the nearest `aspira.json` is not above the repository, as it is at a client root, where the walk-up from the worktree finds it, then runs the project's install and build there, naming each command. When it reuses a branch that exists only on `origin`, or one under a name other than the card's today, it prints the branch's last commit and skips install and build, because that branch's scripts have not been read on this machine: read it, then install yourself or rerun with `--install`. `/aspira-worktree` runs it and continues the Claude Code session in the new worktree.

`kit db migrate --name <n>` runs `prisma migrate dev --name <n>` (plus any prisma arguments) with every `database.envVars` name set from the worktree's `.env.development.local`. It refuses before prisma runs when the branch URL is missing, the branch no longer exists in Neon, or the Prisma datasource reads a variable `database.envVars` does not list; it never passes `--force` and never resets.

`kit dev` runs `dev.command` on the worktree's `PORT` and, when the kit wrote a tunnel config, `cloudflared tunnel run` beside it; either one exiting, or Ctrl-C, stops both. Outside an isolated worktree it runs `dev.command` unchanged.

### Worktree isolation

Optional `aspira.json` keys give every ticket worktree its own state, so two tickets never share a database, port or webhook:

| Key | What `kit worktree` (and build-feature's worktree stage) does |
|---|---|
| `database` (`provider: "neon"`, `projectId`, `parentBranch`, `envVars`) | Creates the Neon branch `wt/<ticket>` from `parentBranch`, expiring in 14 days, through the Neon API with `NEON_API_KEY`, and writes its URLs to each `envVars` name |
| `dev` (`command`, `cwd`, `url`, `urlEnvVars`) | Picks a free `PORT` no sibling worktree claims; a `url` with `{name}` or `{port}` (`http://{name}.localhost:{port}`) is written to each `urlEnvVars` name |
| `tunnel` (`zone`) | Creates the named Cloudflare tunnel `wt-<name>` at `<name>-branch.<zone>` (ingress for `/api/webhooks/*` only), with `~/.cloudflared/cert.pem` and `CLOUDFLARE_API_TOKEN` (DNS Edit, Zone Read) |
| `webhooks` (`provider: "stripe"`, `path`, `events`, `connect`, `secretEnvVar`, `connectSecretEnvVar`) | Creates a Stripe endpoint at the tunnel host with the Stripe CLI and the app's own `STRIPE_SECRET_KEY` (an `sk_live_` key is refused; `stripe switch` is never used), tagged `aspira_worktree=<name>`, and writes its signing secret. A Stripe account holds 16 endpoints, so they are deleted at merge |

Defaults: `dev.urlEnvVars` is `BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL`; `secretEnvVar` is `STRIPE_WEBHOOK_SECRET` and `connectSecretEnvVar` is `STRIPE_CONNECT_WEBHOOK_SECRET`. A `database.envVars` entry is a name (the pooled URL) or `{ "name": "DIRECT_URL", "pooled": false }` (the direct URL). Every isolated worktree also gets `ASPIRA_WORKTREE=<name>`: a webhook handler should skip external side effects (emails, payouts) when it is set, because every worktree branch holds dev's customers. `kit db migrate` refuses a checkout without it.

The results go to the app's `.env.development.local` (git-ignored; `kit init` adds the line). Setup and teardown run one at a time under a lock in the main checkout's `.work/`, create only what is missing, and stop at the first failed step, naming it; a rerun resumes. build-feature tears the isolation down once after the merge, and a failed teardown adds a line to the run's end message that names `kit cleanup`.

## Working on the CLI

```bash
pnpm --filter @aspiralabs/ai build:kit
node packages/ai/dist/cli.js add auth --dry-run --cwd ../some-app
```

- **Stacks** are profiles in `src/stacks/`, one per ecosystem (`next.ts`). Add one as projects need it.
- **Feature templates** live in `templates/<stack>/<feature>/` and ship in the package. `// #if flag` … `// #endif` (`# #if` in env files) keeps lines only when the flag is on, and `{{name}}` is replaced with a value. The command for a feature lives next to its stack (`src/stacks/next-auth.ts`).
- **Before changing a template**, generate it into a scratch project and typecheck it against the version of the library it targets. The templates aren't compiled as part of this package.
- **Tests** are `src/*.test.ts` (`pnpm test`). `install.integration.test.ts` packs every agent package, installs the tarballs into a scratch project, runs `kit init` there and then a launcher from `node_modules`; `release.integration.test.ts` runs `changeset version` on a fixture to check every package bumps together.

## The agents

All agents run without application wall-clock cutoffs, including preparation, model phases, MCP/Notion reads and eve session expiration. Manual cancellation, failure reporting and cost/time measurement remain. Provider or host failures can still end a request. Short launcher waits poll status without stopping the detached agent.

The tracked `@modelcontextprotocol/sdk` patch in `patches/` adds `timeout: false` for agent MCP requests; omitted timeouts keep the SDK default for other consumers. Keep its regression tests passing when upgrading the SDK.

Aspira Labs agents, built on [eve](https://vercel.com/eve). One folder per agent in this one package, published to GitHub Packages at the kit's version as part of `@aspiralabs/ai`, which each engineer installs globally. A project runs that global install; this checkout is for developing the kit.

| Package | Agent | Spec | State |
| --- | --- | --- | --- |
| `packages/ai/groomer` | `groomer` | KIT-8 | grooms a Backlog card's Idea in rounds before Ready: Idea |
| `packages/ai/spec-writer` | `spec-writer` | `specs/agents-spec-writer.md` | idea to spec: explore, draft, then the official review |
| `packages/ai/spec-reviewer` | `spec-reviewer` | `specs/agents-spec-reviewer.md` | official three-phase reviewer |
| `packages/ai/planner` | `planner` | `specs/agents-planner.md` | implementation and test planning |
| `packages/ai/pr-reviewer` | `pr-reviewer` | `specs/agents-pr-reviewer.md` | working |
| `packages/ai/code-analyzer` | `code-analyzer` | `specs/agents-code-analyzer.md` | detect, run, auto-fix, model-fix, loop until clean |
| `packages/ai/implementor` | `implementor` | `specs/agents-implementor.md` | builds a plan test-first, parallel lanes |
| `packages/ai/build-feature` | — (skill-only, no eve agent) | KIT-11 | orchestrates the other skills' steps into one AI-DLC run, idea to merge-ready PR |
| `packages/ai/visual-verify` | — (skill-only, no eve agent) | KIT-58 | opens a UI-touching build in a real browser before the gate; also a standalone report-only run |

### Skills: one pattern for every agent

Spec: `specs/agents-skill-pattern.md`. Every agent a person runs (groomer, spec-writer, spec-reviewer, planner, implementor, code-analyzer, pr-reviewer) has a Claude Code skill at `<agent>/skill/aspira-<agent>/`, with `SKILL.md` and `scripts/<agent>.sh`. The agent is the single source of truth, and the skill only calls it. `build-feature` and `visual-verify` are the two documented exceptions: skill-only folders with no `agent/` and no eve agent. `/aspira-build-feature` runs other skills' steps as subagents of this session instead of launching an agent; `/aspira-visual-verify` drives a browser.

Architecture Decision Record (Proposed): https://app.notion.com/p/3f83e59b225881a2bc2cf2317d7b27a7 covers both the shared `--take-recommended` option on the step agents (below) and this skill-only exception for `build-feature`.

- **`--cloud`: launch the agent.** `scripts/<agent>.sh start` runs the agent as a separate process, detached in `screen`. `status` and `wait` follow it. The skill relays the agent's report and never does the work itself.
- **The default: the same pipeline in the session.** `/aspira-<agent> <ticket>` runs in the session (KIT-51; `--cloud` launches the agent as a separate process, `--local` is accepted and means the default). `scripts/<agent>.sh local` steps a driver in the agent's package. The driver makes no model calls. Each step prints the next stage as JSON, with every task's prompt written to a file. The session runs those tasks as subagents (in parallel where the stage says), and the driver checks their outputs against the agent's own schemas before it advances. Prompts are assembled at runtime from the agent's own files: `agent/instructions.md`, `agent/subagents/*/instructions.md`, and the prompt and schema modules in `agent/lib/`. Editing the agent changes the session run with no copy to update. `--finish` exports what exists as incomplete. A change to the source or the rules mid-run is refused.
- **Notion rules on every path.** The agent loads them with `load-knowledge`, or takes a `--guidelines` `REQUIRED.md` snapshot. In the session, the first stage is `knowledge`, which lists the exact pages the agent's own configuration would load: `KNOWLEDGE_PAGE`, the `KNOWLEDGE_REQUIRED` pages, and the topic pages they route to. The session fetches them with the Notion MCP into `<work>/knowledge/` (`REQUIRED.md`, `INDEX.md`, one file per page), or `--guidelines` stands in. The driver refuses to start without them, and the export records which rules were used.
- **`SKILL.md` is mechanics only.** It says which command to run, how to launch the tasks, and what to report, and it names `agent/instructions.md` (or the agent's procedure file) as the authority. Each skill has a test that the agent's key rule sentences are absent from `SKILL.md`.
- **The ticket is the argument.** Every skill takes the Feature Board ticket first: an ID such as `NOM-4`, a Notion page URL, or nothing when `.work/` holds one ticket (a file path needs `--no-ticket`). The board comes from the project's `aspira.json`. Before any model call the skill checks the Status against its row of the gate table in `common/src/lib/ticket.ts` and refuses otherwise, naming the Status it needs and who makes that move; it pulls the ticket's pages into `.work/<id>-<slug>/` (unchanged files are left alone; a local file newer than its page needs `--force-pull`), makes its own two moves and never a third, and pushes its output back under a fixed title. In the session the driver prints a `board` stage before `knowledge` with the actions as data for the session to perform with the Notion MCP, verifies `ticket.md` between steps, and ends with `--verify`; the launcher's separate-process path performs the same actions itself through `scripts/ticket.ts` and the shared board module with `NOTION_TOKEN`. Every action is recorded in the run's `trace/board.json` with the Status before and after.

The skills are global: `kit update` writes the running `@aspiralabs/ai`'s `skill/aspira-<agent>/` to `~/.claude/skills/aspira-<agent>/` with a `.kit-version`, and `kit doctor` fails when one is missing or from another version. The launcher resolves its agent as `<AGENT>_AGENT_DIR` (kit development only; the run says so), then the global kit (`kit package-dir` names it). `$ASPIRA_KIT` is not consulted. A launcher that lands on a checkout prints one line saying it is running kit source, and every run reports the package version it ran and records it in `trace/agent-version.json`.

The agents are TypeScript run straight from source. Node refuses to strip types under `node_modules`, so each launcher loads `amaro` (Node's own type stripper, a dependency of every agent) as a module hook. The agent's environment is the project's `.env.local`, then the agent's own `.env.local` and `.env.development.local` (kit development); a variable already in the shell wins.

To develop an agent against a project, set `<AGENT>_AGENT_DIR` to the package in your checkout (for example `PLANNER_AGENT_DIR=$PWD/packages/ai/planner`) and run the project's skill. The old `~/.claude/skills/aspira-*` symlinks are replaced by `kit update`; the kit README says how to remove them by hand.

A new agent follows the same pattern: a skill directory, a launcher with `start`/`status`/`wait`/`local`, a `local` driver that reads the agent's own files, a `scripts/ticket.ts` for the launcher's board step, a board stage before the knowledge stage, and the tests from F5 of the spec.

### How an agent is selected

There is no agent-name flag. `eve` walks up from the working directory to the nearest app root (a package with an `agent/` directory) and loads the one root agent it finds there. One package, one root agent, no ambiguity — which is why every command here is `cd packages/ai/<name> && pnpm exec eve <cmd>`: the directory is the choice, and the directory is the choice. `eve invoke --agent <name>` selects from eve's `agents/<name>/` workspace layout, which this repo does not use.

Why not that layout: in eve 0.63.0 a workflow tool inside a workspace member compiles under one id (`workflow//./agents/<name>/agent/tools/...`) and registers at runtime under another (`workflow//./agent/tools/...`), so every call fails with "not registered as a workflow". A single `agent/` per package sidesteps it, and eve names the agent after the package (minus scope). Revisit when eve fixes it.

### Running one from anywhere

Two forms, and the difference matters:

```bash
# Anywhere on the machine, including ~ : point pnpm at the package directory.
pnpm -C /path/to/ASPIRA_KIT/packages/ai/pr-reviewer exec eve invoke "who are you?"

# Inside the monorepo: cd to the folder.
cd packages/ai/pr-reviewer && pnpm exec eve invoke "who are you?"
```

`--filter` resolves package names against the workspace, so it needs the working directory to be *inside* the monorepo. Run it from your home directory and pnpm finds no workspace root, tries to enumerate everything under `~`, and dies on macOS-protected directories:

```
Error: ERR_PNPM_WORKSPACE_WALK_ERROR
 × finding workspace projects
   Failed to walk workspace projects under /Users/you: ... Library/Application Support/
   CallHistoryTransactions: Operation not permitted (os error 1)
```

`-C` (alias `--dir`) skips workspace resolution entirely — it just runs in the directory you name. That is the form to use from an unrelated repo, from `~`, or in a script.

The ergonomic version, once per machine:

```bash
# ~/.zshrc
export ASPIRA_KIT="$HOME/path/to/ASPIRA_KIT"

agent() {
  if [ $# -lt 2 ]; then
    echo "usage: agent <name> <prompt>" >&2
    ls -1 "$ASPIRA_KIT/packages/ai" | grep -v '^README.md$' | sed 's/^/  /' >&2
    return 2
  fi
  local name=$1; shift
  local dir="$ASPIRA_KIT/packages/ai/$name"
  [ -d "$dir" ] || { echo "agent: no such agent '$name'" >&2; return 1; }
  pnpm -C "$dir" exec eve invoke "$@"
}

agent-dev() { pnpm -C "$ASPIRA_KIT/packages/ai/${1:?usage: agent-dev <name>}" dev; }
```

Then, from anywhere — including inside the repo you want reviewed:

```bash
agent spec-reviewer "Review $PWD/specs/feature/spec.md against $PWD"
agent                     # no args: lists the installed agents
agent-dev spec-reviewer
```

Either way the package directory is what selects the agent — eve loads the one root agent under the app root it finds from the working directory, and both `-C` and `--filter` set that directory for you. There is no agent-name flag to get wrong.

Whichever form you use, **relative paths in your prompt resolve against the package directory, not your shell's** — the review tools resolve paths from the agent package. Pass absolute paths and the question disappears.

Package scripts (`dev`, `info`, `typecheck`, `lint`) need no `exec`: `pnpm -C <dir> dev`. Anything else on the eve CLI goes through `exec eve <cmd>`.

### Adding an agent

An agent is a folder of `packages/ai`, so the steps are:

1. Write the spec first (`specs/agents-<name>.md`). Rule zero (Engineering Central › Agent Instructions in Notion): no spec, no code.
2. `mkdir packages/ai/<name>` and copy `tsconfig.json`, `eslint.config.mjs` and `.gitignore` from an existing agent, plus an `agent/` with `agent.ts`, `instructions.md`, and `channels/eve.ts`. Take the agent whose shape is closer to what you are building.
3. Add it to the `AGENTS` list in `packages/ai/src/skills.ts`, and add its folder to `files` in `packages/ai/package.json`. A folder missing from either is not installed or released with the rest.
4. `pnpm install`, then `cd packages/ai/<name> && pnpm exec eve info` to confirm eve discovers it with 0 diagnostics.
5. `cp .env.example .env.local` in the new package and put an AI Gateway key in it. Every package needs its own; `.env.local` is gitignored.
6. Add its skill as **Skills** above describes: `skill/aspira-<name>/` with `SKILL.md` and `scripts/<name>.sh`, plus a `local` driver and its tests.

Root `typecheck`, `lint`, `build` and `test` (which packs every package) pick the package up for free. An eve agent's `build` is `eve build`, which bundles its workflow tools: a workflow body that reaches a Node.js builtin (`node:fs` and the like) fails there instead of at the first run. `eve info` alone does not catch that.

A skill-only folder (`build-feature` and `visual-verify` are the two so far) skips the `agent/` steps above: no `agent.ts`, no `instructions.md`, no eve agent to discover, no `.env.local` symlink. It still joins `files` in `packages/ai/package.json` and `packages/ai/src/skills.ts`, and still ships `skill/aspira-<name>/` with `SKILL.md` and `scripts/<name>.sh`.

### Shared conventions

Every agent package looks the same from the outside: `dev`, `build`, `typecheck`, `lint`, `info` scripts; `@aspiralabs/config` for eslint and tsconfig; published with `files: agent, skill, scripts`; Node 24.

Inside `agent/`, the convention `spec-reviewer` sets and the next agent should follow:

| Path | What goes there |
| --- | --- |
| `agent.ts` | the root agent: model, description. Routes, does not do the work |
| `instructions.md` | the system prompt |
| `tools/` | one file per tool, `defineTool` or `defineWorkflowTool`. Runtime glue only |
| `lib/` | the logic the tools call. Pure, no eve imports, testable without a runtime |
| `subagents/<name>/` | specialists, `tool: false` so only a workflow can reach them |
| `hooks/` | `step.completed` and friends, usually a one-line re-export from `lib/` |
| `channels/eve.ts` | the default HTTP/TUI channel |

Agents do not import each other. Shared logic that two agents need goes in `common/`, not in a sibling agent folder.

### Shared secrets: `packages/ai/.env.local`

In a project, the agents read the project's own `.env.local` (the launcher passes it to Node), so one file serves every agent there. In this checkout, one env file for every agent. Each agent's `.env.local` is a symlink to `packages/ai/.env.local`, and eve loads it from the agent's folder as usual. `packages/ai/.env.example` lists the keys: the AI Gateway key, an optional GitHub token, and the Notion connection token and guidelines page for `load-knowledge`. An agent-specific override goes in `<agent>/.env.development.local`, which eve loads with higher priority; a shell variable on the command line beats both. A new agent joins with `ln -s ../.env.local <agent>/.env.local`.

### Shared tools: `packages/ai/common`

`common/` holds tools and pure helpers every agent can mount. An agent re-exports a tool from its own `agent/tools/`, which is where eve looks:

```ts
// agent/tools/load-knowledge.ts
export { default } from '../../../common/tools/load-knowledge'
```

| Tool | Mounted by | What it does |
| --- | --- | --- |
| `load-knowledge` | spec-writer, spec-reviewer, planner, implementor, pr-reviewer | Loads the org's engineering guidelines from Notion into the sandbox at `/workspace/knowledge` as markdown, `INDEX.md` first, one file per page. Needs `NOTION_TOKEN` and `KNOWLEDGE_PAGE` in the agent's `.env.local`; without them it reports `configured: false`; the spec reviewer requires guidelines and reports a blocker. `KNOWLEDGE_REQUIRED` names the pages every agent must read in full; they are concatenated into `REQUIRED.md`, returned as `requiredFile`, and a missing one is an error. |
| `board` | every agent | The project's Feature Board through the shared board module: `resolve` a ticket, `start` (gate, pull into `.work/<id>-<slug>/`, claim) and `finish` (push the outputs, make the success move). The skill launchers run the same flow on the host around a run, so an agent calls it only when its request says the ticket was not claimed. Needs `NOTION_TOKEN` and the project's `aspira.json`. |

Helpers and their tests live in `common/src/lib/`, so a shared helper is tested once. The spec reviewer owns its three-phase pipeline and per-phase cost report; the PR reviewer owns its separate review loop.

### Spec to implementation workflow

`spec-reviewer` reviews intent and business acceptance criteria. `planner` reads the reviewed spec and creates concrete technical tasks with mapped unit/integration test checklists. `implementor` (or `/aspira-implementor`) writes those tests first, then implements the plan, running independent tasks in parallel. Both planning agents use shared read-only repository/MCP access and run-analysis/trace infrastructure in `agent-common`.

## Running the agents

In a project on the kit, run the agents through their skills: `/aspira-<agent>` in Claude Code, installed globally by `kit update` from `@aspiralabs/ai`. The commands below are for working on the agents in this checkout. They assume the `agent` shell function from **Running one from anywhere** above is in your `~/.zshrc` (`ASPIRA_KIT` is only this function's variable; the skill launchers do not read it):

```bash
export ASPIRA_KIT="$HOME/path/to/ASPIRA_KIT"

agent() {
  if [ $# -lt 2 ]; then
    echo "usage: agent <name> <prompt>" >&2
    ls -1 "$ASPIRA_KIT/packages/ai" | grep -v '\.md$' | sed 's/^/  /' >&2
    return 2
  fi
  local name=$1; shift
  local dir="$ASPIRA_KIT/packages/ai/$name"
  [ -d "$dir" ] || { echo "agent: no such agent '$name'" >&2; return 1; }
  pnpm -C "$dir" exec eve invoke "$@"
}

agent-dev() { pnpm -C "$ASPIRA_KIT/packages/ai/${1:?usage: agent-dev <name>}" dev; }
```

Without the function, replace `agent <name>` with `pnpm -C $ASPIRA_KIT/packages/ai/<name> exec eve invoke`.

Two rules that apply to every command below:

- **Run them from inside the repo you want reviewed**, so `$PWD` is that repo.
- **Always pass absolute paths.** Relative paths resolve against the agent's package directory, not your shell.

Every agent needs Node 24 and a Vercel AI Gateway key in the shared `.env.local`. The PR reviewer and Notion snapshot loader use Docker; direct spec review with an existing guidelines snapshot does not.

Every agent below also has a skill: `/aspira-<agent> <ticket>` runs the agent's pipeline inside your Claude Code session, with no model call made from the script, and `/aspira-<agent> <ticket> --cloud` launches the agent as a separate process (KIT-51; `--local` is still accepted and means the default). The ticket is a Feature Board ID such as `NOM-4`, a Notion page URL, or nothing when `.work/` holds one ticket; the skill gates on the ticket's Status, pulls its pages into `.work/<id>-<slug>/`, makes its own board moves and pushes its output back to the ticket. A file path still works with `--no-ticket`. Both paths load the Notion engineering rules. The skill carries no rules of its own; the agent's files are the authority. Install the skills and read the pattern under **Skills** above.

### spec-writer

Turns an idea (a file, a Notion card or inline text) into a spec: it explores the repository, drafts the spec, then runs the official spec review on the draft.

```bash
agent spec-writer "Write a spec from $PWD/ideas/checkout.md for $PWD"
```

**Skill:** `/aspira-spec-writer <ticket> [--force-pull] [--guidelines FILE] [--repo DIR] [--output DIR]` runs this agent on the ticket's Idea (from `Ready: Idea`; it claims the card and pushes the spec as the page Spec); `<idea.md> --no-ticket` runs it on a file with no board. By default the same pipeline runs in your Claude Code session from the agent's own files (`--cloud` launches the agent instead); the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `spec-writer/skill/aspira-spec-writer/`; see **Skills** above. Also see `spec-writer/README.md` for outputs and models.

### spec-reviewer

The official reviewer runs frontier research, six concurrent specialist reviews and one reconciliation. It requires a local Git repository and engineering guidelines. The original spec remains unchanged.

```bash
agent spec-reviewer "Review $PWD/specs/feature/spec.md against $PWD; required guidelines snapshot: /absolute/REQUIRED.md"

# Without a snapshot, the eve entry point loads the required guidelines from Notion.
agent spec-reviewer "Review $PWD/specs/feature/spec.md against $PWD"

# Direct CLI with a snapshot, without Docker or the eve router:
pnpm -C "$ASPIRA_KIT/packages/ai/spec-reviewer" review \
  "$PWD/specs/feature/spec.md" "$PWD" /absolute/REQUIRED.md
```

Results are written beside the source in `spec.reviewed/`. Only `spec.original.md`, `spec.reviewed.md` (when edits are valid), and `run-analysis.md` are at the top level, plus the `trace/` directory. Run analysis shows cost and wall time per agent/turn and totals. All findings, decisions, checks, prompts, outputs and tool records are in `trace/`. Prior results move to `spec.reviewed/trace/history/run-*/` on rerun. An incomplete review is not approval; consult `trace/checks.md` and `trace/decisions.md`.

**Skill:** `/aspira-spec-reviewer <ticket> [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo DIR] [--output DIR]` runs this agent on the ticket's Spec page (from `In Review: Spec`; no move; it pushes Spec Reviewed and, for `needs-author`, Spec Review Decisions); `<spec.md> --no-ticket` runs it on a file with no board. By default the same pipeline runs in your Claude Code session from the agent's own files (`--cloud` launches the agent instead); the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `spec-reviewer/skill/aspira-spec-reviewer/`; see **Skills** above. A review in the session lands in the same `spec.reviewed/` layout, with no itemized cost, and is not independent of the session. See `spec-reviewer/README.md` for MCP setup and model overrides.

### planner

**Skill:** `/aspira-planner <ticket> [--force-pull] [--guidelines /absolute/REQUIRED.md]` runs this agent on the ticket's Spec Reviewed page (from `Ready: Spec`; it claims the card and pushes the plan as the page Plan, then moves it to `In Review: Plan`); `<spec.reviewed.md> --no-ticket` runs it on a file with no board. By default the same pipeline runs in your Claude Code session from the agent's own files (`--cloud` launches the agent instead); the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `planner/skill/aspira-planner/`; see **Skills** above.

Or invoke the agent directly to turn a reviewed business spec into concrete implementation tasks and unit/integration test checklists:

```bash
agent planner "Plan implementation of $PWD/specs/feature/spec.reviewed/spec.reviewed.md against $PWD; required guidelines snapshot: /absolute/REQUIRED.md"

pnpm -C "$ASPIRA_KIT/packages/ai/planner" plan \
  "$PWD/specs/feature/spec.reviewed/spec.reviewed.md" "$PWD" /absolute/REQUIRED.md
```

Without a supplied snapshot, the eve entry point loads required guidelines from Notion. Standard reviewed specs produce a sibling `plan.review/` with `plan.reviewed.md`, `run-analysis.md` and `trace/`. Failed or unresolved plans must not be treated as ready to implement. See `planner/README.md` for context, models and validation.

### pr-reviewer

Six specialist reviewers plus an independent verifier review a pull request and settle on one fix list. For a local repo the output lands in that repo at `.work/<ticket>/pr-review/` (the ticket's working folder; `<ticket>` is the branch without its type prefix), and `.work/` is added to its `.gitignore` on the first run.

```bash
# A GitHub PR by URL (GITHUB_TOKEN in the environment for private repos)
agent pr-reviewer "Review https://github.com/owner/name/pull/123"

# A GitHub PR by shorthand
agent pr-reviewer "Review owner/name#123"

# The branch checked out in this repo against main, capped at 2 rounds
agent pr-reviewer "Review the branch $(git branch --show-current) in $PWD against main, cap it at 2 rounds"

# A specific branch against a different base
agent pr-reviewer "Review the branch feat/checkout in $PWD against develop"

# Against the spec the feature was built from: every seat reads it and can raise spec findings
agent pr-reviewer "Review the branch feat/checkout in $PWD against main, the spec is $PWD/specs/checkout.md"

# Let it run to the default 4 rounds (it ends earlier after a round with no dispute and no new finding)
agent pr-reviewer "Review the branch feat/checkout in $PWD against main"

# Re-review only what changed since the previous review, and stop at $3
agent pr-reviewer "Review the branch feat/checkout in $PWD against main again, since the previous review in $PWD/.work/checkout/pr-review, stop at \$3"

# Write the output somewhere else
agent pr-reviewer "Review the branch feat/checkout in $PWD against main, write the output to /tmp/checkout-review"

# Terminal UI
agent-dev pr-reviewer
```

Reviewing the checked-out branch includes your uncommitted and untracked files. Naming any other branch reviews committed history only.

**Skill:** `/aspira-pr-reviewer <ticket> [--max-rounds N] [--max-cost USD] [--since DIR] [--no-comment] [--yes]` runs this agent on the ticket's PR (from `In Review: Implementation` with the PR property set; no move; it pushes `review.md` as the page PR Review), after printing a cost estimate (`--yes` skips it); `<github-pr | repo-path> --no-ticket [--branch B] [--base main]` reviews without a board. `--max-cost` stops a cloud run at a dollar amount (default `MAX_COST_USD`); `--since` re-reviews only what changed since the review in DIR. By default the same pipeline runs in your Claude Code session from the agent's own files (`--cloud` launches the agent instead); the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `pr-reviewer/skill/aspira-pr-reviewer/`; see **Skills** above. A review in the session exports the same files; Quinn then runs on the session's model, so it is not a second vendor.

### code-analyzer

Detects the repository's analyzers (project `lint`/`typecheck`/`format:check` scripts, ESLint, tsc, Prettier, Biome, Ruff, mypy, pyright, flake8, black, gofmt, go vet, golangci-lint, cargo fmt/clippy, RuboCop), runs them, applies their auto-fixes, hands the remaining errors to a workhorse model with read/search/exact-edit tools, and loops until clean or no further progress. It never adds suppressions or edits analyzer configuration, lockfiles, CI or tests.

```bash
# A local checkout: fixed in place on the host, report in <repo>/.static-analysis/
agent code-analyzer "Run static analysis on $PWD"

# Direct CLI, no eve or Docker (local repositories only)
pnpm -C "$ASPIRA_KIT/packages/ai/code-analyzer" analyze "$PWD" [--max-rounds 3] [--fix-warnings]

# A GitHub repository: cloned into the sandbox, fixed there, committed on static-analysis/<timestamp>
agent code-analyzer "Run static analysis on owner/name"

# ...and push the branch + open a pull request (GITHUB_TOKEN with write access)
agent code-analyzer "Run static analysis on owner/name and open a pull request"
```

Status `clean` means every analyzer passed; `partial` means diagnostics remain or an analyzer could not run; `nothing-detected` means no supported ecosystem. Review the diff before merging: passing static analysis does not prove behavior is unchanged, and no tests are run. Caps: 6 rounds and 5 USD by default (`STATIC_ANALYSIS_MAX_ROUNDS`, `STATIC_ANALYSIS_MAX_COST_USD`); model `STATIC_ANALYSIS_FIX_MODEL` (default `openai/gpt-6.1-sol`).

**Skill:** `/aspira-code-analyzer <ticket> [--app DIR]` runs this agent (from `In Progress: Implementation` or `In Review: Implementation`; no move, no push); `<repo | subdirectory | url | owner/name> --no-ticket [--push]` runs it without a board. By default the same pipeline runs in your Claude Code session from the agent's own files (`--cloud` launches the agent instead); the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `code-analyzer/skill/aspira-code-analyzer/`; see **Skills** above. A subdirectory is accepted, so a repository with several apps and no root `package.json` can be analyzed one app at a time.

### implementor

Builds a `planner` plan, a spec or a ticket test-first, running independent tasks in parallel. Its procedure is `implementor/agent/skills/aspira-implementor/SKILL.md`, which eve loads with `load_skill`, and its system prompt is `implementor/agent/instructions.md`.

```bash
# The agent: clones the GitHub repository, builds on implement/<feature>-<timestamp> and always pushes that branch
agent implementor "Implement docs/plans/feature/plan.review in the GitHub repository owner/name"
agent implementor "Implement specs/feature.md in the GitHub repository owner/name. Push the branch and open a draft pull request."
```

**Skill:** `/aspira-implementor <ticket> [--repo owner/name] [--ref BRANCH] [--pr]` runs this agent on the ticket's Plan page (from `Ready: Plan`; it claims the card, pushes `implementation.md` as the page Implementation and, when it opened the PR, sets PR and moves to `In Review: Implementation`); `<plan.review | spec.md> --no-ticket` builds a file with no board. By default the same pipeline runs in your Claude Code session from the agent's own files (`--cloud` launches the agent instead); the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `implementor/skill/aspira-implementor/`; see **Skills** above. Without `--repo`, the launcher builds the current checkout's GitHub `origin` from the current branch, which must be pushed. The default mode builds the local checkout and pushes nothing. It also takes a ticket, which the session first restates as a spec. Review the result with `pr-reviewer`.

### groomer

Grooms a Feature card's Idea in rounds before it reaches Ready: Idea. Each run is one round: it finds what the repository already has for the idea, asks the open product questions on the ticket's Grooming Decisions page, and once the human ticks Confirm with nothing open, writes the Decisions and Terms into the card's Idea. It never touches the board itself; the launcher's ticket step makes the moves.

```bash
agent groomer "Groom the ticket in $PWD/.work/<id>-<slug> for $PWD"
```

**Skill:** `/aspira-groomer <ticket> [--force-pull] [--force-run] [--guidelines FILE] [--repo DIR]` runs this agent on the ticket's Idea (from `Idea` or `Grooming`; it moves Idea -> Grooming on start, pushes the page Grooming Decisions each round and, on Confirm, writes the Idea summary and moves Grooming -> Shortlist). It writes to the card, so there is no `--no-ticket` mode. The move from Shortlist to Ready: Idea is the human's. By default the rounds run in your Claude Code session from the agent's own files, answering in chat (`--cloud` launches the agent instead); the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `groomer/skill/aspira-groomer/`; see **Skills** above. Also see `groomer/README.md` for outputs and models. Override the resolved agent with `GROOMER_AGENT_DIR` (kit development only).

### Checking an agent is healthy

```bash
pnpm -C $ASPIRA_KIT/packages/ai/spec-writer exec eve info
pnpm -C $ASPIRA_KIT/packages/ai/spec-reviewer exec eve info
pnpm -C $ASPIRA_KIT/packages/ai/planner exec eve info
pnpm -C $ASPIRA_KIT/packages/ai/pr-reviewer exec eve info
pnpm -C $ASPIRA_KIT/packages/ai/code-analyzer exec eve info
pnpm -C $ASPIRA_KIT/packages/ai/implementor exec eve info
```

Each should report `Compile ready` and `Diagnostics 0 errors`.
