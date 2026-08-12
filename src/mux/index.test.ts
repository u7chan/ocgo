import { describe, expect, it, spyOn } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatCommandSpecForShell } from '../command.js'
import { loadConfig } from '../config.js'
import { createMainCommand } from '../main.js'
import { executeHerdrRun } from './herdr.js'
import {
  createMuxCommand,
  MuxAdapterError,
  MuxExecutionError,
  printMuxExecutionFailure,
  resolveMuxCommand,
  validateMuxAdapter,
} from './index.js'
import type { MuxExecutionResult } from './types.js'

function writeTempConfig(content: string): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cagent-mux-test-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, content)
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function clearEffortEnv() {
  delete process.env.CAGENT_MODEL
  delete process.env.CAGENT_LEVEL
  delete process.env.CAGENT_PROFILE
  delete process.env.CAGENT_EFFORT
}

type FakeHerdrMode =
  | 'success'
  | 'current-fail'
  | 'split-fail'
  | 'dispatch-nonzero'
  | 'dispatch-process-error'

function writeFakeHerdr(): {
  dir: string
  path: string
  log: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'cagent-fake-herdr-'))
  const path = join(dir, 'herdr')
  const log = join(dir, 'invocations.log')
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HERDR_LOG"
if [ "$1" = "pane" ] && [ "$2" = "current" ]; then
  if [ "$FAKE_HERDR_MODE" = "current-fail" ]; then
    printf 'current failed\\n' >&2
    exit 11
  fi
  printf '%s\\n' '{"result":{"pane":{"pane_id":"current-123"}}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  if [ "$FAKE_HERDR_MODE" = "split-fail" ]; then
    printf 'split failed\\n' >&2
    exit 12
  fi
  if [ "$FAKE_HERDR_MODE" = "dispatch-process-error" ]; then
    chmod 000 "$FAKE_HERDR_PATH"
  fi
  printf '%s\\n' '{"result":{"pane":{"pane_id":"created-456"}}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "run" ]; then
  if [ "$FAKE_HERDR_MODE" = "dispatch-nonzero" ]; then
    printf 'dispatch failed\\n' >&2
    exit 17
  fi
  exit 0
fi
exit 0
`,
    'utf-8',
  )
  chmodSync(path, 0o755)
  return {
    dir,
    path,
    log,
    cleanup: () => {
      chmodSync(path, 0o755)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function withFakeHerdr<T>(
  mode: FakeHerdrMode,
  run: (fake: ReturnType<typeof writeFakeHerdr>) => T,
): T {
  const fake = writeFakeHerdr()
  const originalPath = process.env.PATH
  const originalMode = process.env.FAKE_HERDR_MODE
  const originalLog = process.env.FAKE_HERDR_LOG
  const originalHerdrPath = process.env.FAKE_HERDR_PATH
  process.env.PATH = `${fake.dir}:/usr/bin:/bin`
  process.env.FAKE_HERDR_MODE = mode
  process.env.FAKE_HERDR_LOG = fake.log
  process.env.FAKE_HERDR_PATH = fake.path

  const restore = () => {
    fake.cleanup()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalMode === undefined) delete process.env.FAKE_HERDR_MODE
    else process.env.FAKE_HERDR_MODE = originalMode
    if (originalLog === undefined) delete process.env.FAKE_HERDR_LOG
    else process.env.FAKE_HERDR_LOG = originalLog
    if (originalHerdrPath === undefined) delete process.env.FAKE_HERDR_PATH
    else process.env.FAKE_HERDR_PATH = originalHerdrPath
  }

  try {
    const result = run(fake)
    if (result instanceof Promise) {
      return result.finally(restore) as T
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

function herdrContext(dryRun = false) {
  return {
    command: { command: 'codex', args: ['exec', 'hello'] },
    cwd: process.cwd(),
    extraArgs: [],
    dryRun,
  }
}

function invocationLog(fake: ReturnType<typeof writeFakeHerdr>): string[] {
  return readFileSync(fake.log, 'utf-8').trim().split('\n').filter(Boolean)
}

const codexConfig = `default_agent: codex
default_profile: mid
profiles:
  mid: { agent: codex, model: gpt-5 }
agents:
  codex:
    bin: codex
    provider: codex
    model_id_prefix: false
multiplexer:
  default: herdr
  herdr: { enabled: true }
`

const opencodeConfig = `default_agent: opencode-go
default_profile: mid
profiles:
  mid: { agent: opencode-go, model: gpt-5 }
agents:
  opencode-go:
    bin: opencode
    provider: opencode-go
