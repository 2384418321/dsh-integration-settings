// Host half of dsh-integration-settings.
// Registers one loopback+fenced HTTP API used by the three settings pages.
import {
  PLUGIN_NAME,
  paths,
  setHostContext,
  readMcpState,
  writeMcpServers,
  validateServer,
  renderManagedBlock,
  extractMcpRows,
  readTextFile,
  listSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  skillRoots,
  skillRootPath,
  readPersona,
  readPersonaBackup,
  savePersona,
  readProviderState,
  saveProvider,
  deleteProvider,
  probeGateway,
  httpError,
} from './core.js'

export const name = PLUGIN_NAME
export const inject = ['webServer', 'webRuntime', 'sessions']

const API_PREFIX = '/api/dsh-integration'
const MUTATION_HEADER = 'x-dsh-integration'
const BODY_LIMIT = 4 * 1024 * 1024

/* --------------------------------------------------------------- transport */

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res, err) {
  const status = err && err.statusCode ? err.statusCode : 500
  json(res, status, {
    ok: false,
    code: (err && err.code) || 'error.internal',
    error: (err && err.message) || String(err),
  })
}

async function readBody(req, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw httpError(413, 'error.proto.bodyTooLarge', '请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw httpError(400, 'error.proto.invalidJson', '请求体不是合法 JSON')
  }
}

function hostOf(value) {
  if (!value) return ''
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ''
  }
}

function isLoopbackHost(host) {
  const name = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.startsWith('127.')
}

function validateOrigin(ctx, req) {
  const host = String(req.headers.host || '')
  const trusted = []
  try {
    const list = ctx.webRuntime && ctx.webRuntime.trustedHosts
    if (Array.isArray(list)) trusted.push(...list.map((h) => String(h).toLowerCase()))
  } catch { /* service unavailable */ }
  const allowed = isLoopbackHost(host) || trusted.includes(host.toLowerCase())
  if (!allowed) throw httpError(403, 'error.proto.untrustedHost', 'Host 不在受信范围内')
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw httpError(403, 'error.proto.crossSite', '拒绝跨站请求')
  }
  const origin = req.headers.origin
  if (origin && hostOf(origin) && hostOf(origin) !== host.toLowerCase()) {
    throw httpError(403, 'error.proto.badOrigin', 'Origin 与 Host 不一致')
  }
}

function validateMutation(req) {
  if (String(req.headers[MUTATION_HEADER] || '') !== '1') {
    throw httpError(403, 'error.proto.missingHeader', `写操作必须携带 ${MUTATION_HEADER}: 1`)
  }
  const type = String(req.headers['content-type'] || '')
  if (!type.toLowerCase().includes('application/json')) {
    throw httpError(415, 'error.proto.contentType', '写操作必须使用 application/json')
  }
}

