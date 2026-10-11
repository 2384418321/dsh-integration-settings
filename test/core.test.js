// Unit tests for the plugin's pure/file logic. Run: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'

import {
  PLUGIN_NAME,
  MCP_PACKAGE,
  START_MARK,
  END_MARK,
  paths,
  resolveProfileDir,
  profileNameFromArgv,
  validateServer,
  renderManagedBlock,
  applyManagedBlock,
  validatePatchText,
  extractMcpRows,
  readMcpState,
  writeMcpServers,
  skillRoots,
  skillRootPath,
  readSkill,
  writeSkill,
  deleteSkill,
  listSkills,
  readPersona,
  readPersonaBackup,
  savePersona,
  writeWithBackup,
  listBackups,
} from '../src/core.js'

const BASE_PATCH = `- id: ui-settings
  name: dsh-web-app
  config:
    enabled: true
`

async function makeEnv() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsi-test-'))
  const home = path.join(root, 'dsh')
  const profile = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(profile, { recursive: true })
  await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: [PLUGIN_NAME] } } }))
  await fsp.writeFile(path.join(profile, 'cordis.patch.yml'), BASE_PATCH)
  return { root, env: { DSH_HOME: home, DSH_PROFILE_DIR: profile, HOME: path.join(root, 'home') } }
}

const stdioServer = (name, extra = {}) => ({ serverName: name, transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], ...extra })

test('paths() resolves under DSH_HOME / DSH_PROFILE_DIR', async () => {
  const { env } = await makeEnv()
  const p = paths(env)
  assert.equal(p.profileDir, env.DSH_PROFILE_DIR)
  assert.equal(p.patchFile, path.join(env.DSH_PROFILE_DIR, 'cordis.patch.yml'))
  assert.equal(p.mcpFile, path.join(env.DSH_PROFILE_DIR, '.dsh-integration', 'mcp.json'))
  assert.equal(p.personaFile, path.join(env.DSH_HOME, 'AGENTS.md'))
})

test('resolveProfileDir prefers the running host profile over every inference', async () => {
  const { env } = await makeEnv()
  const hostDir = path.join(env.DSH_HOME, 'profiles', 'other')
  await fsp.mkdir(hostDir, { recursive: true })
  const ctx = { get: (name) => (name === 'desktopProfiles' ? { current: { name: 'other', dir: hostDir } } : undefined) }
  assert.equal(resolveProfileDir(env, ctx), hostDir)
  // host service without a usable dir falls through to DSH_PROFILE_DIR
  assert.equal(resolveProfileDir(env, { get: () => ({ current: { name: 'other' } }) }), env.DSH_PROFILE_DIR)
  assert.equal(resolveProfileDir(env, { get: () => { throw new Error('no such service') } }), env.DSH_PROFILE_DIR)
})

test('resolveProfileDir falls back to DSH_PROFILE, the installed-profile scan and desktop', async () => {
  const { env } = await makeEnv()
  const noDir = { DSH_HOME: env.DSH_HOME, HOME: env.HOME, DSH_PROFILE: 'desktop' }
  assert.equal(resolveProfileDir(noDir, {}), env.DSH_PROFILE_DIR) // single match
  const solo = { ...noDir, DSH_PROFILE: '' }
  assert.equal(resolveProfileDir(solo, {}), env.DSH_PROFILE_DIR) // still the only match
  // a second profile with the plugin installed: desktop still wins
  const second = path.join(env.DSH_HOME, 'profiles', 'tui')
  await fsp.mkdir(second, { recursive: true })
  await fsp.writeFile(path.join(second, 'package.json'), JSON.stringify({ name: 'dsh-profile-tui', dsh: { profile: { bundles: [PLUGIN_NAME] } } }))
  assert.equal(resolveProfileDir(solo, {}), env.DSH_PROFILE_DIR)
  assert.equal(resolveProfileDir({ ...solo, DSH_PROFILE: 'tui' }, {}), second)
  // a named profile that does not exist is not trusted
  assert.equal(resolveProfileDir({ ...solo, DSH_PROFILE: 'nope' }, {}), env.DSH_PROFILE_DIR)
})

