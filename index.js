/**
 * dsh-seance — host half.
 *
 * Reads terminated subagent session logs through `ctx.sessionQuery`, distills a
 * small set of residual fragments, and lets the user ask a tool-less "ghost"
 * a limited number of questions. The ghost is a single model call through
 * `ctx.llm` with no session, no tool schemas, and no persistence; answers are
 * returned over a private same-origin route and never enter any session log.
 *
 * The client half (command palette entry + transient dialog) lives in client.js.
 */

export const name = 'dsh-seance'

/** The entire ghost persona. It is deliberately tiny: the echo only has fragments. */
const GHOST_SYSTEM = [
  '你是一段残留的回声。你只记得以下碎片，没有完整的记忆，没有工具，不能执行任务。',
  '你只能基于这些碎片回答用户的问题。如果你不记得，直接说你不知道。',
  '不要声称自己能读取文件、运行命令、联系其他 Agent 或继续之前的工作。',
].join('')

const API_PATH = '/dsh-seance/api'
const GHOST_HEADER = 'x-dsh-seance'
const MAX_QUESTIONS = 3
const MAX_CANDIDATES = 12
const MAX_QUESTION_CHARS = 1200
const MAX_BODY_BYTES = 64 * 1024
/** Roughly 800 tokens at four characters per token. */
const FRAGMENT_CHAR_BUDGET = 3200
const LAST_SEEN_CHAR_LIMIT = 800
const TAIL_CHAR_LIMIT = 1200

/**
 * Register the host half.
 * @param {object} ctx - plugin context.
 */
export function apply(ctx) {
  /** @type {Map<string, Ghost>} parent session id -> the one resident ghost */
  const ghosts = new Map()

  const cleanup = () => {
    for (const ghost of ghosts.values()) {
      for (const controller of ghost.controllers) controller.abort()
      ghost.controllers.clear()
    }
    ghosts.clear()
  }
  ctx.effect(() => () => cleanup())

  ctx.inject(['sessionQuery', 'llm', 'webServer'], (scope) => {
    scope.effect(() => () => cleanup())
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler: (req, res) => {
          handleRequest(scope, ghosts, req, res).catch((error) => {
            if (res.headersSent) {
              res.destroy()
              return
            }
            sendJson(res, 500, { ok: false, error: errorMessage(error) })
          })
        },
      }),
    )
  })
}

/**
 * @typedef {object} Ghost
 * @property {string} parentSessionId
 * @property {string} sourceId
 * @property {string} title
 * @property {string} block residual fragments, already ordered and budgeted
 * @property {number} fragmentCount
 * @property {number} questions
 * @property {Set<AbortController>} controllers
 */

