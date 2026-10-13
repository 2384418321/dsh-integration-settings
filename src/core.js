// Pure logic for dsh-integration-settings: MCP store <-> profile patch block,
// skill files, global persona file. No Cordis / HTTP dependencies, so it can be
// unit tested with plain `node --test`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

export const PLUGIN_NAME = 'dsh-integration-settings'
export const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'
export const MCP_ROW_PREFIX = 'mcp-'
export const START_MARK = '# >>> dsh-integration-settings:managed:mcp'
export const END_MARK = '# <<< dsh-integration-settings:managed:mcp'
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
export const MAX_BODY = 4 * 1024 * 1024

/* ------------------------------------------------------------------ paths */

export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const DEFAULT_PROFILE_NAME = 'desktop'

export function resolveHome(env = process.env) {
  const home = env.DSH_HOME || (env.HOME ? path.join(env.HOME, '.dsh') : path.join(os.homedir(), '.dsh'))
  return path.resolve(home)
}

/** Profile name selected on this process's command line (`--profile X` / `--profile=X`). */
export function profileNameFromArgv(argv = process.argv) {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') return argv[i + 1]
    if (typeof arg === 'string' && arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return undefined
}

/**
 * The host's own Cordis context, when the plugin runs inside DSH. `desktopProfiles`
 * (a Desktop-host service) is the only authoritative answer for "which profile am
 * I living in"; everything else is inference. Set from `apply(ctx)`.
 */
let hostContext
export function setHostContext(ctx) {
  hostContext = ctx
}
function currentHostProfileDir(ctx) {
  let current
  try {
    current = ctx?.get?.('desktopProfiles')?.current
  } catch {
    return undefined
  }
  if (!current || typeof current.dir !== 'string' || !path.isAbsolute(current.dir)) return undefined
  return path.resolve(current.dir)
}

/** Profiles under $DSH_HOME/profiles that list this plugin in bundles or dependencies. */
function profilesWithPlugin(profiles) {
  let entries
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(profiles, entry.name, 'package.json'), 'utf8'))
      const bundles = pkg?.dsh?.profile?.bundles || []
      const deps = Object.keys(pkg?.dependencies || {})
      if (bundles.includes(PLUGIN_NAME) || deps.includes(PLUGIN_NAME)) found.push(entry.name)
    } catch { /* profile without package.json: skip */ }
  }
  return found
}

/**
 * The profile whose patch file we edit, in order of authority:
 *   1. the running host's own profile (`desktopProfiles.current.dir`),
 *   2. `DSH_PROFILE_DIR`,
 *   3. the profile named by `--profile` / `DSH_PROFILE`,
 *   4. the single profile that has this plugin installed (ties prefer `desktop`).
 * Step 4 never silently picks a random profile: with several candidates and no
 * `desktop` among them it fails loudly instead of writing the wrong config.
 */
export function resolveProfileDir(env = process.env, ctx = hostContext) {
  const fromHost = currentHostProfileDir(ctx)
  if (fromHost) return fromHost
  if (env.DSH_PROFILE_DIR) return path.resolve(env.DSH_PROFILE_DIR)
  const profiles = path.join(resolveHome(env), 'profiles')
  const named = profileNameFromArgv() || env.DSH_PROFILE
  if (typeof named === 'string' && PROFILE_NAME_RE.test(named)) {
    const dir = path.join(profiles, named)
    if (fs.existsSync(dir)) return dir
  }
  const found = profilesWithPlugin(profiles)
  if (found.length === 1) return path.join(profiles, found[0])
  if (found.includes(DEFAULT_PROFILE_NAME)) return path.join(profiles, DEFAULT_PROFILE_NAME)
  if (found.length > 1) {
    throw httpError(
      500,
      'ambiguous_profile',
      `已安装本插件的 profile 有多个（${found.join('、')}），无法确定该改哪个配置；请设置 DSH_PROFILE_DIR 后重试。`,
    )
  }
  const fallback = typeof named === 'string' && PROFILE_NAME_RE.test(named) ? named : DEFAULT_PROFILE_NAME
  return path.join(profiles, fallback)
}

export function paths(env = process.env, ctx = hostContext) {
  const home = resolveHome(env)
  const profileDir = resolveProfileDir(env, ctx)
  return {
    home,
    profileDir,
    patchFile: path.join(profileDir, 'cordis.patch.yml'),
    stateDir: path.join(profileDir, '.dsh-integration'),
    mcpFile: path.join(profileDir, '.dsh-integration', 'mcp.json'),
    personaFile: path.join(home, 'AGENTS.md'),
    credentialsFile: path.join(home, '.credentials.yaml'),
  }
}

/* ------------------------------------------------------- low level helpers */

export function httpError(status, code, message) {
  const err = new Error(message || code)
  err.statusCode = status
  err.code = code
  return err
}

export async function ensureDir(dir, mode = 0o700) {
  await fsp.mkdir(dir, { recursive: true, mode })
}

export async function readTextFile(file, fallback = '') {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

export async function writeFileAtomic(file, text, mode = 0o600) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, text, { mode })
  await fsp.rename(tmp, file)
  try { await fsp.chmod(file, mode) } catch { /* best effort */ }
}

export async function writeWithBackup(file, text, mode = 0o600, keep = 3) {
  const previous = await readTextFile(file, null)
  if (previous !== null && previous !== text) {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 17)
    const base = `${file}.bak-${stamp}`
    let candidate = base
    for (let index = 1; await fsp.stat(candidate).catch(() => null); index += 1) {
      candidate = `${base}-${index}`
    }
    await writeFileAtomic(candidate, previous, mode)
    await pruneBackups(file, keep)
  }
  await writeFileAtomic(file, text, mode)
}

export async function listBackups(file) {
  const dir = path.dirname(file)
  const base = `${path.basename(file)}.bak-`
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.startsWith(base))
    const out = []
    for (const name of names) {
      const full = path.join(dir, name)
      const stat = await fsp.stat(full)
      out.push({ name, path: full, size: stat.size, mtime: stat.mtimeMs, mtimeMs: stat.mtimeMs })
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch { return [] }
}

/** Read one timestamped backup of the global persona file (name validated). */
export async function readPersonaBackup(env = process.env, name = '') {
  const target = paths(env).personaFile
  const base = `${path.basename(target)}.bak-`
  const safe = String(name || '')
  if (!safe.startsWith(base) || safe.includes('..') || !/^[A-Za-z0-9._-]+$/.test(safe)) {
    throw httpError(400, 'error.persona.backupName', '备份文件名不合法')
  }
  const full = path.join(path.dirname(target), safe)
  const content = await readTextFile(full, null)
  if (content === null) throw httpError(404, 'error.persona.backupMissing', `未找到备份：${safe}`)
  return { name: safe, path: full, content }
}

