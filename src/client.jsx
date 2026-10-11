// Client half of dsh-integration-settings: three settings pages.
import React from 'react'

const NS = 'dsh-integration-settings'
const API = '/api/dsh-integration'
const { useState, useEffect, useMemo, useRef, useCallback } = React

/* ------------------------------------------------------------------ locale */

const ZH = {
  'group.title': '集成管理',
  'mcp.title': 'MCP 管理',
  'mcp.desc': '可视化管理 MCP 服务器（写入当前 profile 的 cordis.patch.yml）',
  'skills.title': 'Skill 管理',
  'skills.desc': '可视化浏览、编辑、新建技能文件（SKILL.md）',
  'persona.title': '全局人设',
  'persona.desc': '可视化编辑 DSH 的全局人设文件 AGENTS.md',
}
const EN = {
  'group.title': 'Integrations',
  'mcp.title': 'MCP servers',
  'mcp.desc': 'Manage MCP servers visually (writes the profile cordis.patch.yml)',
  'skills.title': 'Skills',
  'skills.desc': 'Browse, edit and create SKILL.md files',
  'persona.title': 'Global persona',
  'persona.desc': "Edit DSH's global persona file AGENTS.md",
}

function makeT(ctx) {
  let bound = null
  try {
    if (ctx && ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
      try { ctx.locale.register(NS, 'zh', ZH) } catch { /* already registered */ }
      try { ctx.locale.register(NS, 'en', EN) } catch { /* already registered */ }
      bound = ctx.locale.bind(NS)
    }
  } catch { bound = null }
  return (key) => {
    if (bound) {
      try {
        const value = bound(key)
        if (value && value !== key) return value
      } catch { /* fall through */ }
    }
    return ZH[key] || key
  }
}

/* --------------------------------------------------------------------- api */

/**
 * The caller's session id, when the shell hands one to this seat.
 *
 * `settings.section` is a root-scope slot, so the session kit is not part of the
 * guaranteed props share, and the seat can be bound differently between renders.
 * Only a plain prop may be read here: calling a shell-provided hook under a guard
 * — or swallowing its throw — desynchronises React's hook chain for this entry,
 * and the next `useState` in the component fails ("more hooks than during the
 * previous render"). The shell catches that in a per-entry error boundary and
 * replaces the whole pane with an empty `data-slot-error` div, which is exactly
 * the blank settings page this function must never cause.
 *
 * Without a session id the host answers with global scope only, which is a
 * normal state, not an error.
 */
export function sessionIdOf(props) {
  const value = props ? props.sessionId : null
  if (!value) return null
  if (typeof value === 'string') return value
  return value.sessionId || value.id || (value.session && value.session.id) || null
}

/**
 * Opt-in diagnostic: log the seat share once, only when the console asks for it
 * with `localStorage.dsiDebug = '1'`. Never runs by default, so a shipped build
 * keeps the user's console clean.
 */
let seatLogged = false
function logSeat(entryId, props) {
  if (seatLogged || !props) return
  try {
    if (typeof localStorage === 'undefined' || !localStorage.getItem('dsiDebug')) return
    seatLogged = true
    const keys = Object.keys(props)
    console.log('[dsi] seat', entryId, 'keys=', keys.join(','), 'hooks=', keys.filter((k) => k.startsWith('use')).join(','))
  } catch { /* diagnostics must never break the pane */ }
}

