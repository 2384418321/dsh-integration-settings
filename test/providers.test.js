import assert from 'node:assert/strict'
import test from 'node:test'
import YAML from 'yaml'
import {
  buildEffortMap,
  judgeProvider,
  mergeProviderIntoPatch,
  normalizeBaseURL,
  normalizeGatewayModel,
  paths,
  probeGateway,
  readCredentialNames,
  readCredentialValue,
  readProviderState,
  readProvidersFromPatch,
  unlockPlan,
  unlockProviderThinking,
} from '../src/core.js'

/* -------------------------------------------------------------- fixtures */

const GATEWAY_ROW = {
  id: 'cn:deepseek-v4.1-flash',
  object: 'model',
  name: 'Deepseek-V4.1-Flash',
  owned_by: 'workbudy',
  context_length: 1000000,
  max_output_tokens: 393216,
  supports_images: true,
  supports_reasoning: true,
  supports_tool_call: true,
  only_reasoning: true,
  can_disable_thinking: true,
  reasoning_default_effort: 'high',
  reasoning_summary: 'auto',
  reasoning_supported_efforts: ['low', 'high', 'max'],
}

// Mirrors the real profile patch: comments, a managed block and a cordis-only
// `!!js` tag that must survive a rewrite untouched.
const PATCH_FIXTURE = `# profile patch
- id: agent-default-model
  config:
    provider: workbudy
    model: cn:deepseek-v4.1-flash
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      workbudy:
        apiKeyEnv: WORKBUDY_API_KEY
        api: openai-completions
        baseURL: https://api.workbuddy.example/v1
        models:
          - id: cn:auto
            name: Auto
            contextWindow: 256000
            maxTokens: 32000
            input:
              - text
              - image
  insert:
    - id: mcp-1
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        command: !!js process.env.MCP_BIN
`

const CREDENTIALS_FIXTURE = `version: 1
records:
  deepseek-account-platform/default:
    access: secret-access
    refresh: secret-refresh
refs:
  WORKBUDY_API_KEY: sk-existing
`

/* ---------------------------------------------------------------- helpers */

test('normalizeBaseURL trims trailing slashes and rejects junk', () => {
  assert.equal(normalizeBaseURL('http://192.168.2.202:7863/v1'), 'http://192.168.2.202:7863/v1')
  assert.equal(normalizeBaseURL('  http://192.168.2.202:7863/v1///  '), 'http://192.168.2.202:7863/v1')
  assert.throws(() => normalizeBaseURL(''), /不能为空/)
  assert.throws(() => normalizeBaseURL('not a url'), /不是合法 URL/)
  assert.throws(() => normalizeBaseURL('ftp://host/v1'), /http \/ https/)
})