async function pruneBackups(file, keep) {
  const list = await listBackups(file)
  for (const old of list.slice(keep)) {
    await fsp.rm(old.path, { force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------------- MCP IO */

const JS_PREFIX = '!!js '
const JS_SENTINEL = '__DSHINT_JS_'

function encodeJsValue(value) {
  if (typeof value === 'string' && value.startsWith(JS_PREFIX)) {
    const expr = value.slice(JS_PREFIX.length).trim()
    return JS_SENTINEL + Buffer.from(expr, 'utf8').toString('base64url') + '__'
  }
  return value
}

function decodeJsSentinels(text) {
  return text.replace(/['"]?__DSHINT_JS_([A-Za-z0-9_-]+)__['"]?/g, (_m, b64) => {
    let expr = ''
    try { expr = Buffer.from(b64, 'base64url').toString('utf8') } catch { expr = '' }
    return `${JS_PREFIX}${expr}`
  })
}

function encodeJsDeep(value) {
  if (typeof value === 'string') return encodeJsValue(value)
  if (Array.isArray(value)) return value.map(encodeJsDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = encodeJsDeep(v)
    return out
  }
  return value
}

export function rowId(serverName) {
  return MCP_ROW_PREFIX + String(serverName || '').replace(/[^A-Za-z0-9_-]/g, '-')
}

export function validateServer(server) {
  const problems = []
  if (!server || typeof server !== 'object') throw httpError(400, 'error.mcp.invalid', '缺少服务器定义')
  const name = String(server.serverName || '').trim()
  if (!SERVER_NAME_RE.test(name)) {
    problems.push('serverName 必须是 1-32 位字母、数字、下划线或连字符')
  }
  const rawTransport = server.transport
  const transport = rawTransport === undefined || rawTransport === null || rawTransport === ''
    ? 'stdio'
    : String(rawTransport)
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    problems.push('transport 必须是 stdio 或 streamable-http')
  } else if (transport === 'stdio') {
    if (!String(server.command || '').trim()) problems.push('stdio 模式必须填写 command')
  } else if (!String(server.url || '').trim()) {
    problems.push('streamable-http 模式必须填写 url')
  }
  for (const key of ['toolCallTimeoutMs', 'maxInstructionBytes']) {
    const raw = server[key]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const num = Number(raw)
    if (!Number.isFinite(num) || num < 0) problems.push(`${key} 必须是非负数字`)
  }
  if (problems.length) throw httpError(400, 'error.mcp.invalid', problems.join('；'))
  return { ...server, serverName: name, transport }
}

/** Body of the managed block in the profile patch (without markers). */
export function renderManagedBlock(servers) {
  const list = Array.isArray(servers) ? servers : []
  const rows = []
  for (const server of list) {
    if (!server || !server.serverName || server.enabled === false) continue
    rows.push({ id: rowId(server.serverName), name: MCP_PACKAGE, config: encodeJsDeep(mcpConfig(server)) })
  }
  const head = [
    START_MARK,
    `# 由 ${PLUGIN_NAME} 维护：${rows.length} 个启用的 MCP 服务器。`,
    '# 直接在设置页里增删改，手工改动本区块会在下次保存时被覆盖。',
  ]
  if (rows.length) {
    const yamlText = YAML.stringify([{ insert: rows }], { lineWidth: 0, singleQuote: true }).trimEnd()
    head.push(decodeJsSentinels(yamlText))
  }
  head.push(END_MARK)
  return head.join('\n') + '\n'
}

export function mcpConfig(server) {
  const config = {
    serverName: server.serverName,
    transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
  }
  if (config.transport === 'stdio') {
    if (server.command) config.command = server.command
    if (Array.isArray(server.args) && server.args.length) config.args = server.args.map(String)
    if (server.env && typeof server.env === 'object' && Object.keys(server.env).length) config.env = { ...server.env }
    if (server.cwd) config.cwd = server.cwd
  } else {
    if (server.url) config.url = server.url
    if (server.headers && typeof server.headers === 'object' && Object.keys(server.headers).length) {
      config.headers = { ...server.headers }
    }
  }
  for (const key of ['toolCallTimeoutMs', 'maxInstructionBytes']) {
    const raw = server[key]
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      const num = Number(raw)
      if (!Number.isFinite(num) || num < 0) throw httpError(400, 'error.mcp.invalid', `${key} 必须是非负数字`)
      config[key] = num
    }
  }
  if (typeof server.failOnStartupError === 'boolean') config.failOnStartupError = server.failOnStartupError
  if (server.reconnect && typeof server.reconnect === 'object' && Object.keys(server.reconnect).length) {
    config.reconnect = { ...server.reconnect }
  }
  return config
}

/** Replace (or append) the managed block inside the profile patch text. */
/**
 * A brand new profile's patch file is `[]` ("no overrides yet"). Appending a block
 * sequence to a flow sequence is invalid YAML, so drop that top-level placeholder
 * (it carries no entries) before appending.
 */
function dropEmptyPatchPlaceholder(text) {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => /^\[\s*\]\s*(?:#.*)?$/.test(line))
  if (index === -1) return text
  lines.splice(index, 1)
  return lines.join('\n')
}

export function applyManagedBlock(patchText, block) {
  const text = dropEmptyPatchPlaceholder(patchText || '')
  const start = text.indexOf(START_MARK)
  if (start === -1) {
    const trimmed = text.trimEnd()
    if (!trimmed) return block
    return `${trimmed}\n\n${block}`
  }
  const end = text.indexOf(END_MARK, start)
  if (end === -1) throw httpError(500, 'error.patch.markers', '受管区块缺少结束标记，已中止写入')
  const rest = text.slice(end + END_MARK.length).replace(/^[^\n]*\n?/, '')
  return `${text.slice(0, start)}${block}${rest}`
}

/** Lightweight structural validation of a profile patch list. */
export function validatePatchText(text) {
  let doc
  try {
    doc = YAML.parseDocument(text, { logLevel: 'silent' })
  } catch (err) {
    throw httpError(500, 'error.patch.yaml', `生成的 patch 不是合法 YAML：${err.message}`)
  }
  if (doc.errors && doc.errors.length) {
    throw httpError(500, 'error.patch.yaml', `生成的 patch 不是合法 YAML：${doc.errors[0].message}`)
  }
  if (!YAML.isSeq(doc.contents)) throw httpError(500, 'error.patch.shape', 'patch 顶层必须是数组')
  for (const item of doc.contents.items) {
    if (!YAML.isMap(item)) throw httpError(500, 'error.patch.shape', 'patch 条目必须是映射')
    if (!item.has('id') && !item.has('insert') && !item.has('disabled') && !item.has('config')) {
      throw httpError(500, 'error.patch.shape', 'patch 条目缺少 id / insert / disabled')
    }
    const insert = item.get('insert', true)
    if (YAML.isSeq(insert)) {
      for (const sub of insert.items) {
        if (!YAML.isMap(sub) || !sub.has('id') || !sub.has('name')) {
          throw httpError(500, 'error.patch.shape', 'insert 条目必须同时提供 id 与 name')
        }
      }
    }
  }
  return true
}

function nodeToJs(node) {
  if (YAML.isMap(node)) {
    const out = {}
    for (const pair of node.items) out[String(nodeToJs(pair.key))] = nodeToJs(pair.value)
    return out
  }
  if (YAML.isSeq(node)) return node.items.map(nodeToJs)
  if (YAML.isScalar(node)) {
    const tag = String(node.tag || '')
    if (tag === 'tag:yaml.org,2002:js' || tag === '!!js') return `${JS_PREFIX}${node.value}`
    return node.value
  }
  return node && typeof node.toJSON === 'function' ? node.toJSON() : undefined
}

/** Every MCP row already present in a patch text (used to import manual rows). */
export function extractMcpRows(patchText) {
  const found = []
  let doc
  try {
    doc = YAML.parseDocument(patchText || '', { logLevel: 'silent' })
  } catch { return found }
  if (!doc || !YAML.isSeq(doc.contents)) return found
  const visit = (seq) => {
    for (const item of seq.items) {
      if (!YAML.isMap(item)) continue
      const insert = item.get('insert', true)
      if (YAML.isSeq(insert)) { visit(insert); continue }
      const name = nodeToJs(item.get('name', true))
      if (name !== MCP_PACKAGE) continue
      const configNode = item.get('config', true)
      const config = configNode ? nodeToJs(configNode) : {}
      if (config && typeof config === 'object' && config.serverName) found.push(config)
    }
  }
  visit(doc.contents)
  return found
}

export async function readMcpState(env = process.env) {
  const p = paths(env)
  const raw = await readTextFile(p.mcpFile, '')
  let servers = []
  let initialized = false
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.servers)) { servers = parsed.servers; initialized = true }
    } catch {
      throw httpError(500, 'error.mcp.store', `状态文件损坏：${p.mcpFile}`)
    }
  }
  return { servers, initialized, ...p }
}