/**
 * Dispatch one API call.
 * @param {object} scope service-providing context
 * @param {Map<string, Ghost>} ghosts resident ghosts
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleRequest(scope, ghosts, req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (req.headers[GHOST_HEADER] !== '1') {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    sendJson(res, 415, { ok: false, error: 'expected application/json' })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) })
    return
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: 'expected a JSON object' })
    return
  }

  const op = typeof body.op === 'string' ? body.op : ''
  const parentSessionId = typeof body.parentSessionId === 'string' ? body.parentSessionId : ''
  if (parentSessionId.length === 0) {
    sendJson(res, 400, { ok: false, error: '缺少会话标识' })
    return
  }

  switch (op) {
    case 'candidates': {
      const candidates = await listCandidates(scope, parentSessionId)
      sendJson(res, 200, { ok: true, candidates })
      return
    }
    case 'summon': {
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
      if (sourceId.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少被选中的会话标识' })
        return
      }
      let ghost
      try {
        ghost = await summonGhost(scope, ghosts, parentSessionId, sourceId)
      } catch (error) {
        if (error?.status === 400 || error?.status === 403) {
          sendJson(res, error.status, { ok: false, error: errorMessage(error) })
          return
        }
        throw error
      }
      sendJson(res, 200, {
        ok: true,
        ghost: {
          sourceId: ghost.sourceId,
          title: ghost.title,
          fragmentCount: ghost.fragmentCount,
          remaining: MAX_QUESTIONS,
        },
      })
      return
    }
    case 'ask': {
      const ghost = ghosts.get(parentSessionId)
      if (ghost === undefined) {
        sendJson(res, 409, { ok: false, error: '幽灵已经不在了，请重新召唤。' })
        return
      }
      const question = typeof body.question === 'string' ? body.question.trim() : ''
      if (question.length === 0) {
        sendJson(res, 400, { ok: false, error: '问题不能为空。' })
        return
      }
      if (question.length > MAX_QUESTION_CHARS) {
        sendJson(res, 400, { ok: false, error: `问题太长了（上限 ${String(MAX_QUESTION_CHARS)} 个字符）。` })
        return
      }
      if (ghost.questions >= MAX_QUESTIONS) {
        sendJson(res, 429, { ok: false, error: `幽灵已经消散：对话上限为 ${String(MAX_QUESTIONS)} 个问题。` })
        return
      }
      ghost.questions += 1
      let answer
      try {
        answer = await askGhost(scope, ghost, question)
      } catch (error) {
        ghost.questions -= 1
        throw error
      }
      sendJson(res, 200, { ok: true, answer, remaining: MAX_QUESTIONS - ghost.questions })
      return
    }
    case 'dismiss': {
      const ghost = ghosts.get(parentSessionId)
      if (ghost !== undefined) {
        for (const controller of ghost.controllers) controller.abort()
        ghost.controllers.clear()
        ghosts.delete(parentSessionId)
      }
      sendJson(res, 200, { ok: true })
      return
    }
    default: {
      sendJson(res, 400, { ok: false, error: `未知操作：${op}` })
    }
  }
}

/**
 * List readable, non-live child sessions under the invoking session's directory.
 * @param {object} scope
 * @param {string} parentSessionId
 * @returns {Promise<Array<{id: string, title: string, summary: string, reason: string, createdAt: number}>>}
 */
async function listCandidates(scope, parentSessionId) {
  const cwd = await resolveParentCwd(scope, parentSessionId)
  if (cwd === undefined) {
    throw new Error('无法确定当前会话的工作目录，已取消候选扫描。')
  }
  /** @type {import('@deepseek-ai/dsh-session-query').SessionResultFilter[]} */
  const filters = [{ kind: 'cwd', values: [cwd] }]
  const records = await scope.sessionQuery.filterSessions(filters)

  const candidates = []
  for (const record of records) {
    if (record.live) continue
    if (record.header.parentSession == null) continue
    if (candidates.length >= MAX_CANDIDATES) break

    const id = record.header.id
    let snapshot
    try {
      snapshot = await scope.sessionQuery.readSession(id)
    } catch {
      // A log that cannot be read is not a candidate; the plugin never repairs it.
      continue
    }
    const title = await readTitleSafe(scope, id)
    const summary = summarizeSnapshot(snapshot)
    candidates.push({
      id,
      title,
      summary: summary.summary,
      reason: summary.reason,
      createdAt: record.header.createdAt,
    })
  }
  return candidates
}

/**
 * Resolve the invoking session's effective directory.
 * @param {object} scope
 * @param {string} parentSessionId
 * @returns {Promise<string | undefined>}
 */
async function resolveParentCwd(scope, parentSessionId) {
  const agent = scope.get('agents')?.get(parentSessionId)
  if (agent !== undefined) {
    const workingDirectory = scope.get('workingDirectory')
    if (workingDirectory !== undefined) {
      try {
        return workingDirectory.get(agent.session)
      } catch {
        // fall through to the header value
      }
    }
    return agent.session.header.cwd
  }
  try {
    const records = await scope.sessionQuery.filterSessions([{ kind: 'id', values: [parentSessionId] }])
    return records[0]?.header.cwd
  } catch {
    return undefined
  }
}

/**
 * Fold the display summary and last end reason of one log.
 * @param {{events: readonly any[], session: any}} snapshot
 * @returns {{summary: string, reason: string}}
 */