test('buildEffortMap only declares what the gateway accepts, off carries no value', () => {
  assert.deepEqual(buildEffortMap(['low', 'high', 'max']), { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(buildEffortMap(['off', 'low', 'high', 'max']), {
    off: null,
    low: 'low',
    high: 'high',
    max: 'max',
  })
  // unknown / non-pi-ai level ids are dropped instead of being pinned to null
  assert.deepEqual(buildEffortMap(['low', 'turbo']), { low: 'low' })
  assert.equal(buildEffortMap([]), null)
})

test('normalizeGatewayModel maps a real gateway row', () => {
  const model = normalizeGatewayModel(GATEWAY_ROW)
  assert.equal(model.id, 'cn:deepseek-v4.1-flash')
  assert.equal(model.name, 'Deepseek-V4.1-Flash')
  assert.equal(model.contextWindow, 1000000)
  assert.equal(model.maxTokens, 393216)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.deepEqual(model.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })
  assert.equal(model.reasoning, 'high')
})

test('normalizeGatewayModel degrades gracefully', () => {
  assert.equal(normalizeGatewayModel({}), null)
  const textOnly = normalizeGatewayModel({ id: 'x', supports_images: false })
  assert.deepEqual(textOnly.input, ['text'])
  assert.equal(textOnly.reasoningEfforts, undefined)
  // a default effort the gateway does not actually list must not be declared
  const odd = normalizeGatewayModel({ ...GATEWAY_ROW, reasoning_default_effort: 'medium' })
  assert.equal(odd.reasoning, undefined)
})

/* ----------------------------------------------------------------- probe */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('probeGateway sends the bearer token and normalizes the model list', async () => {
  let seen = null
  const result = await probeGateway(
    { baseURL: 'http://192.168.2.202:7863/v1/', apiKey: 'sk-test' },
    async (url, init) => {
      seen = { url, auth: init.headers.authorization }
      return jsonResponse({ object: 'list', data: [GATEWAY_ROW, { id: 'cn:glm-5.3', name: 'GLM-5.3' }] })
    },
  )
  assert.equal(seen.url, 'http://192.168.2.202:7863/v1/models')
  assert.equal(seen.auth, 'Bearer sk-test')
  assert.equal(result.baseURL, 'http://192.168.2.202:7863/v1')
  assert.equal(result.models.length, 2)
  assert.equal(result.models[1].name, 'GLM-5.3')
})

test('probeGateway reports auth failures, non-JSON and empty catalogs', async () => {
  await assert.rejects(
    probeGateway({ baseURL: 'http://h/v1', apiKey: 'bad' }, async () => jsonResponse({}, 401)),
    /HTTP 401（API Key 可能不正确）/,
  )
  await assert.rejects(
    probeGateway({ baseURL: 'http://h/v1' }, async () => new Response('<html>', { status: 200 })),
    /不是 JSON/,
  )
  await assert.rejects(
    probeGateway({ baseURL: 'http://h/v1' }, async () => jsonResponse({ data: [] })),
    /没有返回任何可用模型/,
  )
  await assert.rejects(
    probeGateway({ baseURL: 'http://h/v1' }, async () => {
      throw new Error('ECONNREFUSED')
    }),
    /连接网关失败：ECONNREFUSED/,
  )
})

/* --------------------------------------------------------- patch surgery */

test('mergeProviderIntoPatch adds a provider with a quoted "off" key', () => {
  const next = mergeProviderIntoPatch(PATCH_FIXTURE, 'workbudy-lan', {
    apiKeyEnv: 'WORKBUDY_LAN_API_KEY',
    api: 'openai-completions',
    baseURL: 'http://192.168.2.202:7863/v1',
    reasoning: 'high',
    models: [normalizeGatewayModel(GATEWAY_ROW)],
  })
  assert.match(next, /^# profile patch/m, 'leading comment kept')
  assert.match(next, /command: !!js process\.env\.MCP_BIN/, 'cordis-only !!js tag kept')
  assert.match(next, /workbudy-lan:/)
  assert.match(next, /apiKeyEnv: WORKBUDY_LAN_API_KEY/)
  assert.match(next, /reasoning: high/)
  // the load-bearing bit: a bare `off:` would be read as boolean false by YAML 1.1
  assert.match(next, /"off":/)
  assert.doesNotMatch(next, /^\s+off:\s*$/m)

  const parsed = readProvidersFromPatch(next)
  assert.deepEqual(Object.keys(parsed.providers).sort(), ['workbudy', 'workbudy-lan'])
  assert.equal(parsed.providers.workbudy.baseURL, 'https://api.workbuddy.example/v1')
  assert.deepEqual(parsed.providers['workbudy-lan'].models[0].reasoningEfforts, {
    off: null,
    low: 'low',
    high: 'high',
    max: 'max',
  })
  // existing entries are untouched
  assert.equal(next.indexOf('- id: agent-default-model'), PATCH_FIXTURE.indexOf('- id: agent-default-model'))
})

test('mergeProviderIntoPatch replaces an existing provider in place', () => {
  const once = mergeProviderIntoPatch(PATCH_FIXTURE, 'lan', {
    apiKeyEnv: 'LAN_KEY',
    baseURL: 'http://h/v1',
    models: [{ id: 'a' }],
  })
  const twice = mergeProviderIntoPatch(once, 'lan', {
    apiKeyEnv: 'LAN_KEY',
    baseURL: 'http://h/v2',
    models: [{ id: 'a' }, { id: 'b' }],
  })
  const { providers } = readProvidersFromPatch(twice)
  assert.equal(providers.lan.baseURL, 'http://h/v2')
  assert.equal(providers.lan.models.length, 2)
  assert.equal((twice.match(/^ {6}lan:$/gm) || []).length, 1, 'no duplicate key')
})

test('mergeProviderIntoPatch creates the entry when the profile has none', () => {
  const next = mergeProviderIntoPatch('[]\n', 'lan', {
    apiKeyEnv: 'LAN_KEY',
    baseURL: 'http://h/v1',
    models: [{ id: 'a' }],
  })
  const { entryFound, providers } = readProvidersFromPatch(next)
  assert.equal(entryFound, true)
  assert.deepEqual(Object.keys(providers), ['lan'])
  assert.match(next, /- id: llm-pi-ai/)
  assert.match(next, /name: "@deepseek-ai\/dsh-llm-pi-ai"/)
})

test('mergeProviderIntoPatch refuses to clobber a non-map providers block', () => {
  const broken = "- id: llm-pi-ai\n  config:\n    providers: nope\n"
  assert.throws(() => mergeProviderIntoPatch(broken, 'lan', { apiKeyEnv: 'K', baseURL: 'http://h/v1', models: [{ id: 'a' }] }), /providers 不是映射/)
})

test('a provider mixing `false` and dict effort maps survives a patch round trip', () => {
  // The unlock pass hands the merger models straight from the gateway, so the
  // splice itself has to carry both `reasoningEfforts: false` and a quoted
  // `"off":` key through YAML without rewriting them.
  const config = {
    apiKeyEnv: 'WORKBUDY_LAN_API_KEY',
    api: 'openai-completions',
    baseURL: 'http://192.168.2.202:7863/v1',
    models: [
      { id: 'cn:glm-4.6', name: 'GLM-4.6', contextWindow: 168000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: false },
      { id: 'cn:auto', name: 'Auto', input: ['text'], reasoningEfforts: { off: null, high: 'high' } },
      { id: 'cn:plain', name: 'Plain', input: ['text'] },
    ],
  }
  const next = mergeProviderIntoPatch(PATCH_FIXTURE, 'workbudy-lan', config)
  assert.match(next, /reasoningEfforts: false/)
  assert.match(next, /"off":\n/)
  const back = readProvidersFromPatch(next).providers['workbudy-lan']
  assert.equal(back.models[0].reasoningEfforts, false)
  assert.deepEqual(back.models[1].reasoningEfforts, { off: null, high: 'high' })
  assert.equal(back.models[2].reasoningEfforts, undefined)
  // the untouched provider in the same file keeps its shape
  assert.deepEqual(readProvidersFromPatch(next).providers.workbudy.models[0].id, 'cn:auto')
})

test('editing one provider leaves the other groups byte-identical', () => {
  // `hand` is written the way a person writes it (flow list, quoted scalars,
  // `reasoningEfforts: false` for its non-reasoning model); `mine` is canonical.
  const text = [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      hand:',
    '        apiKeyEnv: HAND_KEY',
    '        api: openai-completions',
    '        baseURL: http://hand/v1',
    '        models:',
    '          - id: a',
    '            name: "A"',
    '            input: [ "text", "image" ]',
    '            reasoningEfforts: false',
    '      mine:',
    '        apiKeyEnv: MINE_KEY',
    '        api: openai-completions',
    '        baseURL: http://mine/v1',
    '        models:',
    '          - id: b',
    '            name: B',
    '            input:',
    '              - text',
    '',
  ].join('\n')
  const out = mergeProviderIntoPatch(text, 'mine', {
    apiKeyEnv: 'MINE_KEY',
    api: 'openai-completions',
    baseURL: 'http://mine/v1',
    models: [{ id: 'b', input: ['text'] }, { id: 'c', input: ['text'] }],
  })
  assert.ok(out.includes('            name: "A"'), 'kept the quoted scalar')
  assert.ok(out.includes('            input: [ "text", "image" ]'), 'kept the flow list')
  assert.ok(out.includes('            reasoningEfforts: false'), 'kept the non-reasoning declaration')
  const back = readProvidersFromPatch(out).providers
  assert.equal(back.hand.models[0].reasoningEfforts, false)
  assert.deepEqual(back.mine.models.map((m) => m.id), ['b', 'c'])
  // the edited group really is rewritten
  assert.ok(out.includes('          - id: c'))
})

test('merging a provider back unchanged rewrites nothing', () => {
  const { providers } = readProvidersFromPatch(PATCH_FIXTURE)
  const out = mergeProviderIntoPatch(PATCH_FIXTURE, 'workbudy', providers.workbudy)
  assert.equal(out, PATCH_FIXTURE)
})

/* --------------------------------------------------- end-to-end file flow */

async function sandbox(t) {
  const fsp = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsi-providers-'))
  const home = path.join(root, '.dsh')
  const profileDir = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(profileDir, { recursive: true })
  await fsp.writeFile(path.join(profileDir, 'cordis.patch.yml'), PATCH_FIXTURE, { mode: 0o600 })
  await fsp.writeFile(path.join(home, '.credentials.yaml'), CREDENTIALS_FIXTURE, { mode: 0o600 })
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  // The harness shell exports DSH_PROFILE_DIR/DSH_HOME for the *live* profile, and
  // resolveProfileDir() honours DSH_PROFILE_DIR before DSH_HOME — so both have to be
  // overwritten explicitly, or every write lands in the real config.
  const env = { ...process.env, DSH_HOME: home, DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'desktop' }
  const resolved = paths(env)
  if (!resolved.profileDir.startsWith(root) || !resolved.credentialsFile.startsWith(root)) {
    throw new Error(`sandbox leaked outside ${root}: ${resolved.profileDir} / ${resolved.credentialsFile}`)
  }
  return { fsp, home, profileDir, env, resolved }
}

test('sandbox resolves inside the temp dir, never the live profile', async (t) => {
  const { resolved, profileDir, home } = await sandbox(t)
  assert.equal(resolved.profileDir, profileDir)
  assert.equal(resolved.credentialsFile, `${home}/.credentials.yaml`)
  assert.ok(resolved.patchFile.startsWith(profileDir))
})

/* ------------------------------------------------------- thinking unlock */

const UNLOCK_PATCH = `# profile patch
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      locked:
        apiKeyEnv: LOCKED_KEY
        api: openai-completions
        baseURL: https://locked.example/v1
        models:
          - id: m-reason
            name: Reasoner
            contextWindow: 1000000
            maxTokens: 393216
            input:
              - text
              - image
          - id: m-plain
            name: Plain
            reasoningEfforts: false
            contextWindow: 128000
            maxTokens: 8192
            input:
              - text
      quiet:
        apiKeyEnv: QUIET_KEY
        baseURL: https://quiet.example/v1
        models:
          - id: m-quiet
            name: Quiet
            reasoningEfforts:
              "off":
              high: high
            contextWindow: 64000
            maxTokens: 4096
            input:
              - text
- id: mcp-shared
  config:
    servers: []
`

const UNLOCK_CREDENTIALS = `version: 1
records:
  keep-me: untouched
refs:
  LOCKED_KEY: sk-locked
  QUIET_KEY: sk-quiet
`

const REASON_LEVELS = { off: null, low: 'low', high: 'high', max: 'max' }

function stubFetch(table) {
  const seen = []
  const impl = async (url, init) => {
    seen.push({ url: String(url), authorization: init?.headers?.authorization })
    return { ok: true, status: 200, json: async () => ({ data: table[String(url)] || [] }) }
  }
  impl.seen = seen
  return impl
}

async function unlockSandbox(t) {
  const base = await sandbox(t)
  await base.fsp.writeFile(base.resolved.patchFile, UNLOCK_PATCH, { mode: 0o600 })
  await base.fsp.writeFile(base.resolved.credentialsFile, UNLOCK_CREDENTIALS, { mode: 0o600 })
  return base
}

test('readCredentialValue reads one ref without disturbing the rest', () => {
  assert.equal(readCredentialValue(UNLOCK_CREDENTIALS, 'LOCKED_KEY'), 'sk-locked')
  assert.equal(readCredentialValue(UNLOCK_CREDENTIALS, 'NOPE'), '')
  assert.equal(readCredentialValue('version: 1\n', 'LOCKED_KEY'), '')
})

test('unlockPlan unlocks only what the gateway advertises', () => {
  const configured = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', reasoningEfforts: false },
    { id: 'c', name: 'C', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
    { id: 'd', name: 'D' },
    { id: 'e', name: 'E', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
  ]
  const gateway = [
    { id: 'a', reasoningEfforts: REASON_LEVELS, reasoning: 'high' },
    // silent rows must never be locked down to `false`
    { id: 'b', name: 'B' },
    // same declaration, different key order: not a change
    { id: 'c', reasoningEfforts: { max: 'max', high: 'high', low: 'low', off: null } },
    // the gateway is the truth: levels it does not accept are dropped, and counted
    { id: 'e', reasoningEfforts: { medium: 'medium' } },
  ]
  const { models, report } = unlockPlan(configured, gateway)
  assert.deepEqual(models[0].reasoningEfforts, REASON_LEVELS)
  assert.equal(models[0].reasoning, 'high')
  assert.equal(models[1].reasoningEfforts, false)
  assert.deepEqual(models[2].reasoningEfforts, REASON_LEVELS)
  assert.equal(models[3].reasoningEfforts, undefined)
  assert.deepEqual(models[4].reasoningEfforts, { medium: 'medium' })
  assert.deepEqual(
    { scanned: report.scanned, unlocked: report.unlocked, already: report.already, silent: report.silent, gone: report.gone, narrowed: report.narrowed },
    { scanned: 5, unlocked: 2, already: 1, silent: 1, gone: 1, narrowed: 1 },
  )
  const narrowedRow = report.details.find((d) => d.id === 'e')
  assert.deepEqual(narrowedRow.from, ['off', 'low', 'high', 'max'])
  assert.deepEqual(narrowedRow.to, ['medium'])
  assert.deepEqual(narrowedRow.lost, ['off', 'low', 'high', 'max'])
  assert.deepEqual(report.details.find((d) => d.id === 'a').lost, [])
})

test('unlockProviderThinking dry run reports the gap without writing', async (t) => {
  const { fsp, resolved, env } = await unlockSandbox(t)
  const before = await fsp.readFile(resolved.patchFile, 'utf8')
  const fetchImpl = stubFetch({
    'https://locked.example/v1/models': [
      { id: 'm-reason', supports_reasoning: true, reasoning_supported_efforts: ['low', 'high', 'max'], can_disable_thinking: true },
      { id: 'm-plain' },
    ],
    'https://quiet.example/v1/models': [
      { id: 'm-quiet', supports_reasoning: true, reasoning_supported_efforts: ['high'], can_disable_thinking: true },
    ],
  })
  const report = await unlockProviderThinking(env, { dryRun: true, fetchImpl })
  assert.equal(report.dryRun, true)
  assert.equal(report.changed, false)
  assert.equal(report.unlockedModels, 1)
  assert.deepEqual(report.unlockedProviders, ['locked'])
  assert.equal(report.providers.find((r) => r.id === 'locked').status, 'pending')
  assert.equal(report.providers.find((r) => r.id === 'quiet').status, 'current')
  assert.equal(await fsp.readFile(resolved.patchFile, 'utf8'), before)
  // the probe authenticated with the ref from .credentials.yaml
  assert.deepEqual(fetchImpl.seen.map((c) => c.authorization), ['Bearer sk-locked', 'Bearer sk-quiet'])
})

test('unlockProviderThinking writes levels, keeps silent models and other providers intact', async (t) => {
  const { fsp, resolved, env } = await unlockSandbox(t)
  const before = await fsp.readFile(resolved.patchFile, 'utf8')
  const quietBefore = before.slice(before.indexOf('      quiet:'), before.indexOf('- id: mcp-shared'))
  const fetchImpl = stubFetch({
    'https://locked.example/v1/models': [
      { id: 'm-reason', supports_reasoning: true, reasoning_supported_efforts: ['low', 'high', 'max'], can_disable_thinking: true, reasoning_default_effort: 'high' },
      { id: 'm-plain' },
    ],
    'https://quiet.example/v1/models': [
      { id: 'm-quiet', supports_reasoning: true, reasoning_supported_efforts: ['high'], can_disable_thinking: true },
    ],
  })
  const report = await unlockProviderThinking(env, { fetchImpl })
  assert.equal(report.changed, true)
  assert.equal(report.unlockedModels, 1)

  const after = await fsp.readFile(resolved.patchFile, 'utf8')
  const parsed = YAML.parse(after)
  const providers = parsed.find((entry) => entry.id === 'llm-pi-ai').config.providers
  assert.deepEqual(providers.locked.models[0].reasoningEfforts, REASON_LEVELS)
  assert.equal(providers.locked.models[0].reasoning, 'high')
  // a model the gateway says nothing about keeps its explicit declaration
  assert.equal(providers.locked.models[1].reasoningEfforts, false)
  // untouched groups stay byte-for-byte identical
  assert.equal(after.slice(after.indexOf('      quiet:'), after.indexOf('- id: mcp-shared')), quietBefore)
  assert.equal(YAML.parse(after).find((entry) => entry.id === 'mcp-shared').config.servers.length, 0)
  // a backup was taken before the write
  const backups = (await fsp.readdir(resolved.profileDir)).filter((f) => f.includes('cordis.patch.yml.bak'))
  assert.ok(backups.length >= 1, `expected a backup, got ${backups.join(',')}`)

  // second pass is a no-op: nothing changed, so the file is not rewritten
  const settled = await unlockProviderThinking(env, { fetchImpl })
  assert.equal(settled.changed, false)
  assert.equal(settled.unlockedModels, 0)
  assert.equal(await fsp.readFile(resolved.patchFile, 'utf8'), after)
})

test('unlockProviderThinking reports a failing gateway without skipping the others', async (t) => {
  const { fsp, resolved, env } = await unlockSandbox(t)
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://locked.example')) {
      throw new Error('ECONNREFUSED')
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'm-quiet', supports_reasoning: true, reasoning_supported_efforts: ['high'], can_disable_thinking: true }] }),
    }
  }
  const report = await unlockProviderThinking(env, { fetchImpl })
  const locked = report.providers.find((r) => r.id === 'locked')
  const quiet = report.providers.find((r) => r.id === 'quiet')
  assert.equal(locked.status, 'error')
  assert.match(locked.error, /连接网关失败/)
  assert.equal(quiet.status, 'current')
  assert.equal(report.changed, false)
  const after = await fsp.readFile(resolved.patchFile, 'utf8')
  assert.ok(after.startsWith('# profile patch'))
})

