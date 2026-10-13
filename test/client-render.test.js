// Renders the built client bundle's three sections with the REAL react and
// react-dom/server, against a seed shaped exactly like the DSH web shell's
// client-module seed table (see `as()` in the shell bundle). The shell mounts
// these components as `renderSlot("settings.section", { close }, { only })`;
// if any of them throws on the first render the settings pane goes blank, so
// this test is the guard for that failure mode.
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ReactNS from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import { renderToString } from 'react-dom/server'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const reactCjs = ReactNS.default ?? ReactNS

/** esbuild's __toESM, verbatim. */
function toESM(mod, isNodeMode) {
  const target = mod != null ? Object.create(Object.getPrototypeOf(mod)) : {}
  if (isNodeMode || !mod || !mod.__esModule) {
    Object.defineProperty(target, 'default', { value: mod, enumerable: true })
  }
  for (const key of Object.getOwnPropertyNames(mod)) {
    if (key === 'default' || Object.prototype.hasOwnProperty.call(target, key)) continue
    const desc = Object.getOwnPropertyDescriptor(mod, key)
    if (desc) Object.defineProperty(target, key, desc.get ? desc : { enumerable: true, get: () => mod[key] })
  }
  return target
}

/** The shell bundle's `function as(e, n)` — namespace assembly, then freeze. */
function asModule(base, sources) {
  for (const source of sources) {
    if (typeof source !== 'string' && !Array.isArray(source)) {
      for (const key in source) {
        if (key !== 'default' && !(key in base)) {
          const desc = Object.getOwnPropertyDescriptor(source, key)
          if (desc) Object.defineProperty(base, key, desc.get ? desc : { enumerable: true, get: () => source[key] })
        }
      }
    }
  }
  return Object.freeze(Object.defineProperty(base, Symbol.toStringTag, { value: 'Module' }))
}

/** require('react') as the shell exposes it: `as({__proto__:null, default: toESM(react)}, [react])`. */
function shellReactSeed() {
  return asModule({ __proto__: null, default: toESM(reactCjs) }, [reactCjs])
}

async function loadClient(requires) {
  const source = await fsp.readFile(path.join(root, 'lib', 'client.js'), 'utf8')
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = {
          id: entry.id,
          exports: entry.factory((name) => {
            if (name in requires) return requires[name]
            throw new Error(`unexpected external require: ${name}`)
          }),
        }
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load once')
  return loaded.exports
}

function fakeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      effect: (fn) => {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      slots: {
        inject: (name, callback) => callback(),
        register: (spec, component) => {
          registered.push({ spec, component })
          return () => {}
        },
      },
    },
  }
}

function renderSection(component, props = {}) {
  return renderToString(ReactNS.createElement(component, { close: () => {}, t: (key) => key, ...props }))
}

test('every section renders markup against the shell React seed', async () => {
  const mod = await loadClient({
    react: shellReactSeed(),
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
  })
  const { ctx, registered } = fakeCtx()
  mod.apply(ctx)
  assert.equal(registered.length, 4)

  for (const entry of registered) {
    const html = renderSection(entry.component)
    assert.ok(html.length > 40, `${entry.spec.id} renders non-trivial markup (got ${html.length} chars)`)
    assert.match(html, /dsi-root/, `${entry.spec.id} renders the plugin root element`)
  }
  const [mcp, skills, persona, providers] = registered.map((entry) => renderSection(entry.component))
  assert.match(mcp, /dsi-tabs|dsi-panel|MCP/)
  assert.match(skills, /Skill|技能/)
  assert.match(persona, /人设|persona/i)
  assert.match(providers, /思考解锁/)
  assert.match(providers, /全部解锁/)
  // add/edit is available again, but the delete path stays gone for good
  assert.match(providers, /新增网关/)
  assert.doesNotMatch(providers, /删除|移除网关/)
})

test('sections render against a plain React namespace too', async () => {
  const mod = await loadClient({ react: reactCjs, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient })
  const { ctx, registered } = fakeCtx()
  mod.apply(ctx)
  for (const entry of registered) {
    assert.ok(renderSection(entry.component).length > 40)
  }
})

test('sections render when the shell passes a session hook and a t() translator', async () => {
  const mod = await loadClient({ react: shellReactSeed(), 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient })
  const { ctx, registered } = fakeCtx()
  mod.apply(ctx)
  const props = {
    t: (key) => `T:${key}`,
    useSessions: () => ({ sessions: [], activeId: undefined }),
  }
  for (const entry of registered) {
    assert.ok(renderSection(entry.component, props).length > 40)
  }
})

test('a missing session hook still renders (settings sections are root scope)', async () => {
  const mod = await loadClient({ react: shellReactSeed(), 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient })
  const { ctx, registered } = fakeCtx()
  mod.apply(ctx)
  for (const entry of registered) {
    assert.doesNotThrow(() => renderSection(entry.component, { useSessions: undefined }))
  }
})