function summarizeSnapshot(snapshot) {
  let lastUser = ''
  let boundary = null
  for (const event of snapshot.events) {
    if (event.type === 'user/message') {
      const text = messageText(event.data)
      if (isMeaningfulUserText(text)) lastUser = text
    } else if (event.type === 'turn/start') {
      boundary = { kind: 'open' }
    } else if (event.type === 'turn/end') {
      boundary = { kind: 'end', reason: event.data.reason }
    }
  }
  let reason = ''
  if (boundary?.kind === 'end') reason = describeEndReason(boundary.reason)
  else if (boundary?.kind === 'open') reason = '无结束记录（可能被强制中断）'
  return { summary: truncate(collapse(lastUser), 80), reason }
}

/**
 * Build the resident ghost for one source session.
 * @param {object} scope
 * @param {Map<string, Ghost>} ghosts
 * @param {string} parentSessionId
 * @param {string} sourceId
 * @returns {Promise<Ghost>}
 */
async function summonGhost(scope, ghosts, parentSessionId, sourceId) {
  const cwd = await resolveParentCwd(scope, parentSessionId)
  if (cwd === undefined) {
    const error = new Error('无法确定当前会话的工作目录，拒绝招魂。')
    error.status = 400
    throw error
  }
  const previous = ghosts.get(parentSessionId)
  if (previous !== undefined) {
    for (const controller of previous.controllers) controller.abort()
    previous.controllers.clear()
    ghosts.delete(parentSessionId)
  }

  const snapshot = await scope.sessionQuery.readSession(sourceId)
  if (snapshot.session.parentSession == null) {
    throw new Error('该会话不是子 Agent 会话，无法招魂。')
  }
  if (snapshot.session.cwd !== cwd) {
    const error = new Error('只能招魂当前 workspace 的子会话。')
    error.status = 403
    throw error
  }
  const fragments = extractFragments(snapshot)
  if (fragments.count === 0 || fragments.block.length === 0) {
    throw new Error('没有从这段日志里提取到任何碎片。')
  }
  const title = (await readTitleSafe(scope, sourceId)) || '未命名子 Agent'
  /** @type {Ghost} */
  const ghost = {
    parentSessionId,
    sourceId,
    title,
    block: fragments.block,
    fragmentCount: fragments.count,
    questions: 0,
    controllers: new Set(),
  }
  ghosts.set(parentSessionId, ghost)
  return ghost
}

/**
 * Extract the fragment set described by the seance contract.
 *
 * Only failure results, abnormal turn endings, assistant pieces after the last
 * unclosed step, the final user message, and one lineage line are eligible.
 * The budget prefers later events; the final user message is reserved.
 *
 * @param {{events: readonly any[], session: any}} snapshot
 * @returns {{block: string, count: number}}
 */
