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
  'providers.title': '思考解锁',
  'providers.desc': '打开即自动识别 OpenAI 兼容网关支持的思考档位，一键解锁到模型选择器',
}
const EN = {
  'group.title': 'Integrations',
  'mcp.title': 'MCP servers',
  'mcp.desc': 'Manage MCP servers visually (writes the profile cordis.patch.yml)',
  'skills.title': 'Skills',
  'skills.desc': 'Browse, edit and create SKILL.md files',
  'persona.title': 'Global persona',
  'persona.desc': "Edit DSH's global persona file AGENTS.md",
  'providers.title': 'Thinking unlock',
  'providers.desc': 'Detects each gateway on open and unlocks its thinking levels with one click',
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

/* --------------------------------------------------------------- providers */

const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// Cadence choices for the scheduler. Kept as a literal so the client bundle has
// no dependency on the host half; the host clamps anything outside this range.
const SCHEDULE_INTERVALS = [15, 30, 60, 120, 360, 720, 1440]

// Timestamps arrive as epoch ms from the host's own clock; they are only ever
// shown, never compared against the browser's clock.
function formatTime(ms) {
  const d = new Date(Number(ms) || 0)
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Label for one model's declared thinking levels. `reasoningEfforts: false` is
 * the documented "this model does not reason" declaration, so it is spelled out
 * rather than shown as "nothing declared".
 */
function describeEfforts(model) {
  const efforts = model && model.reasoningEfforts
  if (efforts === false) return '思考 不支持'
  if (!efforts || typeof efforts !== 'object') return null
  const keys = Object.keys(efforts)
  return keys.length ? `思考 ${keys.join('/')}` : null
}

/** `档位 medium/high/low · 10 个模型不支持思考` summary for a whole provider. */
function summarizeEfforts(models) {
  const list = Array.isArray(models) ? models : []
  const levels = []
  let none = 0
  let silent = 0
  for (const model of list) {
    const efforts = model && model.reasoningEfforts
    if (efforts === false) { none += 1; continue }
    if (!efforts || typeof efforts !== 'object' || !Object.keys(efforts).length) { silent += 1; continue }
    for (const level of Object.keys(efforts)) if (!levels.includes(level)) levels.push(level)
  }
  levels.sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))
  const parts = []
  if (levels.length) parts.push(`档位 ${levels.join('/')}`)
  if (none) parts.push(`${none} 个模型不支持思考`)
  if (silent) parts.push(`${silent} 个未声明`)
  return parts.join(' · ')
}

/**
 * Thinking unlock. This page detects which of the profile's providers really are
 * OpenAI-compatible gateways, reads each gateway's own capability table and
 * writes the levels it advertises into the profile patch. Providers that cannot
 * be probed are reported, never guessed at, and nothing here adds, edits or
 * deletes a provider.
 */
const EMPTY_PROVIDER = { id: '', apiKeyEnv: '', apiKey: '', baseURL: '', reasoning: '', models: [] }