test('resolveProfileDir refuses to guess when several non-desktop profiles match', async () => {
  const { env } = await makeEnv()
  await fsp.rm(path.join(env.DSH_HOME, 'profiles', 'desktop'), { recursive: true, force: true })
  for (const name of ['aaa', 'bbb']) {
    const dir = path.join(env.DSH_HOME, 'profiles', name)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [PLUGIN_NAME]: 'link:.' } }))
  }
  const noDir = { DSH_HOME: env.DSH_HOME, HOME: env.HOME, DSH_PROFILE: '' }
  assert.throws(() => resolveProfileDir(noDir, {}), (err) => err.code === 'ambiguous_profile')
})

test('profileNameFromArgv reads --profile and --profile=', () => {
  assert.equal(profileNameFromArgv(['node', 'dsh', '--profile', 'desktop']), 'desktop')
  assert.equal(profileNameFromArgv(['node', 'dsh', '--profile=tui', '--no-open']), 'tui')
  assert.equal(profileNameFromArgv(['node', 'dsh', '--port', '19787']), undefined)
})

test('validateServer accepts stdio and streamable-http, rejects invalid input', () => {
  assert.equal(validateServer(stdioServer('github')).serverName, 'github')
  const http = validateServer({ serverName: 'web', transport: 'streamable-http', url: 'http://localhost:3000/mcp' })
  assert.equal(http.transport, 'streamable-http')
  assert.throws(() => validateServer({ serverName: 'bad name!', transport: 'stdio', command: 'x' }), /serverName/)
  assert.throws(() => validateServer({ serverName: 'a'.repeat(33), transport: 'stdio', command: 'x' }), /serverName/)
  assert.throws(() => validateServer({ serverName: 'x', transport: 'stdio' }), /command/)
  assert.throws(() => validateServer({ serverName: 'x', transport: 'streamable-http' }), /url/)
  assert.throws(() => validateServer({ serverName: 'x', transport: 'nope', command: 'y' }), /transport/)
  assert.throws(() => validateServer({ serverName: 'x', transport: 'stdio', command: 'y', toolCallTimeoutMs: -1 }), /toolCallTimeoutMs/)
})

test('renderManagedBlock emits one insert row per enabled server', () => {
  const block = renderManagedBlock([
    stdioServer('github', { env: { GITHUB_TOKEN: '!!js process.env.GITHUB_TOKEN' } }),
    stdioServer('off', { enabled: false }),
    { serverName: 'web', transport: 'streamable-http', url: 'http://localhost:3000/mcp' },
  ])
  assert.ok(block.startsWith(START_MARK))
  assert.ok(block.trimEnd().endsWith(END_MARK))
  assert.match(block, /- insert:/)
  assert.match(block, /id: mcp-github/)
  assert.match(block, new RegExp(MCP_PACKAGE.replace(/[/@]/g, (m) => `\\${m}`)))
  assert.ok(block.includes('!!js process.env.GITHUB_TOKEN'), '!!js expression survives serialization')
  assert.ok(!block.includes('mcp-off'), 'disabled servers are not rendered')
  assert.match(block, /id: mcp-web/)
  assert.doesNotThrow(() => validatePatchText(block))
})

test('applyManagedBlock appends once, then replaces in place', () => {
  const first = applyManagedBlock(BASE_PATCH, renderManagedBlock([stdioServer('github')]))
  assert.ok(first.startsWith(BASE_PATCH.trimEnd()))
  const second = applyManagedBlock(first, renderManagedBlock([stdioServer('github'), stdioServer('extra')]))
  assert.equal(second.split(START_MARK).length - 1, 1, 'exactly one managed block')
  assert.ok(second.includes('mcp-extra'))
  assert.ok(second.includes('enabled: true'), 'hand-written content preserved')
  assert.doesNotThrow(() => validatePatchText(second))
  assert.equal(applyManagedBlock(BASE_PATCH, renderManagedBlock([stdioServer('github')])), first, 'idempotent')
})

