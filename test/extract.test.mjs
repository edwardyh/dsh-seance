import assert from 'node:assert/strict'
import test from 'node:test'

import { describeEndReason, extractFragments } from '../index.js'

function ev(seq, type, data) {
  return { type, seq, time: seq, data }
}

function textMessage(text) {
  return { id: `m${Math.random()}`, role: 'user', content: [{ type: 'text', text }] }
}

const HEADER = {
  version: 1,
  id: 'child-1',
  createdAt: 1,
  cwd: '/tmp/work',
  parentSession: 'parent-session-1',
  isSeeded: false,
  origin: 'subagent',
  delegationDepth: 1,
}

test('extracts only residual fragment kinds, in chronological order', () => {
  const events = [
    ev(0, 'system/message', { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'GLOBAL SYSTEM PROMPT' }] } }),
    ev(1, 'request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' }),
    ev(2, 'turn/start', { turn: 1 }),
    ev(3, 'user/message', textMessage('first user request: refactor the parser')),
    ev(4, 'step/start', { turn: 1, step: 1 }),
    ev(5, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }),
    ev(6, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ENOENT: a.ts not found' }] },
      error: { name: 'ToolError', code: 'ENOENT', reason: 'file missing' },
    }),
    ev(7, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }),
    ev(8, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'c2', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: 'SUCCESS OUTPUT MUST NOT APPEAR' }] },
    }),
    ev(9, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'old step answer' }], role: 'assistant' },
      stream: [],
    }),
    ev(10, 'step/end', { turn: 1, step: 1 }),
    ev(11, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } }),
    ev(12, 'turn/start', { turn: 2 }),
    ev(13, 'user/message', textMessage('last thing it saw: check the failing test')),
    ev(14, 'step/start', { turn: 2, step: 1 }),
    ev(15, 'assistant/message', {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: 'let me read the test file first' }], role: 'assistant' },
      stream: [],
    }),
  ]

  const result = extractFragments({ session: HEADER, events })
  const block = result.block

  assert.match(block, /\[位置\]/)
  assert.match(block, /\[工具失败\] read: ToolError \[ENOENT\] file missing — ENOENT: a\.ts not found/)
  assert.doesNotMatch(block, /SUCCESS OUTPUT MUST NOT APPEAR/)
  assert.doesNotMatch(block, /old step answer/)
  assert.match(block, /\[终止\] 被取消（父 Agent）/)
  assert.match(block, /\[它最后看到的话\] last thing it saw: check the failing test/)
  assert.match(block, /\[未完成步骤里的最后片段\] let me read the test file first/)
  assert.doesNotMatch(block, /GLOBAL SYSTEM PROMPT/)
  assert.doesNotMatch(block, /request\/header/)

  const order = [
    '[工具失败]',
    '[终止]',
    '[它最后看到的话]',
    '[未完成步骤里的最后片段]',
  ].map((marker) => block.indexOf(marker))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'fragments should be chronological')
})

test('prefers later events under the 800-token budget', () => {
  const events = [ev(0, 'turn/start', { turn: 1 })]
  let seq = 1
  for (let index = 0; index < 60; index += 1) {
    events.push(
      ev(seq, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: `c${String(index)}`,
          source: { kind: 'tool', callId: `c${String(index)}` },
          content: [{ type: 'text', text: `x`.repeat(200) }],
        },
        error: { name: 'Err', code: `E${String(index)}` },
      }),
    )
    seq += 1
  }
  events.push(ev(seq, 'user/message', textMessage('final question')))

  const result = extractFragments({ session: HEADER, events })
  assert.ok(result.block.length <= 3200, `block should respect the budget, got ${String(result.block.length)}`)
  assert.match(result.block, /E59/)
  assert.doesNotMatch(result.block, /E0\]/)
  assert.match(result.block, /\[它最后看到的话\] final question/)
})

test('describes abnormal turn endings', () => {
  assert.equal(describeEndReason({ kind: 'completed' }), '正常结束')
  assert.equal(describeEndReason({ kind: 'interrupted' }), '被强制中断')
  assert.equal(describeEndReason({ kind: 'aborted', reason: { kind: 'user' } }), '被取消（用户）')
  assert.equal(describeEndReason({ kind: 'error', error: { message: 'boom' } }), '错误：boom')
  assert.equal(describeEndReason({ kind: 'max-tokens' }), '达到输出上限')
  assert.equal(describeEndReason({ kind: 'blocked' }), '被阻断')
})

test('handles an empty log without inventing fragments', () => {
  const result = extractFragments({ session: HEADER, events: [] })
  assert.equal(result.count, 0)
  assert.match(result.block, /\[位置\]/)
})
