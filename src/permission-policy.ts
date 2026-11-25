/**
 * OpenCode permission policy and payload helpers.
 *
 * @remarks
 * Keeps rule ordering, project-path matching, payload validation, and
 * policy-denied request detection separate from the WhatsApp delivery state
 * machine.
 */

import path from 'node:path'

/**
 * Conservative permission rules applied to every OpenCode session.
 *
 * @remarks
 * OpenCode V2 uses the last matching rule. Broad asks therefore appear before
 * specific `.env*` denies. Grep and subagents remain blocked because their
 * permission inputs cannot safely enforce the required path boundary.
 */
export const SAFE_PERMISSIONS: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }> = [
  { action: '*', resource: '*', effect: 'ask' },
  { action: 'external_directory', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*', effect: 'ask' },
  { action: 'glob', resource: '*', effect: 'allow' },
  // shortcut: grep permission does not include the path, so it stays blocked until path validation exists.
  { action: 'grep', resource: '*', effect: 'deny' },
  { action: 'subagent', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*.env*', effect: 'deny' },
  { action: 'edit', resource: '*.env*', effect: 'deny' },
  { action: 'question', resource: '*', effect: 'deny' },
]

/** Validated permission request stored while awaiting the owner's decision. */
export interface PermissionRequest {
  /** OpenCode permission request ID used by `/yes` and `/no`. */
  id: string
  /** OpenCode session that owns the request. */
  sessionID: string
  /** Tool action requesting permission, such as `edit` or `shell`. */
  action: string
  /** Resource descriptions supplied by OpenCode. */
  resources: string[]
}

/** Narrows an unknown value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates an OpenCode permission payload.
 *
 * @param value - Raw event data.
 * @returns A normalized request, or `null` when required fields are invalid.
 */
export function parseRequest(value: unknown): PermissionRequest | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.sessionID !== 'string' || typeof value.action !== 'string') return null
  if (!Array.isArray(value.resources) || !value.resources.every((resource) => typeof resource === 'string')) return null
  return { id: value.id, sessionID: value.sessionID, action: value.action, resources: value.resources }
}

/** Returns whether an error represents a missing OpenCode resource. */
export function isNotFound(error: unknown): boolean {
  const value = error as { name?: unknown; status?: unknown; response?: { status?: unknown } } | null
  return value?.status === 404 || value?.response?.status === 404 ||
    (typeof value?.name === 'string' && value.name.endsWith('NotFoundError'))
}

/** Returns whether two filesystem paths identify the same directory. */
export function samePath(left: string, right: string): boolean {
  const actual = path.resolve(left)
  const expected = path.resolve(right)
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
}

/** Returns whether current bridge policy denies a pending request. */
export function isDeniedByPolicy(request: PermissionRequest): boolean {
  if (['external_directory', 'grep', 'subagent', 'question'].includes(request.action)) return true
  return (request.action === 'read' || request.action === 'edit') && request.resources.some((resource) => /\.env/i.test(resource))
}

/** Returns whether an event location belongs to the configured workdir. */
export function matchesWorkdir(location: string | undefined, workdir: string): boolean {
  return typeof location === 'string' && samePath(location, workdir)
}

/** Minimal client surface used to enforce project-scoped permission policy. */
interface PolicyClient {
  session: { get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<{ projectID: string }> }
  permission: {
    saved: {
      list(input: { projectID: string }, options?: { signal?: AbortSignal }): Promise<Array<{ id: string }>>
      remove(input: { id: string }, options?: { signal?: AbortSignal }): Promise<void>
    }
  }
}

/** Removes durable project approvals that could bypass WhatsApp prompts. */
export async function enforcePermissionPolicy(client: PolicyClient, sessionID: string): Promise<void> {
  const signal = AbortSignal.timeout(10_000)
  let saved: Array<{ id: string }>
  try {
    const session = await client.session.get({ sessionID }, { signal })
    saved = await client.permission.saved.list({ projectID: session.projectID }, { signal })
  } catch (error) {
    if (!isNotFound(error)) throw error
    return
  }
  const results = await Promise.allSettled(saved.map((rule) => client.permission.saved.remove({ id: rule.id }, { signal })))
  const failure = results.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected' && !isNotFound(result.reason))
  if (failure) throw failure.reason
}