export async function writeMcpServers(servers, env = process.env) {
  const p = paths(env)
  const list = (Array.isArray(servers) ? servers : []).map(validateServer)
  const seen = new Set()
  for (const server of list) {
    const key = server.serverName.toLowerCase()
    if (seen.has(key)) throw httpError(400, 'error.mcp.duplicate', `serverName 重复：${server.serverName}`)
    seen.add(key)
  }
  const patchText = await readTextFile(p.patchFile, '')
  const nextPatch = applyManagedBlock(patchText, renderManagedBlock(list))
  validatePatchText(nextPatch)
  validatePatchText(patchText === nextPatch ? patchText : nextPatch)
  await writeFileAtomic(p.mcpFile, JSON.stringify({ version: 1, servers: list }, null, 2) + '\n', 0o600)
  await writeWithBackup(p.patchFile, nextPatch, 0o600, 3)
  return { servers: list, patchFile: p.patchFile, mcpFile: p.mcpFile }
}

/* ------------------------------------------------------------------- skills */

export const SKILL_ROOTS = [
  { id: 'dsh-global', label: 'DSH 全局', dir: (c) => path.join(c.home, 'skills'), writable: true },
  { id: 'agents-global', label: '共享全局 .agents', dir: (c) => path.join(c.homeDir, '.agents', 'skills'), writable: true },
  { id: 'claude-global', label: 'Claude 全局', dir: (c) => path.join(c.homeDir, '.claude', 'skills'), writable: true },
  { id: 'codex-global', label: 'Codex 全局', dir: (c) => path.join(c.homeDir, '.codex', 'skills'), writable: true },
  { id: 'dsh-project', label: '当前项目 .dsh', dir: (c) => (c.cwd ? path.join(c.cwd, '.dsh', 'skills') : null), writable: true },
  { id: 'agents-project', label: '当前项目 .agents', dir: (c) => (c.cwd ? path.join(c.cwd, '.agents', 'skills') : null), writable: true },
  { id: 'claude-project', label: '当前项目 .claude', dir: (c) => (c.cwd ? path.join(c.cwd, '.claude', 'skills') : null), writable: true },
]

function ctxFor(env, cwd) {
  return { home: resolveHome(env), homeDir: env.HOME || os.homedir(), cwd: cwd || null }
}

export function skillRoots(env = process.env, cwd = null) {
  const context = ctxFor(env, cwd)
  return SKILL_ROOTS.map((root) => {
    const dir = root.dir(context)
    return { id: root.id, label: root.label, path: dir, writable: root.writable !== false && !!dir }
  }).filter((root) => !!root.path)
}

export function skillRootPath(rootId, env = process.env, cwd = null) {
  const root = skillRoots(env, cwd).find((r) => r.id === rootId)
  if (!root) throw httpError(400, 'error.skill.root', `未知的技能目录：${rootId}`)
  return root.path
}

