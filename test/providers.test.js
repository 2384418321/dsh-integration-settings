import assert from 'node:assert/strict'
import test from 'node:test'
import YAML from 'yaml'
import {
  buildEffortMap,
  deleteProvider,
  mergeCredentialRef,
  mergeProviderIntoPatch,
  normalizeBaseURL,
  normalizeGatewayModel,
  paths,
  probeGateway,
  readCredentialNames,
  readProviderState,
  readProvidersFromPatch,
  removeCredentialRef,
  removeProviderFromPatch,
  renderProviderConfig,
  saveProvider,
  validateModel,
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

test('removeProviderFromPatch drops exactly one provider', () => {
  const withLan = mergeProviderIntoPatch(PATCH_FIXTURE, 'lan', {
    apiKeyEnv: 'LAN_KEY',
    baseURL: 'http://h/v1',
    models: [{ id: 'a' }],
  })
  const back = removeProviderFromPatch(withLan, 'lan')
  assert.deepEqual(Object.keys(readProvidersFromPatch(back).providers), ['workbudy'])
  assert.throws(() => removeProviderFromPatch(back, 'lan'), /未找到供应商：lan/)
})

/* ------------------------------------------------------------ validation */

test('validateModel normalizes effort maps and rejects an empty id', () => {
  const model = validateModel({ id: ' m ', name: '', input: ['image', 'bogus'], reasoningEfforts: { off: null, high: 'high' } })
  assert.deepEqual(model, { id: 'm', name: 'm', input: ['image'], reasoningEfforts: { off: null, high: 'high' } })
  assert.throws(() => validateModel({ id: '  ' }), /模型 id 不能为空/)
})

test('validateModel keeps every declared effort level, including `false`', () => {
  // `false` is the documented spelling for "this model does not reason": it is a
  // declaration, so a save must not turn it into an absent field.
  assert.equal(validateModel({ id: 'm', reasoningEfforts: false }).reasoningEfforts, false)
  // A declared value is the wire spelling the gateway receives, so rewriting it
  // (e.g. forcing `off` to null) would silently change dispatch behaviour.
  assert.deepEqual(
    validateModel({ id: 'm', reasoningEfforts: { off: 'skip', max: 'ultra' } }).reasoningEfforts,
    { off: 'skip', max: 'ultra' },
  )
  // An unknown level id is preserved rather than silently discarded.
  assert.deepEqual(validateModel({ id: 'm', reasoningEfforts: { turbo: 'turbo' } }).reasoningEfforts, { turbo: 'turbo' })
  assert.equal(validateModel({ id: 'm', reasoningEfforts: {} }).reasoningEfforts, undefined)
})

test('a provider mixing `false` and dict effort maps survives a patch round trip', () => {
  const config = renderProviderConfig({
    apiKeyEnv: 'WORKBUDY_LAN_API_KEY',
    baseURL: 'http://192.168.2.202:7863/v1',
    models: [
      { id: 'cn:glm-4.6', name: 'GLM-4.6', contextWindow: 168000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: false },
      { id: 'cn:auto', name: 'Auto', input: ['text'], reasoningEfforts: { high: 'high' } },
      { id: 'cn:plain', name: 'Plain', input: ['text'] },
    ],
  })
  const next = mergeProviderIntoPatch(PATCH_FIXTURE, 'workbudy-lan', config)
  assert.match(next, /reasoningEfforts: false/)
  const back = readProvidersFromPatch(next).providers['workbudy-lan']
  assert.equal(back.models[0].reasoningEfforts, false)
  assert.deepEqual(back.models[1].reasoningEfforts, { high: 'high' })
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

test('saving a provider unchanged rewrites nothing', () => {
  const { providers } = readProvidersFromPatch(PATCH_FIXTURE)
  const out = mergeProviderIntoPatch(PATCH_FIXTURE, 'workbudy', renderProviderConfig(providers.workbudy))
  assert.equal(out, PATCH_FIXTURE)
})

test('renderProviderConfig enforces the env name and model count', () => {
  const provider = renderProviderConfig({ apiKeyEnv: 'LAN_KEY', baseURL: 'http://h/v1', models: [{ id: 'a' }] })
  assert.equal(provider.api, 'openai-completions')
  assert.throws(() => renderProviderConfig({ apiKeyEnv: 'lower', baseURL: 'http://h/v1', models: [{ id: 'a' }] }), /全大写/)
  assert.throws(() => renderProviderConfig({ apiKeyEnv: 'LAN_KEY', baseURL: 'http://h/v1', models: [] }), /至少需要保留一个模型/)
  assert.throws(() => renderProviderConfig({ apiKeyEnv: 'LAN_KEY', baseURL: 'http://h/v1', reasoning: 'turbo', models: [{ id: 'a' }] }), /未知的默认思考档位/)
})

/* ----------------------------------------------------------- credentials */

test('mergeCredentialRef only touches refs and keeps records intact', () => {
  const next = mergeCredentialRef(CREDENTIALS_FIXTURE, 'WORKBUDY_LAN_API_KEY', 'sk-a30IaMiBgZhyAeVMeAIPBM1m1')
  const parsed = YAML.parse(next)
  assert.equal(parsed.version, 1)
  assert.deepEqual(parsed.records['deepseek-account-platform/default'], {
    access: 'secret-access',
    refresh: 'secret-refresh',
  })
  assert.equal(parsed.refs.WORKBUDY_API_KEY, 'sk-existing')
  assert.equal(parsed.refs.WORKBUDY_LAN_API_KEY, 'sk-a30IaMiBgZhyAeVMeAIPBM1m1')
  assert.deepEqual(readCredentialNames(next), ['WORKBUDY_API_KEY', 'WORKBUDY_LAN_API_KEY'])
})

test('mergeCredentialRef can create the refs block from scratch', () => {
  const next = mergeCredentialRef('version: 1\n', 'LAN_KEY', 'sk-x')
  assert.deepEqual(YAML.parse(next), { version: 1, refs: { LAN_KEY: 'sk-x' } })
  assert.throws(() => mergeCredentialRef(CREDENTIALS_FIXTURE, 'LAN_KEY', '  '), /API Key 不能为空/)
  assert.throws(() => mergeCredentialRef('refs: nope\n', 'LAN_KEY', 'sk-x'), /refs 不是映射/)
})

test('removeCredentialRef is a no-op when the ref is absent', () => {
  const removed = removeCredentialRef(CREDENTIALS_FIXTURE, 'WORKBUDY_API_KEY')
  assert.deepEqual(YAML.parse(removed).refs, {})
  assert.equal(removeCredentialRef(CREDENTIALS_FIXTURE, 'NOT_THERE'), null)
  assert.equal(removeCredentialRef('version: 1\n', 'NOT_THERE'), null)
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

test('saveProvider writes patch + credentials and backs both up', async (t) => {
  const { fsp, home, profileDir, env } = await sandbox(t)
  const result = await saveProvider(env, {
    providerId: 'workbudy-lan',
    provider: {
      apiKeyEnv: 'WORKBUDY_LAN_API_KEY',
      baseURL: 'http://192.168.2.202:7863/v1',
      reasoning: 'high',
      models: [normalizeGatewayModel(GATEWAY_ROW)],
    },
    apiKey: 'sk-a30IaMiBgZhyAeVMeAIPBM1m1',
  })
  assert.equal(result.modelCount, 1)
  assert.equal(result.credentialsWritten, true)

  const state = await readProviderState(env)
  const lan = state.providers.find((p) => p.id === 'workbudy-lan')
  assert.equal(lan.hasCredential, true)
  assert.equal(lan.apiKeyEnv, 'WORKBUDY_LAN_API_KEY')
  assert.equal(state.entryFound, true)

  // `off` is emitted without a value, and the key stays quoted
  const patch = await fsp.readFile(`${profileDir}/cordis.patch.yml`, 'utf8')
  assert.match(patch, /"off":\n/)
  assert.doesNotMatch(patch, /"off": null/)
  assert.match(patch, /command: !!js process\.env\.MCP_BIN/)

  const files = await fsp.readdir(profileDir)
  assert.ok(files.some((n) => n.startsWith('cordis.patch.yml.bak-')), 'patch backup written')
  const homeFiles = await fsp.readdir(home)
  assert.ok(homeFiles.some((n) => n.startsWith('.credentials.yaml.bak-')), 'credentials backup written')
})

test('saveProvider without a key keeps the existing ref untouched', async (t) => {
  const { env } = await sandbox(t)
  await saveProvider(env, {
    providerId: 'lan',
    provider: { apiKeyEnv: 'WORKBUDY_API_KEY', baseURL: 'http://h/v1', models: [{ id: 'a' }] },
  })
  const state = await readProviderState(env)
  assert.deepEqual(state.credentialNames, ['WORKBUDY_API_KEY'])
  assert.equal(state.providers.find((p) => p.id === 'lan').hasCredential, true)
})

test('deleteProvider can drop the credential it owned', async (t) => {
  const { env } = await sandbox(t)
  await saveProvider(env, {
    providerId: 'lan',
    provider: { apiKeyEnv: 'LAN_KEY', baseURL: 'http://h/v1', models: [{ id: 'a' }] },
    apiKey: 'sk-lan',
  })
  const gone = await deleteProvider(env, { providerId: 'lan', dropCredential: true })
  assert.equal(gone.credentialRemoved, true)
  const state = await readProviderState(env)
  assert.deepEqual(state.providers.map((p) => p.id), ['workbudy'])
  assert.deepEqual(state.credentialNames, ['WORKBUDY_API_KEY'])
})

test('deleteProvider keeps a ref that another provider still uses', async (t) => {
  const { env } = await sandbox(t)
  await saveProvider(env, {
    providerId: 'twin',
    provider: { apiKeyEnv: 'WORKBUDY_API_KEY', baseURL: 'http://h/v1', models: [{ id: 'a' }] },
  })
  const gone = await deleteProvider(env, { providerId: 'twin', dropCredential: true })
  assert.equal(gone.credentialInUse, true)
  assert.equal(gone.credentialRemoved, false)
  assert.deepEqual((await readProviderState(env)).credentialNames, ['WORKBUDY_API_KEY'])
})

test('saveProvider renames a provider without leaving a duplicate key', async (t) => {
  const { env } = await sandbox(t)
  await saveProvider(env, {
    providerId: 'old-name',
    provider: { apiKeyEnv: 'LAN_KEY', baseURL: 'http://h/v1', models: [{ id: 'a' }] },
  })
  await saveProvider(env, {
    providerId: 'new-name',
    previousId: 'old-name',
    provider: { apiKeyEnv: 'LAN_KEY', baseURL: 'http://h/v2', models: [{ id: 'a' }] },
  })
  const state = await readProviderState(env)
  assert.deepEqual(state.providers.map((p) => p.id).sort(), ['new-name', 'workbudy'])
  assert.equal(state.providers.find((p) => p.id === 'new-name').baseURL, 'http://h/v2')
})
