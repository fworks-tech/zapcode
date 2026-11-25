/**
 * Temporary filesystem fixtures with deterministic cleanup.
 *
 * @remarks
 * Centralizes directory and file setup so tests do not repeat lifecycle code
 * or leak temporary state after failures.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Runs an operation inside a temporary directory and always removes it.
 *
 * @param prefix - Prefix used for the temporary directory name.
 * @param operation - Test behavior that receives the directory path.
 * @returns The operation's result.
 */
export async function withTempDirectory<T>(prefix: string, operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await operation(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Runs an operation with a temporary file containing the supplied content.
 *
 * @param prefix - Prefix used for the temporary directory name.
 * @param name - File name inside the temporary directory.
 * @param content - Initial UTF-8 file content.
 * @param operation - Test behavior that receives the file path.
 * @returns The operation's result.
 */
export async function withTempFile<T>(
  prefix: string,
  name: string,
  content: string,
  operation: (file: string) => Promise<T>,
): Promise<T> {
  return withTempDirectory(prefix, async (directory) => {
    const file = path.join(directory, name)
    await writeFile(file, content)
    return operation(file)
  })
}