function assertSkillDir(dir) {
  if (typeof dir !== 'string' || !dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) {
    throw httpError(400, 'error.skill.dir', '技能目录名不合法')
  }
  return dir
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseSkill(text) {
  const match = FRONTMATTER_RE.exec(text || '')
  if (!match) return { frontmatter: {}, body: (text || '').trimStart(), hasFrontmatter: false }
  let frontmatter = {}
  try {
    const parsed = YAML.parse(match[1], { logLevel: 'silent' })
    if (parsed && typeof parsed === 'object') frontmatter = parsed
  } catch { frontmatter = {} }
  return { frontmatter, body: (text || '').slice(match[0].length), hasFrontmatter: true }
}

export function renderSkill({ name, description, body = '', frontmatter = {} }) {
  const meta = { ...frontmatter }
  if (name) meta.name = name
  if (description !== undefined && description !== '') meta.description = description
  const head = YAML.stringify(meta, { lineWidth: 0 }).trimEnd()
  return `---\n${head}\n---\n\n${String(body || '').replace(/^\n+/, '')}`
}

export async function listSkills(rootPath) {
  const out = []
  let entries = []
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return out
    throw err
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const file = path.join(rootPath, entry.name, 'SKILL.md')
    try {
      const [text, stat] = await Promise.all([readTextFile(file, ''), fsp.stat(file)])
      const { frontmatter, body } = parseSkill(text)
      out.push({
        dir: entry.name,
        name: String(frontmatter.name || entry.name),
        description: String(frontmatter.description || '').split('\n')[0],
        file,
        bytes: stat.size,
        mtime: stat.mtimeMs,
        bodyLines: body.split('\n').length,
      })
    } catch { /* not a skill directory */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function readSkill(rootPath, dir) {
  const safe = assertSkillDir(dir)
  const file = path.join(rootPath, safe, 'SKILL.md')
  const text = await readTextFile(file, null)
  if (text === null) throw httpError(404, 'error.skill.missing', `技能不存在：${safe}`)
  const { frontmatter, body } = parseSkill(text)
  return { dir: safe, file, frontmatter, body, raw: text }
}

export async function writeSkill(rootPath, { dir, name, description, body, frontmatter }) {
  const safe = assertSkillDir(dir)
  if (!SKILL_NAME_RE.test(safe)) throw httpError(400, 'error.skill.name', '技能目录名必须是 kebab-case')
  if (name !== undefined && name !== '' && !SKILL_NAME_RE.test(String(name))) {
    throw httpError(400, 'error.skill.name', 'name 必须是 kebab-case（小写字母、数字、连字符）')
  }
  if (String(description || '').trim() === '') {
    throw httpError(400, 'error.skill.description', 'description 为必填（技能靠它被检索）')
  }
  const text = renderSkill({ name: name || safe, description, body, frontmatter })
  if (text.length > MAX_BODY) throw httpError(413, 'error.skill.tooLarge', '技能内容过大')
  const dirPath = path.join(rootPath, safe)
  const existing = await fsp.stat(dirPath).catch(() => null)
  if (existing && !existing.isDirectory()) throw httpError(409, 'error.skill.conflict', '同名文件已存在')
  await fsp.mkdir(dirPath, { recursive: true })
  const file = path.join(dirPath, 'SKILL.md')
  if (existing) await writeWithBackup(file, text, 0o644, 3)
  else await writeFileAtomic(file, text, 0o644)
  return { dir: safe, file }
}

export async function deleteSkill(rootPath, dir) {
  const safe = assertSkillDir(dir)
  const dirPath = path.join(rootPath, safe)
  const stat = await fsp.stat(dirPath).catch(() => null)
  if (!stat) throw httpError(404, 'error.skill.missing', `技能不存在：${safe}`)
  if (!stat.isDirectory()) throw httpError(400, 'error.skill.dir', '不是技能目录')
  await fsp.rm(dirPath, { recursive: true, force: true })
  return { dir: safe }
}

/* ------------------------------------------------------------------ persona */

export function personaCandidates(env = process.env, cwd = null) {
  const list = [
    { id: 'global', label: '全局人设', path: paths(env).personaFile, scope: 'global' },
  ]
  if (cwd) list.push({ id: 'project', label: '当前项目人设', path: path.join(cwd, 'AGENTS.md'), scope: 'project' })
  return list
}

export async function readPersona(env = process.env, cwd = null) {
  const files = []
  for (const item of personaCandidates(env, cwd)) {
    const content = await readTextFile(item.path, '')
    const stat = await fsp.stat(item.path).catch(() => null)
    files.push({ ...item, content, exists: !!stat, bytes: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 })
  }
  const global = files.find((f) => f.scope === 'global')
  return { files, backups: await listBackups(paths(env).personaFile), globalPath: global.path }
}

export async function savePersona(env = process.env, { scope = 'global', cwd = null, content = '' } = {}) {
  const target = personaCandidates(env, cwd).find((f) => f.scope === scope)
  if (!target) throw httpError(400, 'error.persona.scope', `未知的作用域：${scope}`)
  if (typeof content !== 'string') throw httpError(400, 'error.persona.body', '内容必须是字符串')
  if (content.length > MAX_BODY) throw httpError(413, 'error.persona.tooLarge', '人设内容过大')
  if (target.scope === 'project') await ensureDir(path.dirname(target.path), 0o755)
  else await ensureDir(path.dirname(target.path))
  await writeWithBackup(target.path, content, 0o644, 3)
  return { path: target.path, bytes: Buffer.byteLength(content, 'utf8') }
}

/* --------------------------------------------------------------- providers */

// Model providers live *inside* the profile's existing `- id: llm-pi-ai` entry,
// under `config.providers`. We deliberately never add a second entry with the
// same id: the cordis loader rejects duplicate entry ids at boot, so a new
// provider has to be merged into the entry that is already there.
export const PROVIDERS_ENTRY_ID = 'llm-pi-ai'
export const PROVIDERS_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
export const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
export const PROBE_TIMEOUT_MS = 15000
export const KIND_TIMEOUT_MS = 5000
/** Level ids understood by @deepseek-ai/dsh-llm-pi-ai, ascending. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function validateProviderId(value) {
  const id = String(value ?? '').trim()
  if (!PROVIDER_ID_RE.test(id)) {
    throw httpError(
      400,
      'error.provider.id',
      '供应商 id 需为 1–32 位字母、数字、点、下划线或连字符，并以字母或数字开头（如 workbudy-lan）',
    )
  }
  return id
}

export function normalizeBaseURL(value) {
  const raw = String(value ?? '').trim()
  if (!raw) throw httpError(400, 'error.provider.baseURL', 'baseURL 不能为空')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw httpError(400, 'error.provider.baseURL', `baseURL 不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'error.provider.baseURL', 'baseURL 只支持 http / https')
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * Turn gateway-declared effort levels into a pi-ai `reasoningEfforts` map.
 * A declared level is selectable; every level left out is pinned to "unsupported",
 * so we only declare what the gateway really accepts.
 */
export function buildEffortMap(levels) {
  const map = {}
  for (const raw of Array.isArray(levels) ? levels : []) {
    const level = String(raw ?? '').trim()
    if (!THINKING_LEVELS.includes(level)) continue
    // `off` is the one level that must carry *no* wire value: a declared but
    // empty `off` means "supported, dispatch nothing", i.e. thinking disabled.
    map[level] = level === 'off' ? null : level
  }
  return Object.keys(map).length ? map : null
}

/** Map one `/v1/models` row onto a pi-ai `models[]` entry. */
export function normalizeGatewayModel(raw) {
  const id = String(raw?.id ?? '').trim()
  if (!id) return null
  const model = { id, name: String(raw?.name ?? raw?.display_name ?? '').trim() || id }
  const contextWindow = Number(raw?.context_length ?? raw?.context_window)
  if (Number.isFinite(contextWindow) && contextWindow > 0) model.contextWindow = Math.trunc(contextWindow)
  const maxTokens = Number(raw?.max_output_tokens ?? raw?.max_tokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) model.maxTokens = Math.trunc(maxTokens)
  const input = ['text']
  if (raw?.supports_images === true || raw?.supports_vision === true) input.push('image')
  model.input = input
  const levels = Array.isArray(raw?.reasoning_supported_efforts)
    ? raw.reasoning_supported_efforts.map((v) => String(v ?? '').trim()).filter(Boolean)
    : []
  if (raw?.can_disable_thinking === true) levels.unshift('off')
  const efforts = raw?.supports_reasoning === true || levels.length ? buildEffortMap(levels) : null
  if (efforts) model.reasoningEfforts = efforts
  const fallback = String(raw?.reasoning_default_effort ?? '').trim()
  if (efforts && fallback && Object.prototype.hasOwnProperty.call(efforts, fallback)) {
    model.reasoning = fallback
  }
  return model
}

/** Host-side `GET <baseURL>/models` probe; never runs in the browser. */
export async function probeGateway({ baseURL, apiKey } = {}, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw httpError(500, 'error.provider.fetch', '当前运行时不支持 fetch')
  const base = normalizeBaseURL(baseURL)
  const headers = { accept: 'application/json' }
  const key = String(apiKey ?? '').trim()
  if (key) headers.authorization = `Bearer ${key}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let res
  try {
    res = await doFetch(`${base}/models`, { headers, signal: controller.signal, redirect: 'follow' })
  } catch (err) {
    const reason =
      err?.name === 'AbortError' ? `超过 ${PROBE_TIMEOUT_MS / 1000} 秒未响应` : String(err?.message ?? err)
    throw httpError(502, 'error.provider.probe', `连接网关失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? '（API Key 可能不正确）' : ''
    throw httpError(502, 'error.provider.probe', `网关 /models 返回 HTTP ${res.status}${hint}`)
  }
  let payload
  try {
    payload = await res.json()
  } catch {
    throw httpError(502, 'error.provider.probe', '网关 /models 返回的不是 JSON')
  }
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const models = rows.map(normalizeGatewayModel).filter(Boolean)
  if (!models.length) throw httpError(502, 'error.provider.probe', '网关没有返回任何可用模型')
  return { baseURL: base, models }
}

/* --- cordis.patch.yml surgery -------------------------------------------- */
//
// The patch is rewritten through a YAML *document*, not through
// parse -> mutate -> stringify of plain JS: round-tripping the document keeps
// comments and the cordis-only `!!js` tags intact, while other entries are left
// as untouched nodes.

function parseYamlDocument(text, what) {
  let doc
  try {
    doc = YAML.parseDocument(text || '', { logLevel: 'silent' })
  } catch (err) {
    throw httpError(500, 'error.patch.yaml', `解析${what}失败：${err.message}`)
  }
  if (!doc || doc.errors?.length) {
    throw httpError(500, 'error.patch.yaml', `${what}不是合法 YAML：${doc?.errors?.[0]?.message ?? ''}`)
  }
  return doc
}

function findEntry(doc, id) {
  if (!YAML.isSeq(doc.contents)) return null
  for (const item of doc.contents.items) {
    if (!YAML.isMap(item)) continue
    if (String(nodeToJs(item.get('id', true)) ?? '') === id) return item
  }
  return null
}

/**
 * Force a double-quoted `off` key. `off` is a YAML 1.1 boolean (on/off/yes/no),
 * so a bare `off:` is read as the boolean false by Ruby/Psych and other 1.1
 * parsers — quoting keeps the level id a plain string everywhere.
 */
function quoteAmbiguousKeys(node) {
  if (YAML.isMap(node)) {
    for (const pair of node.items) {
      if (YAML.isScalar(pair.key) && String(pair.key.value) === 'off') pair.key.type = 'QUOTE_DOUBLE'
      quoteAmbiguousKeys(pair.value)
    }
    return
  }
  if (YAML.isSeq(node)) {
    for (const item of node.items) quoteAmbiguousKeys(item)
  }
}

function providerMapFor(doc, entry) {
  let config = entry.get('config', true)
  if (config !== undefined && !YAML.isMap(config)) {
    throw httpError(409, 'error.provider.shape', `条目 ${PROVIDERS_ENTRY_ID} 的 config 不是映射，已中止以免破坏现有配置`)
  }
  if (!YAML.isMap(config)) {
    config = doc.createNode({})
    entry.set('config', config)
  }
  let providers = config.get('providers', true)
  if (providers !== undefined && !YAML.isMap(providers)) {
    throw httpError(
      409,
      'error.provider.shape',
      `条目 ${PROVIDERS_ENTRY_ID} 的 config.providers 不是映射，已中止以免破坏现有配置`,
    )
  }
  if (!YAML.isMap(providers)) {
    providers = doc.createNode({})
    config.set('providers', providers)
  }
  return providers
}

function newEntryDocument(providerId, providerConfig) {
  const doc = new YAML.Document()
  doc.contents = doc.createNode([
    { id: PROVIDERS_ENTRY_ID, name: PROVIDERS_PACKAGE, config: { providers: { [providerId]: providerConfig } } },
  ])
  return doc
}

/**
 * `"off": null` and `"off":` are the same YAML, but the empty form is the one the
 * pi-ai docs use for "thinking can be switched off, dispatch no wire value".
 */
function stringifyPatch(doc) {
  return YAML.stringify(doc, { lineWidth: 0 }).replace(/"off": null/g, '"off":')
}

export function validateModel(input) {
  const id = String(input?.id ?? '').trim()
  if (!id) throw httpError(400, 'error.provider.model', '模型 id 不能为空')
  const model = { id, name: String(input?.name ?? '').trim() || id }
  const contextWindow = Number(input?.contextWindow)
  if (Number.isFinite(contextWindow) && contextWindow > 0) model.contextWindow = Math.trunc(contextWindow)
  const maxTokens = Number(input?.maxTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) model.maxTokens = Math.trunc(maxTokens)
  const kinds = (Array.isArray(input?.input) ? input.input : ['text']).map((v) => String(v))
  model.input = kinds.filter((v) => v === 'text' || v === 'image')
  if (!model.input.length) model.input = ['text']
  // `reasoningEfforts: false` is the documented spelling for "this model does
  // not reason" — a declaration, not an absent value, so it must survive a
  // round trip instead of being dropped.
  const raw = input?.reasoningEfforts
  if (raw === false) {
    model.reasoningEfforts = false
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const efforts = {}
    const declared = Object.keys(raw).filter((key) => !THINKING_LEVELS.includes(key))
    for (const level of [...THINKING_LEVELS, ...declared]) {
      if (!Object.prototype.hasOwnProperty.call(raw, level)) continue
      const value = raw[level]
      // The value is the spelling dispatch sends on the wire (`max: ultra`
      // renames a level for a gateway with its own vocabulary), so write it
      // back verbatim; a valueless level stays valueless.
      efforts[level] = value === null || value === undefined || value === '' ? null : String(value)
    }
    if (Object.keys(efforts).length) model.reasoningEfforts = efforts
  }
  const reasoning = String(input?.reasoning ?? '').trim()
  if (reasoning && THINKING_LEVELS.includes(reasoning)) model.reasoning = reasoning
  return model
}


export function renderProviderConfig(draft) {
  const apiKeyEnv = String(draft?.apiKeyEnv ?? '').trim()
  if (!ENV_NAME_RE.test(apiKeyEnv)) {
    throw httpError(400, 'error.provider.env', 'apiKeyEnv 需为全大写字母/数字/下划线，例如 WORKBUDY_LAN_API_KEY')
  }
  const models = Array.isArray(draft?.models) ? draft.models : []
  if (!models.length) throw httpError(400, 'error.provider.models', '至少需要保留一个模型')
  const reasoning = String(draft?.reasoning ?? '').trim()
  if (reasoning && !THINKING_LEVELS.includes(reasoning)) {
    throw httpError(400, 'error.provider.reasoning', `未知的默认思考档位：${reasoning}`)
  }
  const provider = {
    apiKeyEnv,
    api: String(draft?.api ?? '').trim() || 'openai-completions',
    baseURL: normalizeBaseURL(draft?.baseURL),
    models: models.map(validateModel),
  }
  if (reasoning) provider.reasoning = reasoning
  return provider
}


export function readProvidersFromPatch(patchText) {
  let doc
  try {
    doc = parseYamlDocument(patchText, '配置文件')
  } catch {
    return { entryFound: false, providers: {} }
  }
  const entry = findEntry(doc, PROVIDERS_ENTRY_ID)
  if (!entry) return { entryFound: false, providers: {} }
  const config = entry.get('config', true)
  const providersNode = YAML.isMap(config) ? config.get('providers', true) : null
  if (!YAML.isMap(providersNode)) return { entryFound: true, providers: {} }
  const providers = {}
  for (const pair of providersNode.items) {
    const id = String(nodeToJs(pair.key) ?? '')
    const value = nodeToJs(pair.value)
    if (id && value && typeof value === 'object' && !Array.isArray(value)) providers[id] = value
  }
  return { entryFound: true, providers }
}

/** Leading whitespace of the line `offset` falls on. */
function indentAt(text, offset) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset))
  return match ? match[0] : ''
}