function suggestEnvName(id) {
  const base = String(id || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return base ? `${base}_API_KEY` : ''
}

/**
 * The scheduler card. It shows the cadence the background timer is running on,
 * lets the user change it, and offers the same sweep the timer performs — with
 * the honest caveat that a sweep only happens while DSH is running.
 */
function ScheduleCard({ schedule, busy, loading, error, onChange, onRunNow }) {
  if (loading && !schedule) return h('div', { className: 'dsi-hint' }, '正在读取定时更新状态…')
  if (error) return h(Note, { kind: 'error' }, `定时更新状态读取失败：${error}`)
  if (!schedule) return null
  const enabled = !!schedule.enabled
  const last = schedule.lastResult
  return h('div', { className: 'dsi-card' },
    h('div', { className: 'dsi-inline' },
      h('strong', { style: { fontSize: 13 } }, '定时更新'),
      h('span', { className: `dsi-badge ${enabled ? 'dsi-badge-on' : 'dsi-badge-off'}` },
        enabled ? `每 ${schedule.intervalMinutes} 分钟` : '已关闭'),
    ),
    h('label', { className: 'dsi-check' },
      h('input', {
        type: 'checkbox', checked: enabled, disabled: busy,
        onChange: (e) => onChange({ enabled: e.target.checked }),
      }),
      h('span', null, '自动获取最新思考档位并写回配置（无需打开本页面）')),
    h('div', { className: 'dsi-grid2' },
      h(Field, { label: '更新间隔', hint: '到点才执行；睡眠/合盖跨过的时段不会补跑。' },
        h('select', {
          className: 'dsi-select', value: String(schedule.intervalMinutes), disabled: busy,
          onChange: (e) => onChange({ intervalMinutes: Number(e.target.value) }),
        },
          SCHEDULE_INTERVALS.map((minutes) => h('option', { key: minutes, value: String(minutes) },
            minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`)),
        ),
      ),
      h(Field, { label: '范围', hint: '与「全部解锁」使用同一判断。' },
        h('label', { className: 'dsi-check', style: { paddingTop: 6 } },
          h('input', {
            type: 'checkbox', checked: !!schedule.onlyWorkbuddy, disabled: busy,
            onChange: (e) => onChange({ onlyWorkbuddy: e.target.checked }),
          }),
          h('span', null, '只处理 WorkBuddy 网关')),
      ),
    ),
    h('div', { className: 'dsi-hint' },
      `下次 ${schedule.nextRunAt ? formatTime(schedule.nextRunAt) : '开启后一个周期'}`
      + `　上次 ${schedule.lastRunAt ? formatTime(schedule.lastRunAt) : '从未执行'}`
      + (last
        ? `（${last.changed ? `更新 ${last.unlockedModels} 个模型` : '无改动'}${(last.failedProviders || []).length ? `，探测失败 ${last.failedProviders.join('、')}` : ''}）`
        : '')
      + (schedule.lastError ? `　上次错误：${schedule.lastError}` : '')),
    h('div', { className: 'dsi-hint' },
      '仅在 DeepSeek Harness 运行期间生效：退出后计时暂停，重启时若已到点会立即补一次，之后按新间隔继续。'),
    h('div', { className: 'dsi-inline' },
      h(Button, { variant: 'primary', disabled: busy, onClick: onRunNow }, busy ? '执行中…' : '立即执行一次'),
    ),
  )
}

function ProviderEditor({ draft, setDraft, saving, probing, isNew, onCancel, onSave, onProbe }) {
  const patch = (part) => setDraft((prev) => ({ ...prev, ...part }))
  const models = draft.models || []
  const chosen = models.filter((m) => m.checked)
  const levels = []
  for (const model of chosen) {
    for (const level of Object.keys(model.reasoningEfforts || {})) if (!levels.includes(level)) levels.push(level)
  }
  levels.sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))
  const toggle = (id, checked) => patch({ models: models.map((m) => (m.id === id ? { ...m, checked } : m)) })
  const setAll = (checked) => patch({ models: models.map((m) => ({ ...m, checked })) })

  return h('div', { className: 'dsi-card' },
    h('div', { className: 'dsi-inline' },
      h('strong', { style: { fontSize: 13 } }, isNew ? '新增供应商' : `编辑供应商：${draft.id}`),
      h('span', { className: 'dsi-badge' }, `${chosen.length}/${models.length} 个模型已勾选`),
    ),
    h('div', { className: 'dsi-grid2' },
      h(Field, { label: 'id', hint: '1–32 位字母/数字/点/下划线/连字符；会出现在模型选择器里' },
        h(Text, {
          value: draft.id, mono: true, placeholder: 'workbudy-lan', disabled: !isNew,
          onChange: (v) => patch({ id: v, apiKeyEnv: !draft.apiKeyEnv ? suggestEnvName(v) : draft.apiKeyEnv }),
        }),
      ),
      h(Field, { label: 'baseURL', hint: 'OpenAI 兼容根地址，通常以 /v1 结尾' },
        h(Text, { value: draft.baseURL, mono: true, placeholder: 'http://192.168.2.202:7863/v1', onChange: (v) => patch({ baseURL: v }) }),
      ),
      h(Field, { label: 'apiKeyEnv', hint: '密钥在凭据文件里的引用名；密钥本身不会写进 cordis.patch.yml' },
        h(Text, { value: draft.apiKeyEnv, mono: true, placeholder: 'WORKBUDY_LAN_API_KEY', onChange: (v) => patch({ apiKeyEnv: v }) }),
      ),
      h(Field, { label: 'apiKey', hint: isNew ? '粘贴网关密钥，保存时写入凭据文件' : '留空表示不改动已保存的密钥' },
        h('input', {
          className: 'dsi-input dsi-mono', type: 'password', autoComplete: 'off', placeholder: 'sk-…',
          value: draft.apiKey, onChange: (e) => patch({ apiKey: e.target.value }),
        }),
      ),
    ),
    h('div', { className: 'dsi-inline' },
      h(Button, { disabled: probing || saving || !draft.baseURL, onClick: onProbe }, probing ? '正在连接…' : '测试连接并拉取模型'),
      models.length ? h(Button, { disabled: saving, onClick: () => setAll(true) }, '全选') : null,
      models.length ? h(Button, { disabled: saving, onClick: () => setAll(false) }, '全不选') : null,
    ),
    models.length
      ? h('div', { style: { maxHeight: 300, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
        models.map((model) => h('label', {
          key: model.id, className: 'dsi-check',
          style: { padding: '5px 7px', borderRadius: 7, background: 'color-mix(in srgb, currentColor 4%, transparent)' },
        },
          h('input', { type: 'checkbox', checked: !!model.checked, onChange: (e) => toggle(model.id, e.target.checked) }),
          h('span', { className: 'dsi-mono', style: { fontSize: 11.5 } }, model.id),
          model.name && model.name !== model.id ? h('span', { style: { opacity: 0.6, fontSize: 11 } }, model.name) : null,
          h('span', { style: { opacity: 0.45, fontSize: 10.5, marginLeft: 'auto', whiteSpace: 'nowrap' } },
            [
              model.contextWindow ? `ctx ${model.contextWindow}` : null,
              model.maxTokens ? `max ${model.maxTokens}` : null,
              describeEfforts(model),
            ].filter(Boolean).join(' · ')),
        )),
      )
      : h('div', { className: 'dsi-hint' }, '还没有模型列表：填好 baseURL（和密钥）后点「测试连接并拉取模型」。'),
    levels.length
      ? h(Field, { label: '默认思考档位（可选）', hint: '新对话的默认推理强度；只列出所选模型共同支持的档位' },
        h('select', { className: 'dsi-select', value: draft.reasoning, onChange: (e) => patch({ reasoning: e.target.value }) },
          h('option', { value: '' }, '不指定（用模型自带的默认档）'),
          levels.map((level) => h('option', { key: level, value: level }, level)),
        ),
      )
      : null,
    h('div', { className: 'dsi-inline' },
      h(Button, { variant: 'primary', disabled: saving || !chosen.length, onClick: onSave }, saving ? '保存中…' : '保存'),
      h(Button, { disabled: saving, onClick: onCancel }, '取消'),
    ),
  )
}

function ProviderSection(props) {
  const sessionId = sessionIdOf(props)
  logSeat('settings.section', props)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const state = useAsync(() => api(`/state?session=${encodeURIComponent(sessionId || '')}&root=`, { sessionId }), [sessionId])
  const data = state.data
  const info = (data && data.providers) || {}
  const providers = info.providers || []
  const patchFile = info.patchFile || (data && data.paths && data.paths.patchFile) || ''
  const credentialsFile = info.credentialsFile || ''
  const providerKey = providers.map((p) => p.id).join(',')
  const [scan, setScan] = useState({ loading: false, at: null, error: null, data: null })
  const [onlyWorkbuddy, setOnlyWorkbuddy] = useState(true)
  const [draft, setDraft] = useState(null)
  const [probing, setProbing] = useState(false)

  // Read-only detection: probes every provider the host judged to be a gateway
  // and reports which models are missing thinking levels. Writes nothing.
  const detect = async () => {
    if (!providers.length) return
    setScan({ loading: true, at: null, error: null, data: null })
    try {
      const result = await api('/provider/unlock', {
        method: 'POST',
        sessionId,
        body: { providerIds: providers.map((p) => p.id), dryRun: true, onlyWorkbuddy },
      })
      setScan({ loading: false, at: Date.now(), error: null, data: result })
    } catch (err) {
      setScan({ loading: false, at: Date.now(), error: err.message || String(err), data: null })
    }
  }

  useEffect(() => { detect() }, [providerKey, sessionId, onlyWorkbuddy]) // eslint-disable-line react-hooks/exhaustive-deps

  const unlockAll = async () => {
    if (!providers.length) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const result = await api('/provider/unlock', {
        method: 'POST',
        sessionId,
        body: { providerIds: providers.map((p) => p.id), onlyWorkbuddy },
      })
      const rows = result.providers || []
      const failed = rows.filter((r) => r.status === 'error')
      const parts = [result.unlockedModels
        ? `已解锁 ${result.unlockedModels} 个模型（${(result.unlockedProviders || []).join('、')}）`
        : '所有网关的思考档位都已是最新，没有改动文件']
      if (failed.length) parts.push(`探测失败：${failed.map((r) => `${r.id}（${r.error}）`).join('；')}`)
      if (result.changed) parts.push('写配置前已自动备份，重启 DeepSeek Harness 后生效。')
      setMessage(parts.join('　'))
      state.reload()
      await detect()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  const startNew = () => { setError(null); setMessage(null); setDraft({ ...EMPTY_PROVIDER }) }
  // The id is deliberately not editable afterwards: there is no rename path,
  // and therefore no path that removes one provider to create another.
  const startEdit = (provider) => {
    setError(null); setMessage(null)
    setDraft({
      id: provider.id,
      apiKeyEnv: provider.apiKeyEnv || '',
      apiKey: '',
      baseURL: provider.baseURL || '',
      reasoning: provider.reasoning || '',
      models: (provider.models || []).map((m) => ({ ...m, checked: true })),
    })
  }

  const probe = async () => {
    if (!draft) return
    setProbing(true); setError(null); setMessage(null)
    try {
      const pulled = await api('/provider/probe', { method: 'POST', sessionId, body: { baseURL: draft.baseURL, apiKey: draft.apiKey } })
      const models = (pulled.models || []).map((m) => ({ ...m, checked: true }))
      setDraft((prev) => (prev ? { ...prev, models } : prev))
      setMessage(`网关返回 ${models.length} 个模型，已全部勾选。`)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setProbing(false)
    }
  }

  const save = async () => {
    if (!draft) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const chosen = (draft.models || []).filter((m) => m.checked)
      const result = await api('/provider/save', {
        method: 'POST',
        sessionId,
        body: {
          providerId: draft.id.trim(),
          apiKey: draft.apiKey,
          provider: { apiKeyEnv: draft.apiKeyEnv, api: 'openai-completions', baseURL: draft.baseURL, reasoning: draft.reasoning, models: chosen },
        },
      })
      setMessage(`${result.created ? '已新增' : '已更新'}供应商 ${result.providerId}（${result.modelCount} 个模型）`
        + `${result.credentialsWritten ? '，密钥已写入凭据文件' : ''}。重启 DeepSeek Harness 后生效。`)
      setDraft(null)
      state.reload()
      await detect()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  // The scheduler's own state. It lives in the host, not in this component, so a
  // page reload shows the same cadence the background timer is running on.
  const [schedule, setSchedule] = useState(null)
  const [scheduleBusy, setScheduleBusy] = useState(false)
  const scheduleState = useAsync(
    () => api(`/provider/schedule?session=${encodeURIComponent(sessionId || '')}`, { sessionId }),
    [sessionId],
  )
  useEffect(() => { setSchedule(scheduleState.data || null) }, [scheduleState.data])

  const saveSchedule = async (part) => {
    if (!schedule) return
    setScheduleBusy(true); setError(null); setMessage(null)
    try {
      const next = await api('/provider/schedule', {
        method: 'POST',
        sessionId,
        body: { ...schedule, ...part },
      })
      setSchedule(next)
      setMessage(part.enabled === false
        ? '已关闭定时更新；已经到点的那一次不会再写配置。'
        : `定时更新已保存：每 ${next.intervalMinutes} 分钟，仅在 DeepSeek Harness 运行期间生效。`)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setScheduleBusy(false)
    }
  }

  const runNow = async () => {
    setScheduleBusy(true); setError(null); setMessage(null)
    try {
      const result = await api('/provider/schedule/run', { method: 'POST', sessionId, body: {} })
      const rows = (result.report && result.report.providers) || []
      const failed = rows.filter((r) => r.status === 'error')
      const parts = []
      if (!result.ran) parts.push('还没到点，未执行。')
      else if (!result.report) parts.push(`未能完成解锁：${result.error || '未知原因'}`)
      else if (result.report.unlockedModels) parts.push(`已更新 ${result.report.unlockedModels} 个模型的思考档位`)
      else parts.push('各网关的思考档位都已是最新，没有改动文件')
      if (failed.length) parts.push(`探测失败：${failed.map((r) => `${r.id}（${r.error}）`).join('；')}`)
      if (result.report && result.report.changed) parts.push('写配置前已自动备份，重启 DeepSeek Harness 后生效。')
      setMessage(parts.join('　'))
      scheduleState.reload()
      state.reload()
      await detect()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setScheduleBusy(false)
    }
  }

  const scanned = (scan.data && scan.data.providers) || []
  const scanFor = (id) => scanned.find((r) => r.id === id) || null
  const detailFor = (providerId, modelId) => {
    const row = scanFor(providerId)
    return (row && (row.details || []).find((d) => d.id === modelId)) || null
  }

  const kindBadge = (id) => {
    const row = scanFor(id)
    if (!row) return null
    if (row.verdict === 'gateway') {
      const how = row.kindSource === 'model-id-prefix' ? '按模型命名空间' : '按 /healthz'
      return h('span', { className: 'dsi-badge dsi-badge-on' }, `WorkBuddy${row.service ? ` · ${row.service}` : ''}（${how}）`)
    }
    if (row.verdict === 'other') return h('span', { className: 'dsi-badge dsi-badge-off' }, '非 WorkBuddy 网关')
    return null
  }

  const scanBadge = (id) => {
    const row = scanFor(id)
    if (!row) return null
    if (row.verdict === 'skipped') return h('span', { className: 'dsi-badge' }, '不处理')
    if (row.verdict === 'unreachable' || row.status === 'error') return h('span', { className: 'dsi-badge dsi-badge-off' }, '探测失败')
    if (row.status === 'missing') return h('span', { className: 'dsi-badge dsi-badge-off' }, '配置已不在文件里')
    const parts = []
    if (row.unlocked) parts.push(`待解锁 ${row.unlocked}`)
    if (row.already) parts.push(`已一致 ${row.already}`)
    if (row.silent) parts.push(`网关未声明 ${row.silent}`)
    if (row.gone) parts.push(`网关已不提供 ${row.gone}`)
    return h('span', { className: row.unlocked ? 'dsi-badge dsi-badge-off' : 'dsi-badge dsi-badge-on' },
      parts.join(' · ') || `${row.scanned} 个模型`)
  }

  const pending = (scan.data && scan.data.unlockedModels) || 0
  const pendingRows = scanned.reduce((rows, r) => rows.concat((r.details || []).filter((d) => d.status === 'unlocked')), [])
  const narrowedRows = pendingRows.filter((d) => (d.lost || []).length)
  const skippedRows = scanned.filter((r) => r.verdict === 'skipped' || r.verdict === 'other')

  return h(Panel, {
    title: '思考解锁',
    desc: h('span', null, '打开页面即自动识别每个网关支持的思考档位（只读探测，不改文件）；点「全部解锁」把网关实际支持的档位写进 ',
      h('code', null, patchFile || 'profile/cordis.patch.yml'),
      '　按网关形态自动判断：只处理这个 profile 里 ',
      h('code', null, info.entryId || 'llm-pi-ai'),
      ' 条目下真正的 WorkBuddy 网关（先认 ',
      h('code', null, '/healthz'),
      ' 里的 service 名称，认不出时看模型 id 是否带 cn:/global: 命名空间），识别结果逐行标注，其余跳过并说明原因；写前自动备份，重启 DSH 后生效。'),
    actions: h(React.Fragment, null,
      h(Button, { variant: 'primary', disabled: busy || scan.loading || !providers.length, onClick: unlockAll },
        pending ? `全部解锁（${pending} 个模型待更新）` : '全部解锁'),
      h(Button, { disabled: busy, onClick: () => { state.reload(); detect() } }, '重新识别'),
      h(Button, { disabled: busy, onClick: startNew }, '新增网关'),
    ),
    footer: patchFile ? `配置文件：${patchFile}${credentialsFile ? `　密钥文件：${credentialsFile}` : ''}` : null,
  },
    h(Styles),
    h(Note, { kind: 'error' }, error),
    h(Note, { kind: 'ok' }, message),
    h(ScheduleCard, {
      schedule, busy: scheduleBusy || busy, loading: scheduleState.loading, error: scheduleState.error,
      onChange: saveSchedule, onRunNow: runNow,
    }),
    scan.loading ? h('div', { className: 'dsi-hint' }, '正在识别网关支持的思考档位…') : null,
    scan.error ? h(Note, { kind: 'error' }, `自动识别失败：${scan.error}`) : null,
    scan.data && !scan.data.unlockedModels && providers.length
      ? h('div', { className: 'dsi-hint' }, '已识别的网关，思考档位都已是最新。') : null,
    pendingRows.length
      ? h('div', { className: 'dsi-hint' },
        `检测到 ${pendingRows.length} 个模型的档位与网关不一致`
        + (narrowedRows.length ? `（其中 ${narrowedRows.length} 个会减少档位）` : '')
        + '：'
        + pendingRows.slice(0, 3).map((d) => `${d.id}（${(d.from && d.from.length ? d.from : ['未声明']).join('/')} → ${d.to.join('/')}）`).join('；')
        + (pendingRows.length > 3 ? ` 等 ${pendingRows.length} 个` : ''))
      : null,
    skippedRows.length
      ? h('div', { className: 'dsi-hint' }, `${skippedRows.length} 个供应商不参与解锁：`
        + skippedRows.map((r) => `${r.id}（${r.reason || '不适用'}）`).join('；'))
      : null,
    providers.length
      ? h('label', { className: 'dsi-check', style: { marginTop: '6px' } },
        h('input', { type: 'checkbox', checked: onlyWorkbuddy, onChange: (e) => setOnlyWorkbuddy(e.target.checked) }),
        h('span', null, '只解锁 WorkBuddy 网关（先看 ', h('code', null, '/healthz'), ' 的 service 名称，再看模型 id 是否都带 ',
          h('code', null, 'cn:'), ' / ', h('code', null, 'global:'), ' 命名空间；取消勾选才会去改其它网关）'))
      : null,
    draft
      ? h(ProviderEditor, {
        draft, setDraft, saving: busy, probing, isNew: !providers.some((p) => p.id === draft.id),
        onCancel: () => setDraft(null), onSave: save, onProbe: probe,
      })
      : null,
    state.loading && !data ? h(Spinner) : null,
    state.error ? h(Note, { kind: 'error' }, `读取失败：${state.error}`) : null,
    !providers.length && !state.loading ? h('div', { className: 'dsi-empty' }, '这个 profile 的 llm-pi-ai 条目下还没有配置任何供应商。') : null,
    providers.map((provider) => {
      const row = scanFor(provider.id)
      const open = expanded === provider.id
      return h('div', { className: 'dsi-row', key: provider.id },
        h('div', { className: 'dsi-row-main' },
          h('div', { className: 'dsi-row-name' }, provider.id,
            h('span', { className: 'dsi-badge' }, `${provider.modelCount} 模型`),
            kindBadge(provider.id),
            scanBadge(provider.id),
            provider.apiKeyEnv
              ? h('span', { className: provider.hasCredential ? 'dsi-badge dsi-badge-on' : 'dsi-badge dsi-badge-off' },
                provider.hasCredential ? '密钥已配置' : '缺少密钥')
              : null),
          h('div', { className: 'dsi-row-meta' },
            [
              provider.baseURL || '(未设置 baseURL)',
              provider.apiKeyEnv || '(未设置 apiKeyEnv)',
              provider.reasoning ? `默认思考 ${provider.reasoning}` : null,
              summarizeEfforts(provider.models) || null,
            ].filter(Boolean).join(' · ')),
          row && row.reason ? h('div', { className: 'dsi-row-meta' }, `${(row.verdict === 'skipped' || row.verdict === 'other') ? '未参与原因' : '探测结果'}：${row.reason}`) : null,
        ),
        h('div', { className: 'dsi-toolbar' },
          h(Button, { disabled: busy, onClick: () => setExpanded(open ? null : provider.id) }, open ? '收起模型' : '查看模型'),
          h(Button, { disabled: busy, onClick: () => startEdit(provider) }, '编辑'),
        ),
        open ? h('div', { className: 'dsi-card', style: { marginTop: '8px' } },
          h('div', { className: 'dsi-hint' }, `${(provider.models || []).length} 个模型（当前写在配置里的思考档位）`),
          (provider.models || []).map((model) => {
            const detail = detailFor(provider.id, model.id)
            const changed = detail && detail.status === 'unlocked'
            return h('div', { className: 'dsi-row-meta', key: model.id },
              h('span', { className: 'dsi-mono' }, model.id),
              '　',
              describeEfforts(model) || '未声明档位',
              changed ? `　→ 网关支持 ${detail.to.join('/')}${(detail.lost || []).length ? `（会去掉 ${detail.lost.join('/')}）` : ''}` : null,
              detail && detail.status === 'silent' ? '　网关未声明，保持原样' : null,
              detail && detail.status === 'gone' ? '　网关已不提供，保持原样' : null,
            )
          })) : null,
      )
    }),
  )
}

/* ------------------------------------------------------------- registration */

export function apply(ctx) {
  const t = makeT(ctx)
  const sections = [
    { id: 'integration-mcp', order: 61, labelKey: 'mcp.title', Component: McpSection },
    { id: 'integration-skills', order: 62, labelKey: 'skills.title', Component: SkillSection },
    { id: 'integration-persona', order: 63, labelKey: 'persona.title', Component: PersonaSection },
    { id: 'integration-providers', order: 64, labelKey: 'providers.title', Component: ProviderSection },
  ]
  for (const section of sections) {
    ctx.effect(() =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: section.id,
            order: section.order,
            label: () => t(section.labelKey),
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