test('renderManagedBlock emits real !!js tags (not quoted literals) everywhere', () => {
  const block = renderManagedBlock([
    stdioServer('github', {
      env: { GITHUB_TOKEN: '!!js process.env.GITHUB_TOKEN', PLAIN: 'value' },
      args: ['-y', '!!js String(process.env.PKG)'],
    }),
  ])
  assert.match(block, /GITHUB_TOKEN: !!js process\.env\.GITHUB_TOKEN/, 'env tag emitted, unquoted')
  assert.match(block, /PLAIN: value/)
  assert.match(block, /- !!js String\(process\.env\.PKG\)/, 'args may carry expressions too')
  assert.match(block, /- -y/, 'plain args stay strings')
  assert.ok(!/!!js\s+process\.env\.GITHUB_TOKEN['"]/.test(block), 'no trailing quote after the tag value')
  const doc = YAML.parseDocument(block)
  assert.deepEqual(doc.errors, [])
  const parsed = doc.toJS()[0].insert[0].config.env.GITHUB_TOKEN
  assert.equal(typeof parsed, 'string')
  assert.ok(!parsed.includes('!!js'), 'tag is consumed by the parser, not left in the value')
  assert.equal(extractMcpRows(block)[0].env.GITHUB_TOKEN, '!!js process.env.GITHUB_TOKEN')
  assert.deepEqual(extractMcpRows(block)[0].args, ['-y', '!!js String(process.env.PKG)'])
})

test('applyManagedBlock refuses a half-written managed block', () => {
  const broken = `${BASE_PATCH}\n${START_MARK}\n- insert: []\n`
  assert.throws(() => applyManagedBlock(broken, renderManagedBlock([])), /结束标记/)
})

test('applyManagedBlock replaces a brand new profile\'s "[]" placeholder', () => {
  const template = '# Your patch layer for this dsh profile\n# applied after every bundle layer\n[]\n'
  const block = renderManagedBlock([stdioServer('probe')])
  const next = applyManagedBlock(template, block)
  assert.ok(next.includes('# Your patch layer'), 'template comments preserved')
  assert.ok(!/^\[\]$/m.test(next), 'placeholder removed')
  assert.doesNotThrow(() => validatePatchText(next))
  assert.equal(extractMcpRows(next).length, 1)
  // and it stays valid on the next save
  const again = applyManagedBlock(next, renderManagedBlock([stdioServer('probe'), stdioServer('two')]))
  assert.doesNotThrow(() => validatePatchText(again))
  assert.equal(again.split(START_MARK).length - 1, 1)
  assert.equal(applyManagedBlock('', block), block)
})

test('extractMcpRows reads insert rows and standalone rows back out of the patch', () => {
  const patch = applyManagedBlock(BASE_PATCH, renderManagedBlock([
    stdioServer('github', { args: ['-y', '@modelcontextprotocol/server-github'], env: { TOKEN: '!!js process.env.TOKEN' } }),
  ]))
  const rows = extractMcpRows(patch)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].serverName, 'github')
  assert.deepEqual(rows[0].args, ['-y', '@modelcontextprotocol/server-github'])
  assert.equal(rows[0].env.TOKEN, '!!js process.env.TOKEN')

  const handWritten = `${BASE_PATCH}- id: mcp-manual\n  name: '${MCP_PACKAGE}'\n  config:\n    serverName: manual\n    transport: stdio\n    command: uvx\n`
  const manual = extractMcpRows(handWritten)
  assert.equal(manual.length, 1)
  assert.equal(manual[0].serverName, 'manual')
  assert.equal(manual[0].command, 'uvx')
})

test('writeMcpServers keeps JSON as the source of truth and rewrites the patch block', async () => {
  const { env } = await makeEnv()
  await writeMcpServers([stdioServer('github'), { serverName: 'off', transport: 'stdio', command: 'echo', enabled: false }], env)
  const state = await readMcpState(env)
  assert.equal(state.initialized, true)
  assert.equal(state.servers.length, 2)

  const patch = await fsp.readFile(paths(env).patchFile, 'utf8')
  assert.ok(patch.startsWith(BASE_PATCH.trimEnd()))
  assert.equal(patch.split(START_MARK).length - 1, 1)
  assert.ok(!patch.includes('mcp-off'))

  await writeMcpServers([stdioServer('only')], env)
  const next = await fsp.readFile(paths(env).patchFile, 'utf8')
  assert.equal(next.split(START_MARK).length - 1, 1, 'no duplicate blocks on rewrite')
  assert.ok(!next.includes('mcp-github'))

  await assert.rejects(() => writeMcpServers([stdioServer('dup'), stdioServer('DUP')], env), /重复/)
})