/**
 * One provider entry rendered on its own: the `id:` key line plus the body
 * lines, still carrying stringify's relative indentation.
 */
function renderProviderEntry(id, providerConfig, indentUnit) {
  const doc = new YAML.Document()
  doc.contents = doc.createNode({ [id]: providerConfig })
  quoteAmbiguousKeys(doc.contents)
  const text = YAML.stringify(doc, { lineWidth: 0, indent: indentUnit })
    .replace(/"off": null/g, '"off":')
    .replace(/\n+$/, '')
  const lines = text.split('\n')
  if (lines.length < 2) return null
  return { keyLine: lines[0], body: lines.slice(1) }
}

/**
 * Rewrite exactly one provider, leaving the rest of the file byte-for-byte
 * alone.
 *
 * `YAML.stringify` would reflow the *whole* file, and hand-written groups use
 * their own layout (flow lists, quoted scalars), so an edit to one provider
 * would otherwise show up as a diff across every other provider. Splicing over
 * the byte range the old entry occupied keeps everyone else's formatting.
 */
export function mergeProviderIntoPatch(patchText, providerId, providerConfig) {
  const id = validateProviderId(providerId)
  const doc = parseYamlDocument(patchText, '配置文件')
  const entry = findEntry(doc, PROVIDERS_ENTRY_ID)
  if (!entry) {
    const next = newEntryDocument(id, providerConfig)
    quoteAmbiguousKeys(next.contents)
    return stringifyPatch(next)
  }
  const providers = providerMapFor(doc, entry)
  const indentUnit = 2
  const spliced = spliceProviderEntry(patchText, providers, id, providerConfig, indentUnit)
  if (spliced !== null) return spliced
  const node = doc.createNode(providerConfig)
  quoteAmbiguousKeys(node)
  providers.set(id, node)
  return stringifyPatch(doc)
}

