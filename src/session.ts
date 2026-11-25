/**
 * Persistent single-session storage for zapcode.
 *
 * @remarks
 * The session file is written atomically so a process crash does not leave
 * partially written JSON. Reused sessions are validated and refreshed with the
 * current permission policy before they are returned to the runtime.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { SAFE_PERMISSIONS, isNotFound, samePath } from './permission-policy.js'

/** Request options accepted by the OpenCode control calls used here. */
interface ControlOptions {
  signal?: AbortSignal
}

/** Minimal OpenCode client surface required by the session store. */
interface SessionClient {
  /** OpenCode session operations. */
  session: {
    /**
     * Creates a session with conservative permissions.
     *
     * @param input - Project location and permission rules.
     * @param options - Optional request deadline.
     */
    create(input: { location: { directory: string }; permissions: typeof SAFE_PERMISSIONS }, options?: ControlOptions): Promise<{ id: string }>
    /**
     * Loads a session to validate that it still exists.
     *
     * @param input - Session ID to load.
     * @param options - Optional request deadline.
     */
    get(input: { sessionID: string }, options?: ControlOptions): Promise<{ id: string; location: { directory: string } }>
    /**
     * Updates mutable session settings such as permissions.
     *
     * @param input - Session ID and replacement permission rules.
     * @param options - Optional request deadline.
     */
    update(input: { sessionID: string; permissions: typeof SAFE_PERMISSIONS }, options?: ControlOptions): Promise<void>
    /**
     * Removes a session and its server-side conversation history.
     *
     * @param input - Session ID to remove.
     * @param options - Optional request deadline.
     */
    remove(input: { sessionID: string }, options?: ControlOptions): Promise<void>
  }
}

/** Signals that persisted session state is unsafe to overwrite automatically. */
export class SessionStateError extends Error {
  /** Creates a session-state error with recovery guidance. */
  constructor(message: string) {
    super(message)
    this.name = 'SessionStateError'
  }
}

/** Signals that saved or server session configuration requires an explicit reset. */
export class SessionConfigurationError extends Error {
  /** Creates a non-retryable session-configuration error with recovery guidance. */
  constructor(message: string) {
    super(message)
    this.name = 'SessionConfigurationError'
  }
}

/** Active prompt bookkeeping persisted for restart recovery. */
interface SavedActiveRun {
  /** Stable inbox ID used when the prompt was admitted. */
  inboxID: string
}

/** JSON shape persisted in `data/session.json`. */
interface SavedSession {
  /** OpenCode session identifier. */
  sessionID: string
  /** Absolute workdir associated with the session. */
  workdir: string
  /** Prompt that may still be running after a bridge restart. */
  activeRun?: SavedActiveRun
}

/** Narrows an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Throws the stable fail-closed error for an invalid session shape. */
function invalidSessionShape(): never {
  throw new SessionStateError('Invalid data/session.json shape. Back up or remove the file before retrying.')
}

/** Validates optional active-run bookkeeping. */
function parseActiveRun(value: Record<string, unknown>): SavedActiveRun | undefined {
  if (!('activeRun' in value)) return undefined
  const activeRun = value.activeRun
  if (!isRecord(activeRun) || typeof activeRun.inboxID !== 'string' || activeRun.inboxID.length === 0) {
    throw new SessionStateError('Invalid activeRun in data/session.json. Back up or remove the file before retrying.')
  }
  return { inboxID: activeRun.inboxID }
}

/** Creates, reuses, recovers, and deletes the bridge's one OpenCode session. */
export class SessionStore {
  /** Serializes atomic writes for this store instance. */
  private writeQueue: Promise<void> = Promise.resolve()

  /**
   * Creates a session store.
   *
   * @param client - OpenCode client used to manage sessions.
   * @param workdir - Project directory that sessions must match.
   * @param file - JSON file used to persist session and active-run state.
   */
  constructor(
    private readonly client: SessionClient,
    private readonly workdir: string,
    private readonly file: string,
  ) {}