test('unlockProviderThinking refuses a patch without the llm-pi-ai entry', async (t) => {
  const { fsp, resolved, env } = await unlockSandbox(t)
  await fsp.writeFile(resolved.patchFile, '# nothing here\n- id: ui-chat\n', { mode: 0o600 })
  await assert.rejects(() => unlockProviderThinking(env, { fetchImpl: stubFetch({}) }), /没有 - id: llm-pi-ai 条目/)
})

/* --------------------------------------------------- gateway detection */

test('judgeProvider only claims providers that really are gateways', () => {
  const creds = { credentialNames: ['LAN_KEY'], env: {} }
  const ok = judgeProvider({ apiKeyEnv: 'LAN_KEY', baseURL: 'http://g.example:7863/v1' }, creds)
  assert.equal(ok.verdict, 'gateway')
  assert.match(ok.reason, /OpenAI 兼容网关/)
  assert.equal(judgeProvider({ apiKeyEnv: 'LAN_KEY', api: 'anthropic-messages', baseURL: 'http://g/v1' }, creds).verdict, 'skipped')
  assert.match(judgeProvider({ apiKeyEnv: 'LAN_KEY', api: 'anthropic-messages', baseURL: 'http://g/v1' }, creds).reason, /anthropic-messages/)
  assert.equal(judgeProvider({ apiKeyEnv: 'LAN_KEY' }, creds).verdict, 'skipped')
  assert.equal(judgeProvider({ apiKeyEnv: 'LAN_KEY', baseURL: 'not a url' }, creds).verdict, 'skipped')
  assert.equal(judgeProvider({ apiKeyEnv: 'LAN_KEY', baseURL: 'ftp://g/v1' }, creds).verdict, 'skipped')
  const noKey = judgeProvider({ apiKeyEnv: 'MISSING_KEY', baseURL: 'http://g/v1' }, creds)
  assert.equal(noKey.verdict, 'skipped')
  assert.match(noKey.reason, /MISSING_KEY/)
  // no apiKeyEnv at all is fine, and the process environment counts as a source
  assert.equal(judgeProvider({ baseURL: 'http://g/v1' }, creds).verdict, 'gateway')
  assert.equal(judgeProvider({ apiKeyEnv: 'ENV_KEY', baseURL: 'http://g/v1' }, { credentialNames: [], env: { ENV_KEY: 'x' } }).verdict, 'gateway')
})

