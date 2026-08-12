import type { Config, ResolvedProfile } from './config.js'

export interface ResolveProfileOptions {
  cliProfile?: string
  envProfile?: string
  cliModel?: string
  envModel?: string
  cliEffort?: string
  envEffort?: string
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

function cliValue(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined
  if (value === '') throw new ProfileError(`${flag} must not be empty`)
  return value
}

export function resolveProfile(config: Config, options: ResolveProfileOptions): ResolvedProfile {
  const cliProfile = cliValue(options.cliProfile, '--profile')
  const envProfile = nonEmpty(options.envProfile)
  const profileName = cliProfile ?? envProfile ?? config.default_profile

  if (profileName === undefined) {
    throw new ProfileError('no launch profile selected')
  }

  const profiles = config.profiles
  const profile =
    profiles !== undefined && Object.hasOwn(profiles, profileName)
      ? profiles[profileName]
      : undefined
  if (!profile) {
    throw new ProfileError(`unknown profile: ${profileName}`)
  }

  const cliModel = cliValue(options.cliModel, '--model')
  const envModel = nonEmpty(options.envModel)
  const cliEffort = cliValue(options.cliEffort, '--effort')
  const envEffort = nonEmpty(options.envEffort)

  const model = cliModel ?? envModel ?? profile.model
  const modelSource = cliModel !== undefined ? 'cli' : envModel !== undefined ? 'env' : 'profile'

  const effort = cliEffort ?? envEffort ?? profile.effort
  const effortSource =
    cliEffort !== undefined
      ? 'cli'
      : envEffort !== undefined
        ? 'env'
        : profile.effort !== undefined
          ? 'profile'
          : undefined

  return {
    name: profileName,
    source: cliProfile !== undefined ? 'cli' : envProfile !== undefined ? 'env' : 'default',
    agent: profile.agent,
    model,
    effort,
    modelSource,
    effortSource,
  }
}

export function formatResolvedProfileLines(resolved: ResolvedProfile): string[] {
  const lines = [
    `# Resolved profile: ${resolved.name} (source: ${resolved.source})`,
    `# Resolved agent: ${resolved.agent}`,
    `# Resolved model: ${resolved.model}`,
  ]
  if (resolved.effort) {
    lines.push(`# Resolved effort: ${resolved.effort}`)
  }
  const overrides: string[] = []
  if (resolved.modelSource !== 'profile') {
    overrides.push(`model=${resolved.modelSource}`)
  }
  if (resolved.effortSource !== undefined && resolved.effortSource !== 'profile') {
    overrides.push(`effort=${resolved.effortSource}`)
  }
  if (overrides.length > 0) {
    lines.push(`# Overrides: ${overrides.join(', ')}`)
  }
  return lines
}
