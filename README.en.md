# dsh-integration-settings

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH supported through 0.2.0-rc.2](https://img.shields.io/badge/DSH-up%20to%200.2.0--rc.2-2563eb.svg)](#requirements)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)](#requirements)

**English** | [简体中文](README.md)

Adds four visual pages to the DeepSeek Harness (DSH) **Settings**. The headline one is **one-click
thinking unlock**: it detects which thinking levels each OpenAI-compatible gateway really supports and
writes them into the model picker. The other three turn things you would otherwise hand-edit in files
into point-and-click operations:

| Settings page | What it manages | Where it writes |
| --- | --- | --- |
| **MCP servers** | add / remove / edit / enable–disable MCP servers | the current profile's `cordis.patch.yml` (managed block) + `.dsh-integration/mcp.json` (source of truth) |
| **Skills** | browse / create / edit / delete skills | DSH global, shared `.agents`, Claude / Codex global directories, plus the current project's `.dsh` / `.agents` / `.claude` directories |
| **Global persona** | visually edit the persona file (the equivalent of Claude Code's `CLAUDE.md`) | `$DSH_HOME/AGENTS.md` (global) and `<project>/AGENTS.md` (current project) |
| **Thinking unlock** | detects each gateway's supported thinking levels on page open and unlocks them in one click; also add / edit / delete OpenAI-compatible gateways and pull model lists | the current profile's `cordis.patch.yml` (the `llm-pi-ai` entry's `config.providers`) + `$DSH_HOME/.credentials.yaml` (`refs`, secrets only) |

> This is a community plugin, not an official DeepSeek product. Evaluate it yourself before
> installing, and consider backing up your profile directory first.

## Requirements

- **DSH desktop 0.2.0-rc.2** (this plugin is built against that version's `settings.section` slot and
  loader patch mechanism; host packages use the `@deepseek-ai/*` names from this version onward).
- **Node.js `^22.19.0 || >=24`** — only needed to build or test locally. **Installing does not need
  Node**, because the built `lib/` output is committed to the repository.
- **A DSH restart is required after installation**: MCP changes are read by the loader at startup
  (skill and persona changes take effect immediately).

## Installation

Pick any one of the three ways below. The examples use the `desktop` profile — **replace it with your
own profile name** (DSH desktop's default profile is `desktop`).

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
pnpm install
node scripts/build.mjs            # only needed after you change src/

DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "$(pwd)"    # a local directory is registered as link:
```

With a `link:` registration, edit `src/`, re-run `node scripts/build.mjs`, then restart DSH — no
reinstall needed.

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

1. After DSH restarts, three entries appear at the bottom of the left column of **Settings**:
   `MCP 管理 / Skill 管理 / 全局人设` (MCP servers / Skills / Global persona).
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
| Installed, but the three pages are missing from Settings | ① Check that this package appears in both `list` and the profile `package.json`'s `dsh.profile.bundles`; ② make sure you restarted the **same** profile; ③ if the bundle failed to load, DSH prints `<bin>: skipping profile bundle "dsh-integration-settings": <reason>` to stderr at startup and skips it silently — the usual causes are editing `src/` without rebuilding (missing `lib/`), too old a Node version, or a dependency resolution failure |
| Clicking a page shows a blank area | `settings.section` is a root-scope slot: calling a seat session hook (`usePanelInfo` etc.) from an entry triggers `Minified React error #311`, and the shell replaces the whole slot with `<div data-slot-error="settings.section"></div>`. When changing client code, keep the rule "root-scope entries never call any seat hook" (see Design notes below) |
| MCP changes do not take effect | The profile patch is read by the loader **at startup**: restart DSH (the page says so too). Skill and persona changes apply immediately |
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

### Thinking unlock (and model providers)
DSH providers live in `@deepseek-ai/dsh-llm-pi-ai`'s `config.providers`, written into each profile's
`cordis.patch.yml`. A declared `reasoningEfforts` dict is a **whitelist**: levels you do not declare
show up greyed out in the model picker, so "can I pick High / Max on this model?" is decided entirely
by those few dozen lines of YAML. This page automates that.

**Auto-detect + one-click unlock**

- **Detected on page open**: the page sends one read-only `GET /models` per configured gateway, reads
  `reasoning_supported_efforts` / `can_disable_thinking` and diffs it against the current config.
  Detection **writes nothing**; the page shows "N to unlock / M already current / K gateway-silent".
- **One click to unlock**: "Unlock all" writes the levels back to `cordis.patch.yml`, with a backup
  first. **The gateway's capability table is the only truth** — if it says a model only supports
  `medium`, only `medium` is declared, and levels your config had on top of that are dropped. Before
  unlocking, the page lists every such model with its `old levels → new levels`.
- **Only the gateways in this entry**: only providers under `- id: llm-pi-ai`'s `config.providers` are
  read or rewritten. DSH's built-in `deepseek-official` / `deepseek-account` do not live in this file.
- **A silent gateway changes nothing**: when the gateway reports no thinking information for a model,
  your existing declaration is kept — the plugin never writes `reasoningEfforts: false` for you, which
  would declare the model non-reasoning.
- **One failing gateway does not block the rest**: it is reported separately, the others still unlock.

**The form (add / edit / delete a gateway)**

- DSH has no built-in way to add a provider: a provider only exists as a `config.providers` entry
  inside `- id: llm-pi-ai`, so this page merges into that existing entry. Adding a second entry with
  the same id makes DSH fail at startup (dedupe with `dev_fix_patch`); when the entry is missing the
  page shows an amber banner.
- Edits go through a YAML **document** (parse → mutate nodes → stringify) instead of
  `parse → JS → stringify`, so comments and the other entries survive untouched.
- **Each provider keeps its own bytes**: saving one provider replaces only that provider's byte range,
  so a hand-written group keeps its layout verbatim — flow lists (`input: [ "text", "image" ]`),
  quoted scalars and `reasoningEfforts: false` (declaring a non-reasoning model) are neither reflowed
  nor dropped. Re-saving a provider unchanged leaves the file byte-identical, and deleting removes only
  that entry's bytes.
- **Secrets never go into the patch**: `apiKeyEnv` is only a reference name; the secret itself is
  written to the `refs:` section of `$DSH_HOME/.credentials.yaml`. The apiKey field is only needed when
  adding a provider or rotating a key — leave it empty to keep the stored secret.
- **`off` must stay quoted** (`"off":`) because YAML 1.1 parses a bare `off:` as boolean `false`, which
  would give the level dict a non-string key.
- Saving, unlocking and deleting all write a `.bak-<timestamp>` backup (3 kept) and both files are
  written `0600`.

Restart DSH for changes to take effect; before restarting you can check each model with `de_models`.

### Which profile is being edited?
Resolution order, preferring evidence over guesses (authoritative → explicit → inferred):

1. the host service `ctx.get('desktopProfiles').current.dir` (in the desktop app this is the profile
   actually in use — the most authoritative source);
2. the `DSH_PROFILE_DIR` environment variable;
3. a `--profile <name>` / `--profile=<name>` argument or the `DSH_PROFILE` environment variable (that
   profile directory must exist);
4. scanning `$DSH_HOME/profiles/*` for the **only** profile that has this plugin in its dependencies;
5. when several candidates remain, `desktop` wins; if it still cannot be determined uniquely the plugin
   reports `ambiguous_profile` and asks you to specify one instead of writing blindly.

The profile badge at the top of the page confirms the current target.

### The seat pitfall in the Settings page (read this before changing the plugin)
`settings.section` is a **root-scope** slot. The shell passes each entry a whole set of seat shares:
`usePanelInfo`, `useSessions`, `useSessionStatus`, `useWorkspaces`, `useResource`,
`useSessionRetainInfo`, `renderFactorySlot`, `t`, `close`.

- **Calling those `use*` functions from a root-scope entry throws** (they belong to session scope).
  If you swallow the exception in a `try/catch`, React's hook chain is already misaligned and the
  **next render** throws `Minified React error #311` at the component's first `useState`; the shell has
  a per-entry error boundary that replaces the whole slot with
  `<div data-slot-error="settings.section"></div>` — what the user sees is "clicked in, blank page".
  So: **root-scope entries must never call any seat hook**, only ordinary props (this plugin's
  `sessionIdOf` merely reads `props.sessionId`).
- Never let the hook call order depend on the shape of props either (props changing on the second
  render → "more/fewer hooks than during the previous render", again a blank page).
- `test/client-hooks.test.js` guards exactly these two rules: it drives the component function with a
  counting version of React and asserts that no seat session hook is ever called and that the hook
  sequence is identical under two different prop sets. Do not work around it when changing the
  component.
- When you need to debug something a single render cannot reveal, `renderToString` will not catch hook
  order changes; instead run `DSI_DEBUG=1 node scripts/build.mjs` to get an **unminified client bundle
  with function names kept and an inline sourcemap**, then open the real GUI in headless Chrome and read
  the console stack (function names such as `McpSection` appear directly in it).

### Skills
A skill is a `SKILL.md` inside a directory, with YAML frontmatter (`name` in kebab-case plus
`description`). Deleting removes the whole directory; the previous `SKILL.md` is backed up before any
write, and directory names are protected against `../` escapes.

### Global persona
DSH's `@deepseek-ai/dsh-agent-instructions` plugin injects a baseline into the first request of every
session: `$DSH_HOME/AGENTS.md` (your persona) plus the project chain (from the project root down to the
session cwd: `AGENTS.md`/`CLAUDE.md` and `AGENTS.local.md`/`CLAUDE.local.md`). This page is an editor
for that global file, and lists the 3 most recent backups for one-click restore.

## Security boundary

The host side registers a single loopback HTTP route, `/api/dsh-integration`:

- **Host validation**: only loopback hosts and hosts in `ctx.webRuntime.trustedHosts` are accepted; a
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

```bash
pnpm install                    # first time
node scripts/build.mjs          # esbuild: src/index.js -> lib/index.js, src/client.jsx -> lib/client.js
DSI_DEBUG=1 node scripts/build.mjs   # debug build: client bundle unminified, names kept, inline sourcemap
node --test test/*.test.js      # 30 tests (the glob is required; node --test test/ treats the dir as a module)
```

- `test/core.test.js`: managed-block generation/replacement/idempotency, `!!js` tag round-trips, the
  empty `[]` placeholder, server validation, skill CRUD (including `../` escape rejection), persona
  backup rotation and reading.
- `test/host.test.js`: starts a **real HTTP server against the built output** and covers the 10 routes
  plus the three security fences.
- `test/client.test.js`: loads the client bundle the way `window.__ModuleLoader__.load` really does and
  asserts the three `settings.section` registrations (including the no-locale-service case and the
  locale-throws case).
- `test/client-render.test.js`: uses real React plus `react-dom/server` to replicate the shell's React
  seed with its `as()` semantics, asserting all three pages render non-empty DOM.
- `test/client-hooks.test.js`: white-box regression for hook order and seat hooks (see the section
  above).

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