test('skill roots cover global and project scopes', async () => {
  const { env, root } = await makeEnv()
  const cwd = path.join(root, 'proj')
  const globalIds = skillRoots(env).map((r) => r.id)
  assert.deepEqual(globalIds, ['dsh-global', 'agents-global', 'claude-global', 'codex-global'])
  const ids = skillRoots(env, cwd).map((r) => r.id)
  assert.ok(ids.includes('dsh-project') && ids.includes('agents-project') && ids.includes('claude-project'))
  assert.equal(skillRootPath('dsh-project', env, cwd), path.join(cwd, '.dsh', 'skills'))
  assert.equal(skillRootPath('dsh-global', env), path.join(env.DSH_HOME, 'skills'))
  assert.throws(() => skillRootPath('nope', env), /技能目录/)
  assert.throws(() => skillRootPath('dsh-project', env, null), /技能目录/)
})

test('skill write / read / list / delete round trip', async () => {
  const { env } = await makeEnv()
  const rootPath = skillRootPath('dsh-global', env)
  await writeSkill(rootPath, { dir: 'my-skill', name: 'my-skill', description: 'Use when testing', body: '## 概览\n- 步骤一\n' })

  const listed = await listSkills(rootPath)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'my-skill')
  assert.equal(listed[0].description, 'Use when testing')

  const skill = await readSkill(rootPath, 'my-skill')
  assert.equal(skill.frontmatter.name, 'my-skill')
  assert.match(skill.body, /步骤一/)

  await assert.rejects(() => writeSkill(rootPath, { dir: 'bad-dir', name: 'bad-dir', description: '' }), /description/)
  await assert.rejects(() => writeSkill(rootPath, { dir: 'Bad Dir', name: 'x', description: 'd' }), /kebab-case/)
  await assert.rejects(() => writeSkill(rootPath, { dir: '../escape', name: 'x', description: 'd' }), /目录名/)
  await assert.rejects(() => readSkill(rootPath, '../../etc'), /目录名/)
  await assert.rejects(() => deleteSkill(rootPath, 'missing'), /技能不存在/)

  await deleteSkill(rootPath, 'my-skill')
  assert.deepEqual(await listSkills(rootPath), [])
})

test('listSkills tolerates a missing root and skips non-skill directories', async () => {
  const { env } = await makeEnv()
  const rootPath = skillRootPath('dsh-global', env)
  assert.deepEqual(await listSkills(rootPath), [])
  await fsp.mkdir(path.join(rootPath, 'not-a-skill'), { recursive: true })
  assert.deepEqual(await listSkills(rootPath), [])
})

test('persona save writes, keeps at most three backups, and reads back', async () => {
  const { env } = await makeEnv()
  assert.equal((await readPersona(env)).files[0].exists, false)

  for (let index = 0; index < 5; index += 1) {
    await savePersona(env, { scope: 'global', content: `# 人设 v${index}\n` })
  }
  const state = await readPersona(env)
  assert.equal(state.files[0].exists, true)
  assert.equal(state.files[0].content, '# 人设 v4\n')
  assert.equal(state.backups.length, 3)

  const backup = await readPersonaBackup(env, state.backups[0].name)
  assert.match(backup.content, /^# 人设 v\d/)
  await assert.rejects(() => readPersonaBackup(env, '../AGENTS.md'), /不合法/)
  await assert.rejects(() => readPersonaBackup(env, 'AGENTS.md.bak-99999999'), /未找到/)
})

test('persona project scope requires a cwd', async () => {
  const { env, root } = await makeEnv()
  const cwd = path.join(root, 'proj')
  await fsp.mkdir(cwd, { recursive: true })
  const scopes = (await readPersona(env, cwd)).files.map((f) => f.scope)
  assert.deepEqual(scopes, ['global', 'project'])
  assert.equal((await readPersona(env)).files.length, 1, 'no project entry without a cwd')
  await savePersona(env, { scope: 'project', cwd, content: '# 项目人设\n' })
  const saved = (await readPersona(env, cwd)).files.find((f) => f.scope === 'project')
  assert.equal(saved.content, '# 项目人设\n')
  await assert.rejects(() => savePersona(env, { scope: 'nope', cwd, content: 'x' }), /未知的作用域/)
})

test('writeWithBackup rotates timestamped copies', async () => {
  const { root } = await makeEnv()
  const file = path.join(root, 'note.md')
  for (let index = 0; index < 4; index += 1) {
    await writeWithBackup(file, `v${index}`, 0o600, 2)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(await fsp.readFile(file, 'utf8'), 'v3')
  assert.equal((await listBackups(file)).length, 2)
})
