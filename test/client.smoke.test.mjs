import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * Load client.js in a vm, run its factory with a minimal React mock, and
 * capture the component registered in shell.overlay.
 */
function loadClient() {
  let factory
  const sandbox = { console, fetch, URL, JSON, Promise, AbortController, setTimeout, clearTimeout }
  sandbox.window = {
    __ModuleLoader__: {
      load(definition) {
        factory = definition.factory
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  assert.equal(typeof factory, 'function', 'client factory should be registered')

  let snapshot
  class MockComponent {
    constructor(props) {
      this.props = props
    }

    setState(patch) {
      this.state = { ...this.state, ...patch }
    }
  }
  const React = {
    Component: MockComponent,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (value) => [value, () => {}],
    useSyncExternalStore: () => snapshot,
  }

  let overlay
  const ctx = {
    effect: (callback) => callback(),
    commandUi: { register: () => () => {} },
    slots: {
      inject: (key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        overlay = component
        return () => {}
      },
    },
  }
  const module = factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
  module.apply(ctx)
  assert.equal(typeof overlay, 'function', 'shell.overlay component should be registered')

  // SeanceOverlay wraps SeanceDialog in the local boundary; render the dialog.
  const wrapper = overlay()
  assert.equal(typeof wrapper, 'object')
  const dialog = wrapper.children[0].type
  assert.equal(typeof dialog, 'function', 'dialog component should be reachable')

  return {
    dialog,
    setSnapshot(next) {
      snapshot = next
    },
  }
}

const BASE = {
  open: true,
  parentSessionId: 'session-test',
  status: 'ready',
  candidates: [{ id: 'child-1', title: 'Child', summary: 'summary', reason: 'interrupted' }],
  ghost: null,
  messages: [],
  remaining: 3,
  busy: false,
  error: null,
}

test('SeanceDialog renders picker, chat, and closed states without throwing', () => {
  const client = loadClient()

  client.setSnapshot({ ...BASE, open: false })
  assert.equal(client.dialog(), null, 'closed state should render nothing')

  client.setSnapshot({ ...BASE })
  let picker
  assert.doesNotThrow(() => {
    picker = client.dialog()
  }, 'picker state should render without throwing')
  assert.equal(picker.props.className, 'dsh-seance-backdrop')

  client.setSnapshot({
    ...BASE,
    ghost: { title: 'Child', fragmentCount: 3 },
    messages: [
      { role: 'user', text: 'where did you stop?' },
      { role: 'ghost', text: 'only fragments remain' },
    ],
    remaining: 2,
  })
  let chat
  assert.doesNotThrow(() => {
    chat = client.dialog()
  }, 'chat state should render without throwing')
  assert.equal(chat.props.className, 'dsh-seance-backdrop')
})
