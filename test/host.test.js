// End-to-end test of the built host half: real HTTP against the real route table.
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'

import { apply } from '../lib/index.js'
import { START_MARK, paths } from '../src/core.js'

const SAVED = { ...process.env }

async function startHost() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsi-host-'))
  const home = path.join(root, 'dsh')
  const profile = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(profile, { recursive: true })
  await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-integration-settings'] } } }))
  await fsp.writeFile(path.join(profile, 'cordis.patch.yml'), '- id: ui-settings\n  name: dsh-web-app\n  config:\n    enabled: true\n')
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.HOME = path.join(root, 'home')

  const captured = []
  const disposers = []
  const ctx = {
    effect: (fn) => { const out = fn(); disposers.push(out); return () => { if (typeof out === 'function') out() } },
    webServer: { register: (route) => { captured.push(route); return () => {} } },
    webRuntime: { trustedHosts: [] },
    sessions: { get: (id) => (id === 'sess-1' ? { header: { cwd: path.join(root, 'proj') } } : undefined) },
  }
  apply(ctx)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].kind, 'prefix')

  const server = http.createServer((req, res) => {
    Promise.resolve(captured[0].handler(req, res)).catch(() => { res.statusCode = 500; res.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { root, home, profile, origin, server, stop: () => new Promise((resolve) => server.close(resolve)) }
}

function call(host, route, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const finalHeaders = { ...headers }
  if (payload !== undefined && !raw) {
    finalHeaders['content-type'] = 'application/json'
    if (!finalHeaders['x-dsh-integration']) finalHeaders['x-dsh-integration'] = '1'
  }
  return fetch(host.origin + '/api/dsh-integration' + route, { method, headers: finalHeaders, body: payload })
    .then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }))
}

