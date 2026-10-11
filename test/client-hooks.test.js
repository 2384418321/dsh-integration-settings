// White-box regression tests for the two ways a settings entry can blank its own
// pane in the real shell:
//
//   1. Calling a shell-provided hook (the seat hands over `useSessions` and five
//      more) from a root-scope entry. In the real DSH those hooks throw for a
//      root-scope slot; a try/catch around the call swallows the throw, leaves
//      React's hook chain desynchronised, and the NEXT `useState` in the
//      component fails with React error #311. The shell catches that in its
//      per-entry error boundary and renders an empty `data-slot-error` div —
//      the "blank settings page" this file exists to prevent.
//   2. Letting the hook CALL SEQUENCE depend on the props share, which React
//      rejects the same way ("Rendered more/fewer hooks than during the previous
//      render") as soon as the seat changes between renders.
//
// A single server-side render cannot see either bug, so these tests drive the
// component function directly with a counting stand-in for React and compare the
// recorded hook sequence across renders.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function makeStubReact() {
  const calls = []
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => {
      calls.push('useState')
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect: () => { calls.push('useEffect') },
    useMemo: (fn) => { calls.push('useMemo'); return fn() },
    useCallback: (fn) => { calls.push('useCallback'); return fn },
    useRef: (value) => { calls.push('useRef'); return { current: value } },
  }
  return { react, calls }
}

function loadPlugin(react) {
  const require = (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require("${id}")`)
  }
  let exported = null
  const window = { __ModuleLoader__: { load: ({ factory }) => { exported = factory(require) } } }
  new Function('window', SRC)(window)
  assert.ok(exported && typeof exported.apply === 'function', 'bundle must export apply()')

  const sections = []
  const ctx = {
    effect: (fn) => { const disposer = fn(); return () => disposer && disposer() },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, fn) => fn(),
      register: (def, Component) => { sections.push({ def, Component }) },
    },
  }
  exported.apply(ctx)
  assert.equal(sections.length, 3, 'three settings sections register')
  return sections
}

const OTHER_PROPS = { usePanelInfo: null, useWorkspaces: null, renderFactorySlot: null, t: (k) => k, close: () => {} }

test('a root-scope settings entry never invokes the seat session hooks', () => {
  const { react, calls } = makeStubReact()
  let seatHookCalls = 0
  const trap = () => {
    seatHookCalls += 1
    throw new Error('session hooks are not callable from a root-scope settings entry')
  }
  const seat = {
    ...OTHER_PROPS,
    useSessions: trap,
    useSessionStatus: trap,
    useResource: trap,
    useSessionRetainInfo: trap,
  }

  for (const { def, Component } of loadPlugin(react)) {
    calls.length = 0
    assert.doesNotThrow(() => Component(seat), `${def.name || def.id}: render must not throw`)
    assert.equal(seatHookCalls, 0, `${def.id}: seat session hooks must not be called`)
    assert.ok(calls.includes('useState'), `${def.id}: the section still renders its own state`)
  }
})

test('the hook call sequence does not depend on the seat share', () => {
  const { react, calls } = makeStubReact()
  const plainSeat = { ...OTHER_PROPS }
  const richSeat = { ...OTHER_PROPS, useSessions: () => null, useSessionStatus: () => null }

  for (const { def, Component } of loadPlugin(react)) {
    calls.length = 0
    Component(plainSeat)
    const bare = [...calls]
    calls.length = 0
    Component(richSeat)
    const rich = [...calls]
    assert.ok(bare.length > 0, `${def.id}: expected the section to use hooks`)
    assert.deepEqual(rich, bare, `${def.id}: hook order must be identical for every seat share`)
  }
})