/** Order-insensitive rendering used to detect a save that changed nothing. */
function stableShape(value) {
  if (Array.isArray(value)) return `[${value.map(stableShape).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableShape(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function spliceProviderEntry(patchText, providers, id, providerConfig, indentUnit) {
  if (!providerConfig || typeof providerConfig !== 'object') return null
  const pair = providers.items.find((item) => String(nodeToJs(item.key) ?? '') === id)
  const snippet = renderProviderEntry(id, providerConfig, indentUnit)
  if (pair) {
    const value = pair.value
    // Saving a provider without touching it must not rewrite the file at all.
    if (stableShape(nodeToJs(value)) === stableShape(providerConfig)) return patchText
    if (!snippet || !YAML.isMap(value) || !Array.isArray(value.range) || !Array.isArray(pair.key?.range)) return null
    const pad = indentAt(patchText, pair.key.range[0])
    const [start, end] = value.range
    // The text just before the value already carries the first line's indent, so
    // only the body's own relative indentation is added back; trailing newlines
    // belong to the range, so they are carried over verbatim.
    const trailing = /\n+$/.exec(patchText.slice(start, end))?.[0] ?? ''
    const body = [snippet.body[0].slice(indentUnit), ...snippet.body.slice(1).map((line) => pad + line)]
    return patchText.slice(0, start) + body.join('\n') + trailing + patchText.slice(end)
  }
  if (!snippet || !Array.isArray(providers.range) || !providers.items.length) return null
  const pad = indentAt(patchText, providers.items[0].key.range[0])
  const end = providers.range[1]
  const at = patchText[end - 1] === '\n' ? end : patchText.indexOf('\n', end)
  const insertAt = at === -1 ? patchText.length : at
  const block = `${pad}${snippet.keyLine}\n${snippet.body.map((line) => pad + line).join('\n')}\n`
  return patchText.slice(0, insertAt) + block + patchText.slice(insertAt)
}


/* --- ~/.dsh/.credentials.yaml -------------------------------------------- */
//
// Keys never go into the patch: `apiKeyEnv` names an entry in the credentials
// file's `refs` map, and only that map is touched — `records` is left alone.

export function readCredentialNames(text) {
  const doc = parseYamlDocument(text, '凭据文件')
  const refs = YAML.isMap(doc.contents) ? doc.contents.get('refs', true) : null
  return YAML.isMap(refs) ? refs.items.map((pair) => String(nodeToJs(pair.key) ?? '')).filter(Boolean) : []
}

/**
 * Read one secret out of the credentials file's `refs` map. Host-only: the value
 * never travels back to the browser, it is used locally to authenticate a probe.
 */
export function readCredentialValue(text, name) {
  const doc = parseYamlDocument(text, '凭据文件')
  const refs = YAML.isMap(doc.contents) ? doc.contents.get('refs', true) : null
  if (!YAML.isMap(refs)) return ''
  for (const pair of refs.items) {
    if (String(nodeToJs(pair.key) ?? '') === String(name)) return String(nodeToJs(pair.value) ?? '').trim()
  }
  return ''
}

export function mergeCredentialRef(text, name, value) {
  if (!ENV_NAME_RE.test(String(name ?? ''))) {
    throw httpError(400, 'error.provider.env', '密钥引用的名字需为全大写字母/数字/下划线')
  }
  const secret = String(value ?? '').trim()
  if (!secret) throw httpError(400, 'error.provider.secret', 'API Key 不能为空')
  const doc = parseYamlDocument(text, '凭据文件')
  if (doc.contents == null) doc.contents = doc.createNode({})
  if (!YAML.isMap(doc.contents)) throw httpError(500, 'error.credentials.shape', '凭据文件顶层不是映射')
  let refs = doc.contents.get('refs', true)
  if (refs !== undefined && !YAML.isMap(refs)) {
    throw httpError(500, 'error.credentials.shape', '凭据文件的 refs 不是映射，已中止以免破坏现有记录')
  }
  if (!YAML.isMap(refs)) {
    refs = doc.createNode({})
    doc.contents.set('refs', refs)
  }
  refs.set(String(name), doc.createNode(secret))
  return YAML.stringify(doc, { lineWidth: 0 })
}

export async function readProviderState(env = process.env) {
  const p = paths(env)
  const [patchText, credentialsText] = await Promise.all([
    readTextFile(p.patchFile, ''),
    readTextFile(p.credentialsFile, ''),
  ])
  const { entryFound, providers } = readProvidersFromPatch(patchText)
  let credentialNames = []
  try {
    credentialNames = readCredentialNames(credentialsText)
  } catch {
    credentialNames = []
  }
  const list = Object.entries(providers).map(([id, raw]) => ({
    id,
    api: String(raw.api ?? ''),
    baseURL: String(raw.baseURL ?? ''),
    apiKeyEnv: String(raw.apiKeyEnv ?? ''),
    reasoning: String(raw.reasoning ?? ''),
    models: Array.isArray(raw.models) ? raw.models : [],
    modelCount: Array.isArray(raw.models) ? raw.models.length : 0,
    hasCredential: credentialNames.includes(String(raw.apiKeyEnv ?? '')),
  }))
  return {
    patchFile: p.patchFile,
    credentialsFile: p.credentialsFile,
    entryFound,
    entryId: PROVIDERS_ENTRY_ID,
    entryPackage: PROVIDERS_PACKAGE,
    levels: THINKING_LEVELS,
    providers: list,
    credentialNames,
  }
}

/** Add or update one provider in place. There is deliberately no delete path. */
export async function saveProvider(env = process.env, { providerId, provider, apiKey } = {}) {
  const id = validateProviderId(providerId)
  const p = paths(env)
  const patchText = await readTextFile(p.patchFile, '')
  const config = renderProviderConfig(provider)
  const created = !Object.prototype.hasOwnProperty.call(readProvidersFromPatch(patchText).providers, id)
  const nextPatch = mergeProviderIntoPatch(patchText, id, config)
  validatePatchText(nextPatch)

  let credentialsWritten = false
  const secret = String(apiKey ?? '').trim()
  if (secret) {
    const credentialsText = await readTextFile(p.credentialsFile, 'version: 1\n')
    const nextCredentials = mergeCredentialRef(credentialsText, config.apiKeyEnv, secret)
    await writeWithBackup(p.credentialsFile, nextCredentials, 0o600, 3)
    credentialsWritten = true
  }
  await writeWithBackup(p.patchFile, nextPatch, 0o600, 3)
  return {
    providerId: id,
    created,
    modelCount: config.models.length,
    apiKeyEnv: config.apiKeyEnv,
    credentialsWritten,
    patchFile: p.patchFile,
    credentialsFile: p.credentialsFile,
  }
}


/* --- thinking unlock ------------------------------------------------------ */
//
// The gateway's capability table is the truth. A model the gateway advertises
// levels for gets exactly those levels declared — including dropping a level the
// config had invented and the gateway does not accept — while a model the gateway
// stays silent about is left untouched, never written as `reasoningEfforts:
// false` (that would declare the model non-reasoning). Detection is read-only and
// never writes; only the unlock pass writes, and only to providers it judged to
// be a reachable OpenAI-compatible gateway.

/**
 * Decide whether one configured provider really is an OpenAI-compatible gateway
 * this page may probe. The judgement is by shape and reachability, not by name,
 * so a provider is only ever unlocked after it passes this check — and a refused
 * one carries the reason so the page can show why.
 */
export function judgeProvider(config, { credentialNames = [], env = {} } = {}) {
  const api = String(config?.api ?? '').trim()
  const baseURL = String(config?.baseURL ?? '').trim()
  const apiKeyEnv = String(config?.apiKeyEnv ?? '').trim()
  let parsed = null
  try {
    parsed = new URL(baseURL)
  } catch {
    parsed = null
  }
  if (api && api !== 'openai-completions') {
    return { verdict: 'skipped', reason: `api 是 ${api}，不是 OpenAI 兼容网关` }
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    return { verdict: 'skipped', reason: 'baseURL 不是可探测的 http(s) 地址' }
  }
  if (apiKeyEnv && !credentialNames.includes(apiKeyEnv) && !env?.[apiKeyEnv]) {
    return { verdict: 'skipped', reason: `凭据 ${apiKeyEnv} 不在凭据文件里` }
  }
  return { verdict: 'gateway', reason: `OpenAI 兼容网关 ${baseURL}` }
}

function declaredEfforts(model) {
  const raw = model?.reasoningEfforts
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  return null
}

/**
 * Decide the new `models[]` for one provider. Pure: it takes the configured rows
 * plus the gateway rows and reports what it would change, so the caller can skip
 * writing — and skip touching the file at all — when nothing is out of date.
 */
/**
 * WorkBuddy gateways announce themselves: `GET <origin>/healthz` answers without a
 * key and names the stack in `service` (`workbuddy2api` on the LAN box,
 * `workbuddy-manager` on the cloud one). A gateway that stays silent there is
 * reported as unidentified instead of being guessed at.
 */
export async function detectGatewayKind({ baseURL } = {}, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch
  let origin = ''
  try {
    origin = new URL(normalizeBaseURL(baseURL)).origin
  } catch {
    return { kind: 'unknown', reason: 'baseURL 无法解析，跳过身份探测' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), KIND_TIMEOUT_MS)
  try {
    const response = await doFetch(`${origin}/healthz`, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response || !response.ok) {
      return { kind: 'unknown', reason: `/healthz 返回 HTTP ${response ? response.status : '无响应'}` }
    }
    const header = typeof response.headers?.get === 'function' ? String(response.headers.get('x-service') || '') : ''
    const body = await response.json().catch(() => null)
    const service = String((body && body.service) || '').trim()
    if (/workbuddy/i.test(service) || /workbuddy/i.test(header)) {
      return { kind: 'workbuddy', service: service || header, source: 'healthz' }
    }
    return { kind: 'unknown', reason: `/healthz 未表明身份${service ? `（service=${service}）` : ''}` }
  } catch (err) {
    return { kind: 'unknown', reason: `/healthz 探测失败：${err?.message || String(err)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Every id on these gateways carries a realm prefix (`cn:` / `global:`). */
export function realmNamespaced(models) {
  const ids = (Array.isArray(models) ? models : []).map((m) => String(m?.id ?? '')).filter(Boolean)
  if (!ids.length) return false
  return ids.every((id) => /^(cn|global):/.test(id))
}

export function unlockPlan(configuredModels, gatewayModels) {
  const byId = new Map()
  for (const row of Array.isArray(gatewayModels) ? gatewayModels : []) {
    byId.set(String(row?.id ?? ''), row)
  }
  const report = { scanned: 0, unlocked: 0, already: 0, silent: 0, gone: 0, narrowed: 0, details: [] }
  const models = []
  for (const row of Array.isArray(configuredModels) ? configuredModels : []) {
    const model = { ...row }
    const id = String(model.id ?? '')
    report.scanned += 1
    const gateway = byId.get(id)
    if (!gateway) {
      // The gateway no longer lists it — leave the declared row untouched.
      report.gone += 1
      report.details.push({ id, status: 'gone' })
      models.push(model)
      continue
    }
    const advertised = declaredEfforts(gateway)
    if (!advertised) {
      // No thinking advertised: keep whatever was configured, never lock it.
      report.silent += 1
      report.details.push({ id, status: 'silent' })
      models.push(model)
      continue
    }
    const current = declaredEfforts(model)
    if (current && stableShape(current) === stableShape(advertised)) {
      report.already += 1
      report.details.push({ id, status: 'current', levels: Object.keys(advertised) })
      models.push(model)
      continue
    }
    model.reasoningEfforts = advertised
    const fallback = String(gateway?.reasoning ?? '').trim()
    if (fallback && Object.prototype.hasOwnProperty.call(advertised, fallback)) model.reasoning = fallback
    // The gateway table is the truth, so a level the config declared but the
    // gateway does not accept disappears. Count those so the page can say so
    // instead of narrowing a model silently.
    const from = current ? Object.keys(current) : []
    const to = Object.keys(advertised)
    const lost = from.filter((level) => !to.includes(level))
    if (lost.length) report.narrowed += 1
    report.unlocked += 1
    report.details.push({ id, status: 'unlocked', levels: to, from, to, lost })
    models.push(model)
  }
  return { models, report }
}

/**
 * Probe every configured gateway (or the given subset) and write back the
 * thinking levels each one advertises.
 *
 * Only the `llm-pi-ai` entry's own providers are reachable from here — nothing
 * else in the patch and nothing in the credentials file is touched, and each
 * rewritten provider is spliced over its own byte range so the rest of the file
 * keeps its original formatting.
 */
export async function unlockProviderThinking(env = process.env, { providerIds, dryRun = false, onlyWorkbuddy = true, fetchImpl } = {}) {
  const p = paths(env)
  const [patchText, credentialsText] = await Promise.all([
    readTextFile(p.patchFile, ''),
    readTextFile(p.credentialsFile, ''),
  ])
  const { entryFound, providers } = readProvidersFromPatch(patchText)
  if (!entryFound) {
    throw httpError(404, 'error.provider.entry', `这个 profile 的 cordis.patch.yml 里没有 - id: ${PROVIDERS_ENTRY_ID} 条目`)
  }
  let credentialNames = []
  try {
    credentialNames = readCredentialNames(credentialsText)
  } catch {
    credentialNames = []
  }
  const wanted = Array.isArray(providerIds) && providerIds.length
    ? providerIds.map((value) => validateProviderId(value))
    : Object.keys(providers)

  let nextPatch = patchText
  const results = []
  for (const id of wanted) {
    const raw = providers[id]
    if (!raw) {
      results.push({ id, status: 'missing', error: `未找到供应商：${id}` })
      continue
    }
    const judged = judgeProvider(raw, { credentialNames, env })
    if (judged.verdict !== 'gateway') {
      // Not one of the configured gateways: reported, never probed, never written.
      results.push({
        id,
        verdict: 'skipped',
        status: 'skipped',
        reason: judged.reason,
        modelCount: Array.isArray(raw.models) ? raw.models.length : 0,
      })
      continue
    }
    try {
      const envName = String(raw.apiKeyEnv ?? '')
      const secret = envName ? readCredentialValue(credentialsText, envName) || String(env?.[envName] ?? '') : ''
      const probed = await probeGateway({ baseURL: raw.baseURL, apiKey: secret }, fetchImpl)
      const identity = await detectGatewayKind({ baseURL: raw.baseURL }, fetchImpl)
      const kindSource = identity.kind === 'workbuddy' ? 'healthz' : realmNamespaced(probed.models) ? 'model-id-prefix' : null
      if (onlyWorkbuddy && !kindSource) {
        // A reachable gateway this plugin does not own: listed with the reason, never written.
        results.push({
          id,
          verdict: 'other',
          status: 'skipped',
          reason: `${identity.reason || '不是 WorkBuddy 网关'}；模型 id 也不带 cn:/global: 命名空间`,
          service: identity.service || '',
          modelCount: Array.isArray(raw.models) ? raw.models.length : 0,
          scanned: probed.models.length,
        })
        continue
      }
      const { models, report } = unlockPlan(raw.models, probed.models)
      if (dryRun) {
        // Detection only: report what is out of date without touching the file.
        results.push({ id, verdict: 'gateway', reason: judged.reason, status: report.unlocked ? 'pending' : 'current', service: identity.service || '', kindSource, modelCount: models.length, ...report })
        continue
      }
      if (!report.unlocked) {
        results.push({ id, verdict: 'gateway', reason: judged.reason, status: 'current', service: identity.service || '', kindSource, modelCount: models.length, ...report })
        continue
      }
      // Merge into a temporary first: a provider that fails to render must not
      // leave a half-built document behind for the next provider to merge into.
      const merged = mergeProviderIntoPatch(nextPatch, id, { ...raw, models })
      validatePatchText(merged)
      nextPatch = merged
      results.push({ id, verdict: 'gateway', reason: judged.reason, status: 'unlocked', service: identity.service || '', kindSource, modelCount: models.length, ...report })
    } catch (err) {
      const message = err?.message || String(err)
      results.push({ id, verdict: 'unreachable', status: 'error', reason: `探测失败：${message}`, error: message })
    }
  }

  const changed = !dryRun && nextPatch !== patchText
  if (changed) await writeWithBackup(p.patchFile, nextPatch, 0o600, 3)
  return {
    entryFound,
    entryId: PROVIDERS_ENTRY_ID,
    patchFile: p.patchFile,
    credentialsFile: p.credentialsFile,
    dryRun: !!dryRun,
    onlyWorkbuddy: !!onlyWorkbuddy,
    changed,
    providers: results,
    scannedProviders: results.length,
    gatewayProviders: results.filter((r) => r.verdict === 'gateway').map((r) => r.id),
    skippedProviders: results.filter((r) => r.verdict === 'skipped').map((r) => r.id),
    otherProviders: results.filter((r) => r.verdict === 'other').map((r) => r.id),
    workbuddyProviders: results.filter((r) => r.verdict === 'gateway').map((r) => r.id),
    unlockedProviders: results.filter((r) => (r.unlocked || 0) > 0).map((r) => r.id),
    unlockedModels: results.reduce((total, r) => total + (r.unlocked || 0), 0),
  }
}
