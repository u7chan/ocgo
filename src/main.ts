import { Command, Option } from 'commander'
import { getAgentAdapter } from './agents/registry.js'
import { formatCommandSpec, runCommandSpec } from './command.js'
import { getAgent, loadConfig, type ResolvedProfile, resolveConfigPath } from './config.js'
import { isJsonMode, outputJsonFailure, outputJsonSuccess } from './json-output.js'
import { formatResolvedProfileLines, ProfileError, resolveProfile } from './profile.js'
import { assertTty } from './tty.js'
import { VERSION } from './version.js'

export interface MainOptions {
  model?: string
  effort?: string
  dryRun?: boolean
  json?: boolean
  adapter?: string
}

export function createMainCommand(): Command {
  const program = new Command()

  program
    .name('cagent')
    .description('Coding-agent launcher with model routing')
    .version(VERSION)
    .addOption(new Option('-v', 'output the version number').hideHelp())
    .argument('[profile]', 'launch profile')
    .option('-m, --model <model>', 'explicit model id')
    .option('-e, --effort <effort>', 'explicit reasoning effort')
    .option('-d, --dry-run', 'print the resolved command without executing')
    .option('--json', 'output control information as JSON')
    .addOption(
      new Option('--adapter <adapter>', 'multiplexer adapter to use').default(undefined).hideHelp(),
    )
    .allowUnknownOption()
    .action(async (positionalProfile: string | undefined, options: MainOptions) => {
      if (positionalProfile === 'profiles') {
        program.error("error: unknown command 'profiles'")
      }

      if (positionalProfile?.startsWith('--')) {
        program.error(`error: unknown option '${positionalProfile}'`)
      }

      if (program.opts().v) {
        console.log(VERSION)
        process.exit(0)
      }

      const json = isJsonMode(options)
      if (json && !options.dryRun) {
        outputJsonFailure(
          'run.plan',
          'USAGE_ERROR',
          '--json requires --dry-run for this command',
          { suggestion: 'Use --dry-run --json or pass --json after --' },
          'Use `cagent run --dry-run [profile] --json` for cagent control metadata.\n' +
            'Pass `--json` after `--` when requesting JSON from the underlying agent CLI.',
        )
        process.exit(1)
      }

      const config = loadConfig()
      let resolved: ResolvedProfile
      try {
        resolved = resolveProfile(config, {
          cliProfile: positionalProfile,
          envProfile: process.env.CAGENT_PROFILE,
          cliModel: options.model,
          envModel: process.env.CAGENT_MODEL,
          cliEffort: options.effort,
          envEffort: process.env.CAGENT_EFFORT,
        })
      } catch (error) {
        if (error instanceof ProfileError) {
          if (json) {
            outputJsonFailure('run.plan', 'PROFILE_ERROR', error.message)
          } else {
            console.error(error.message)
            program.outputHelp()
          }
          process.exit(1)
        }
        throw error
      }

      const agentId = resolved.agent
      const agent = getAgent(config, agentId)
      const adapter = getAgentAdapter(agentId)
      const extraArgs = program.args.slice(positionalProfile !== undefined ? 1 : 0)
      const ctx = {
        bin: agent.bin,
        modelId: resolved.model,
        cwd: process.cwd(),
        extraArgs,
        config: agent,
        effort: resolved.effort,
      }

      if (!options.dryRun) {
        assertTty('[profile]', ['cagent run <profile> -- "<prompt>"', 'cagent mux start <profile>'])
      }

      const spec = adapter.buildStartCommand?.(ctx) ?? adapter.buildRunCommand(ctx)

      if (options.dryRun) {
        if (json) {
          outputJsonSuccess('run.plan', {
            interactive: true,
            config_path: resolveConfigPath(),
            profile: resolved.name,
            profile_source: resolved.source,
            agent: agentId,
            model: resolved.model,
            model_source: resolved.modelSource,
            effort: resolved.effort,
            effort_source: resolved.effortSource,
            command: {
              executable: spec.command,
              args: spec.args,
              env: spec.env ?? {},
            },
          })
          return
        }
        for (const line of formatResolvedProfileLines(resolved)) {
          console.log(line)
        }
        console.log(formatCommandSpec(spec))
        return
      }

      const result = await runCommandSpec(spec, {
        stdio: 'inherit',
      })

      if (result.exitCode !== 0 && result.exitCode !== null) {
        process.exit(result.exitCode)
      }
    })

  return program
}

export async function main(argv: string[]): Promise<void> {
  const program = createMainCommand()
  await program.parseAsync(argv)
}
