/**
 * Contract tests for the generated OpenCode V2 client.
 *
 * @remarks
 * A scripted `fetch` exercises the real client URL, query, body, authentication,
 * and response handling instead of replacing the client with handwritten mocks.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { OpenCode } from '@opencode/client'

import { promptWithContext } from '../src/opencode.js'

/** Captured HTTP request metadata. */
interface CapturedRequest {
  method: string
  path: string
  search: URLSearchParams
  headers: Headers
  body: unknown
}

/** Verifies the real list → prompt → wait → list HTTP contract. */
test('promptWithContext uses the generated OpenCode V2 HTTP contract', async () => {
  /** Requests captured by the scripted fetch implementation. */
  const requests: CapturedRequest[] = []
  /** Counts message-list calls before and after execution. */
  let listCalls = 0
  /** Scripted fetch that returns the minimal OpenCode response shapes. */
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path: url.pathname, search: url.searchParams, headers: new Headers(init?.headers), body })

    if (url.pathname === '/api/session/session-1/message') {
      listCalls++
      return Response.json({
        data: listCalls === 1
          ? [{ id: 'previous', type: 'assistant', content: [{ type: 'text', text: 'old' }] }]
          : [{ id: 'new', type: 'assistant', content: [{ type: 'text', text: 'new response' }] }],
        cursor: {},
      })
    }
    if (url.pathname === '/api/session/session-1/prompt') return Response.json({ id: 'user-1' })
    if (url.pathname === '/api/experimental/session/session-1/wait') return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${method} ${url}`)
  }

  /** Expected Basic authorization value. */
  const authorization = `Basic ${Buffer.from('opencode:password').toString('base64')}`
  /** Real generated client with only the network boundary replaced. */
  const client = OpenCode.make({
    baseUrl: 'http://127.0.0.1:4096',
    headers: { authorization },
    fetch: fakeFetch,
  })

  const reply = await promptWithContext(client, 'session-1', {
    text: 'What is the answer?',
    knowledge: ['faq.md:\nFAQ content'],
    promptID: 'msg-contract',
  })

  assert.equal(reply, 'new response')
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [
    ['GET', '/api/session/session-1/message'],
    ['POST', '/api/session/session-1/prompt'],
    ['POST', '/api/experimental/session/session-1/wait'],
    ['GET', '/api/session/session-1/message'],
  ])
  assert.equal(requests[0]?.search.get('limit'), '1')
  assert.equal(requests[0]?.search.get('order'), 'desc')
  assert.equal(requests[0]?.search.get('type'), 'assistant')
  assert.equal(requests[3]?.search.get('limit'), '20')
  assert.equal((requests[1]?.body as { id: string }).id, 'msg-contract')
  assert.match((requests[1]?.body as { text: string }).text, /FAQ content/)
  assert.ok(requests.every((request) => request.headers.get('authorization') === authorization))
})
