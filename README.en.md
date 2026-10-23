# dsh-integration-settings

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH supported through 0.2.0-rc.2](https://img.shields.io/badge/DSH-up%20to%200.2.0--rc.2-2563eb.svg)](#requirements)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)](#requirements)

**English** | [简体中文](README.md)

Adds two visual pages to the DeepSeek Harness (DSH) **Settings**: **MCP servers** and **Thinking
unlock**. The latter turns what you would otherwise hand-edit in files into point-and-click
operations — it detects which thinking levels each OpenAI-compatible gateway really supports and
writes them into the model picker, on demand or on a schedule.

> **This repo is a local fork** (version numbers carry a `-dsh.N` suffix). See
> [LOCAL-PATCH.md](LOCAL-PATCH.md): the upstream **Skills** and **Global persona** pages are removed
> here (their backend routes remain, only the UI entries are gone), and **thinking levels** and the
> **available model list** are now two separate things — an "unlock thinking levels" switch and an
> independent "sync model list" button.

| Settings page | What it manages | Where it writes |
| --- | --- | --- |
| **MCP servers** | add / remove / edit / enable–disable MCP servers; paste an `mcpServers` JSON block to add servers after a preview | the current profile's `cordis.patch.yml` (managed block) + `.dsh-integration/mcp.json` (source of truth) |
| **Thinking unlock** | detects each gateway's real thinking levels on page open and unlocks them in one click; can add/edit gateways (no delete) | the current profile's `cordis.patch.yml` (the `llm-pi-ai` entry's `config.providers`) + `$DSH_HOME/.credentials.yaml` (`refs`, secrets only) |
| **Sync model list** | an independent button, semantically separate from the unlock switch: preview "will add N / will remove M" first, then confirm; one sync refreshes both thinking levels and the available model list atomically; can share the page's update schedule (scheduled runs auto-confirm and surface the last diff summary in the UI) | the same `config.providers` (`levels` and `models`) + `$DSH_HOME/.dsh-integration/unlock-schedule.json` (schedule state and last sync summary) |

> This is a community plugin, not an official DeepSeek product. Evaluate it yourself before
> installing, and consider backing up your profile directory first.

## Requirements

- **DSH desktop 0.2.0-rc.2** (this plugin is built against that version's `settings.section` slot and
  loader patch mechanism; host packages use the `@deepseek-ai/*` names from this version onward).
- **Node.js `^22.19.0 || >=24`** — only needed to build or test locally. **Installing does not need
  Node**, because the built `lib/` output is committed to the repository.
- **A DSH restart is required after installation**: MCP changes are read by the loader at startup
  (the managed patch block has no live reload).

## Installation

Pick one of the two ways below. The examples use the `desktop` profile — **replace it with your
own profile name** (DSH desktop's default profile is `desktop`).

> **Handing the install to an AI on another machine?** Give it the repo URL plus
> [INSTALL.zh-CN.md](INSTALL.zh-CN.md) — an executable runbook (in Chinese) with a command and an
> expected output for every step: environment probe → install → restart → verify → gateway setup →
> schedule acceptance → troubleshooting → acceptance checklist.

### Option A: install from GitHub (recommended)

```bash
# The dsh CLI lives inside the DSH application directory:
#   macOS        /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
#   Windows etc. <DSH install dir>/resources/runtime/cli/bin/dsh (dsh.cmd on Windows)
# If dsh is already on your PATH you can just write `dsh`; if your layout differs, search for runtime/cli
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 1) Install: registers the dependency and appends the package name to the profile's dsh.profile.bundles
"$DSH" plugin --profile desktop add github:2384418321/dsh-integration-settings

# 2) Confirm it is registered (dsh-integration-settings appearing in the list means success)
"$DSH" plugin --profile desktop list
```

The repository commits its `lib/` build output, so **installing from GitHub needs neither an npm
release nor a local build**.

### Option B: install from a local directory (for hacking on the source)

```bash
git clone https://github.com/2384418321/dsh-integration-settings.git
cd dsh-integration-settings
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "$(pwd)"    # a local directory is registered as link:
```

With a `link:` registration this fork has no `src/` and no build script: **edit
`lib/index.js` / `lib/client.js` directly**, then restart DSH — no reinstall needed.

### Option C: register by hand without the dsh CLI

1. Install inside the profile directory (profile directories live at `$DSH_HOME/profiles/<name>`):

   ```bash
   cd "$HOME/.dsh/profiles/desktop"
   pnpm add github:2384418321/dsh-integration-settings
   ```

2. Make sure that directory's `package.json` has `"dsh-integration-settings"` in its
   `dsh.profile.bundles` array (append it to the end if missing).
3. Restart DSH.

### Verifying the installation

1. After DSH restarts, two entries appear at the bottom of the left column of **Settings**:
   `MCP 管理 / 思考解锁` (MCP servers / Thinking unlock).
2. Open "MCP servers" — the **profile badge** at the top of the page should show the profile you want
   to modify. With multiple profiles, check the badge before changing anything.
3. Existing MCP servers are listed; lines hand-written in `cordis.patch.yml` that the plugin does not
   manage yet are reported with a banner and can be imported in one click.

## Uninstall

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-integration-settings
```

Then delete this package's name from the profile's `dsh.profile.bundles`, and (optionally) remove the
managed block between `# >>> dsh-integration-settings:managed:mcp` and
`# <<< dsh-integration-settings:managed:mcp` in the profile's `cordis.patch.yml`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Installed, but the two pages are missing from Settings | ① Check that this package appears in both `list` and the profile `package.json`'s `dsh.profile.bundles`; ② make sure you restarted the **same** profile; ③ if the bundle failed to load, DSH prints `<bin>: skipping profile bundle "dsh-integration-settings": <reason>` to stderr at startup and skips it silently — the usual causes are a missing `lib/` build output, too old a Node version, or a dependency resolution failure |
| Clicking a page shows a blank area | `settings.section` is a root-scope slot: calling a seat session hook (`usePanelInfo` etc.) from an entry triggers `Minified React error #311`, and the shell replaces the whole slot with `<div data-slot-error="settings.section"></div>`. When changing client code, keep the rule "root-scope entries never call any seat hook" (see Design notes below) |
| MCP changes do not take effect | The profile patch is read by the loader **at startup**: restart DSH (the page says so too). the managed patch block has no live reload |
| Write requests return 403 / 415 | The host route requires `x-dsh-integration: 1` and `application/json`; non-loopback or untrusted hosts, an `Origin` that differs from `Host`, and `Sec-Fetch-Site: cross-site` are all rejected with 403 |
| You broke the patch and want to roll back | Every write leaves a timestamped backup in the profile directory (3 kept); rename one back, or just delete the managed block between the two marker lines |
| The page reports `ambiguous_profile` | More than one profile has this plugin as a dependency, so it cannot be determined uniquely. Pick one with the profile selector on the page, set `DSH_PROFILE_DIR`, or pass `--profile <name>` |

**Data and privacy**: the plugin ships no credentials. Reference secrets through environment
variables (`!!js process.env.X`) as shown below instead of writing them into the patch in plaintext;
`.dsh-integration/` holds your local data and is excluded by `.gitignore`.

## Design notes

### MCP servers
DSH has no such thing as an "MCP registry": **an MCP server is a single loader line in the profile
patch.**

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github                              # tool name => mcp__github__<tool>
        transport: stdio                                # stdio | streamable-http
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env: { GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN }
```

- Because `- insert:` is the only legal way to add a patch entry with an unknown id, this plugin
  **rewrites the managed block as a whole**: the JSON file (`.dsh-integration/mcp.json`) is the source
  of truth and the block is regenerated from it every time.
- The block is wrapped in two marker comments; everything else hand-written in `cordis.patch.yml` is
  preserved verbatim. Every write is preceded by YAML structure validation and a timestamped backup
  (3 kept).
- MCP lines already hand-written in the patch but unknown to the plugin are reported with a banner and
  can be imported into management in one click.
- `!!js` expressions (for example `!!js process.env.GITHUB_TOKEN`) survive round-trips and never put
  secrets on disk: values at any nesting level of `env` / `headers`, and `args` elements starting with
  `!!js `, are written as real YAML tags (`TOKEN: !!js process.env.GITHUB_TOKEN`), while plain strings
  stay plain; reading them back yields strings again, so the round-trip is lossless.
- If the profile patch file is still the template's empty `[]` placeholder, the plugin drops that line
  before writing the managed block, avoiding invalid YAML such as `Unexpected seq-item-ind token`.

### Thinking unlock

DSH providers live in `@deepseek-ai/dsh-llm-pi-ai`'s `config.providers`, written into each profile's
`cordis.patch.yml`. A declared `reasoningEfforts` dict is a **whitelist**: levels you do not declare
show up greyed out in the model picker, so "can I pick High / Max on this model?" is decided entirely
by those few dozen lines of YAML.

This page has **two entry points that are deliberately not bound together** — the one semantic fix this
fork makes over upstream:

| Entry point | Owns only | Fields written |
| --- | --- | --- |
| "Unlock thinking" switch / "Unlock all" | thinking levels (`reasoningEfforts` / `levels`) | `config.providers[*].levels` |
| "Sync model list" button | the available model list (`models`), refreshing levels with it | `config.providers[*].models` + `levels` |

**Auto-detect (read-only, writes nothing)**

- **Detected on page open**: the page sends one read-only `GET /models` per provider it judges to be a
  gateway, reads `reasoning_supported_efforts` / `can_disable_thinking` and diffs it against the
  current config. The page shows "N to unlock / M already current / K gateway-silent / G no longer
  offered". Detection **writes nothing**.
- **Judged by shape, not by name**: a provider is probed only when all three hold — `api` is empty or
  `openai-completions`; `baseURL` is an http(s) URL; the `apiKeyEnv` credential is present in
  `$DSH_HOME/.credentials.yaml`'s `refs:` (or as an environment variable of that name). Everything
  else is listed with its **skip reason** (`api` is not OpenAI-compatible / address unparseable /
  credential missing) and is neither probed nor rewritten.
- **Only this entry's `config.providers`**: nothing outside `- id: llm-pi-ai` is read or written.
  DSH's built-in `deepseek-official` / `deepseek-account` do not live in this file.
- **Identity first, then unlocking**: by default only real WorkBuddy gateways are unlocked. Two
  signals, in order: the JSON at `<origin>/healthz` must name a `service` containing `workbuddy`
  (this box's two gateways answer `workbuddy-manager` and `workbuddy2api`; the endpoint needs no
  key); when that is silent, every `/v1/models` id must carry a `cn:` / `global:` namespace. The
  verdict is labelled per row: `WorkBuddy · workbuddy2api (via /healthz)` or `not a WorkBuddy gateway`.
- **Other gateways are left alone**: providers that are not identified are listed with the reason and
  skipped — not a byte is written. To unlock them too, clear the "WorkBuddy gateways only" checkbox.
- **"Show models"** expands a provider's **read-only** model list, showing what each model currently
  declares and what the gateway wants instead (including which levels would be dropped).

**One-click unlock**

- "Unlock all" writes the levels into `cordis.patch.yml`, with a backup first. **The gateway's
  capability table is the only truth** — if it says a model only supports `medium`, only `medium` is
  declared, and levels your config had on top of that are dropped. Before unlocking, the page lists
  every such model with its `old levels → new levels`.
- **A silent gateway changes nothing**: when the gateway reports no thinking information for a model,
  your existing declaration is kept — the plugin never writes `reasoningEfforts: false` for you, which
  would declare the model non-reasoning. Models the gateway no longer offers are kept verbatim too.
- **One failing gateway does not block the rest**: it is reported separately, the others still unlock.
- **Each provider keeps its own bytes**: writing replaces only that provider's byte range, so every
  other group keeps its layout verbatim — flow lists (`input: [ "text", "image" ]`), quoted scalars and
  `reasoningEfforts: false` (declaring a non-reasoning model) are neither reflowed nor dropped. With
  nothing to change, the file stays byte-identical.
- **`off` must stay quoted** (`"off":`) because YAML 1.1 parses a bare `off:` as boolean `false`, which
  would give the level dict a non-string key.
- Unlocking writes a `.bak-<timestamp>` backup (3 kept) and the file is written `0600`.

**Sync model list (its own button, preview before write)**

"Unlock all" only touches levels; whether the model list still matches what the gateway serves is a
different question. "Sync model list" answers exactly that, and refreshing the levels is a side effect
of the same write — the two are separate so that unlocking levels can never quietly blank the model list.

- **Preview first**: the button calls `POST /providers/models/sync-preview` (read-only) and returns
  "will add N / will remove M / keep K", broken down per provider into `levels` and `models`
  (`added` / `removed` / `kept`). The preview **writes nothing**.
- **Then confirm**: `POST /providers/models/sync-apply` requires the preview digest per provider (plus
  `confirm: true`). If the list moved between preview and apply (the gateway changed, someone edited the
  patch), the server answers `409 error.provider.sync.stale` and asks you to preview again — it never
  writes blind.
- **One write, two things**: confirming refreshes the thinking levels *and* the available model list in
  the same pass, so you can never end up with new levels next to a stale model list.
- **Probe failures error out, they never blank the list**: an unreachable gateway or a failing `/models`
  is reported per provider, an empty result from the gateway is refused with `502
  error.provider.sync.empty`, and when every gateway fails the whole call returns `502` without writing
  a single byte. **The model list is never emptied.**
- **Atomic write plus backup**: the patch is rewritten through `writeFileAtomic` (`writeWithBackup`,
  3 `.bak-<timestamp>` kept), validated as YAML before writing and re-parsed afterwards.
- **Same schedule as "scheduled updates"**: the scheduler runs this very path (`source: "schedule"`,
  auto-confirmed) and records the diff summary in `unlock-schedule.json`'s `lastResult.sync` (models
  added/removed, the ids involved, level changes, failing gateways); the page shows a line such as
  "last sync: +3 / -1".

**Scheduled updates**

You do not have to open this page and press "Unlock all" or "Sync model list": while DSH runs, the plugin
does **both** jobs on a cadence — unlock the thinking levels and sync the available model list (the
scheduled path auto-confirms without a dialog, but it logs the run and surfaces the last diff summary on
the page).

- **Every 6 hours by default**, changeable on the page (15 min / 30 min / 1 / 2 / 6 / 12 / 24 h) or
  switched off entirely. Changing the cadence — or switching a disabled schedule back on — restarts the
  clock from now.
- **It runs when the slot arrives, and never catches up in a burst.** The clock lives in
  `<profile>/.dsh-integration/unlock-schedule.json`. Time skipped by sleep, lid-close or quitting DSH is
  not replayed slot by slot — the next start notices the slot has passed, sweeps once, and continues on
  the cadence. Only the switch, cadence and scope are writable from the page; "last run", "next run" and
  the last outcome are host-owned and any stale value posted back is ignored.
- **Same unlock path as the button**: it calls the very same `unlockProviderThinking` (same identity
  check, same `onlyWorkbuddy` scope, same byte-range rewrite and pre-write backup) and goes through the
  same serial queue, so the timer and the button can never write the file at the same time. The scope
  switch defaults to WorkBuddy gateways only.
- **Only while DSH runs**: no resident daemon, no OS-level schedule — no cron, no launchd, no autostart.
  Quitting DSH stops it.
- **Failures do not break the cadence**: an unreachable gateway is recorded in `lastError` and
  `lastResult.failedProviders`, the others still unlock, and the next slot retries. When nothing is out
  of date, not a single byte is written.
- **"Run once now"** does not wait for the slot. It reuses the same route, still writes and still records
  the run, but never flips a disabled switch back on.
- The page shows the next/last run time and the last outcome (models updated / no change / failing
  gateways).
- A restart is still required for the written levels to reach the model picker.

**What this page does not do**

- **It never adds, edits or deletes a provider, and never writes a secret.** Provider add/edit lives in
  "Add / edit a gateway" below. This page's routes are `GET /provider/list` (read-only state),
  `POST /provider/unlock` (the unlock write), `GET|POST /provider/schedule` plus
  `POST /provider/schedule/run` (read/write the cadence, run once now), and
  `POST /providers/models/sync-preview` / `POST /providers/models/sync-apply` (preview and write the
  model list).
- When nothing is out of date and the list has no diff, no write happens at all.

Restart DSH for the new levels to reach the model picker; before restarting you can check each model
with `de_models`.

### Add / edit a gateway

The "Add gateway" button at the top: fill in `id` / `baseURL` / `apiKeyEnv` / key → "Test and pull
models" → tick the models to expose → save. A backup is taken first; the key goes into
`$DSH_HOME/.credentials.yaml`'s `refs:`, never into `cordis.patch.yml`.

Existing gateways can be edited (address, key, model set), but the **`id` is fixed once created** and
the page offers **no delete**: a stray click cannot make a gateway disappear. To really remove one,
edit `cordis.patch.yml` by hand or restore the pre-write backup.

## Security boundary

The host side registers a single loopback HTTP route, `/api/dsh-integration`:

- **Host validation**: only loopback hosts and hosts matching the `webApp` / `webServer` advertised
  origin are accepted (older DSH falls back to `webRuntime.trustedHosts`); a
  mismatched `Origin`/`Host` is rejected with 403, and `Sec-Fetch-Site: cross-site` is rejected with
  403 (preventing web pages from hitting the local API cross-site).
- **Write credentials**: every non-GET request must carry `x-dsh-integration: 1` and
  `application/json`, otherwise 403/415.
- **Path fences**: skill directories allow only single-level kebab-case names; backup file names are
  whitelist-matched; symbolic links are not followed out of the sandbox.
- **Serialization**: all writes go through one Promise queue so concurrent writes cannot corrupt the
  patch.
- No credentials are written by the plugin: putting plaintext secrets into `env`/`headers` remains the
  user's own choice; the README recommends `!!js process.env.X`.

## Development

> Upstream keeps sources in `src/`, builds them to `lib/` with esbuild and ships a `test/` suite.
> **This fork keeps only the build output**: there is no `src/`, `scripts/` or `test/`. Editing the
> code means editing `lib/`. The upstream test list below is kept for reference.

```bash
# "Building" in this fork = editing these two files:
#   lib/index.js    server ESM (routes, patch read/write, provider / thinking-unlock logic)
#   lib/client.js   React client bundle (minified; Chinese is \uXXXX-escaped, decode before grepping)
node --check lib/index.js       # syntax check (package.json type=module => parsed as ESM)
node --check lib/client.js
```

- `test/core.test.js`: managed-block generation/replacement/idempotency, `!!js` tag round-trips, the
  empty `[]` placeholder, server validation, skill CRUD (including `../` escape rejection), persona
  backup rotation and reading.
- `test/host.test.js`: starts a **real HTTP server against the built output** and covers the 11 routes
  plus the three security fences.
- `test/client.test.js`: loads the client bundle the way `window.__ModuleLoader__.load` really does and
  asserts the three `settings.section` registrations (including the no-locale-service case and the
  locale-throws case).
- `test/client-render.test.js`: uses real React plus `react-dom/server` to replicate the shell's React
  seed with its `as()` semantics, asserting the page renders non-empty DOM.
- `test/client-hooks.test.js`: white-box regression for hook order and seat hooks (see the section
  above).
- `test/providers.test.js`: gateway judging (`judgeProvider`) and `/models` probing, the `unlockPlan`
  pure function, unlock writes and backups, `dryRun` leaving the file alone, skipped non-gateways and
  missing credentials, and the `"off"`-quoting / `false` round trip.

Debug helper: run `localStorage.dsiDebug = '1'` in the browser console and reload to **print the seat
share prop names once** (silent by default, so normal users' consoles stay clean).

Reference implementation: `@michengai/dsh-skills-manager` (the `settings.section` slot plus the
esbuild banner/footer packaging style). The slot contract lives in
`@deepseek-ai/dsh-client-ui-settings`'s `slots.d.ts`: `settings.section` =
`{ kind: 'list', scope: 'root', owner: { close } }`, and the registrant supplies `id` / `order` /
`label`.

## Known limitations

- **Global scope only**: `settings.section` is a root-scope slot and has no session context (see "The
  seat pitfall" above), so the Skills page lists global skill directories only and the Persona page
  edits `$DSH_HOME/AGENTS.md` only; project-level skill directories and a project-level `AGENTS.md`
  can only appear in an in-session surface. The page titles say so. The host-side `/state?session=<id>`
  endpoint and the `x-dsh-integration-session` header are already reserved for a future in-session
  slot.
- Profile patch changes are read by the loader **at startup**; a stock desktop profile has no HMR
  bundle, so MCP changes need a DSH restart (the page tells you). Skill and persona changes apply
  immediately.
- The MCP page cannot edit the `reconnect` sub-object or MCP prompt templates yet (the former keeps
  its original value; the latter is not supported by DSH).
- No icon is registered: the `settings.section` owner props only define `id`/`order`/`label`, and the
  shell provides a fallback icon.

## License

[MIT](LICENSE) © 2026 2384418321