multiplexer:
  default: herdr
  herdr: { enabled: true }
`

describe('validateMuxAdapter', () => {
  it('succeeds for enabled adapter', () => {
    const { file, cleanup } = writeTempConfig(codexConfig)
    try {
      const config = loadConfig(file)
      const adapter = validateMuxAdapter(config, 'herdr')
      expect(adapter.enabled).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('throws MuxAdapterError for disabled adapter', () => {
    const { file, cleanup } = writeTempConfig(
      `default_agent: opencode-go\nprofiles:\n  low: { agent: opencode-go, model: test-model }\nagents:\n  opencode-go:\n    bin: opencode\n    provider: opencode-go\nmultiplexer:\n  default: herdr\n  herdr: { enabled: false }\n`,
    )
    try {
      const config = loadConfig(file)
      expect(() => validateMuxAdapter(config, 'herdr')).toThrow(MuxAdapterError)
    } finally {
      cleanup()
    }
  })

  it('throws MuxAdapterError for unknown adapter', () => {
    const { file, cleanup } = writeTempConfig(
      `default_agent: opencode-go\nprofiles:\n  low: { agent: opencode-go, model: test-model }\nagents:\n  opencode-go:\n    bin: opencode\n    provider: opencode-go\nmultiplexer:\n  default: unknown\n  unknown: { enabled: true }\n`,
    )
    try {
      const config = loadConfig(file)
      expect(() => validateMuxAdapter(config, 'nonexistent')).toThrow(MuxAdapterError)
    } finally {
      cleanup()
    }
  })
})

describe('resolveMuxCommand', () => {
  it('mux run passes effort as -c model_reasoning_effort for Codex', () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    try {
      const config = loadConfig(file)
      const { commandSpec } = resolveMuxCommand(config, 'run', 'mid', { effort: 'high' }, ['hello'])
      expect(commandSpec.command).toBe('codex')
      expect(commandSpec.args).toContain('-c')
      expect(commandSpec.args).toContain('model_reasoning_effort="high"')
    } finally {
      cleanup()
    }
  })

  it('mux run passes effort as --variant for OpenCode', () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(opencodeConfig)
    try {
      const config = loadConfig(file)
      const { commandSpec } = resolveMuxCommand(config, 'run', 'mid', { effort: 'high' }, ['hello'])
      expect(commandSpec.command).toBe('opencode')
      expect(commandSpec.args).toContain('--variant')
      expect(commandSpec.args).toContain('high')
    } finally {
      cleanup()
    }
  })

  it('mux start + opencode-go + effort throws MuxAdapterError (fail-fast before herdr pane operations)', () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(opencodeConfig)
    try {
      const config = loadConfig(file)
      expect(() => resolveMuxCommand(config, 'start', 'mid', { effort: 'high' }, [])).toThrow(
        MuxAdapterError,
      )
    } finally {
      cleanup()
    }
  })

  it('mux run effort with special chars produces shell-safe serialization', () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    try {
      const config = loadConfig(file)
      const { commandSpec } = resolveMuxCommand(
        config,
        'run',
        'mid',
        { effort: '$HOME $(id) `backtick` ; rm -rf / "quote" it\'s \\back' },
        ['hello'],
      )
      const shellCmd = formatCommandSpecForShell(commandSpec)
      // All args are single-quote-wrapped — shell cannot expand anything inside single quotes
      expect(shellCmd.startsWith("'codex'")).toBe(true)
      expect(shellCmd).toContain('$HOME')
      expect(shellCmd).toContain('$(id)')
      // Single quotes within args are properly escaped with '\''
      expect(shellCmd).toContain("'\\''")
    } finally {
      cleanup()
    }
  })

  it('mux run effort without special chars produces shell-safe args', () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    try {
      const config = loadConfig(file)
      const { commandSpec } = resolveMuxCommand(config, 'run', 'mid', { effort: 'high' }, ['hello'])
      const shellCmd = formatCommandSpecForShell(commandSpec)
      expect(shellCmd).toBe(
        "'codex' 'exec' '--model' 'gpt-5' '-c' 'model_reasoning_effort=\"high\"' 'hello'",
      )
    } finally {
      cleanup()
    }
  })
})

describe('mux JSON output', () => {
  it('outputs a herdr dry-run plan as JSON', async () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const program = createMainCommand()
      program.addCommand(createMuxCommand())
      await program.parseAsync([
        'node',
        'cagent',
        'mux',
        'run',
        'mid',
        '--dry-run',
        '--json',
        '--model',
        'codex/unknown-model',
        '--',
        'hello',
      ])
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).not.toHaveBeenCalled()
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.schema_version).toBe(1)
      expect(output.ok).toBe(true)
      expect(output.operation).toBe('mux.run.plan')
      expect(output.data.adapter).toBe('herdr')
      expect(output.data.mode).toBe('run')
      expect(output.data.profile).toBe('mid')
      expect(output.data.profile_source).toBe('cli')
      expect(output.data.agent).toBe('codex')
      expect(output.data.model).toBe('codex/unknown-model')
      expect(output.data.model_source).toBe('cli')
      expect(output.data.pane_operations).toHaveLength(3)
      expect(output.warnings).toHaveLength(0)
      expect(String(logSpy.mock.calls[0]?.[0])).not.toContain('# Herdr dry-run')
      expect(String(logSpy.mock.calls[0]?.[0])).not.toContain('level')
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })
})

describe('mux unknown profile guidance', () => {
  for (const mode of ['start', 'run'] as const) {
    it(`guides human users to cagent list for mux ${mode}`, async () => {
      clearEffortEnv()
      const { file, cleanup } = writeTempConfig(codexConfig)
      const originalConfig = process.env.CAGENT_CONFIG
      process.env.CAGENT_CONFIG = file
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit')
      })
      try {
        const program = createMainCommand()
        program.addCommand(createMuxCommand())
        await expect(
          program.parseAsync(['node', 'cagent', 'mux', mode, 'missing-profile']),
        ).rejects.toThrow('process.exit')

        expect(errorSpy).toHaveBeenNthCalledWith(1, 'unknown profile: missing-profile')
        expect(errorSpy).toHaveBeenNthCalledWith(
          2,
          'Run `cagent list` to view configured profiles.',
        )
        expect(logSpy).not.toHaveBeenCalled()
        expect(exitSpy).toHaveBeenCalledWith(1)
      } finally {
        exitSpy.mockRestore()
        logSpy.mockRestore()
        errorSpy.mockRestore()
        if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
        else process.env.CAGENT_CONFIG = originalConfig
        cleanup()
      }
    })

    it(`keeps mux ${mode} JSON failures structured for an unknown profile`, async () => {
      clearEffortEnv()
      const { file, cleanup } = writeTempConfig(codexConfig)
      const originalConfig = process.env.CAGENT_CONFIG
      process.env.CAGENT_CONFIG = file
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit')
      })
      try {
        const program = createMainCommand()
        program.addCommand(createMuxCommand())
        await expect(
          program.parseAsync([
            'node',
            'cagent',
            'mux',
            mode,
            'missing-profile',
            '--dry-run',
            '--json',
          ]),
        ).rejects.toThrow('process.exit')

        expect(logSpy).toHaveBeenCalledTimes(1)
        const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
        expect(output.schema_version).toBe(1)
        expect(output.ok).toBe(false)
        expect(output.operation).toBe(`mux.${mode}.plan`)
        expect(output.error.code).toBe('PROFILE_ERROR')
        expect(output.error.message).toBe('unknown profile: missing-profile')
        expect(output.error.suggestion).toBe('Run `cagent list` to view configured profiles.')
        expect(errorSpy).not.toHaveBeenCalled()
        expect(exitSpy).toHaveBeenCalledWith(1)
      } finally {
        exitSpy.mockRestore()
        errorSpy.mockRestore()
        logSpy.mockRestore()
        if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
        else process.env.CAGENT_CONFIG = originalConfig
        cleanup()
      }
    })
  }
})

describe('mux dry-run resolution output', () => {
  it('prints resolved profile lines with overrides before the herdr plan', async () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = createMainCommand()
      program.addCommand(createMuxCommand())
      await program.parseAsync([
        'node',
        'cagent',
        'mux',
        'run',
        'mid',
        '--dry-run',
        '--model',
        'codex/other',
        '--effort',
        'high',
        '--',
        'hello',
      ])
      const lines = logSpy.mock.calls.map((call) => String(call[0]))
      expect(lines).toContain('# Resolved profile: mid (source: cli)')
      expect(lines).toContain('# Resolved agent: codex')
      expect(lines).toContain('# Resolved model: codex/other')
      expect(lines).toContain('# Resolved effort: high')
      expect(lines).toContain('# Overrides: model=cli, effort=cli')
      expect(lines).toContain('# Herdr dry-run command sequence:')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })

  it('reports env-sourced effort in the JSON plan', async () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    process.env.CAGENT_EFFORT = 'high'
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = createMainCommand()
      program.addCommand(createMuxCommand())
      await program.parseAsync([
        'node',
        'cagent',
        'mux',
        'run',
        'mid',
        '--dry-run',
        '--json',
        '--',
        'hello',
      ])
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.data.profile).toBe('mid')
      expect(output.data.profile_source).toBe('cli')
      expect(output.data.model_source).toBe('profile')
      expect(output.data.effort).toBe('high')
      expect(output.data.effort_source).toBe('env')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      delete process.env.CAGENT_EFFORT
      cleanup()
    }
  })
})

describe('Herdr MuxExecutionResult', () => {
  it('records preflight failure and skips all Herdr operations', () => {
    const originalPath = process.env.PATH
    process.env.PATH = '/usr/bin:/bin'
    try {
      const result = executeHerdrRun(herdrContext()) as MuxExecutionResult

      expect(result.failed_step).toBe('preflight')
      expect(result.steps).toEqual([
        { step: 'preflight', status: 'fail', exit_code: 127, error: 'herdr CLI not found in PATH' },
        { step: 'current', status: 'skip', error: 'not attempted because preflight failed' },
        { step: 'split', status: 'skip', error: 'not attempted because preflight failed' },
        { step: 'dispatch', status: 'skip', error: 'not attempted because preflight failed' },
      ])
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it('records a successful current, split, and dispatch flow', () => {
    withFakeHerdr('success', (fake) => {
      const result = executeHerdrRun(herdrContext()) as MuxExecutionResult

      expect(result.failed_step).toBeUndefined()
      expect(result.current_pane_id).toBe('current-123')
      expect(result.created_pane_id).toBe('created-456')
      expect(result.command_dispatched).toBe(true)
      expect(result.task_completed).toBe(false)
      expect(result.steps).toEqual([
        { step: 'preflight', status: 'pass', exit_code: 0 },
        { step: 'current', status: 'pass', pane_id: 'current-123', exit_code: 0 },
        { step: 'split', status: 'pass', pane_id: 'created-456', exit_code: 0 },
        { step: 'dispatch', status: 'pass', pane_id: 'created-456', exit_code: 0 },
      ])
      expect(invocationLog(fake)).toEqual([
        'pane current --current',
        `pane split --pane current-123 --direction right --cwd ${process.cwd()}`,
        "pane run created-456 'codex' 'exec' 'hello'",
      ])
    })
  })

  it('records current failure and does not attempt split or dispatch', () => {
    withFakeHerdr('current-fail', (fake) => {
      const result = executeHerdrRun(herdrContext()) as MuxExecutionResult

      expect(result.failed_step).toBe('current')
      expect(result.current_pane_id).toBeUndefined()
      expect(result.created_pane_id).toBeUndefined()
      expect(result.command_dispatched).toBe(false)
      expect(result.steps[1]).toMatchObject({
        step: 'current',
        status: 'fail',
        exit_code: 11,
      })
      expect(result.steps[1]?.error).toContain('current failed')
      expect(result.steps.slice(2)).toEqual([
        {
          step: 'split',
          status: 'skip',
          error: 'not attempted because current pane lookup failed',
        },
        {
          step: 'dispatch',
          status: 'skip',
          error: 'not attempted because current pane lookup failed',
        },
      ])
      expect(invocationLog(fake)).toEqual(['pane current --current'])
    })
  })

  it('records split failure and does not attempt dispatch', () => {
    withFakeHerdr('split-fail', (fake) => {
      const result = executeHerdrRun(herdrContext()) as MuxExecutionResult

      expect(result.failed_step).toBe('split')
      expect(result.current_pane_id).toBe('current-123')
      expect(result.created_pane_id).toBeUndefined()
      expect(result.steps[2]).toMatchObject({
        step: 'split',
        status: 'fail',
        exit_code: 12,
      })
      expect(result.steps[2]?.error).toContain('split failed')
      expect(result.steps[3]).toEqual({
        step: 'dispatch',
        status: 'skip',
        error: 'not attempted because pane split failed',
      })
      expect(invocationLog(fake)).toEqual([
        'pane current --current',
        `pane split --pane current-123 --direction right --cwd ${process.cwd()}`,
      ])
    })
  })

  it('keeps the created pane when dispatch exits non-zero', () => {
    withFakeHerdr('dispatch-nonzero', (fake) => {
      const result = executeHerdrRun(herdrContext()) as MuxExecutionResult

      expect(result.failed_step).toBe('dispatch')
      expect(result.created_pane_id).toBe('created-456')
      expect(result.command_dispatched).toBe(false)
      expect(result.steps[3]).toMatchObject({
        step: 'dispatch',
        status: 'fail',
        pane_id: 'created-456',
        exit_code: 17,
      })
      expect(result.steps[3]?.error).toContain('dispatch failed')
      expect(invocationLog(fake)).not.toContain('pane close created-456')
    })
  })

  it('keeps the created pane when dispatch has a process error', () => {
    withFakeHerdr('dispatch-process-error', (fake) => {
      const result = executeHerdrRun(herdrContext()) as MuxExecutionResult

      expect(result.failed_step).toBe('dispatch')
      expect(result.created_pane_id).toBe('created-456')
      expect(result.steps[3]).toMatchObject({
        step: 'dispatch',
        status: 'fail',
        pane_id: 'created-456',
        exit_code: null,
      })
      expect(result.steps[3]?.error).toContain('process error')
      expect(invocationLog(fake)).not.toContain('pane close created-456')
    })
  })

  it('returns a side-effect-free plan with explicit pane placeholders for dry-run', () => {
    const result = executeHerdrRun(herdrContext(true))

    expect(result.current_pane_id).toBeUndefined()
    expect(result.created_pane_id).toBeUndefined()
    expect(result.command_dispatched).toBe(false)
    expect(result.steps.every((step) => step.status === 'skip')).toBe(true)
    if (!('plan' in result)) {
      throw new Error('expected dry-run plan')
    }
    expect(result.plan.side_effects).toEqual(['pane.current', 'pane.split', 'pane.run'])
    expect(result.plan.command).toEqual({ executable: 'codex', args: ['exec', 'hello'], env: {} })
    expect(result.plan.placeholders).toEqual({
      current_pane_id: { value: '<current-pane>', placeholder: true },
      created_pane_id: { value: '<created-pane>', placeholder: true },
    })
    expect(result.plan.pane_operations[2]?.command).toEqual(result.plan.command)
  })

  it('includes pane recovery guidance in human-readable partial failure output', () => {
    const result: MuxExecutionResult = {
      adapter: 'herdr',
      mode: 'run',
      cwd: process.cwd(),
      current_pane_id: 'current-123',
      created_pane_id: 'created-456',
      command_dispatched: false,
      task_completed: false,
      failed_step: 'dispatch',
      steps: [
        { step: 'preflight', status: 'pass' },
        { step: 'current', status: 'pass', pane_id: 'current-123' },
        { step: 'split', status: 'pass', pane_id: 'created-456' },
        {
          step: 'dispatch',
          status: 'fail',
          pane_id: 'created-456',
          exit_code: 17,
          error: 'herdr pane run failed (exit 17): dispatch failed',
        },
      ],
    }
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      printMuxExecutionFailure(result)
      const output = errorSpy.mock.calls.map(([line]) => String(line)).join('\n')
      expect(output).toContain('created-456')
      expect(output).toContain('dispatch')
      expect(output).toContain('herdr pane get created-456')
      expect(output).toContain('herdr pane close created-456')
      expect(output).toContain('Task completion: not observed by cagent')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('mux execution JSON output', () => {
  it('serializes the successful MuxExecutionResult for a real Herdr dispatch', async () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      withFakeHerdr('success', async () => {
        const program = createMainCommand()
        program.addCommand(createMuxCommand())
        await program.parseAsync(['node', 'cagent', 'mux', 'run', 'mid', '--json'])
      })
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.ok).toBe(true)
      expect(output.operation).toBe('mux.run')
      expect(output.data).toMatchObject({
        adapter: 'herdr',
        mode: 'run',
        current_pane_id: 'current-123',
        created_pane_id: 'created-456',
        command_dispatched: true,
        task_completed: false,
      })
      expect(output.data.steps).toHaveLength(4)
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })

  it('serializes a partial failure result in JSON and does not close the pane', async () => {
    clearEffortEnv()
    const { file, cleanup } = writeTempConfig(codexConfig)
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(
        withFakeHerdr('dispatch-nonzero', async () => {
          const program = createMainCommand()
          program.addCommand(createMuxCommand())
          await program.parseAsync(['node', 'cagent', 'mux', 'run', 'mid', '--json'])
        }),
      ).rejects.toBeInstanceOf(MuxExecutionError)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.ok).toBe(false)
      expect(output.error.code).toBe('MUX_EXECUTION_FAILED')
      expect(output.error.details.created_pane_id).toBe('created-456')
      expect(output.error.details.failed_step).toBe('dispatch')
      expect(output.error.details.steps[3].exit_code).toBe(17)
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })
})
