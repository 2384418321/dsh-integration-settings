// Loads the built client bundle the way the DSH web shell does, then checks
// that it registers the three settings sections on the slots service.
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function reactStub() {
  const noop = () => {}
  const fn = () => noop
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, noop],
    useEffect: noop,
    useMemo: (factory) => (typeof factory === 'function' ? factory() : undefined),
    useRef: (initial) => ({ current: initial }),
    useCallback: (callback) => callback,
    version: '18.3.1',
    default: undefined,
  }
}

async function loadClient() {
  const source = await fsp.readFile(path.join(root, 'lib', 'client.js'), 'utf8')
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load: (entry) => { loaded = entry },
    },
  }
  window.__ModuleLoader__.load = (entry) => {
    loaded = { id: entry.id, exports: entry.factory((name) => {
      if (name === 'react') return reactStub()
      throw new Error(`unexpected external require: ${name}`)
    }) }
  }
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load once')
  assert.equal(loaded.id, 'dsh-integration-settings')
  return loaded.exports
}

function fakeCtx({ locale } = {}) {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    ctx: {
      effect: (fn) => { fn(); return () => {} },
      slots: {
        inject: (name, callback) => { injected.push(name); return callback() },
        register: (spec, component) => { registered.push({ spec, component }); return () => {} },
      },
      locale,
    },
  }
}

test('client bundle exports the plugin surface', async () => {
  const mod = await loadClient()
  assert.equal(mod.name, 'dsh-integration-settings')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

test('client bundle registers the three settings sections without a locale service', async () => {
  const mod = await loadClient()
  const { ctx, registered, injected } = fakeCtx()
  mod.apply(ctx)

  assert.deepEqual(injected, ['settings.section', 'settings.section', 'settings.section'])
  assert.equal(registered.length, 3)
  const ids = registered.map((entry) => entry.spec.id)
  assert.deepEqual(ids, ['integration-mcp', 'integration-skills', 'integration-persona'])
  for (const entry of registered) {
    assert.equal(entry.spec.name, 'settings.section')
    assert.equal(typeof entry.spec.order, 'number')
    assert.equal(typeof entry.spec.label, 'function')
    assert.ok(entry.spec.label().length > 0, 'label resolves to text even without locale')
    assert.ok(!('icon' in entry.spec), 'icon is optional and omitted')
    assert.equal(typeof entry.component, 'function')
  }
  const titles = registered.map((entry) => entry.spec.label())
  assert.deepEqual(titles, ['MCP 管理', 'Skill 管理', '全局人设'])
  assert.ok(registered[0].spec.order < registered[1].spec.order)
  assert.ok(registered[1].spec.order < registered[2].spec.order)
})

test('client bundle survives a locale service and localizes labels through it', async () => {
  const mod = await loadClient()
  const dicts = []
  const locale = {
    register: (ns, tag, dict) => { dicts.push({ ns, tag, keys: Object.keys(dict).length }); return () => {} },
    bind: (ns) => (key) => ({ 'mcp.title': 'MCP servers', 'skills.title': 'Skills', 'persona.title': 'Global persona' }[key] || key),
  }
  const { ctx, registered } = fakeCtx({ locale })
  mod.apply(ctx)

  assert.equal(dicts.length, 2, 'registers the zh and en dictionaries')
  assert.deepEqual(dicts.map((d) => d.tag), ['zh', 'en'])
  assert.deepEqual(registered.map((entry) => entry.spec.label()), ['MCP servers', 'Skills', 'Global persona'])
})

test('client bundle falls back to built-in labels when the locale service throws', async () => {
  const mod = await loadClient()
  const locale = {
    register: () => { throw new Error('duplicate namespace') },
    bind: () => { throw new Error('unknown namespace') },
  }
  const { ctx, registered } = fakeCtx({ locale })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.deepEqual(registered.map((entry) => entry.spec.label()), ['MCP 管理', 'Skill 管理', '全局人设'])
})