async function api(path, { method = 'GET', body, sessionId } = {}) {
  const headers = {}
  if (sessionId) headers['x-dsh-integration-session'] = sessionId
  if (method !== 'GET') {
    headers['content-type'] = 'application/json'
    headers['x-dsh-integration'] = '1'
  }
  const res = await fetch(API + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { payload = null }
  if (!res.ok || !payload || payload.ok !== true) {
    throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`)
  }
  return payload.data
}

/* ---------------------------------------------------------------- ui atoms */

const h = React.createElement

function Styles() {
  useEffect(() => {
    if (document.getElementById('dsi-styles')) return undefined
    const el = document.createElement('style')
    el.id = 'dsi-styles'
    el.textContent = CSS
    document.head.appendChild(el)
    return undefined
  }, [])
  return null
}

const CSS = `
.dsi-root { display:flex; flex-direction:column; gap:14px; color:inherit; font:inherit; min-width:0; }
.dsi-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.dsi-title { font-size:15px; font-weight:600; margin:0; }
.dsi-sub { font-size:12px; opacity:.66; margin:2px 0 0; line-height:1.5; }
.dsi-sub code { font-size:11px; opacity:.9; word-break:break-all; }
.dsi-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.dsi-btn { font:inherit; font-size:12px; padding:5px 11px; border-radius:7px; cursor:pointer;
  border:1px solid color-mix(in srgb, currentColor 22%, transparent);
  background:color-mix(in srgb, currentColor 7%, transparent); color:inherit; transition:background .12s ease; }
.dsi-btn:hover:not(:disabled) { background:color-mix(in srgb, currentColor 14%, transparent); }
.dsi-btn:disabled { opacity:.45; cursor:not-allowed; }
.dsi-btn-primary { background:color-mix(in srgb, #2f6fed 82%, transparent); border-color:transparent; color:#fff; }
.dsi-btn-primary:hover:not(:disabled) { background:color-mix(in srgb, #2f6fed 92%, transparent); }
.dsi-btn-danger { color:#e5484d; border-color:color-mix(in srgb, #e5484d 40%, transparent); background:transparent; }
.dsi-btn-danger:hover:not(:disabled) { background:color-mix(in srgb, #e5484d 12%, transparent); }
.dsi-card { border:1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px; }
.dsi-row { display:flex; align-items:center; gap:10px; padding:9px 11px; border-radius:9px; border:1px solid color-mix(in srgb, currentColor 12%, transparent); }
.dsi-row:hover { background:color-mix(in srgb, currentColor 4%, transparent); }
.dsi-row-main { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.dsi-row-name { font-size:13px; font-weight:600; display:flex; align-items:center; gap:7px; }
.dsi-row-meta { font-size:11px; opacity:.6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsi-badge { font-size:10px; padding:1px 6px; border-radius:99px; background:color-mix(in srgb, currentColor 13%, transparent); opacity:.85; font-weight:500; letter-spacing:.02em; }
.dsi-badge-on { background:color-mix(in srgb, #2fbf71 22%, transparent); color:#1f8f52; }
.dsi-badge-off { background:color-mix(in srgb, currentColor 10%, transparent); opacity:.5; }
.dsi-field { display:flex; flex-direction:column; gap:4px; }
.dsi-label { font-size:12px; font-weight:500; opacity:.85; }
.dsi-hint { font-size:11px; opacity:.55; line-height:1.45; }
.dsi-input, .dsi-textarea, .dsi-select { font:inherit; font-size:12.5px; padding:6px 9px; border-radius:7px; color:inherit;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent); background:color-mix(in srgb, currentColor 4%, transparent); width:100%; box-sizing:border-box; }
.dsi-input:focus, .dsi-textarea:focus, .dsi-select:focus { outline:2px solid color-mix(in srgb, #2f6fed 45%, transparent); outline-offset:-1px; }
.dsi-textarea { resize:vertical; line-height:1.55; }
.dsi-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dsi-grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; }
.dsi-tabs { display:flex; gap:6px; }
.dsi-tab { font:inherit; font-size:12px; padding:5px 12px; border-radius:99px; cursor:pointer; border:1px solid transparent;
  background:color-mix(in srgb, currentColor 7%, transparent); color:inherit; }
.dsi-tab-active { background:color-mix(in srgb, #2f6fed 16%, transparent); border-color:color-mix(in srgb, #2f6fed 45%, transparent); font-weight:600; }
.dsi-note { font-size:12px; padding:8px 11px; border-radius:8px; line-height:1.5; }
.dsi-error { background:color-mix(in srgb, #e5484d 14%, transparent); color:#c62a2f; }
.dsi-ok { background:color-mix(in srgb, #2fbf71 16%, transparent); color:#1f8f52; }
.dsi-empty { font-size:12px; opacity:.55; padding:16px; text-align:center; border:1px dashed color-mix(in srgb, currentColor 22%, transparent); border-radius:10px; }
.dsi-pre { font-family:ui-monospace, Menlo, monospace; font-size:11px; line-height:1.5; padding:10px; border-radius:8px; margin:0;
  background:color-mix(in srgb, currentColor 5%, transparent); border:1px solid color-mix(in srgb, currentColor 12%, transparent);
  white-space:pre-wrap; word-break:break-all; max-height:280px; overflow:auto; }
.dsi-footer { font-size:11px; opacity:.5; line-height:1.5; word-break:break-all; }
.dsi-inline { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dsi-check { display:flex; gap:7px; align-items:center; font-size:12px; }
`

function Button({ children, variant, ...rest }) {
  const cls = `dsi-btn${variant ? ` dsi-btn-${variant}` : ''}`
  return h('button', { type: 'button', className: cls, ...rest }, children)
}

function Field({ label, hint, children }) {
  return h('label', { className: 'dsi-field' },
    h('span', { className: 'dsi-label' }, label),
    children,
    hint ? h('span', { className: 'dsi-hint' }, hint) : null,
  )
}

function Text({ value, onChange, placeholder, mono, ...rest }) {
  return h('input', {
    className: `dsi-input${mono ? ' dsi-mono' : ''}`,
    value: value == null ? '' : value,
    placeholder,
    onChange: (e) => onChange(e.target.value),
    ...rest,
  })
}

function Area({ value, onChange, rows = 6, mono, placeholder, ...rest }) {
  return h('textarea', {
    className: `dsi-textarea${mono ? ' dsi-mono' : ''}`,
    value: value == null ? '' : value,
    rows,
    placeholder,
    spellCheck: false,
    onChange: (e) => onChange(e.target.value),
    ...rest,
  })
}

function Note({ kind = 'error', children }) {
  if (!children) return null
  return h('div', { className: `dsi-note dsi-${kind}` }, children)
}

function Panel({ title, desc, actions, children, footer }) {
  return h('div', { className: 'dsi-root' },
    h('div', { className: 'dsi-head' },
      h('div', null,
        h('h3', { className: 'dsi-title' }, title),
        desc ? h('p', { className: 'dsi-sub' }, desc) : null,
      ),
      actions ? h('div', { className: 'dsi-toolbar' }, actions) : null,
    ),
    children,
    footer ? h('div', { className: 'dsi-footer' }, footer) : null,
  )
}

function Spinner({ text = '加载中…' }) {
  return h('div', { className: 'dsi-empty' }, text)
}

function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: null }))
    Promise.resolve()
      .then(fn)
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => setState({ loading: false, error: err.message || String(err), data: null }))
  }, deps || [])
  useEffect(() => { reload() }, [reload])
  return { ...state, reload, setState }
}

function linesToList(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
}

function linesToMap(text) {
  const out = {}
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    const key = (idx === -1 ? line : line.slice(0, idx)).trim()
    const value = idx === -1 ? '' : line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function mapToLines(map) {
  if (!map || typeof map !== 'object') return ''
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n')
}

/* --------------------------------------------------------------- MCP page */

const EMPTY_SERVER = {
  serverName: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  cwd: '',
  url: '',
  headersText: '',
  toolCallTimeoutMs: '',
  maxInstructionBytes: '',
  failOnStartupError: false,
  enabled: true,
}

function serverToDraft(server) {
  return {
    ...EMPTY_SERVER,
    ...server,
    argsText: Array.isArray(server.args) ? server.args.join('\n') : '',
    envText: mapToLines(server.env),
    headersText: mapToLines(server.headers),
    toolCallTimeoutMs: server.toolCallTimeoutMs == null ? '' : String(server.toolCallTimeoutMs),
    maxInstructionBytes: server.maxInstructionBytes == null ? '' : String(server.maxInstructionBytes),
    enabled: server.enabled !== false,
  }
}

function draftToServer(draft) {
  const server = {
    serverName: String(draft.serverName || '').trim(),
    transport: draft.transport,
    enabled: draft.enabled !== false,
  }
  if (draft.transport === 'stdio') {
    server.command = String(draft.command || '').trim()
    const args = linesToList(draft.argsText)
    if (args.length) server.args = args
    const env = linesToMap(draft.envText)
    if (Object.keys(env).length) server.env = env
    if (String(draft.cwd || '').trim()) server.cwd = String(draft.cwd).trim()
  } else {
    server.url = String(draft.url || '').trim()
    const headers = linesToMap(draft.headersText)
    if (Object.keys(headers).length) server.headers = headers
  }
  if (String(draft.toolCallTimeoutMs || '').trim()) server.toolCallTimeoutMs = Number(draft.toolCallTimeoutMs)
  if (String(draft.maxInstructionBytes || '').trim()) server.maxInstructionBytes = Number(draft.maxInstructionBytes)
  if (draft.failOnStartupError) server.failOnStartupError = true
  return server
}

function McpEditor({ draft, setDraft, onCancel, onSave, saving, isNew }) {
  const patch = (part) => setDraft((prev) => ({ ...prev, ...part }))
  const nameLocked = !isNew
  return h('div', { className: 'dsi-card' },
    h('div', { className: 'dsi-inline' },
      h('strong', { style: { fontSize: 13 } }, isNew ? '新增 MCP 服务器' : `编辑：${draft.serverName}`),
      h('span', { className: 'dsi-badge' }, draft.transport),
    ),
    h('div', { className: 'dsi-grid2' },
      h(Field, { label: 'serverName', hint: '1–32 位字母/数字/下划线/连字符，工具名会变成 mcp__<serverName>__<tool>' },
        h(Text, { value: draft.serverName, onChange: (v) => patch({ serverName: v }), placeholder: 'github', disabled: nameLocked, className: 'dsi-input dsi-mono' }),
      ),
      h(Field, { label: 'transport' },
        h('select', { className: 'dsi-select', value: draft.transport, onChange: (e) => patch({ transport: e.target.value }) },
          h('option', { value: 'stdio' }, 'stdio（本地进程）'),
          h('option', { value: 'streamable-http' }, 'streamable-http（远程）'),
        ),
      ),
    ),
    draft.transport === 'stdio'
      ? h(React.Fragment, null,
        h(Field, { label: 'command', hint: '可执行文件，例如 npx / uvx / node' },
          h(Text, { value: draft.command, onChange: (v) => patch({ command: v }), placeholder: 'npx', mono: true }),
        ),
        h(Field, { label: 'args', hint: '每行一个参数' },
          h(Area, { value: draft.argsText, onChange: (v) => patch({ argsText: v }), rows: 3, mono: true, placeholder: '-y\n@modelcontextprotocol/server-github' }),
        ),
        h(Field, { label: 'env', hint: '每行 KEY=VALUE；值写 !!js process.env.XXX 可避免把密钥写进配置文件' },
          h(Area, { value: draft.envText, onChange: (v) => patch({ envText: v }), rows: 3, mono: true, placeholder: 'GITHUB_TOKEN=!!js process.env.GITHUB_TOKEN' }),
        ),
        h(Field, { label: 'cwd（可选）' },
          h(Text, { value: draft.cwd, onChange: (v) => patch({ cwd: v }), mono: true }),
        ),
      )
      : h(React.Fragment, null,
        h(Field, { label: 'url' },
          h(Text, { value: draft.url, onChange: (v) => patch({ url: v }), placeholder: 'http://localhost:3000/mcp', mono: true }),
        ),
        h(Field, { label: 'headers', hint: '每行 KEY=VALUE' },
          h(Area, { value: draft.headersText, onChange: (v) => patch({ headersText: v }), rows: 3, mono: true, placeholder: 'Authorization=Bearer xxx' }),
        ),
      ),
    h('div', { className: 'dsi-grid2' },
      h(Field, { label: 'toolCallTimeoutMs（可选，默认 60000）' },
        h(Text, { value: draft.toolCallTimeoutMs, onChange: (v) => patch({ toolCallTimeoutMs: v }), mono: true }),
      ),
      h(Field, { label: 'maxInstructionBytes（可选，默认 32768）' },
        h(Text, { value: draft.maxInstructionBytes, onChange: (v) => patch({ maxInstructionBytes: v }), mono: true }),
      ),
    ),
    h('div', { className: 'dsi-inline' },
      h('label', { className: 'dsi-check' },
        h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e) => patch({ enabled: e.target.checked }) }),
        '启用（取消勾选只从配置中移除，配置仍保留）',
      ),
      h('label', { className: 'dsi-check' },
        h('input', { type: 'checkbox', checked: !!draft.failOnStartupError, onChange: (e) => patch({ failOnStartupError: e.target.checked }) }),
        '启动失败时视为致命',
      ),
    ),
    h('div', { className: 'dsi-toolbar' },
      h(Button, { variant: 'primary', onClick: () => onSave(draftToServer(draft)), disabled: saving }, saving ? '保存中…' : '保存'),
      h(Button, { onClick: onCancel, disabled: saving }, '取消'),
    ),
  )
}

function McpSection(props) {
  const sessionId = sessionIdOf(props)
  logSeat('settings.section', props)
  const [draft, setDraft] = useState(null)
  const [isNew, setIsNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [showPreview, setShowPreview] = useState(false)
  const state = useAsync(() => api(`/state?session=${encodeURIComponent(sessionId || '')}&root=`, { sessionId }), [sessionId])
  const data = state.data

  const run = async (fn, okText) => {
    setBusy(true); setError(null); setMessage(null)
    try {
      await fn()
      setMessage(okText)
      state.reload()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  const servers = (data && data.mcp && data.mcp.servers) || []
  const importable = (data && data.mcp && data.mcp.importable) || []
  const patchFile = data && data.paths ? data.paths.patchFile : ''

  const actions = h(React.Fragment, null,
    h(Button, { variant: 'primary', onClick: () => { setIsNew(true); setDraft({ ...EMPTY_SERVER }) }, disabled: !!draft }, '新增服务器'),
    h(Button, { onClick: state.reload, disabled: busy }, '刷新'),
  )

  return h(Panel, {
    title: 'MCP 管理',
    desc: h('span', null, '增删改 MCP 服务器，写入 ', h('code', null, patchFile || 'profile/cordis.patch.yml'), '　（保存后需重启 DSH 生效）'),
    actions,
    footer: patchFile ? `配置文件：${patchFile}` : null,
  },
    h(Styles),
    h(Note, { kind: 'error' }, error),
    h(Note, { kind: 'ok' }, message),
    state.loading && !data ? h(Spinner) : null,
    state.error ? h(Note, { kind: 'error' }, `读取失败：${state.error}`) : null,

    importable.length
      ? h('div', { className: 'dsi-note', style: { background: 'color-mix(in srgb, #f5a524 18%, transparent)' } },
        h('div', { style: { marginBottom: 8 } }, `检测到 ${importable.length} 个未纳管的 MCP 配置（手工写在 patch 里）：${importable.map((s) => s.serverName).join('、')}`),
        h(Button, {
          disabled: busy,
          onClick: () => run(() => api('/mcp/import', { method: 'POST', sessionId, body: { serverNames: importable.map((s) => s.serverName) } }), '已导入未纳管配置'),
        }, '全部导入以便可视化编辑'),
      )
      : null,

    draft ? h(McpEditor, {
      draft, setDraft, saving: busy, isNew,
      onCancel: () => { setDraft(null); setIsNew(false) },
      onSave: (server) => run(async () => {
        await api('/mcp/save', { method: 'POST', sessionId, body: { server, previousName: isNew ? null : draft.serverName } })
        setDraft(null); setIsNew(false)
      }, `已保存 ${server.serverName}`),
    }) : null,

    !servers.length && !state.loading
      ? h('div', { className: 'dsi-empty' }, '还没有 MCP 服务器，点右上角「新增服务器」开始。')
      : null,

    servers.map((server) => h('div', { className: 'dsi-row', key: server.serverName },
      h('div', { className: 'dsi-row-main' },
        h('div', { className: 'dsi-row-name' },
          server.serverName,
          h('span', { className: 'dsi-badge' }, server.transport),
          server.enabled === false ? h('span', { className: 'dsi-badge dsi-badge-off' }, '已停用') : h('span', { className: 'dsi-badge dsi-badge-on' }, '启用'),
        ),
        h('div', { className: 'dsi-row-meta' },
          server.transport === 'streamable-http'
            ? server.url
            : [server.command, ...(server.args || [])].join(' '),
        ),
      ),
      h('div', { className: 'dsi-toolbar' },
        h(Button, { onClick: () => { setIsNew(false); setDraft(serverToDraft(server)) }, disabled: busy || !!draft }, '编辑'),
        h(Button, {
          disabled: busy,
          onClick: () => run(() => api('/mcp/toggle', { method: 'POST', sessionId, body: { serverName: server.serverName, enabled: server.enabled === false } }), server.enabled === false ? '已启用' : '已停用'),
        }, server.enabled === false ? '启用' : '停用'),
        h(Button, {
          variant: 'danger', disabled: busy,
          onClick: () => {
            if (!window.confirm(`确定删除 MCP 服务器「${server.serverName}」？`)) return
            run(() => api('/mcp/delete', { method: 'POST', sessionId, body: { serverName: server.serverName } }), `已删除 ${server.serverName}`)
          },
        }, '删除'),
      ),
    )),

    data && data.mcp
      ? h('div', null,
        h(Button, { onClick: () => setShowPreview((v) => !v) }, showPreview ? '隐藏生成的配置' : '查看生成的配置'),
        showPreview ? h('pre', { className: 'dsi-pre', style: { marginTop: 8 } }, data.mcp.managedPreview) : null,
      )
      : null,
  )
}

/* ------------------------------------------------------------ skills page */

function SkillEditor({ rootId, skill, onDone, onError, sessionId }) {
  const isNew = !skill || skill.isNew
  const [dir, setDir] = useState(skill && skill.dir ? skill.dir : '')
  const [name, setName] = useState(skill && skill.frontmatter && skill.frontmatter.name ? skill.frontmatter.name : '')
  const [description, setDescription] = useState(skill && skill.frontmatter && skill.frontmatter.description ? skill.frontmatter.description : '')
  const [body, setBody] = useState(skill && skill.body ? skill.body : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const target = dir || name
      await api('/skill/save', { method: 'POST', sessionId, body: { root: rootId, dir: target, name: name || target, description, body } })
      onDone(isNew ? '已新建技能' : '已保存技能')
    } catch (err) {
      setError(err.message || String(err))
      if (onError) onError(err)
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: 'dsi-card' },
    h('strong', { style: { fontSize: 13 } }, isNew ? '新建技能' : `编辑：${dir}`),
    h(Note, null, error),
    h(Field, { label: '目录名 / name', hint: 'kebab-case，决定技能目录名' },
      h(Text, { value: dir, onChange: (v) => { setDir(v); if (isNew) setName(v) }, placeholder: 'my-skill', mono: true, disabled: !isNew }),
    ),
    h(Field, { label: 'description', hint: '必填：一句话说明何时使用该技能' },
      h(Text, { value: description, onChange: setDescription, placeholder: 'Use when …' }),
    ),
    h(Field, { label: '正文（Markdown）' },
      h(Area, { value: body, onChange: setBody, rows: 16, mono: true, placeholder: '## 概览\n…' }),
    ),
    h('div', { className: 'dsi-toolbar' },
      h(Button, { variant: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
      h(Button, { onClick: () => onDone(null), disabled: busy }, '关闭'),
    ),
  )
}

function SkillSection(props) {
  const sessionId = sessionIdOf(props)
  logSeat('settings.section', props)
  const [rootId, setRootId] = useState(null)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const query = rootId ? `&root=${encodeURIComponent(rootId)}` : ''
  // Project-scoped skill roots need a session context, which a root-scope
  // settings entry does not have; saying so beats silently hiding directories.
  const scopeHint = sessionId ? '' : '　项目级技能目录需要会话上下文，这里显示的是全局视图。'
  const state = useAsync(() => api(`/state?session=${encodeURIComponent(sessionId || '')}${query}`, { sessionId }), [sessionId, rootId])
  const data = state.data
  const roots = (data && data.skills && data.skills.roots) || []
  const activeRootId = (data && data.skills && data.skills.rootId) || null
  const list = (data && data.skills && data.skills.list) || []

  const openSkill = async (dir) => {
    setBusy(true); setError(null)
    try {
      const skill = await api(`/skill/read?root=${encodeURIComponent(activeRootId)}&dir=${encodeURIComponent(dir)}`, { sessionId })
      setEditing(skill)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = (dir) => {
    if (!window.confirm(`确定删除技能「${dir}」？该目录会被整体删除。`)) return
    setBusy(true); setError(null)
    api('/skill/delete', { method: 'POST', sessionId, body: { root: activeRootId, dir } })
      .then(() => { setMessage(`已删除 ${dir}`); state.reload() })
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setBusy(false))
  }

  return h(Panel, {
    title: 'Skill 管理',
    desc: `浏览与编辑各技能目录下的 SKILL.md；保存后对之后的会话立即生效。${scopeHint}`,
    actions: h(React.Fragment, null,
      h(Button, { variant: 'primary', onClick: () => setEditing({ isNew: true, dir: '', frontmatter: {}, body: '' }), disabled: !!editing }, '新建技能'),
      h(Button, { onClick: state.reload, disabled: busy }, '刷新'),
    ),
    footer: data && data.skills ? `当前目录：${(roots.find((r) => r.id === activeRootId) || {}).path || ''}` : null,
  },
    h(Styles),
    h(Note, { kind: 'error' }, error),
    h(Note, { kind: 'ok' }, message),
    roots.length
      ? h('div', { className: 'dsi-tabs' }, roots.map((root) =>
        h('button', {
          key: root.id, type: 'button',
          className: `dsi-tab${root.id === activeRootId ? ' dsi-tab-active' : ''}`,
          onClick: () => { setRootId(root.id); setEditing(null) },
          title: root.path,
        }, root.label),
      ))
      : null,
    state.loading && !data ? h(Spinner) : null,
    state.error ? h(Note, { kind: 'error' }, `读取失败：${state.error}`) : null,
    editing ? h(SkillEditor, {
      rootId: activeRootId, skill: editing, sessionId,
      onDone: (msg) => { setEditing(null); if (msg) { setMessage(msg); state.reload() } },
    }) : null,
    !list.length && !state.loading && !editing ? h('div', { className: 'dsi-empty' }, '该目录下还没有技能。') : null,
    list.map((skill) => h('div', { className: 'dsi-row', key: skill.dir },
      h('div', { className: 'dsi-row-main' },
        h('div', { className: 'dsi-row-name' }, skill.name, h('span', { className: 'dsi-badge' }, `${skill.bodyLines} 行`)),
        h('div', { className: 'dsi-row-meta' }, skill.description || '（无 description）'),
      ),
      h('div', { className: 'dsi-toolbar' },
        h(Button, { onClick: () => openSkill(skill.dir), disabled: busy || !!editing }, '编辑'),
        h(Button, { variant: 'danger', onClick: () => remove(skill.dir), disabled: busy }, '删除'),
      ),
    )),
  )
}

/* ----------------------------------------------------------- persona page */

function PersonaSection(props) {
  const sessionId = sessionIdOf(props)
  logSeat('settings.section', props)
  const [scope, setScope] = useState('global')
  const [text, setText] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const state = useAsync(() => api(`/state?session=${encodeURIComponent(sessionId || '')}`, { sessionId }), [sessionId])
  const data = state.data
  const files = (data && data.persona && data.persona.files) || []
  const current = files.find((file) => file.scope === scope) || files[0] || null
  const globalPath = data && data.persona ? data.persona.globalPath : ''

  useEffect(() => {
    if (text === null && current) setText(current.content || '')
  }, [current, text])

  const save = async () => {
    setBusy(true); setError(null); setMessage(null)
    try {
      const result = await api('/persona/save', {
        method: 'POST', sessionId,
        body: { scope: current.scope, cwd: data && data.session ? data.session.cwd : null, content: text || '' },
      })
      setMessage(`已保存（${result.bytes} 字节），已自动生成备份`)
      state.reload()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  const template = `# 全局人设\n\n## 身份\n- 你是 ……\n\n## 语言与风格\n- 始终使用中文回答\n- ……\n\n## 工作习惯\n- ……\n`

  return h(Panel, {
    title: '全局人设',
    desc: h('span', null, '等价于 Claude Code 的 CLAUDE.md：写入 ', h('code', null, globalPath || '~/.dsh/AGENTS.md'), '，作为所有会话的基线指令注入。', sessionId ? '' : '　项目级人设需要会话上下文，这里编辑的是全局人设。'),
    actions: h(React.Fragment, null,
      h(Button, { variant: 'primary', onClick: save, disabled: busy || text === null }, busy ? '保存中…' : '保存'),
      h(Button, { onClick: state.reload, disabled: busy }, '重新载入'),
    ),
    footer: current ? `${current.path}　${current.exists ? `${current.bytes} 字节` : '（文件不存在，保存后创建）'}` : null,
  },
    h(Styles),
    h(Note, { kind: 'error' }, error),
    h(Note, { kind: 'ok' }, message),
    files.length > 1
      ? h('div', { className: 'dsi-tabs' }, files.map((file) =>
        h('button', {
          key: file.scope, type: 'button',
          className: `dsi-tab${file.scope === scope ? ' dsi-tab-active' : ''}`,
          onClick: () => { setScope(file.scope); setText(null) },
          title: file.path,
        }, file.label),
      ))
      : null,
    state.loading && !data ? h(Spinner) : null,
    state.error ? h(Note, { kind: 'error' }, `读取失败：${state.error}`) : null,
    current ? h(React.Fragment, null,
      !current.exists && text !== null && !text.trim()
        ? h('div', { className: 'dsi-inline' }, h(Button, { onClick: () => setText(template) }, '填入模板'))
        : null,
      h(Area, { value: text === null ? '' : text, onChange: setText, rows: 20, mono: true, placeholder: '# 全局人设' }),
      h('div', { className: 'dsi-sub' }, `${(text || '').length} 字符`),
    ) : null,
    data && data.persona && data.persona.backups && data.persona.backups.length
      ? h('div', null,
        h('div', { className: 'dsi-label', style: { marginBottom: 6 } }, '历史备份（最近 3 份，点击载入编辑器）'),
        data.persona.backups.map((backup) => h('div', { className: 'dsi-row', key: backup.name },
          h('div', { className: 'dsi-row-main' },
            h('div', { className: 'dsi-row-name' }, backup.name),
            h('div', { className: 'dsi-row-meta' }, `创建于 ${new Date(backup.mtimeMs).toLocaleString()}`),
          ),
          h('div', { className: 'dsi-toolbar' },
            h(Button, {
              disabled: busy,
              onClick: async () => {
                setError(null)
                try {
                  const backupFile = await api(`/persona/backup?name=${encodeURIComponent(backup.name)}`, { sessionId })
                  setText(backupFile.content)
                  setMessage(`已把备份 ${backup.name} 载入编辑器，确认后点「保存」生效`)
                } catch (err) {
                  setError(err.message || String(err))
                }
              },
            }, '载入编辑器'),
          ),
        )),
      )
      : null,
  )
}

/* ------------------------------------------------------------- registration */

export function apply(ctx) {
  const t = makeT(ctx)
  const sections = [
    { id: 'integration-mcp', order: 61, label: t('mcp.title'), Component: McpSection },
    { id: 'integration-skills', order: 62, label: t('skills.title'), Component: SkillSection },
    { id: 'integration-persona', order: 63, label: t('persona.title'), Component: PersonaSection },
  ]
  for (const section of sections) {
    ctx.effect(() =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: section.id,
            order: section.order,
            label: () => t(section.id === 'integration-mcp' ? 'mcp.title' : section.id === 'integration-skills' ? 'skills.title' : 'persona.title'),
            locale: NS,
          },
          section.Component,
        ),
      ),
    )
  }
}

export const inject = ['slots', 'locale']
export const name = NS