function sessionCwd(ctx, req, url) {
  const id = req.headers['x-dsh-integration-session'] || url.searchParams.get('session')
  if (!id) return null
  try {
    const session = ctx.sessions && ctx.sessions.get && ctx.sessions.get(String(id))
    return (session && session.header && session.header.cwd) || null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ routes */

async function stateResponse(ctx, req, url) {
  const env = process.env
  const cwd = sessionCwd(ctx, req, url)
  const mcpState = await readMcpState(env)
  const p = paths(env)
  const patchText = await readTextFile(p.patchFile, '')
  const stored = new Map(mcpState.servers.map((s) => [String(s.serverName).toLowerCase(), s]))
  const importable = []
  for (const row of extractMcpRows(patchText)) {
    if (!row.serverName) continue
    if (!stored.has(String(row.serverName).toLowerCase())) importable.push(row)
  }
  const roots = skillRoots(env, cwd)
  const requestedRoot = url.searchParams.get('root')
  const rootId = requestedRoot && roots.some((r) => r.id === requestedRoot) ? requestedRoot : roots[0] && roots[0].id
  const activeRoot = roots.find((r) => r.id === rootId)
  const skills = activeRoot ? await listSkills(activeRoot.path) : []
  return {
    paths: { home: p.home, profileDir: p.profileDir, patchFile: p.patchFile, mcpFile: p.mcpFile, personaFile: p.personaFile },
    session: { id: (req.headers['x-dsh-integration-session'] || url.searchParams.get('session')) || null, cwd },
    mcp: {
      servers: mcpState.servers,
      initialized: mcpState.initialized,
      importable,
      managedPreview: renderManagedBlock(mcpState.servers),
      patchTail: patchText.includes('dsh-integration-settings:managed:mcp'),
    },
    skills: { roots, rootId: rootId || null, list: skills },
    persona: await readPersona(env, cwd),
    providers: await readProviderState(env),
  }
}

async function saveMcpServer(body) {
  const incoming = validateServer(body && body.server ? body.server : body)
  const previousName = body && body.previousName ? String(body.previousName) : null
  const env = process.env
  const current = await readMcpState(env)
  const list = current.servers.filter((server) => {
    const key = server.serverName.toLowerCase()
    if (key === incoming.serverName.toLowerCase()) return false
    if (previousName && key === previousName.toLowerCase()) return false
    return true
  })
  list.push(incoming)
  list.sort((a, b) => a.serverName.localeCompare(b.serverName))
  await writeMcpServers(list, env)
  return { server: incoming, servers: list }
}

async function deleteMcpServer(body) {
  const serverName = String((body && body.serverName) || '').toLowerCase()
  if (!serverName) throw httpError(400, 'error.mcp.invalid', '缺少 serverName')
  const env = process.env
  const current = await readMcpState(env)
  const list = current.servers.filter((server) => server.serverName.toLowerCase() !== serverName)
  await writeMcpServers(list, env)
  return { servers: list }
}

async function toggleMcpServer(body) {
  const serverName = String((body && body.serverName) || '').toLowerCase()
  const enabled = !!(body && body.enabled)
  const env = process.env
  const current = await readMcpState(env)
  let hit = false
  const list = current.servers.map((server) => {
    if (server.serverName.toLowerCase() !== serverName) return server
    hit = true
    return { ...server, enabled }
  })
  if (!hit) throw httpError(404, 'error.mcp.missing', `未找到服务器：${serverName}`)
  await writeMcpServers(list, env)
  return { servers: list }
}

async function importMcpServers(body) {
  const env = process.env
  const p = paths(env)
  const patchText = await readTextFile(p.patchFile, '')
  const wanted = Array.isArray(body && body.serverNames) ? body.serverNames.map((n) => String(n)) : null
  const current = await readMcpState(env)
  const seen = new Set(current.servers.map((s) => s.serverName.toLowerCase()))
  const added = []
  for (const row of extractMcpRows(patchText)) {
    if (!row.serverName) continue
    const key = String(row.serverName).toLowerCase()
    if (seen.has(key)) continue
    if (wanted && !wanted.includes(row.serverName)) continue
    seen.add(key)
    added.push(validateServer({ ...row, transport: row.transport || 'stdio' }))
  }
  const list = current.servers.concat(added).sort((a, b) => a.serverName.localeCompare(b.serverName))
  await writeMcpServers(list, env)
  return { added: added.map((a) => a.serverName), servers: list }
}

async function skillListResponse(ctx, req, url) {
  const env = process.env
  const cwd = sessionCwd(ctx, req, url)
  const rootId = url.searchParams.get('root')
  const rootPath = skillRootPath(rootId, env, cwd)
  return { rootId, rootPath, list: await listSkills(rootPath) }
}

// The probe is the only call that ever holds an API key typed into the form; it
// runs host-side so the key never has to round-trip through a saved file first.
async function probeProviderGateway(body) {
  return probeGateway({ baseURL: body && body.baseURL, apiKey: body && body.apiKey })
}

async function handle(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const route = url.pathname.replace(/\/+$/, '').slice(API_PREFIX.length) || '/'
  validateOrigin(ctx, req)
  const mutation = req.method !== 'GET' && req.method !== 'HEAD'
  if (mutation) validateMutation(req)
  const body = mutation ? await readBody(req) : {}

  switch (`${req.method} ${route}`) {
    case 'GET /state':
      return json(res, 200, { ok: true, data: await stateResponse(ctx, req, url) })
    case 'GET /skill/list':
      return json(res, 200, { ok: true, data: await skillListResponse(ctx, req, url) })
    case 'GET /skill/read': {
      const env = process.env
      const cwd = sessionCwd(ctx, req, url)
      const rootPath = skillRootPath(url.searchParams.get('root'), env, cwd)
      return json(res, 200, {
        ok: true,
        data: await readSkill(rootPath, String(url.searchParams.get('dir') || '')),
      })
    }
    case 'GET /persona/backup':
      return json(res, 200, {
        ok: true,
        data: await readPersonaBackup(process.env, String(url.searchParams.get('name') || '')),
      })
    case 'POST /mcp/save':
      return json(res, 200, { ok: true, data: await saveMcpServer(body) })
    case 'POST /mcp/delete':
      return json(res, 200, { ok: true, data: await deleteMcpServer(body) })
    case 'POST /mcp/toggle':
      return json(res, 200, { ok: true, data: await toggleMcpServer(body) })
    case 'POST /mcp/import':
      return json(res, 200, { ok: true, data: await importMcpServers(body) })
    case 'POST /skill/save': {
      const env = process.env
      const cwd = sessionCwd(ctx, req, url)
      const rootPath = skillRootPath(body.root, env, cwd)
      const saved = await writeSkill(rootPath, body)
      return json(res, 200, { ok: true, data: saved })
    }
    case 'POST /skill/delete': {
      const env = process.env
      const cwd = sessionCwd(ctx, req, url)
      const rootPath = skillRootPath(body.root, env, cwd)
      return json(res, 200, { ok: true, data: await deleteSkill(rootPath, String(body.dir || '')) })
    }
    case 'POST /persona/save': {
      const cwd = body.cwd || sessionCwd(ctx, req, url)
      return json(res, 200, { ok: true, data: await savePersona(process.env, { ...body, cwd }) })
    }
    case 'GET /provider/list':
      return json(res, 200, { ok: true, data: await readProviderState(process.env) })
    case 'POST /provider/probe':
      return json(res, 200, { ok: true, data: await probeProviderGateway(body) })
    case 'POST /provider/save':
      return json(res, 200, { ok: true, data: await saveProvider(process.env, body || {}) })
    case 'POST /provider/delete':
      return json(res, 200, { ok: true, data: await deleteProvider(process.env, body || {}) })
    default:
      return json(res, 404, { ok: false, code: 'error.proto.notFound', error: `未知接口：${req.method} ${route}` })
  }
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx) {
  // Lets core.js ask the host which profile we live in (desktopProfiles.current)
  // instead of guessing from $DSH_HOME/profiles.
  setHostContext(ctx)

  let queue = Promise.resolve()
  const serialize = (task) => {
    const next = queue.then(task, task)
    queue = next.catch(() => {})
    return next
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          const method = req.method || 'GET'
          const run = method === 'GET' || method === 'HEAD' ? handle(ctx, req, res) : serialize(() => handle(ctx, req, res))
          Promise.resolve(run).catch((err) => fail(res, err))
        },
      }),
    `${PLUGIN_NAME}: API route`,
  )
}
