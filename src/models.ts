import { Command } from 'commander'
import { getAgentAdapter } from './agents/registry.js'
import { formatCommandSpec, runCommandSpec } from './command.js'
import { getAgent, loadConfig } from './config.js'
import { isJsonMode, outputJsonFailure } from './json-output.js'

export function createModelsCommand(): Command {
  const command = new Command('models')

  command
    .description('Query the provider for available models')
    .option(
      '--refresh',
      'No effect; use "cagent models available --refresh" to refresh the provider model list',
    )
    .action(() => {
      const globals = command.optsWithGlobals() as { json?: boolean }
      const message =
        "Error: 'cagent models' is removed. Use 'cagent list' to view profiles or 'cagent models available' to list provider models."
      if (isJsonMode(globals)) {
        outputJsonFailure('models', 'USAGE_ERROR', message)
      } else {
        console.error(message)
      }
      process.exit(1)
    })

  const availableCmd = new Command('available')
  availableCmd
    .description('List available models from the provider')
    .option('--refresh', 'Refresh the model list from the provider')
    .action(async () => {
      const config = loadConfig()
      const globals = availableCmd.optsWithGlobals() as {
        agent?: string
        dryRun?: boolean
        refresh?: boolean
      }
      const effectiveAgentId = globals.agent ?? process.env.CAGENT_AGENT ?? config.default_agent
      if (!config.agents[effectiveAgentId]) {
        console.error(`Error: agent "${effectiveAgentId}" is not defined in config`)
        process.exit(1)
      }
      const agent = getAgent(config, effectiveAgentId)
      const adapter = getAgentAdapter(effectiveAgentId)

      if (!adapter.buildModelListCommand) {
        console.error(
          `Error: provider model discovery is not supported for agent "${effectiveAgentId}".\n` +
            `Run \`cagent list\` to view configured profiles.`,
        )
        process.exit(1)
      }

      const spec = adapter.buildModelListCommand({
        bin: agent.bin,
        provider: agent.provider,
        refresh: globals.refresh,
      })

      if (globals.dryRun) {
        console.log(formatCommandSpec(spec))
        return
      }

      const result = await runCommandSpec(spec, { stdio: 'inherit' })
      if (result.exitCode !== 0 && result.exitCode !== null) {
        process.exit(result.exitCode)
      }
    })

  command.addCommand(availableCmd)
  return command
}
