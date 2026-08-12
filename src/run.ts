import { Command } from 'commander'
import { getAgentAdapter } from './agents/registry.js'
import { formatCommandSpec, runCommandSpec } from './command.js'
import { getAgent, loadConfig, type ResolvedProfile, resolveConfigPath } from './config.js'
import { isJsonMode, outputJsonFailure, outputJsonSuccess } from './json-output.js'
import { formatResolvedProfileLines, ProfileError, resolveProfile } from './profile.js'

export interface RunCommandOptions {
  model?: string
  effort?: string
  dryRun?: boolean
  json?: boolean
}

/**
 * Parse `cagent run` argv so that:
 * - optional profile is taken only from tokens before `--`
 * - tokens after `--` are always prompt/extra args (never profile)
 */
export function parseRunArgv(argv: string[]): {
  positionalProfile?: string
  extraArgs: string[]
} {
  let start = -1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === 'run') {
      start = i + 1
    }
  }
  if (start === -1) {
    return { extraArgs: [] }
  }

  const rest = argv.slice(start)
  const dd = rest.indexOf('--')
  const beforeDd = dd === -1 ? rest : rest.slice(0, dd)
  const afterDd = dd === -1 ? [] : rest.slice(dd + 1)

  const positionals: string[] = []
  for (let i = 0; i < beforeDd.length; i++) {
    const arg = beforeDd[i]
    if (arg.startsWith('-')) {
      if (
        arg === '--dry-run' ||
        arg === '-d' ||
        arg === '--json' ||
        arg === '--help' ||
        arg === '-h' ||
        arg === '--version' ||
        arg === '-V'
      ) {
        continue
      }
      if (arg.includes('=')) {
        continue
      }
      i += 1
      continue
    }
    positionals.push(arg)
  }

  return {
    positionalProfile: positionals[0],
    extraArgs: [...positionals.slice(1), ...afterDd],
  }
}

function parseRunCommandArgs(args: string[]): {
  positionalProfile?: string
  extraArgs: string[]
} {
  if (args[0] && !args[0].startsWith('-')) {
    return {
      positionalProfile: args[0],
      extraArgs: args.slice(1),
    }
  }
  return { extraArgs: args }
}

export function createRunCommand(): Command {
  const command = new Command('run')

  command
    .description('Run a coding agent non-interactively with a prompt')
    .allowUnknownOption()
    .action(async () => {
      const globals = command.optsWithGlobals() as RunCommandOptions
      const { positionalProfile, extraArgs } = process.argv.includes('run')
        ? parseRunArgv(process.argv)
        : parseRunCommandArgs(command.args)

      const dryRun = globals.dryRun === true
      const json = isJsonMode(globals)

      if (json && !dryRun) {
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
          cliModel: globals.model,
          envModel: process.env.CAGENT_MODEL,
          cliEffort: globals.effort,
          envEffort: process.env.CAGENT_EFFORT,
        })
      } catch (error) {
        if (error instanceof ProfileError) {
          console.error(error.message)
          const rootCommand = command.parent ?? command
          rootCommand.outputHelp()
          process.exit(1)
        }
        throw error
      }
      const effectiveAgentId = resolved.agent
      const agent = getAgent(config, effectiveAgentId)
      const adapter = getAgentAdapter(effectiveAgentId)

      const spec = adapter.buildRunCommand({
        bin: agent.bin,
        modelId: resolved.model,
        cwd: process.cwd(),
        extraArgs,
        config: agent,
        effort: resolved.effort,
      })

      if (dryRun) {
        if (json) {
          outputJsonSuccess('run.plan', {
            interactive: false,
            config_path: resolveConfigPath(),
            profile: resolved.name,
            profile_source: resolved.source,
            agent: effectiveAgentId,
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

  return command
}
