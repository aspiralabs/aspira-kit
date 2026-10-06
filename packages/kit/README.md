# @aspiralabs/kit

The CLI that puts a project on the kit: it installs `@aspiralabs/ui`, `@aspiralabs/config` and `@aspiralabs/agents`, wires them in, installs the `/aspira-*` agent skills, scaffolds shared features like auth, and reports drift.

```bash
pnpm dlx @aspiralabs/kit init --stack next --board <Feature Board URL>   # first run, before the kit is installed
pnpm kit add auth                            # base Better Auth setup
pnpm kit doctor                              # what version you're on, what's wired
pnpm kit next NOM-4                          # what to run next for a ticket
```

In a repository where the app is not the root (no root `package.json`; the Next app, its `package.json` and `node_modules` are in `apps/web`; Claude Code runs at the root), run `init` at the root with `--app`:

```bash
pnpm dlx @aspiralabs/kit init --stack next --app apps/web --board <Feature Board URL>   # at the repository root
pnpm -C apps/web kit doctor                  # the app is read from aspira.json; the root is found from inside the app
```

Installing needs a GitHub Packages token in `~/.npmrc`; see the [repo README](../../README.md#use-the-kit-in-an-app).

## Commands

| Command | What it does |
|---|---|
| `kit init --stack next` | Installs the kit packages and wires the project to them; `--board <url>` also writes `aspira.json`; `--app <dir>` for a repository whose app is not the root |
| `kit init --board <url>` | Writes or updates `aspira.json` (the Feature Board, and `--releases <url>`) in a project already on the kit |
| `kit add auth` | Writes a base Better Auth setup the project then owns |
| `kit doctor` | Prints the kit versions in use and checks the wiring, including `aspira.json` and the agent skills; `--app <dir>` (or `app` in `aspira.json`) names the app |
| `kit next [<ticket>]` | Prints the ticket's Status and the Playbook step, command and owner that come next |
| `kit playbook` | Prints the Playbook section of From Idea to Release as markdown, from the same table `kit next` reads |

Every command takes `--cwd <path>` to run against another directory. `init` and `add` take `--dry-run`, which prints the plan and changes nothing. `init`, `doctor` and `next` take `--app <dir>`, the app that owns `package.json` and `node_modules` when it is not the root (see [`--app`](#--app-a-repository-whose-app-is-not-the-root)); `doctor` and `next` read it from `aspira.json` once `init` has recorded it.

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
pnpm kit init --stack next [--app <dir>] [--board <Feature Board URL>] [--releases <Releases page URL>] [--dry-run] [--cwd <path>]
```

Puts a Next.js project on the kit. `next` is the only stack so far. Without `--app`, every step below runs in the project root. With `--app <dir>`, the package steps (`.npmrc`, the install, `eslint.config.mjs`, `prettier.config.mjs`, `tsconfig.json`, `globals.css`) run in `<dir>` and the rest at the root.

| Step | Result |
|---|---|
| `.npmrc` | Maps `@aspiralabs` to GitHub Packages. Warns if `~/.npmrc` has no token |
| Install | `@aspiralabs/ui`; dev: `@aspiralabs/config`, `@aspiralabs/kit`, `@aspiralabs/agents`, `eslint`, `prettier`, `typescript`. Uses the project's package manager (pnpm, npm or yarn, from the lockfile) |
| `eslint.config.mjs` | `@aspiralabs/config/eslint/next`, if the file doesn't exist |
| `prettier.config.mjs` | `@aspiralabs/config/prettier`, if the file doesn't exist |
| `tsconfig.json` | `extends` the kit's `next.json`; adds `paths: { "@/*": ["./*"] }` if there are none |
| `globals.css` | Adds the `tokens.css` import and the `@source` lines Tailwind needs to scan the package. Looks in `app/`, `src/app/`, `styles/` |
| `AGENTS.md` | Writes or replaces the block between `<!-- aspiralabs:begin -->` and `<!-- aspiralabs:end -->`. Everything outside it is yours and is kept |
| `CLAUDE.md` | `@AGENTS.md`, if the file doesn't exist |
| `.mcp.json` | Registers the `aspiralabs-ui` docs server (`npx --no aspiralabs-ui-mcp`; with `--app`, `node <app>/node_modules/@aspiralabs/ui/bin/mcp.js`), merged into your servers. The kit's entry is replaced on a re-run, yours are kept |
| `.claude/settings.json` | Adds the session-start, deny-tier3 and audit-log hooks (`sh node_modules/@aspiralabs/kit/hooks/<name>.sh`; with `--app`, `sh <app>/node_modules/...`), merged into your settings. The kit's hook groups are replaced on a re-run, including entries pointing at the retired `@aspiralabs/config/agent/hooks/` path or at a previous app directory; yours are kept |
| `.claude/skills/aspira-<agent>/` | One folder per agent (spec-writer, spec-reviewer, planner, implementor, code-analyzer, pr-reviewer): a copy of the installed package's `skill/aspira-<agent>/` (`SKILL.md` and `scripts/`) plus `.kit-version`, the installed `@aspiralabs/agents` version. Commit them. A re-run after a bump rewrites them |
| `.gitignore` | Adds `.work/` (the per-ticket working folder) and `.aspira/` (the audit log the hooks write, `.aspira/audit.jsonl`), whichever is missing |
| `aspira.json` | With `--board`: the project's Feature Board URL and, with `--releases`, its Releases page. The `/aspira-*` skills and `kit next` read it. With `--app`: `"app": "<dir>"`, which `kit doctor`, `kit next` and the skill launchers read to find the installed packages. Without `--board` the board is left as it is, and a project without one has no board: every skill then needs `--no-ticket` |

### `--app`: a repository whose app is not the root

nomnomzz is the case: the Next app with its `package.json` and `node_modules` is `apps/web`, there is no root `package.json`, and Claude Code runs at the repository root, where it reads `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and `.claude/`. Run `init` at the root with `--app <dir>`, where `<dir>` is the app, relative to the root:

```bash
pnpm dlx @aspiralabs/kit init --stack next --app apps/web --board <Feature Board URL>
```

| Where | What |
|---|---|
| `apps/web/` | `.npmrc`, the install (`pnpm add` runs there, with its lockfile), `eslint.config.mjs`, `prettier.config.mjs`, `tsconfig.json`, `app/globals.css` |
| the root | `AGENTS.md` (managed block, plus one line naming the app), `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`, `.claude/skills/aspira-*/`, `.gitignore` (`.work/`, `.aspira/`), `aspira.json` with `"app": "apps/web"` |

Every path inside the root files points into the app, relative to the root where Claude Code runs them: the hooks are `sh apps/web/node_modules/@aspiralabs/kit/hooks/<name>.sh`, the MCP server is `node apps/web/node_modules/@aspiralabs/ui/bin/mcp.js`, and the skills are copied from the agent packages under `apps/web/node_modules`. The launchers in `.claude/skills/` read `app` from the root's `aspira.json` and resolve the installed agents under `apps/web/node_modules` whatever the working directory is; the app's `.env.local` is the one they load. `kit doctor` and `kit next` read `app` from `aspira.json` too, so they need no flag after `init`, and run from inside the app (`pnpm -C apps/web kit doctor`, where the kit's bin is) they find the root that wired it. One app per repository: `--app` names the app the kit packages are installed in; other apps keep their own tooling.

The `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and settings templates ship in this package (`templates/agent/`), and the hooks in `hooks/`, so re-running `init` after an upgrade brings them up to that version. The managed `AGENTS.md` block and the session-start hook only point at the rules in Notion; they restate none.

### The agent skills

`@aspiralabs/agents` is one dependency that brings every agent package (`@aspiralabs/spec-writer`, `spec-reviewer`, `planner`, `implementor`, `code-analyzer`, `pr-reviewer` and `agent-common`) into the project at the kit's version. Each agent's skill is copied into `.claude/skills/aspira-<agent>/`, so `/aspira-planner` and friends run the agent installed in `node_modules`, never a source checkout. The launcher resolves its agent as `<AGENT>_AGENT_DIR` (kit development only; the run says so), then the installed package under the app named in the root's `aspira.json` (`--app`), then walking up from the working directory, then from its own location; `$ASPIRA_KIT` is not consulted. Agent environment comes from the project's `.env.local` (`AI_GATEWAY_API_KEY`, `NOTION_TOKEN`, `KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`), then the agent's own folder.

Updating an agent is a kit release, a bump of `@aspiralabs/agents` in the project, and `kit init` again; `kit doctor` fails until the skills match the installed version. Each run reports the agent package and version it ran, and writes `trace/agent-version.json` into its export.

**Removing the old `~/.claude/skills` symlinks.** Before this, the skills were symlinks from `~/.claude/skills/aspira-*` into one kit checkout, and `ASPIRA_KIT` pointed the launchers at it. Those links now shadow nothing useful and can point at a stale checkout, so remove them once per machine:

```bash
for a in spec-writer spec-reviewer planner implementor code-analyzer pr-reviewer; do
  [ -L ~/.claude/skills/aspira-$a ] && rm ~/.claude/skills/aspira-$a
done
# and drop `export ASPIRA_KIT=...` from your shell profile; the launchers no longer read it
```

## `kit add auth`

```bash
pnpm kit add auth [--no-passkey] [--expo <scheme>] [--dry-run] [--cwd <path>]
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
pnpm kit doctor [--app <dir>] [--cwd <path>]
```

Prints the version of each kit package the project declares and has installed (`@aspiralabs/ui`, `config`, `kit` and `agents`), then checks each part of the `init` wiring: ESLint, `tsconfig.json`, the tokens import, the `AGENTS.md` block, the MCP server, the hooks, `.gitignore` (`.work/` and `.aspira/`), `aspira.json` (present, with a Notion URL as `board`, and an `app` directory that has a `package.json` when set), and each `.claude/skills/aspira-<agent>/` folder (present, complete, and its `.kit-version` equal to the installed `@aspiralabs/agents` version). It exits `1` if anything is missing and tells you to re-run `init`.

With an app (`--app <dir>`, or `app` in `aspira.json`), one run checks both places: the package-level items (`package.json`, `node_modules`, ESLint, `tsconfig.json`, `globals.css`) in the app, and the Claude-facing items at the root, where the hooks and the MCP server must point into `<app>/node_modules`. Run from inside the app with no `--cwd`, it works on the root whose `aspira.json` names that app.

## `kit next` and `kit playbook`

```bash
pnpm kit next [<ticket>] [--app <dir>] [--cwd <path>]
pnpm kit playbook
```

`kit next` answers "what is the next step" for a ticket. It reads the board (and the app) from `aspira.json`, resolves the ticket (an ID such as `NOM-4`, a Notion page URL, or, with no argument, the one folder under `.work/` that holds a `ticket.md`; two is an error naming them) through the agents installed under the app's `node_modules` with `NOTION_TOKEN` from `.env.local` (the root's, then the app's, which wins), and prints its Status, the Playbook step for that Status, the exact command to run with the ID filled in, and who acts. When the board does not answer, the Status as pulled into the working folder stands in and the output says so.

The mapping is `src/playbook.ts`, the one source of the Status table. `kit playbook` renders it as the markdown of the "Playbook: what to run next" section of From Idea to Release in Notion; paste its output there when the table changes, so the page and the command stay in step.

## Working on the CLI

```bash
pnpm --filter @aspiralabs/kit build
node packages/kit/dist/cli.js add auth --dry-run --cwd ../some-app
```

- **Stacks** are profiles in `src/stacks/`, one per ecosystem (`next.ts`). Add one as projects need it.
- **Feature templates** live in `templates/<stack>/<feature>/` and ship in the package. `// #if flag` … `// #endif` (`# #if` in env files) keeps lines only when the flag is on, and `{{name}}` is replaced with a value. The command for a feature lives next to its stack (`src/stacks/next-auth.ts`).
- **Before changing a template**, generate it into a scratch project and typecheck it against the version of the library it targets. The templates aren't compiled as part of this package.
- **Tests** are `src/*.test.ts` (`pnpm test`). `install.integration.test.ts` packs every agent package, installs the tarballs into a scratch project, runs `kit init` there and then a launcher from `node_modules`; `release.integration.test.ts` runs `changeset version` on a fixture to check every package bumps together.
