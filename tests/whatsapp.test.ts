/**
 * Evolution text delivery contract tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { sendText } from '../src/whatsapp.js'
import { evolutionConfig as config } from './helpers/webhook.js'

/** Verifies the Evolution text payload and HTTP error propagation. */
test('sendText uses the Evolution textMessage contract and fails on HTTP errors', async () => {
  /** Captures the URL passed to the injected fetch implementation. */
  let calledUrl = ''
  /** Captures the request options passed to the injected fetch implementation. */
  let calledInit: RequestInit | undefined
  /** Fetch mock that records the request and returns HTTP 200. */
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url)
    calledInit = init
    return new Response('{}', { status: 200 })
  }
  await sendText(config, '5511999999999', 'Hello', fakeFetch)
  assert.equal(calledUrl, 'http://localhost:8080/message/sendText/zapcode')
  /** Headers extracted from the captured request. */
  const headers = new Headers(calledInit?.headers)
  assert.equal(headers.get('apikey'), 'api-key')
  assert.deepEqual(JSON.parse(String(calledInit?.body)), { number: '5511999999999', textMessage: { text: 'Hello' } })
  await assert.rejects(sendText(config, '5511999999999', 'Hello', async () => new Response('failed', { status: 500 })), /500/)
})
