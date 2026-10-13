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
  // The page detects gateways and unlocks thinking levels. Provider add / edit /
  // Add and edit are back; delete is deliberately never exposed.
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

  for (const route of ['/provider/delete', '/provider/rename', '/provider/remove']) {
    res = await call(host, route, { method: 'POST', body: { providerId: 'workbudy' } })
    assert.equal(res.status, 404, `${route} must never be an endpoint`)
    assert.equal(res.json.code, 'error.proto.notFound')
  }
})
