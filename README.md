# Cueston MCP server and CLI

[![npm](https://img.shields.io/npm/v/cueston)](https://www.npmjs.com/package/cueston)
[![Cueston MCP connector](https://glama.ai/mcp/connectors/com.cueston/cueston/badges/score.svg)](https://glama.ai/mcp/connectors/com.cueston/cueston)
[![CI](https://github.com/andreycretsu/cueston-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/andreycretsu/cueston-mcp/actions/workflows/ci.yml)

The MCP server and command line for [Cueston](https://cueston.com), in-app guidance for SaaS web apps. An
AI agent (Claude, ChatGPT, Cursor, VS Code, Windsurf, any MCP client) can build, check, preview and
publish product tours, tooltips, banners, checklists, surveys and announcements in your own app, and
read how they perform.

## Connect

**Hosted server (no install).** Add this URL as a connector and sign in with your Cueston account
(OAuth 2.1; you pick read, edit or publish access on the consent screen):

```
https://app.cueston.com/api/mcp
```

```sh
claude mcp add --transport http cueston https://app.cueston.com/api/mcp
```

**Local (stdio) bridge**, for clients that only run local servers:

```json
{
  "mcpServers": {
    "cueston": { "command": "npx", "args": ["-y", "cueston", "mcp"] }
  }
}
```

Run `npx cueston login` once, or set `CUESTON_API_KEY` to a secret key (`sk_…`).

Registry name: `com.cueston/cueston` ([Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=com.cueston/cueston)).
A free Cueston plan is enough to try it: [sign up](https://app.cueston.com/signup).

## What the agent can do

76 tools and 5 prompts. Every tool says whether it only reads; write tools that overwrite or take
content down are marked destructive.

- **Learn the product:** pages, UI elements with checked selectors, tracked events, saved audiences.
- **Build guidance as drafts:** tours, tooltips, banners, checklists, surveys, announcements, and
  campaigns that group them for one goal.
- **Check before going live:** validate a draft against the real page, estimate the audience, ask
  "would this person see it?", open a preview link on your own site.
- **Ship safely:** publish, request review when the workspace needs approval, unpublish, roll back to
  any version.
- **Measure:** guide analytics, survey results, stuck points, product analytics, retention, tasks,
  session recordings.
- **Translate:** read, write, machine-translate, import and export translations.
- **Sales demo agent:** settings, leads, questions it couldn't answer, coaching notes.

Prompts: `announce_feature`, `onboard_new_users`, `fix_broken_targets`, `run_nps_survey`,
`explain_visibility`.

Nothing goes live until you or your agent publish it. Your role, plan limits, approval rules and the
audit log apply exactly as they do in the dashboard. Full tool catalog and setup for each app:
[cueston.com/docs/mcp](https://cueston.com/docs/mcp).

## The CLI

The Cueston command line and MCP server. Build, check, preview and publish in-app guidance (tours,
tooltips, banners, checklists, surveys and announcements) from your terminal, from CI or from an AI
agent such as Claude, ChatGPT, Cursor or VS Code.

It uses the same API as the dashboard. Your role, plan limits, approval rules and the audit log
apply exactly as they do there. Everything you create or edit is a draft until you publish it.

## Install

```sh
npm install -g cueston
cueston --version
```

Or run it without installing:

```sh
npx cueston tours list
```

Node.js 20 or later.

## Set up Cueston in your project

```sh
npx cueston init
```

`init` signs you in through the browser (new to Cueston? the page lets you create a free account), finds where your app renders its HTML shell and adds the Cueston snippet there with your workspace's publishable key. It shows the file first and asks before editing it.

- **Next.js App Router:** `app/layout.tsx` (or `src/app/`), two `next/script` tags before `</body>`.
- **Next.js Pages Router:** `pages/_document.tsx`, inside `<Head>`.
- **Vite and other `index.html` projects, Create React App:** two `<script>` tags before `</head>`.

Anything else gets the snippet printed to paste in. Running it again changes nothing.

- `--dry-run` prints the exact lines it would add, without writing.
- `--dir apps/web` points it at a project in a monorepo.
- `--yes` skips the question (needed when there's no terminal, like CI).

It then prints the `Cueston.identify()` call to add where your app knows the signed-in user.

## Sign in

```sh
cueston login
```

This shows a short code and opens your browser. Check that the code matches, pick the workspace
and approve. The CLI then saves a secret API key (`Cueston CLI · <your computer>`) that acts as
you, with your role. Revoke it any time in **Settings → API keys**.

- On a remote machine, use `cueston login --no-browser` and open the link yourself.
- To use a key you already have: `cueston login --key sk_…`, or `echo "$KEY" | cueston login --with-key`.
- `cueston whoami` shows who you are, the workspace, your role and the API URL.
- `cueston logout` forgets the key on this computer. `cueston logout --revoke` also revokes it.

The key is stored in `~/.config/cueston/config.json` (or `$XDG_CONFIG_HOME/cueston/`), readable
only by you. Set `CUESTON_CONFIG_DIR` to use another folder.

### Which key and URL a command uses

| Setting | Order                                                                                  |
| ------- | -------------------------------------------------------------------------------------- |
| Key     | `--key` → `CUESTON_API_KEY` → saved by `cueston login`                                 |
| API URL | `--api-url` → `CUESTON_API_URL` → saved by `cueston login` → `https://app.cueston.com` |

## Guidance

Every content type has the same commands. Use the plural or singular name: `tours` or `tour`,
`tooltips`, `banners`, `checklists`, `surveys`, `announcements`.

```sh
cueston tours list                        # id, name, status (live, staging, draft), URL pattern
cueston tours list --status live
cueston tours get 12                      # every field, as YAML (--json for JSON)
cueston tours create --file tour.yaml     # a draft; JSON or YAML; --file - reads stdin
cueston tours create --name "Welcome" --url-pattern "https://app.acme.com/*"
cueston tours update 12 --name "Welcome v2"
cueston tours update 12 --data '{"steps":[{"selector":"#new","title":"New","content":"…"}]}'
cueston tours duplicate 12
cueston tours delete 12 --yes
```

Field flags (`--name`, `--url-pattern`) win over `--file` and `--data`. To see every field a type
takes, run `cueston tools list --schema create_tour`.

### Publish, roll back, review

```sh
cueston tours publish 12                              # to production
cueston tours publish 12 --env staging --note "New export step"
cueston tours unpublish 12
cueston tours versions 12
cueston tours rollback 12 345                         # make version id 345 live again
cueston tours restore 12 345                          # copy version 345 into the draft
cueston tours request-review 12 --note "Ready for launch"
```

If your workspace requires approval, `publish` to production fails with `approval_required`. Use
`request-review` instead; a publisher approves it in Approvals or with `cueston reviews approve`.

```sh
cueston reviews list                      # pending; --status all for every request
cueston reviews approve 7
cueston reviews reject 7 --note "Shorten step 2"
cueston reviews cancel 7                  # your own request
```

### Surveys

```sh
cueston surveys results 4 --days 90       # responses, response rate, NPS, answers
cueston surveys export 4 -o responses.csv
```

## Design system

```sh
cueston design-system                     # show style, colours, corners, shadow, buttons, sizes
cueston design-system update --style soft --accent '#8e4f9c'
cueston design-system update -f theme.yaml
```

## Audiences, analytics, translations, previews, webhooks

```sh
cueston segments list
cueston segments create --file segment.yaml
cueston segments update 3 --description "Admins on Pro"
cueston segments estimate 3               # matching users from the last 30 days
cueston segments estimate --file rules.yaml
cueston segments delete 3 --yes

cueston analytics                         # workspace totals and top guidance, last 30 days
cueston analytics --days 7
cueston analytics item tour 12            # totals and the step funnel
cueston analytics issues                  # tooltips and steps whose element went missing
cueston analytics export events -o events.csv

cueston translations export --languages de,fr -o strings.csv     # or --format xliff
cueston translations import strings.csv                          # shows what would change
cueston translations import strings.csv --apply                  # writes it (to drafts)
cueston translations auto tour 12 --to de,fr                     # machine-translate every step

cueston preview tour 12 --site-url https://app.acme.com/billing  # a link that shows the draft

cueston webhooks list
cueston webhooks create --url https://example.com/hooks --events content.published
cueston webhooks test 5
cueston webhooks delete 5 --yes
```

## Content as code

Keep guidance in git and ship it from CI.

```sh
cueston pull                     # writes ./cueston/<type>/<id>-<name>.json
cueston pull content --type tours,banners
# edit the files, or add a new file without "id"
cueston push --dry-run           # prints the plan
cueston push                     # creates and updates drafts
cueston push --publish --env staging
```

- Files hold the editable draft fields, with keys in a stable order, so they diff cleanly.
- A file without `"id"` creates a new draft. Its id is written back into the file.
- A file with an id updates that item's draft. Only fields that differ are sent. Fields a file
  leaves out stay as they are.
- After saving, `push` writes back what the server stored, so running it again changes nothing.
- `push` exits with code 1 if any item failed. `pull --prune` removes files of deleted items.

### In CI

Create a key in **Settings → API keys** and store it as a secret. No login needed:

```yaml
# .github/workflows/guidance.yml
on:
  push:
    branches: [main]
    paths: ["cueston/**"]
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx cueston push --publish
        env:
          CUESTON_API_KEY: ${{ secrets.CUESTON_API_KEY }}
```

## AI agents and MCP

Every MCP tool is also a CLI command:

```sh
cueston tools list
cueston tools list --schema validate_content
cueston tools call validate_content --arg type=tour --arg id=12
cueston tools call find_elements --arg query="export button"
cueston tools call debug_audience --data '{"url":"https://app.acme.com/billing","userId":"u_42"}'
```

Most MCP clients connect to `https://app.cueston.com/api/mcp` directly and sign in. For a client
that only runs local (stdio) servers, `cueston mcp` bridges stdio to Cueston:

```json
{
  "mcpServers": {
    "cueston": {
      "command": "npx",
      "args": ["-y", "cueston", "mcp"],
      "env": { "CUESTON_API_KEY": "sk_…" }
    }
  }
}
```

## Any endpoint

```sh
cueston api GET /api/tours
cueston api PATCH /api/tours/12 --data '{"name":"Welcome"}'
cueston api GET analytics/overview -q days=7       # /api is added for you
```

## Output and exit codes

- `--json` on any command prints one JSON document on stdout. Errors in `--json` mode are
  `{ "error": { "message", "code", "status", "details", "hint" } }`.
- Without `--json`, results go to stdout and progress to stderr. Colors only on a terminal; set
  `NO_COLOR` to turn them off.
- Exit codes: `0` success, `1` failure, `2` wrong arguments or flags.
- Rate-limited requests are retried after the time the server asks for.

## Development

```sh
pnpm install
cd packages/cli
npm run type-check && npm test && npm run build
node dist/cli.js --help

# End to end, against a running app and a key for a scratch workspace:
CUESTON_API_URL=http://localhost:3000 CUESTON_API_KEY=sk_… npm run e2e
```

Releases: push a `cli-vX.Y.Z` tag. The release workflow publishes to npm (needs the `NPM_TOKEN`
repository secret).
