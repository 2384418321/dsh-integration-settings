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
