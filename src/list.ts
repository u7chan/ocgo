import { Command } from 'commander'
import { type Config, loadConfig } from './config.js'
import { isJsonMode, outputJsonSuccess } from './json-output.js'

export function formatList(config: Config): string {
  const profiles = Object.entries(config.profiles ?? {})

  if (profiles.length === 0) {
    return 'No profiles defined.'
  }

  const nameWidth = Math.max(
    7,
    ...profiles.map(([name]) => (name === config.default_profile ? name.length + 2 : name.length)),
  )
  const agentWidth = Math.max(5, ...profiles.map(([, profile]) => profile.agent.length))
  const modelWidth = Math.max(5, ...profiles.map(([, profile]) => profile.model.length))
  const effortWidth = Math.max(6, ...profiles.map(([, profile]) => profile.effort?.length ?? 0))

  const lines: string[] = [
    `${'PROFILE'.padEnd(nameWidth + 1)} ${'AGENT'.padEnd(agentWidth + 1)} ${'MODEL'.padEnd(modelWidth + 1)} ${'EFFORT'.padEnd(effortWidth + 1)}`,
  ]
  for (const [name, profile] of profiles) {
    const marker = name === config.default_profile ? ' *' : ''
    lines.push(
      `${(name + marker).padEnd(nameWidth + 1)} ${profile.agent.padEnd(agentWidth + 1)} ${profile.model.padEnd(modelWidth + 1)} ${(profile.effort ?? '-').padEnd(effortWidth + 1)}`,
    )
  }
  if (config.default_profile && profiles.some(([name]) => name === config.default_profile)) {
    lines.push('')
    lines.push('* = default_profile')
  }
  return lines.join('\n')
}

export function createListCommand(): Command {
  const command = new Command('list')

  command.description('List configured launch profiles').action(() => {
    const config = loadConfig()
    const globals = command.optsWithGlobals() as { json?: boolean }

    if (isJsonMode(globals)) {
      const profiles = Object.entries(config.profiles ?? {}).map(([name, profile]) => ({
        name,
        agent: profile.agent,
        model: profile.model,
        effort: profile.effort ?? null,
      }))
      outputJsonSuccess('list', {
        default_profile: config.default_profile ?? null,
        profiles,
      })
      return
    }
    console.log(formatList(config))
  })

  return command
}
