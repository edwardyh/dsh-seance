/**
 * dsh-seance — client half.
 *
 * Registers the single entry point (`/dsh-seance.summon` in the command
 * palette) and a transient dialog in the frame-wide overlay. The dialog is the
 * only surface: no sidebar row, no activity icon, no settings page, no
 * resident webview. Closing it discards the ghost on the host.
 *
 * The dialog talks to the host half over a same-origin JSON route. Nothing the
 * user or the ghost says is written to any session log.
 */
window.__ModuleLoader__.load({
  id: 'dsh-seance',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    const API_PATH = '/dsh-seance/api'
    const MAX_QUESTIONS = 3

    // ---------------------------------------------------------------------
    // Store: one resident dialog, one resident ghost per invoking session.
    // ---------------------------------------------------------------------

    let state = {
      open: false,
      parentSessionId: null,
      status: 'idle',
      candidates: [],
      ghost: null,
      messages: [],
      remaining: MAX_QUESTIONS,
      busy: false,
      error: null,
    }
    const listeners = new Set()
    let generation = 0

    function setState(patch) {
      state = { ...state, ...patch }
      for (const listener of listeners) listener()
    }
    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    function getSnapshot() {
      return state
    }

    async function api(op, payload) {
      if (typeof fetch !== 'function') throw new Error('当前环境不支持 fetch，无法连接到宿主。')
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-seance': '1' },
        body: JSON.stringify({ op, ...payload }),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        // fall through to the status-based error
      }
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error ?? `请求失败（HTTP ${response.status}）`)
      }
      return data
    }

    function messageOf(error) {
      if (error instanceof Error && error.message.length > 0) return error.message
      return String(error)
    }

    function openDialog(parentSessionId) {
      generation += 1
      const current = generation
      setState({
        open: true,
        parentSessionId,
        status: 'loading',
        candidates: [],
        ghost: null,
        messages: [],
        remaining: MAX_QUESTIONS,
        busy: false,
        error: null,
      })
      api('candidates', { parentSessionId }).then(
        (data) => {
          if (current !== generation || !state.open) return
          setState({ status: 'ready', candidates: Array.isArray(data.candidates) ? data.candidates : [] })
        },
        (error) => {
          if (current !== generation || !state.open) return
          setState({ status: 'error', error: messageOf(error) })
        },
      )
    }

    function openFromCommand(session) {
      const parentSessionId = session?.sessionId
      if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
        setState({
          open: true,
          parentSessionId: null,
          status: 'error',
          candidates: [],
          ghost: null,
          messages: [],
          remaining: MAX_QUESTIONS,
          busy: false,
          error: '无法确定当前会话，招魂失败。',
        })
        return
      }
      openDialog(parentSessionId)
    }

    function close() {
      const parentSessionId = state.parentSessionId
      generation += 1
      setState({
        open: false,
        parentSessionId: null,
        status: 'idle',
        candidates: [],
        ghost: null,
        messages: [],
        remaining: MAX_QUESTIONS,
        busy: false,
        error: null,
      })
      if (typeof parentSessionId === 'string' && parentSessionId.length > 0) {
        api('dismiss', { parentSessionId }).catch(() => {})
      }
    }

    async function summon(candidate) {
      const current = generation
      const { parentSessionId } = state
      if (typeof parentSessionId !== 'string') return
      setState({ busy: true, error: null })
      try {
        const data = await api('summon', { parentSessionId, sourceId: candidate.id })
        if (current !== generation || !state.open) return
        setState({
          busy: false,
          ghost: data.ghost ?? null,
          remaining: typeof data.ghost?.remaining === 'number' ? data.ghost.remaining : MAX_QUESTIONS,
        })
      } catch (error) {
        if (current !== generation || !state.open) return
        setState({ busy: false, error: messageOf(error) })
      }
    }

    async function ask(question) {
      const current = generation
      const { parentSessionId, ghost, busy, remaining } = state
      if (typeof parentSessionId !== 'string' || ghost == null || busy || remaining <= 0) return
      setState({
        busy: true,
        error: null,
        messages: [...state.messages, { role: 'user', text: question }],
      })
      try {
        const data = await api('ask', { parentSessionId, question })
        if (current !== generation || !state.open) return
        setState({
          busy: false,
          messages: [...state.messages, { role: 'ghost', text: data.answer }],
          remaining: typeof data.remaining === 'number' ? data.remaining : Math.max(0, remaining - 1),
        })
      } catch (error) {
        if (current !== generation || !state.open) return
        setState({ busy: false, error: messageOf(error) })
      }
    }

    // ---------------------------------------------------------------------
    // Styles: host theme tokens only, scoped to the plugin's class prefix.
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-seance-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);pointer-events:auto}
.dsh-seance-panel{box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:min(72vh,640px);display:flex;flex-direction:column;gap:12px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);outline:none}
.dsh-seance-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dsh-seance-heading{min-width:0}
.dsh-seance-title{font-size:15px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-seance-sub{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dsh-seance-x{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:6px 8px;border-radius:8px}
.dsh-seance-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-seance-body{min-height:0;display:flex;flex-direction:column;gap:10px}
.dsh-seance-muted{font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary);padding:6px 2px}
.dsh-seance-list{display:flex;flex-direction:column;gap:6px;min-height:0;max-height:44vh;overflow:auto}
.dsh-seance-row{display:flex;gap:10px;align-items:flex-start;text-align:left;width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}
.dsh-seance-row:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-seance-row:disabled{opacity:.55;cursor:default}
.dsh-seance-index{flex:none;width:18px;height:18px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;text-align:center;margin-top:1px}
.dsh-seance-rowbody{min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-seance-rowtitle{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-seance-rowmeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-seance-thread{display:flex;flex-direction:column;gap:10px;overflow:auto;min-height:0;max-height:44vh;padding-right:2px}
.dsh-seance-msg{display:flex;flex-direction:column;gap:3px}
.dsh-seance-who{font-size:10px;letter-spacing:.4px;color:var(--dsw-alias-label-secondary)}
.dsh-seance-text{font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.dsh-seance-msg.ghost .dsh-seance-text{background:var(--dsw-alias-bg-layer-2)}
.dsh-seance-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px}
.dsh-seance-compose{display:flex;gap:8px;align-items:flex-end}
.dsh-seance-input{flex:1;min-height:38px;max-height:120px;resize:vertical;box-sizing:border-box;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:19px;outline:none}
.dsh-seance-input:focus{border-color:var(--dsw-alias-border-l2)}
.dsh-seance-send{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;padding:0 14px;height:38px}
.dsh-seance-send:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-seance-send:disabled{opacity:.5;cursor:default}
.dsh-seance-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-seance-link{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;padding:2px 5px;border-radius:6px}
.dsh-seance-link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
`

    // ---------------------------------------------------------------------
    // Dialog
    // ---------------------------------------------------------------------

    function SeanceDialog() {
      const snapshot = useSyncExternalStore(subscribe, getSnapshot)
      const panelRef = useRef(null)
      const inputRef = useRef(null)
      const threadRef = useRef(null)
      const [draft, setDraft] = useState('')

      useEffect(() => {
        if (!snapshot.open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          close()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [snapshot.open])

      useEffect(() => {
        if (snapshot.open) panelRef.current?.focus()
        else setDraft('')
      }, [snapshot.open])

      useEffect(() => {
        const element = threadRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [snapshot.messages.length, snapshot.busy])

      useEffect(() => {
        if (snapshot.ghost != null && !snapshot.busy) inputRef.current?.focus()
      }, [snapshot.ghost, snapshot.busy])

      if (!snapshot.open) return null

      const submit = (event) => {
        event?.preventDefault?.()
        const question = draft.trim()
        if (question.length === 0 || snapshot.busy || snapshot.remaining <= 0) return
        setDraft('')
        ask(question)
      }

      const ghost = snapshot.ghost
      const canAsk = ghost != null && snapshot.remaining > 0

      const header = h(
        'div',
        { className: 'dsh-seance-head' },
        h(
          'div',
          { className: 'dsh-seance-heading' },
          h('div', { className: 'dsh-seance-title' }, ghost == null ? '招魂' : ghost.title),
          h(
            'div',
            { className: 'dsh-seance-sub' },
            ghost == null
              ? '在删除之前，先听一听。'
              : `它只记得 ${String(ghost.fragmentCount ?? 0)} 段碎片，没有完整的记忆。`,
          ),
        ),
        h(
          'button',
          { className: 'dsh-seance-x', type: 'button', onClick: close, 'aria-label': '关闭' },
          '✕',
        ),
      )

      let body
      if (ghost == null) {
        if (snapshot.status === 'loading') {
          body = h('div', { className: 'dsh-seance-muted' }, '正在扫描残留会话…')
        } else if (snapshot.status === 'error') {
          const canRetry = typeof snapshot.parentSessionId === 'string'
          body = h(
            'div',
            { className: 'dsh-seance-muted' },
            '无法扫描残留会话。',
            canRetry
              ? h(
                  'button',
                  {
                    className: 'dsh-seance-link',
                    type: 'button',
                    onClick: () => openDialog(snapshot.parentSessionId),
                  },
                  '重试',
                )
              : null,
          )
        } else if (snapshot.candidates.length === 0) {
          body = h('div', { className: 'dsh-seance-muted' }, '没有可招魂的残留会话。')
        } else {
          body = h(
            'div',
            { className: 'dsh-seance-list' },
            snapshot.candidates.map((candidate, index) =>
              h(
                'button',
                {
                  key: candidate.id,
                  className: 'dsh-seance-row',
                  type: 'button',
                  disabled: snapshot.busy,
                  onClick: () => summon(candidate),
                },
                h('span', { className: 'dsh-seance-index' }, String(index + 1)),
                h(
                  'span',
                  { className: 'dsh-seance-rowbody' },
                  h(
                    'span',
                    { className: 'dsh-seance-rowtitle' },
                    candidate.title || candidate.summary || candidate.id,
                  ),
                  h(
                    'span',
                    { className: 'dsh-seance-rowmeta' },
                    [candidate.reason, candidate.summary].filter(Boolean).join(' · ') ||
                      '没有更多摘要',
                  ),
                ),
              ),
            ),
          )
        }
        if (snapshot.busy) {
          body = h('div', { className: 'dsh-seance-muted' }, '正在把回声聚拢起来…')
        }
      } else {
        const thread = h(
          'div',
          { className: 'dsh-seance-thread', ref: threadRef },
          snapshot.messages.length === 0 && !snapshot.busy
            ? h(
                'div',
                { className: 'dsh-seance-muted' },
                '它只记得碎片。问它：你当时卡在哪里？最后看到了什么？',
              )
            : null,
          snapshot.messages.map((message, index) =>
            h(
              'div',
              { key: String(index), className: `dsh-seance-msg ${message.role}` },
              h('div', { className: 'dsh-seance-who' }, message.role === 'user' ? '你' : '回声'),
              h('div', { className: 'dsh-seance-text' }, message.text),
            ),
          ),
          snapshot.busy ? h('div', { className: 'dsh-seance-muted' }, '幽灵正在回忆…') : null,
        )
        body = h(
          'div',
          { className: 'dsh-seance-body' },
          thread,
          canAsk
            ? h(
                'form',
                { className: 'dsh-seance-compose', onSubmit: submit },
                h('textarea', {
                  ref: inputRef,
                  className: 'dsh-seance-input',
                  value: draft,
                  rows: 1,
                  placeholder: '问它：你当时卡在哪里？最后看到了什么？',
                  disabled: snapshot.busy,
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submit(event)
                    }
                  },
                }),
                h(
                  'button',
                  {
                    className: 'dsh-seance-send',
                    type: 'submit',
                    disabled: snapshot.busy || draft.trim().length === 0,
                  },
                  '追问',
                ),
              )
            : h('div', { className: 'dsh-seance-muted' }, '它已经消散了。关闭窗口，回声就彻底消失。'),
          h(
            'div',
            { className: 'dsh-seance-foot' },
            h(
              'span',
              null,
              canAsk
                ? `还可提问 ${String(snapshot.remaining)} / ${String(MAX_QUESTIONS)} 次 · 只基于碎片回答`
                : '对话已结束 · 不留下任何持久化记录',
            ),
            h(
              'button',
              { className: 'dsh-seance-link', type: 'button', onClick: close },
              '结束对话',
            ),
          ),
        )
      }

      return h(
        'div',
        {
          className: 'dsh-seance-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h('style', null, CSS),
        h(
          'div',
          {
            className: 'dsh-seance-panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '招魂',
            tabIndex: -1,
            ref: panelRef,
          },
          header,
          snapshot.error === null ? null : h('div', { className: 'dsh-seance-error' }, snapshot.error),
          body,
        ),
      )
    }

    class SeanceDialogBoundary extends React.Component {
      state = { error: null }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== null) {
          const message =
            this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
          return h(
            'div',
            { className: 'dsh-seance-backdrop' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'dsh-seance-panel', role: 'dialog', 'aria-modal': 'true' },
              h('div', { className: 'dsh-seance-title' }, '招魂界面出错了'),
              h('div', { className: 'dsh-seance-error' }, message || '未知错误'),
              h(
                'div',
                { className: 'dsh-seance-foot' },
                h(
                  'button',
                  {
                    className: 'dsh-seance-link',
                    type: 'button',
                    onClick: () => this.setState({ error: null }),
                  },
                  '重试',
                ),
                h(
                  'button',
                  {
                    className: 'dsh-seance-link',
                    type: 'button',
                    onClick: () => {
                      this.setState({ error: null })
                      close()
                    },
                  },
                  '关闭',
                ),
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    function SeanceOverlay() {
      return h(SeanceDialogBoundary, null, h(SeanceDialog))
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    return {
      inject: ['commandUi', 'slots'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.commandUi.register({
            name: 'dsh-seance.summon',
            available: () => true,
            label: () => '招魂',
            description: () => '召唤一个已终止子 Agent 的残留回声，问它最后记得什么',
            ui: {
              kind: 'action',
              run: (session) => {
                openFromCommand(session)
              },
            },
          }),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-seance-overlay',
              order: 900,
            },
            SeanceOverlay,
          ),
        )
      },
    }
  },
})
