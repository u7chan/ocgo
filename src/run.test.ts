import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createListCommand } from './list.js'
import { createMainCommand } from './main.js'
import { createRunCommand, parseRunArgv } from './run.js'

describe('parseRunArgv', () => {
  it('takes profile before -- and prompt after --', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', 'mid', '--', 'hello'])).toEqual({
      positionalProfile: 'mid',
      extraArgs: ['hello'],
    })
  })

  it('does not treat post-- prompt as level when only --model is set', () => {
    expect(
      parseRunArgv(['node', 'cagent', 'run', '--model', 'qwen3.7-plus', '--', 'hello']),
    ).toEqual({
      positionalProfile: undefined,
      extraArgs: ['hello'],
    })
  })

  it('ignores the removed level option before --', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', '-l', 'high', '--', 'hello'])).toEqual({
      positionalProfile: undefined,
      extraArgs: ['hello'],
    })
  })

  it('keeps extra positionals before -- as extraArgs', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', 'mid', 'extra', '--', 'hello'])).toEqual({
      positionalProfile: 'mid',
      extraArgs: ['extra', 'hello'],
    })
  })

  it('works without -- separator', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', 'mid', 'hello'])).toEqual({
      positionalProfile: 'mid',
      extraArgs: ['hello'],
    })
  })

  it('handles --effort=x correctly', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', '--effort=high', '--', 'prompt'])).toEqual({
      positionalProfile: undefined,
      extraArgs: ['prompt'],
    })
  })

  it('handles --effort x correctly (no = sign)', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', '--effort', 'high', '--', 'prompt'])).toEqual({
      positionalProfile: undefined,
      extraArgs: ['prompt'],
    })
  })

  it('handles -e flag for effort', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', '-e', 'high', '--', 'prompt'])).toEqual({
      positionalProfile: undefined,
      extraArgs: ['prompt'],
    })
  })

  it('treats --json as a flag-like option', () => {
    expect(parseRunArgv(['node', 'cagent', 'run', '--json', 'low', '--dry-run'])).toEqual({
      positionalProfile: 'low',
      extraArgs: [],
    })
  })
})

describe('run JSON output', () => {
  it('prints the profile error and root CLI help for an unknown profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cagent-run-profile-error-test-'))
    const file = join(dir, 'config.yaml')
    writeFileSync(
      file,
      `default_agent: codex
default_profile: mid
profiles:
  mid: { agent: codex, model: test-model-v1 }
agents:
  codex:
    bin: node
    provider: codex
    model_id_prefix: false
multiplexer:
  default: herdr
  herdr: { enabled: true }
`,
    )
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    let help = ''
    try {
      const program = createMainCommand()
      program.addCommand(createRunCommand())
      program.addCommand(createListCommand())
      program.configureOutput({ writeOut: (message) => (help += message) })
      await expect(program.parseAsync(['node', 'cagent', 'run', 'missing'])).rejects.toThrow(
        'process.exit',
      )

      expect(errorSpy).toHaveBeenCalledWith('unknown profile: missing')
      expect(help).toContain('Usage: cagent [options] [command] [profile]')
      expect(help).toContain('Options:')
      expect(help).toContain('Commands:')
      expect(help).toContain('list')
      expect(help).not.toContain('Available profiles:')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('outputs a non-interactive dry-run plan as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cagent-run-json-test-'))
    const file = join(dir, 'config.yaml')
    writeFileSync(
      file,
      `default_agent: codex
default_profile: mid
profiles:
  mid: { agent: codex, model: gpt-5 }
agents:
  codex:
    bin: node
    provider: codex
    model_id_prefix: false
multiplexer:
  default: herdr
  herdr: { enabled: true }
`,
    )
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const command = createMainCommand()
      command.addCommand(createRunCommand())
      await command.parseAsync([
        'node',
        'cagent',
        'run',
        '--json',
        'mid',
        '--dry-run',
        '--',
        'hello',
      ])
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.schema_version).toBe(1)
      expect(output.ok).toBe(true)
      expect(output.operation).toBe('run.plan')
      expect(output.data.interactive).toBe(false)
      expect(output.data.config_path).toBe(file)
      expect(output.data.profile).toBe('mid')
      expect(output.data.profile_source).toBe('cli')
      expect(output.data.model_source).toBe('profile')
      expect(output.data.command.args).toContain('hello')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('places model resolution warnings in the JSON envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cagent-run-warning-json-test-'))
    const file = join(dir, 'config.yaml')
    writeFileSync(
      file,
      `default_agent: codex
default_profile: mid
profiles:
  mid: { agent: codex, model: gpt-5 }
agents:
  codex:
    bin: node
    provider: codex
    model_id_prefix: false
multiplexer:
  default: herdr
  herdr: { enabled: true }
`,
    )
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const command = createMainCommand()
      command.addCommand(createRunCommand())
      await command.parseAsync([
        'node',
        'cagent',
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
      expect(output.warnings).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects run JSON without dry-run', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    try {
      const command = createMainCommand()
      command.addCommand(createRunCommand())
      await expect(command.parseAsync(['node', 'cagent', 'run', 'mid', '--json'])).rejects.toThrow(
        'process.exit',
      )
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.schema_version).toBe(1)
      expect(output.ok).toBe(false)
      expect(output.operation).toBe('run.plan')
      expect(output.error.code).toBe('USAGE_ERROR')
      expect(errorSpy).not.toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      logSpy.mockRestore()
    }
  })
})

describe('run config validation', () => {
  it('throws ConfigError before resolving the agent when provider is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cagent-run-test-'))
    const file = join(dir, 'config.yaml')
    writeFileSync(
      file,
      `default_agent: opencode-go
default_profile: mid
profiles:
  mid: { agent: opencode-go, model: deepseek-v4-pro }
agents:
  opencode-go:
    bin: opencode
    provider: ""
multiplexer:
  default: herdr
  herdr: { enabled: true }
`,
    )
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const command = createMainCommand()
    command.addCommand(createRunCommand())

    try {
      await expect(command.parseAsync(['node', 'cagent', '--dry-run', 'run'])).rejects.toThrow(
        'agent "opencode-go".provider must not be empty',
      )
    } finally {
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
