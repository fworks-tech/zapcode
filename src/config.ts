/**
 * Environment configuration for zapcode.
 *
 * @remarks
 * Configuration is loaded once at startup. Validation fails closed so the
 * bridge cannot run with missing credentials, placeholder secrets, or an
 * invalid listening port.
 */

import path from 'node:path'

/** Fully validated runtime configuration used by the bridge modules. */
export interface Config {
  /** Base URL of the authenticated OpenCode V2 server. */
  openCodeUrl: string
  /** Password shared with OpenCode for HTTP Basic authentication. */
  openCodePassword: string
  /** Absolute project directory exposed to OpenCode. */
  workdir: string
  /** Absolute directory containing Markdown knowledge files. */
  knowledgeDir: string
  /** Absolute path of the persisted OpenCode session file. */
  sessionFile: string
  /** Base URL of the local Evolution API. */
  evolutionUrl: string
  /** API key used to authenticate requests to Evolution. */
  evolutionApiKey: string
  /** Evolution instance name used for webhook and message routes. */
  evolutionInstance: string
  /** Normalized phone number allowed to send commands and prompts. */
  allowedNumber: string
  /** Secret required in the `Webhook-Secret` request header. */
  webhookSecret: string
  /** TCP port on which the local bridge listens. */
  port: number
}

/** Environment variables that must be present before startup. */
const required = [
  'OPENCODE_URL',
  'OPENCODE_PASSWORD',
  'WORKDIR',
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'ALLOWED_NUMBER',
  'WEBHOOK_SECRET',
] as const

/** Validates one required secret and rejects example placeholders. */
function validateSecret(env: NodeJS.ProcessEnv, key: string): void {
  const value = env[key]!
  if (value.length < 16 || value.startsWith('replace-')) {
    throw new Error(`${key} must be at least 16 characters and cannot be the .env.example placeholder.`)
  }
}

/** Rejects missing or blank required environment variables. */
function validateRequired(env: NodeJS.ProcessEnv): void {
  for (const key of required) {
    if (!env[key]?.trim()) throw new Error(`Missing required environment variable: ${key}`)
  }
}

/** Normalizes and validates the owner's WhatsApp number. */
function parseAllowedNumber(value: string): string {
  const allowedNumber = value.replace(/\D/g, '')
  if (allowedNumber.length < 10) throw new Error('ALLOWED_NUMBER must include country code + area code + number.')
  return allowedNumber
}

/** Validates the listening port, defaulting to 3000. */
function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.')
  return port
}

/**
 * Loads and validates configuration from an environment object.
 *
 * @param env - Environment variables to read; defaults to `process.env`.
 * @returns A normalized configuration object with absolute filesystem paths.
 * @throws If a required variable is missing, a secret is a placeholder, the
 * allowed number is malformed, or the port is outside the TCP range.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  validateRequired(env)
  const allowedNumber = parseAllowedNumber(env.ALLOWED_NUMBER!)
  validateSecret(env, 'OPENCODE_PASSWORD')
  validateSecret(env, 'WEBHOOK_SECRET')
  validateSecret(env, 'EVOLUTION_API_KEY')
  const port = parsePort(env.PORT)

  return {
    openCodeUrl: env.OPENCODE_URL!.replace(/\/$/, ''),
    openCodePassword: env.OPENCODE_PASSWORD!,
    workdir: path.resolve(env.WORKDIR!),
    knowledgeDir: path.resolve(process.cwd(), 'knowledge'),
    sessionFile: path.resolve(process.cwd(), 'data', 'session.json'),
    evolutionUrl: env.EVOLUTION_API_URL!.replace(/\/$/, ''),
    evolutionApiKey: env.EVOLUTION_API_KEY!,
    evolutionInstance: env.EVOLUTION_INSTANCE!,
    allowedNumber,
    webhookSecret: env.WEBHOOK_SECRET!,
    port,
  }
}