export function extractFragments(snapshot) {
  const events = snapshot.events
  const toolNames = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') toolNames.set(event.data.callId, event.data.name)
  }

  const openSteps = new Map()
  for (const event of events) {
    if (event.type === 'step/start') {
      openSteps.set(`${String(event.data.turn)}:${String(event.data.step)}`, event.seq)
    } else if (event.type === 'step/end') {
      openSteps.delete(`${String(event.data.turn)}:${String(event.data.step)}`)
    }
  }
  let openStepSeq = null
  for (const seq of openSteps.values()) {
    if (openStepSeq === null || seq > openStepSeq) openStepSeq = seq
  }

  let lastUser = null
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = messageText(event.data)
    if (isMeaningfulUserText(text)) lastUser = { seq: event.seq, text }
  }

  const fragments = []
  for (const event of events) {
    if (event.type === 'tool/result') {
      const data = event.data
      const failed = data.message?.isError === true || data.error !== undefined
      if (!failed) continue
      const callId = data.message?.toolCallId ?? data.message?.source?.callId
      const toolName = toolNames.get(callId) ?? '未知工具'
      const detail =
        data.error !== undefined
          ? [formatToolError(data.error), messageText(data.message)].filter(Boolean).join(' — ')
          : messageText(data.message)
      fragments.push({
        seq: event.seq,
        text: `[工具失败] ${toolName}: ${truncate(collapse(detail), 300)}`,
      })
    } else if (event.type === 'turn/end') {
      if (event.data.reason?.kind === 'completed') continue
      fragments.push({ seq: event.seq, text: `[终止] ${describeEndReason(event.data.reason)}` })
    }
  }

  if (openStepSeq !== null) {
    const pieces = []
    for (const event of events) {
      if (event.seq <= openStepSeq) continue
      if (event.type === 'assistant/message') {
        const text = messageText(event.data.message) || streamText(event.data.stream)
        if (text.length > 0) pieces.push(text)
      } else if (event.type === 'assistant/attempt') {
        const text = streamText(event.data.stream)
        if (text.length > 0) pieces.push(text)
      }
    }
    const tail = normalizeText(pieces.join('\n'))
    if (tail.length > 0) {
      const clipped = tail.length > TAIL_CHAR_LIMIT ? `…${tail.slice(-TAIL_CHAR_LIMIT)}` : tail
      fragments.push({
        seq: events.at(-1)?.seq ?? openStepSeq,
        text: `[未完成步骤里的最后片段] ${clipped}`,
      })
    }
  }

  const lineage = `[位置] 它是 ${shortId(snapshot.session.parentSession)} 的子 Agent，深度 ${String(
    snapshot.session.delegationDepth ?? 1,
  )}。`
  const lastSeen =
    lastUser === null
      ? undefined
      : {
          seq: lastUser.seq,
          text: truncate(normalizeText(lastUser.text), LAST_SEEN_CHAR_LIMIT),
        }

  return assembleFragments(fragments, lineage, lastSeen)
}

/**
 * Apply the token budget and chronological ordering.
 * @param {Array<{seq: number, text: string}>} fragments
 * @param {string} lineage
 * @param {{seq: number, text: string} | undefined} lastSeen
 * @returns {{block: string, count: number}}
 */
function assembleFragments(fragments, lineage, lastSeen) {
  const items = [...fragments]
  if (lastSeen !== undefined && lastSeen.text.length > 0) {
    items.push({ seq: lastSeen.seq, text: `[它最后看到的话] ${lastSeen.text}`, mandatory: true })
  }
  const mandatory = items.filter((item) => item.mandatory === true)
  const optional = items.filter((item) => item.mandatory !== true)

  let reserved = lineage.length
  for (const item of mandatory) reserved += item.text.length + 1
  let budget = Math.max(200, FRAGMENT_CHAR_BUDGET - reserved)

  const kept = []
  for (const item of [...optional].sort((left, right) => right.seq - left.seq)) {
    const cost = item.text.length + 1
    if (cost > budget) continue
    kept.push(item)
    budget -= cost
  }

  const ordered = [...kept, ...mandatory].sort((left, right) => left.seq - right.seq)
  return {
    block: [lineage, ...ordered.map((item) => item.text)].join('\n'),
    count: ordered.length,
  }
}

/**
 * Answer one question with a single tool-less model call.
 * @param {object} scope
 * @param {Ghost} ghost
 * @param {string} question
 * @returns {Promise<string>}
 */
async function askGhost(scope, ghost, question) {
  const route = resolveRoute(scope, ghost.parentSessionId)
  const controller = new AbortController()
  ghost.controllers.add(controller)
  try {
    let answer = ''
    let failure
    const stream = scope.llm.stream({
      provider: route.provider,
      model: route.model,
      system: GHOST_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `${ghost.block}\n\n【用户现在问】\n${question}` }],
        },
      ],
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta':
          answer += chunk.text
          break
        case 'tool-call-delta':
          throw new Error('幽灵试图调用工具，已被阻止。')
        case 'finish':
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failure = chunk.reason.failure
          }
          break
        default:
          break
      }
    }
    if (failure !== undefined) {
      throw new Error(`模型调用失败：${failure.message ?? failure.code ?? '未知错误'}`)
    }
    const text = answer.trim()
    return text.length > 0 ? text : '（它张了张嘴，没有留下任何声音。）'
  } finally {
    ghost.controllers.delete(controller)
  }
}

