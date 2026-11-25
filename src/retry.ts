/**
 * Shared bounded retry helper.
 *
 * @remarks
 * Used for transient WhatsApp and OpenCode control operations. The current
 * predicate lets reset stop retries before another attempt starts.
 */

/**
 * Retries an operation up to three times with bounded backoff.
 *
 * @param operation - Asynchronous operation to attempt.
 * @param isCurrent - Returns whether another attempt is still allowed.
 * @returns The first successful result.
 * @throws The last failure, or a cancellation error when stale.
 */
export async function retryOperation<T>(operation: () => Promise<T>, isCurrent: () => boolean = () => true): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isCurrent()) throw new Error('Operation cancelled by reset.')
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
  throw lastError
}