test('unlockProviderThinking skips a non-gateway provider without probing it', async (t) => {
  const { fsp, resolved, env } = await unlockSandbox(t)
  const patched = UNLOCK_PATCH.replace('      quiet:\n', '      quiet:\n        api: anthropic-messages\n')
  assert.notEqual(patched, UNLOCK_PATCH)
  await fsp.writeFile(resolved.patchFile, patched, { mode: 0o600 })
  const fetchImpl = stubFetch({ 'https://locked.example/v1/models': [{ id: 'm-reason' }] })
  const report = await unlockProviderThinking(env, { dryRun: true, fetchImpl })
  const quiet = report.providers.find((r) => r.id === 'quiet')
  assert.equal(quiet.verdict, 'skipped')
  assert.equal(quiet.status, 'skipped')
  assert.match(quiet.reason, /anthropic-messages/)
  assert.deepEqual(report.gatewayProviders, ['locked'])
  assert.deepEqual(report.skippedProviders, ['quiet'])
  assert.equal(fetchImpl.seen.length, 1)
})

test('unlockProviderThinking reports a gateway whose credential is missing instead of failing', async (t) => {
  const { fsp, resolved, env } = await unlockSandbox(t)
  await fsp.writeFile(resolved.credentialsFile, 'version: 1\nrefs:\n  QUIET_KEY: sk-quiet\n', { mode: 0o600 })
  const fetchImpl = stubFetch({ 'https://quiet.example/v1/models': [{ id: 'm-quiet' }] })
  const report = await unlockProviderThinking(env, { dryRun: true, fetchImpl })
  const locked = report.providers.find((r) => r.id === 'locked')
  assert.equal(locked.verdict, 'skipped')
  assert.match(locked.reason, /LOCKED_KEY/)
  assert.deepEqual(report.gatewayProviders, ['quiet'])
  assert.equal(fetchImpl.seen.length, 1)
})
