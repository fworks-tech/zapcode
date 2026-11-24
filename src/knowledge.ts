/**
 * Loads the Markdown knowledge base injected into every OpenCode prompt.
 *
 * @remarks
 * Files are read on every request so edits take effect without restarting the
 * bridge. Alphabetical ordering keeps prompt context deterministic, and a
 * total size budget prevents accidental context or cost explosions.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** Maximum number of Markdown files loaded for one prompt. */
const MAX_KNOWLEDGE_FILES = 20

/** Maximum total characters loaded from the knowledge directory. */
const MAX_KNOWLEDGE_CHARACTERS = 24_000

/**
 * Reads all Markdown files from a knowledge directory.
 *
 * @param directory - Directory containing `.md` knowledge files.
 * @returns File-name-prefixed contents sorted by file name.
 * @throws When the knowledge base exceeds its file or character budget.
 */
export async function loadKnowledge(directory: string): Promise<string[]> {
  /** Directory entries, including file type metadata. */
  const entries = await readdir(directory, { withFileTypes: true })
  /** Sorted names of regular Markdown files in the directory. */
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()

  if (files.length > MAX_KNOWLEDGE_FILES) {
    throw new Error(`Knowledge base has more than ${MAX_KNOWLEDGE_FILES} Markdown files.`)
  }

  /** Loaded file contents in deterministic order. */
  const knowledge = await Promise.all(files.map(async (file) => `${file}:\n${await readFile(path.join(directory, file), 'utf8')}`))
  if (knowledge.reduce((total, item) => total + item.length, 0) > MAX_KNOWLEDGE_CHARACTERS) {
    throw new Error(`Knowledge base exceeds ${MAX_KNOWLEDGE_CHARACTERS} characters.`)
  }
  return knowledge
}
