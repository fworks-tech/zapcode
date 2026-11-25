/**
 * Configuration, parsing, permission-policy, and knowledge unit tests.
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { loadConfig } from '../src/config.js'
import { SAFE_PERMISSIONS } from '../src/permission-policy.js'
import { chunkText } from '../src/whatsapp.js'
import { extractIncoming, normalizeNumber } from '../src/webhook.js'
import { loadKnowledge } from '../src/knowledge.js'
import { withTempDirectory } from './helpers/temp.js'

/** Environment variables temporarily cleared by the configuration test. */
const envKeys = ['OPENCODE_URL', 'OPENCODE_PASSWORD', 'WORKDIR', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'ALLOWED_NUMBER', 'WEBHOOK_SECRET']

/**
 * Resolves the effective permission effect using V2's last-match behavior.
 *
 * @param action - Permission action to evaluate.
 * @param resource - Resource string to match against each rule.
 * @returns The last matching effect, or `undefined` when no rule matches.
 */
function permissionEffect(action: string, resource: string): string | undefined {
  /** Effect produced by the most recently matching rule. */
  let effect: string | undefined
  for (const rule of SAFE_PERMISSIONS) {
    if (rule.action !== action && rule.action !== '*') continue
    /** Rule resource converted from glob syntax to an anchored regular expression. */
    const pattern = rule.resource.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    if (new RegExp(`^${pattern}$`, 'i').test(resource)) effect = rule.effect
  }
  return effect
}

/** Verifies that missing mandatory configuration fails immediately. */
test('config requires every mandatory variable', () => {
  /** Snapshot of environment values restored after the test. */
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  try {
    assert.throws(() => loadConfig(), /OPENCODE_URL/)
  } finally {
    for (const key of envKeys) {
      if (saved[key] !== undefined) process.env[key] = saved[key]
    }
  }
})

/** Verifies number normalization and rejection of example secret placeholders. */
test('config normalizes the number and rejects secret placeholders', () => {
  /** Complete valid environment used as the baseline for assertions. */
  const valid = {
    OPENCODE_URL: 'http://127.0.0.1:4096/',
    OPENCODE_PASSWORD: 'opencode-password-with-32-characters',
    WORKDIR: '.',
    EVOLUTION_API_URL: 'http://127.0.0.1:8080/',
    EVOLUTION_API_KEY: 'evolution-key-with-32-characters',
    EVOLUTION_INSTANCE: 'zapcode',
    ALLOWED_NUMBER: '+55 (11) 99999-9999',
    WEBHOOK_SECRET: 'webhook-secret-with-32-characters',
  }
  assert.equal(loadConfig(valid).allowedNumber, '5511999999999')
  assert.equal(loadConfig(valid).openCodeUrl, 'http://127.0.0.1:4096')
  assert.equal(loadConfig(valid).openCodePassword, 'opencode-password-with-32-characters')
  assert.throws(() => loadConfig({ ...valid, WEBHOOK_SECRET: 'replace-with-another-random-32-byte-secret' }), /WEBHOOK_SECRET/)
  assert.throws(() => loadConfig({ ...valid, OPENCODE_PASSWORD: 'replace-with-an-opencode-password' }), /OPENCODE_PASSWORD/)
})

/** Verifies that specific denies override broad allows and risky tools stay blocked. */
test('permissions deny .env after broad allows and block grep/subagents', () => {
  assert.equal(permissionEffect('read', '.env'), 'deny')
  assert.equal(permissionEffect('read', 'secrets/.env.local'), 'deny')
  assert.equal(permissionEffect('read', 'src/index.ts'), 'ask')
  assert.equal(permissionEffect('edit', '.env'), 'deny')
  assert.equal(permissionEffect('grep', '.*'), 'deny')
  assert.equal(permissionEffect('subagent', 'general'), 'deny')
})

/** Verifies JID and formatted phone-number normalization. */
test('normalizeNumber accepts JIDs and formatted numbers', () => {
  assert.equal(normalizeNumber('5511999999999:12@s.whatsapp.net'), '5511999999999')
  assert.equal(normalizeNumber('+55 (11) 99999-9999'), '5511999999999')
})

/** Verifies that only direct incoming text messages are extracted. */
test('extractIncoming only accepts text in direct incoming conversations', () => {
  /** Minimal valid payload reused across shape variations. */
  const base = { event: 'messages.upsert', data: { key: { id: 'm1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false } } }
  assert.deepEqual(extractIncoming(base), { from: '5511999999999', text: undefined, id: 'm1' })
  assert.equal(extractIncoming({ ...base, data: { ...base.data, message: { conversation: 'Hello' } } })?.text, 'Hello')
  assert.equal(extractIncoming({ ...base, data: { ...base.data, message: { extendedTextMessage: { text: 'Hello' } } } })?.text, 'Hello')
  assert.equal(extractIncoming({ ...base, data: { ...base.data, key: { ...base.data.key, fromMe: true } } }), null)
  assert.equal(extractIncoming({ ...base, data: { ...base.data, key: { ...base.data.key, remoteJid: '123@g.us' } } }), null)
  assert.equal(extractIncoming({ ...base, data: { ...base.data, message: { imageMessage: {} } } }), null)
})

/** Verifies chunk ordering, lossless joining, word boundaries, and Unicode safety. */
test('chunkText preserves text and respects the limit without splitting words', () => {
  assert.deepEqual(chunkText('short', 10), ['short'])
  /** Long input designed to require multiple word-aware chunks. */
  const text = ('word '.repeat(30) + '\n').repeat(20)
  /** Chunks produced for the long input. */
  const chunks = chunkText(text, 100)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 100))
  /** Input with no whitespace, forcing hard character boundaries. */
  const unbroken = 'a'.repeat(25)
  assert.deepEqual(chunkText(unbroken, 10), ['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa'])
  assert.deepEqual(chunkText('😀', 1), ['😀'])
})

/** Verifies deterministic Markdown-only knowledge loading. */
test('loadKnowledge reads only Markdown deterministically', async () => {
  await withTempDirectory('zapcode-knowledge-', async (directory) => {
    await writeFile(path.join(directory, 'b.md'), 'B')
    await writeFile(path.join(directory, 'a.md'), 'A')
    await writeFile(path.join(directory, 'ignored.txt'), 'ignored')
    assert.deepEqual(await loadKnowledge(directory), ['a.md:\nA', 'b.md:\nB'])
  })
})