test('host API: state, MCP lifecycle, fences, skills and persona', async (t) => {
  const host = await startHost()
  t.after(async () => { await host.stop(); process.env = { ...SAVED } })

  // ---- GET /state ---------------------------------------------------------
  let res = await call(host, '/state?session=sess-1')
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.data.session.cwd, path.join(host.root, 'proj'))
  assert.equal(res.json.data.mcp.servers.length, 0)
  assert.ok(res.json.data.paths.patchFile.endsWith('cordis.patch.yml'))

  // ---- protocol fences ----------------------------------------------------
  assert.equal((await call(host, '/mcp/save', { method: 'POST', body: { server: { serverName: 'x', transport: 'stdio', command: 'x' } }, headers: { 'x-dsh-integration': '' }, raw: true })).status, 403)
  assert.equal((await call(host, '/mcp/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: undefined, raw: true })).status, 403)
  assert.equal((await call(host, '/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call(host, '/state', { headers: { origin: 'http://evil.example' } })).status, 403)
  assert.equal((await call(host, '/nope')).status, 404)

  // ---- MCP save / toggle / delete ----------------------------------------
  const server = { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: '!!js process.env.TOKEN' } }
  res = await call(host, '/mcp/save', { method: 'POST', body: { server } })
  assert.equal(res.status, 200)
  assert.equal(res.json.data.servers.length, 1)

  let patch = await fsp.readFile(paths(process.env).patchFile, 'utf8')
  assert.ok(patch.includes(START_MARK))
  assert.ok(patch.includes('mcp-github'))
  assert.ok(patch.includes('!!js process.env.TOKEN'))
  assert.ok(patch.startsWith('- id: ui-settings'), 'pre-existing patch entry untouched')

  res = await call(host, '/state')
  assert.equal(res.json.data.mcp.servers.length, 1)
  assert.equal(res.json.data.mcp.importable.length, 0)

  res = await call(host, '/mcp/save', { method: 'POST', body: { server: { ...server, serverName: 'bad name' } } })
  assert.equal(res.status, 400)

  res = await call(host, '/mcp/toggle', { method: 'POST', body: { serverName: 'github', enabled: false } })
  assert.equal(res.status, 200)
  patch = await fsp.readFile(paths(process.env).patchFile, 'utf8')
  assert.ok(!patch.includes('mcp-github'), 'disabled server removed from the patch')

  res = await call(host, '/mcp/toggle', { method: 'POST', body: { serverName: 'github', enabled: true } })
  assert.equal(res.status, 200)
  patch = await fsp.readFile(paths(process.env).patchFile, 'utf8')
  assert.equal(patch.split(START_MARK).length - 1, 1)

  res = await call(host, '/mcp/delete', { method: 'POST', body: { serverName: 'github' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.data.servers.length, 0)

  // ---- hand-written rows are importable ----------------------------------
  const manual = `${await fsp.readFile(paths(process.env).patchFile, 'utf8')}- id: mcp-manual\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: manual\n    transport: stdio\n    command: uvx\n`
  await fsp.writeFile(paths(process.env).patchFile, manual)
  res = await call(host, '/state')
  assert.equal(res.json.data.mcp.importable.length, 1)
  assert.equal(res.json.data.mcp.importable[0].serverName, 'manual')
  res = await call(host, '/mcp/import', { method: 'POST', body: {} })
  assert.deepEqual(res.json.data.added, ['manual'])

  // ---- skills -------------------------------------------------------------
  res = await call(host, '/state?session=sess-1&root=dsh-global')
  const roots = res.json.data.skills.roots.map((r) => r.id)
  assert.ok(roots.includes('dsh-project'))

  res = await call(host, '/skill/save', { method: 'POST', body: { root: 'dsh-global', dir: 'demo-skill', name: 'demo-skill', description: 'Use when demoing', body: '## 概览\n' } })
  assert.equal(res.status, 200)

  res = await call(host, '/skill/read?root=dsh-global&dir=demo-skill')
  assert.equal(res.json.data.frontmatter.name, 'demo-skill')

  res = await call(host, '/skill/read?root=dsh-global&dir=../../etc')
  assert.equal(res.status, 400)

  res = await call(host, '/skill/save', { method: 'POST', body: { root: 'dsh-global', dir: 'x', name: 'x', description: '' } })
  assert.equal(res.status, 400)

  res = await call(host, '/skill/delete', { method: 'POST', body: { root: 'dsh-global', dir: 'demo-skill' } })
  assert.equal(res.status, 200)

  // ---- persona ------------------------------------------------------------
  res = await call(host, '/persona/save', { method: 'POST', body: { scope: 'global', content: '# 人设 A\n' } })
  assert.equal(res.status, 200)
  res = await call(host, '/persona/save', { method: 'POST', body: { scope: 'global', content: '# 人设 B\n' } })
  assert.equal(res.status, 200)

  res = await call(host, '/state')
  const persona = res.json.data.persona
  assert.equal(persona.files[0].content, '# 人设 B\n')
  assert.equal(persona.backups.length, 1)
  assert.equal(await fsp.readFile(path.join(process.env.DSH_HOME, 'AGENTS.md'), 'utf8'), '# 人设 B\n')

  res = await call(host, `/persona/backup?name=${encodeURIComponent(persona.backups[0].name)}`)
  assert.equal(res.json.data.content, '# 人设 A\n')
  assert.equal((await call(host, '/persona/backup?name=nope')).status, 400)

  res = await call(host, '/persona/save', { method: 'POST', body: { scope: 'global', cwd: host.root, content: '# 再次保存\n' } })
  assert.equal(res.status, 200, 'global scope wins even when a cwd is present')

  // ---- thinking unlock ----------------------------------------------------
  // The page detects gateways and unlocks thinking levels; add and edit are back,
  // delete is deliberately never exposed.
  res = await call(host, '/provider/list')
  assert.equal(res.status, 200)
  assert.equal(res.json.data.entryFound, false, 'this profile has no llm-pi-ai entry yet')

  res = await call(host, '/provider/unlock', { method: 'POST', body: { dryRun: true } })
  assert.equal(res.status, 404)
  assert.match(res.json.error, /llm-pi-ai/)

  // /provider/save exists again (add + edit only) and rejects an empty id.
  res = await call(host, '/provider/save', { method: 'POST', body: { providerId: 'workbudy' } })
  assert.equal(res.status, 400)
  assert.equal(res.json.code, 'error.provider.env')

  // /provider/probe backs the "add gateway" editor (it pulls /v1/models). It must
  // exist and reach the network layer: a missing route answers 404 with
  // "未知接口", which is the exact regression this guards.
  res = await call(host, '/provider/probe', { method: 'POST', body: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x' } })
  assert.equal(res.status, 502)
  assert.equal(res.json.code, 'error.provider.probe')

  for (const route of ['/provider/delete', '/provider/rename', '/provider/remove']) {
    res = await call(host, route, { method: 'POST', body: { providerId: 'workbudy' } })
    assert.equal(res.status, 404, `${route} must never be an endpoint`)
    assert.equal(res.json.code, 'error.proto.notFound')
  }

  // ---- scheduled thinking unlock ------------------------------------------
  // The host owns the cadence so the page can show it without guessing, and so a
  // sweep happens with the page closed. These routes are what the schedule card
  // calls; the timer itself uses the same runScheduledUnlock on the same queue.
  res = await call(host, '/provider/schedule')
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.data.enabled, true, 'a profile with no state file starts enabled')
  assert.equal(res.json.data.intervalMinutes, 360)
  assert.equal(res.json.data.onlyWorkbuddy, true)
  assert.ok(res.json.data.nextRunAt > Date.now(), 'a fresh schedule waits one interval')
  const scheduleFile = path.join(host.profile, '.dsh-integration', 'unlock-schedule.json')
  assert.equal(await fsp.readFile(scheduleFile, 'utf8').catch(() => ''), '', 'reading never creates the file')

  res = await call(host, '/provider/schedule', {
    method: 'POST',
    body: { enabled: true, intervalMinutes: 15, onlyWorkbuddy: false },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.data.intervalMinutes, 15)
  assert.equal(res.json.data.onlyWorkbuddy, false)
  // A changed cadence restarts the clock instead of waiting out the old slot.
  assert.ok(Math.abs(res.json.data.nextRunAt - Date.now() - 15 * 60000) < 5000)
  assert.equal((await fsp.stat(scheduleFile)).mode & 0o777, 0o600)
  res = await call(host, '/provider/schedule')
  assert.equal(res.json.data.intervalMinutes, 15, 'the cadence survives a re-read')

  // The page cannot rewind the host-owned bookkeeping, whatever it posts back.
  const beforeStale = await call(host, '/provider/schedule')
  res = await call(host, '/provider/schedule', {
    method: 'POST',
    body: { ...beforeStale.json.data, enabled: true, intervalMinutes: 15, nextRunAt: 1, lastRunAt: 1, lastResult: { changed: true } },
  })
  assert.equal(res.json.data.nextRunAt, beforeStale.json.data.nextRunAt, 'a stale nextRunAt is ignored')
  assert.equal(res.json.data.lastRunAt, null)
  assert.equal(res.json.data.lastResult, null)

  // An out-of-range interval is clamped by the host, not by the page.
  res = await call(host, '/provider/schedule', { method: 'POST', body: { enabled: true, intervalMinutes: 1 } })
  assert.equal(res.json.data.intervalMinutes, 360)
  res = await call(host, '/provider/schedule', { method: 'POST', body: { enabled: false } })
  assert.equal(res.json.data.enabled, false)
  assert.equal(res.json.data.nextRunAt, null, 'a disabled schedule has no next slot')
  // Switching it back on waits a full interval rather than firing at once.
  res = await call(host, '/provider/schedule', { method: 'POST', body: { enabled: true } })
  assert.equal(res.json.data.enabled, true)
  assert.ok(Math.abs(res.json.data.nextRunAt - Date.now() - 360 * 60000) < 5000)
  await call(host, '/provider/schedule', { method: 'POST', body: { enabled: false } })

  // "立即执行一次" always sweeps, even though the schedule is off, so the route
  // must reach the unlock pass and report the missing llm-pi-ai entry rather
  // than a 404 route miss or a silent skip.
  res = await call(host, '/provider/schedule/run', { method: 'POST', body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json.data.ran, true)
  assert.equal(res.json.data.report, null)
  assert.match(res.json.data.error, /llm-pi-ai/)
  const afterRun = await call(host, '/provider/schedule')
  assert.ok(afterRun.json.data.lastRunAt > 0, 'a forced run is recorded')
  assert.equal(afterRun.json.data.enabled, false, 'forcing a run does not switch the schedule back on')

  // The write fence applies to the new routes too.
  res = await call(host, '/provider/schedule', { method: 'POST', body: { enabled: true }, headers: { 'x-dsh-integration': '' }, raw: true })
  assert.equal(res.status, 403)
})

// The timer is the whole point of the feature, so drive it for real: a due slot
// in the state file, apply() on a temp profile, and a real HTTP gateway. Nothing
// is stubbed, so this fails if the route, the sweep or the write-back drifts.
test('a due slot sweeps the gateways on its own and writes the levels back', async (t) => {
  const gateway = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/healthz') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ service: 'workbuddy-manager' }))
    }
    if (url.pathname === '/v1/models') {
      if (!/^Bearer .+/.test(req.headers.authorization || '')) {
        res.statusCode = 401
        return res.end('{}')
      }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({
        data: [{
          id: 'cn:deepseek-v4.1-flash',
          supports_reasoning: true,
          can_disable_thinking: true,
          reasoning_supported_efforts: ['low', 'high', 'max'],
        }],
      }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => gateway.close(resolve)))
  const gatewayBase = `http://127.0.0.1:${gateway.address().port}/v1`

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsi-sweep-'))
  const home = path.join(root, 'dsh')
  const profile = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(path.join(profile, '.dsh-integration'), { recursive: true })
  await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-integration-settings'] } } }))
  const patchFile = path.join(profile, 'cordis.patch.yml')
  await fsp.writeFile(patchFile, [
    '# profile patch',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      workbudy:',
    '        apiKeyEnv: WORKBUDY_API_KEY',
    '        api: openai-completions',
    `        baseURL: ${gatewayBase}`,
    '        models:',
    '          - id: cn:deepseek-v4.1-flash',
    '            name: Deepseek-V4.1-Flash',
    '            contextWindow: 1000000',
    '            maxTokens: 393216',
    '            input:',
    '              - text',
    '',
  ].join('\n'))
  // Credentials live next to DSH_HOME (`paths().credentialsFile`), not under HOME.
  await fsp.writeFile(path.join(home, '.credentials.yaml'), 'refs:\n  WORKBUDY_API_KEY: sk-test\n')

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.HOME = path.join(root, 'home')
  t.after(() => { process.env = { ...SAVED } })

  // The model starts with no declared level, and the slot is already overdue.
  const now = Date.now()
  await fsp.writeFile(path.join(profile, '.dsh-integration', 'unlock-schedule.json'), JSON.stringify({
    enabled: true,
    intervalMinutes: 360,
    onlyWorkbuddy: true,
    lastRunAt: now - 7 * 3600000,
    nextRunAt: now - 60000,
  }))

  const captured = []
  apply({
    effect: (fn) => { fn(); return () => {} },
    webServer: { register: (route) => { captured.push(route); return () => {} } },
    webRuntime: { trustedHosts: [] },
    sessions: { get: () => undefined },
  })
  assert.equal(captured.length, 1, 'the scheduler must not steal the route registration')

  // apply() sweeps without being asked, because the stored slot has arrived.
  let sweep = ''
  for (let i = 0; i < 100; i += 1) {
    sweep = await fsp.readFile(patchFile, 'utf8')
    if (sweep.includes('reasoningEfforts')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.match(sweep, /reasoningEfforts:/, 'the timer must reach the gateway and write the levels back')
  assert.match(sweep, /low:\s*low/)
  assert.match(sweep, /high:\s*high/)
  assert.match(sweep, /max:\s*max/)
  assert.match(sweep, /"off":/, 'a gateway that can disable thinking gets the quoted off key')
  assert.match(sweep, /# profile patch/, 'the scheduler rewrites bytes, it does not reformat the file')

  const state = JSON.parse(await fsp.readFile(path.join(profile, '.dsh-integration', 'unlock-schedule.json'), 'utf8'))
  assert.ok(state.lastRunAt >= now, 'the run is recorded')
  assert.ok(state.nextRunAt > Date.now(), 'the next slot is one interval out, so sleep cannot replay a burst')
  assert.equal(state.lastError, '')
  assert.equal(state.lastResult.changed, true)
  assert.equal(state.lastResult.unlockedModels, 1)
  assert.deepEqual(state.lastResult.failedProviders, [])
  assert.equal((await fsp.stat(path.join(profile, '.dsh-integration', 'unlock-schedule.json'))).mode & 0o777, 0o600)

  // A second sweep on the same slot must not fire again.
  const settled = await fsp.readFile(patchFile, 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(await fsp.readFile(patchFile, 'utf8'), settled)
})