/**
 * Resolve the model route used for the ghost.
 * @param {object} scope
 * @param {string} parentSessionId
 * @returns {{provider: string, model: string}}
 */
function resolveRoute(scope, parentSessionId) {
  const agent = scope.get('agents')?.get(parentSessionId)
  const config = agent?.session?.requestHeader?.()?.config
  if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  const fallback = scope.get('agentDefaultModel')?.currentSelection()
  if (typeof fallback?.provider === 'string' && typeof fallback?.model === 'string') {
    return { provider: fallback.provider, model: fallback.model }
  }
  throw new Error('无法确定模型路由：当前会话没有可用的 provider/model。')
}

/**
 * Render a turn-end reason in the user's language.
 * @param {any} reason
 * @returns {string}
 */
export function describeEndReason(reason) {
  if (reason === undefined || reason === null) return '未知结束原因'
  switch (reason.kind) {
    case 'completed':
      return '正常结束'
    case 'interrupted':
      return '被强制中断'
    case 'aborted':
      return `被取消（${abortCause(reason.reason)}）`
    case 'blocked':
      return '被阻断'
    case 'error':
      return `错误：${truncate(collapse(reason.error?.message ?? '未知错误'), 120)}`
    case 'max-tokens':
      return '达到输出上限'
    case 'forked':
      return '已分叉'
    default:
      return String(reason.kind)
  }
}

/**
 * @param {any} cause
 * @returns {string}
 */
function abortCause(cause) {
  if (cause === undefined || cause === null) return '未知来源'
  switch (cause.kind) {
    case 'user':
      return '用户'
    case 'parent':
      return '父 Agent'
    case 'hook':
      return `钩子：${truncate(collapse(cause.reason ?? ''), 80)}`
    case 'disposed':
      return '会话被回收'
    case 'legacy':
      return '旧版日志'
    default:
      return String(cause.kind)
  }
}

/**
 * @param {{name?: string, code?: string, reason?: string}} error
 * @returns {string}
 */
function formatToolError(error) {
  const head = error.name ?? 'Error'
  const code = error.code === undefined || error.code.length === 0 ? '' : ` [${error.code}]`
  const reason = error.reason === undefined ? '' : ` ${error.reason}`
  return `${head}${code}${reason}`.trim()
}

/**
 * Prefixes of framework-injected user-role context. A child's real task is
 * usually its first user message; the loop appends these around it.
 */
const INJECTED_USER_PREFIXES = [
  'Current runtime context.',
  '<system-reminder>',
  'Time sampled while preparing',
  'Elapsed since the preceding',
]

/**
 * Whether a user-role message is the agent's task rather than injected context.
 * @param {string} text
 * @returns {boolean}
 */
function isMeaningfulUserText(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return !INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * Concatenate the text blocks of one message.
 * @param {any} message
 * @returns {string}
 */
function messageText(message) {
  if (message === undefined || message === null || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * Concatenate the text carried by assistant stream records.
 * @param {readonly any[] | undefined} records
 * @returns {string}
 */
function streamText(records) {
  if (!Array.isArray(records)) return ''
  const pieces = []
  for (const record of records) {
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      pieces.push(record.texts.join(''))
    } else if (record.type === 'chunk' && record.chunk?.type === 'text-delta') {
      pieces.push(record.chunk.text)
    }
  }
  return pieces.join('')
}

/**
 * @param {object} scope
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
async function readTitleSafe(scope, sessionId) {
  try {
    const snapshot = await scope.sessionQuery.readTitle(sessionId)
    return typeof snapshot?.title === 'string' ? snapshot.title : ''
  } catch {
    return ''
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function collapse(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Trim line edges and collapse blank lines, keeping meaningful newlines.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncate(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * @param {string | undefined} id
 * @returns {string}
 */
function shortId(id) {
  if (typeof id !== 'string' || id.length === 0) return '未知会话'
  return id.replace(/^session-/u, '').slice(0, 8)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed)
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