  /**
   * Loads a valid saved session or creates a new one for the configured workdir.
   *
   * @returns The active OpenCode session ID.
   */
  async ensure(): Promise<string> {
    const signal = AbortSignal.timeout(10_000)
    const saved = await this.read()
    if (saved && saved.workdir !== this.workdir) {
      throw new SessionConfigurationError('Saved session belongs to a different WORKDIR. Send /reset before changing projects.')
    }
    if (saved?.workdir === this.workdir) {
      try {
        const remote = await this.client.session.get({ sessionID: saved.sessionID }, { signal })
        if (!samePath(remote.location.directory, this.workdir)) {
          throw new SessionConfigurationError('Saved OpenCode session location does not match WORKDIR. Send /reset before changing projects.')
        }
        await this.client.session.update({ sessionID: saved.sessionID, permissions: SAFE_PERMISSIONS }, { signal })
        return saved.sessionID
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }

    const session = await this.client.session.create({
      location: { directory: this.workdir },
      permissions: SAFE_PERMISSIONS,
    }, { signal })
    try {
      await this.enqueue(() => this.writeAtomically({ sessionID: session.id, workdir: this.workdir }))
    } catch (error) {
      try {
        await this.client.session.remove({ sessionID: session.id }, { signal: AbortSignal.timeout(5_000) })
      } catch (cleanupError) {
        console.error(`Failed to remove unpersisted OpenCode session ${session.id}.`, cleanupError)
      }
      throw error
    }
    return session.id
  }

  /**
   * Returns the saved session ID so reset can clean up prior project state.
   *
   * @returns The persisted session ID, if present.
   */
  async currentSessionID(): Promise<string | undefined> {
    const saved = await this.read()
    return saved?.sessionID
  }

  /**
   * Returns active prompt bookkeeping saved before a bridge restart, even
   * when the configured workdir changed.
   *
   * @returns The persisted session and inbox IDs, if a run was active.
   */
  async getActiveRun(): Promise<{ sessionID: string; inboxID: string } | undefined> {
    const saved = await this.read()
    if (!saved?.activeRun) return undefined
    return { sessionID: saved.sessionID, inboxID: saved.activeRun.inboxID }
  }

  /**
   * Persists the active inbox ID before a prompt is admitted.
   *
   * @param inboxID - Stable prompt ID used for cancellation.
   */
  markActive(inboxID: string): Promise<void> {
    return this.enqueue(async () => {
      const saved = await this.read()
      if (!saved || saved.workdir !== this.workdir) throw new Error('No saved session is available for the active run.')
      await this.writeAtomically({ ...saved, activeRun: { inboxID } })
    })
  }

  /**
   * Clears active-run bookkeeping after completion or confirmed cancellation.
   *
   * @param inboxID - Only clear the marker when it belongs to this prompt.
   */
  clearActive(inboxID?: string): Promise<void> {
    return this.enqueue(async () => {
      const saved = await this.read()
      if (!saved?.activeRun || (inboxID && saved.activeRun.inboxID !== inboxID)) return
      const { activeRun: _activeRun, ...withoutActiveRun } = saved
      await this.writeAtomically(withoutActiveRun)
    })
  }

  /**
   * Removes the server-side session and then deletes the local pointer.
   *
   * @param sessionID - Session to remove; defaults to the saved session.
   */
  reset(sessionID?: string): Promise<void> {
    return this.enqueue(() => this.resetAtomically(sessionID))
  }

  /** Removes the server session and local pointer after prior writes finish. */
  private async resetAtomically(sessionID?: string): Promise<void> {
    const signal = AbortSignal.timeout(10_000)
    const saved = await this.read()
    const target = sessionID ?? saved?.sessionID
    if (target) {
      try {
        await this.client.session.remove({ sessionID: target }, { signal })
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
    await rm(this.file, { force: true })
  }

  /** Validates a parsed session JSON value. */
  private parseSavedSession(value: unknown): SavedSession {
    if (!isRecord(value)) invalidSessionShape()
    const { sessionID, workdir } = value
    if (typeof sessionID !== 'string' || sessionID.length === 0 || typeof workdir !== 'string' || workdir.length === 0) {
      invalidSessionShape()
    }
    const activeRun = parseActiveRun(value)
    return { sessionID, workdir, ...(activeRun ? { activeRun } : {}) }
  }

  /**
   * Reads and validates the persisted session JSON.
   *
   * @returns A saved session, or `null` when the file is missing.
   * @throws When persisted JSON or session shape is invalid.
   */
  private async read(): Promise<SavedSession | null> {
    try {
      /** Parsed but not yet validated JSON value. */
      const saved: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return this.parseSavedSession(saved)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof SyntaxError) {
        throw new SessionStateError('Invalid JSON in data/session.json. Back up or remove the file before retrying.')
      }
      throw error
    }
  }

  /** Serializes a read-modify-write session operation. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Atomically replaces the session file with validated JSON.
   *
   * @param saved - Session data to persist.
   */
  private async writeAtomically(saved: SavedSession): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    /** Unique temporary path used before the atomic rename. */
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(saved, null, 2), 'utf8')
      await rename(temporary, this.file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
