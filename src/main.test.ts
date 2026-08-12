import { describe, expect, it, spyOn } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import { createListCommand } from './list.js'
import { createMainCommand } from './main.js'
import { createRunCommand } from './run.js'
import { VERSION } from './version.js'

function mockTty(stdinIsTTY: boolean, stdoutIsTTY: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: stdinIsTTY,
  })
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: stdoutIsTTY,
  })

  return () => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY')
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor)
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY')
    }
  }
}

function writeTestConfig(path: string, bin: string): void {
  writeFileSync(
    path,
    `default_agent: codex
default_profile: mid
profiles:
  mid: { agent: codex, model: gpt-5 }
agents:
  codex:
    bin: ${bin}
    provider: codex
    model_id_prefix: false
multiplexer:
  default: herdr
  herdr:
    enabled: true
`,
    'utf-8',
  )
}

describe('createMainCommand', () => {
  it('prints the profile error and root CLI help for an unknown profile', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cagent-main-profile-error-test-'))
    const config = join(tmpDir, 'config.yaml')
    writeTestConfig(config, 'node')

    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = config
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
      await expect(program.parseAsync(['node', 'cagent', 'missing'])).rejects.toThrow(
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
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects the removed profiles command as unknown', async () => {
    const program = createMainCommand()
    program.exitOverride()
    await expect(program.parseAsync(['node', 'cagent', 'profiles'])).rejects.toThrow(
      "unknown command 'profiles'",
    )
  })

  it('fails a bare cagent without a TTY before launching a child process', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cagent-main-test-'))
    const config = join(tmpDir, 'config.yaml')
    const marker = join(tmpDir, 'spawned')
    const agent = join(tmpDir, 'agent.sh')
    writeFileSync(agent, `#!/bin/sh\nprintf spawned > '${marker}'\n`, 'utf-8')
    chmodSync(agent, 0o755)
    writeTestConfig(config, agent)

    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = config
    const restoreTty = mockTty(false, true)
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    try {
      const program = createMainCommand()
      await expect(program.parseAsync(['node', 'cagent', 'mid'])).rejects.toThrow('process.exit')
      expect(existsSync(marker)).toBe(false)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('requires a TTY')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      restoreTty()
      if (originalConfig === undefined) {
        delete process.env.CAGENT_CONFIG
      } else {
        process.env.CAGENT_CONFIG = originalConfig
      }
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('runs a bare cagent dry-run with a TTY', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cagent-main-test-'))
    const config = join(tmpDir, 'config.yaml')
    writeTestConfig(config, 'node')

    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = config
    const restoreTty = mockTty(true, true)
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = createMainCommand()
      await program.parseAsync(['node', 'cagent', 'mid', '--dry-run'])
      expect(logSpy).toHaveBeenCalledWith('# Resolved profile: mid (source: cli)')
      expect(logSpy).toHaveBeenCalledWith('# Resolved agent: codex')
      expect(logSpy).toHaveBeenCalledWith('# Resolved model: gpt-5')
    } finally {
      logSpy.mockRestore()
      restoreTty()
      if (originalConfig === undefined) {
        delete process.env.CAGENT_CONFIG
      } else {
        process.env.CAGENT_CONFIG = originalConfig
      }
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('outputs a bare cagent dry-run plan as JSON', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cagent-main-json-test-'))
    const config = join(tmpDir, 'config.yaml')
    writeTestConfig(config, 'node')

    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = config
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = createMainCommand()
      await program.parseAsync(['node', 'cagent', 'mid', '--dry-run', '--json'])
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.schema_version).toBe(1)
      expect(output.ok).toBe(true)
      expect(output.operation).toBe('run.plan')
      expect(output.data.interactive).toBe(true)
      expect(output.data.agent).toBe('codex')
      expect(output.data.profile).toBe('mid')
      expect(output.data.profile_source).toBe('cli')
      expect(output.data.model_source).toBe('profile')
      expect(output.data.config_path).toBe(config)
      expect(output.data.command.executable).toBe('node')
      expect(String(logSpy.mock.calls[0]?.[0])).not.toContain('# Resolved profile')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('rejects bare cagent JSON without dry-run', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    try {
      const program = createMainCommand()
      await expect(program.parseAsync(['node', 'cagent', 'mid', '--json'])).rejects.toThrow(
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

  it('places model resolution warnings in the JSON envelope', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cagent-main-warning-json-test-'))
    const config = join(tmpDir, 'config.yaml')
    writeTestConfig(config, 'node')

    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = config
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const program = createMainCommand()
      await program.parseAsync([
        'node',
        'cagent',
        '--dry-run',
        '--json',
        '--model',
        'codex/unknown-model',
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
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('passes --json after -- to the child CLI', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cagent-main-boundary-test-'))
    const config = join(tmpDir, 'config.yaml')
    const marker = join(tmpDir, 'arguments')
    const agent = join(tmpDir, 'agent.sh')
    writeFileSync(agent, `#!/bin/sh\nprintf "%s" "$*" > ${marker}`, 'utf-8')
    chmodSync(agent, 0o755)
    writeTestConfig(config, agent)

    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = config
    try {
      const program = createMainCommand()
      program.addCommand(createRunCommand())
      await program.parseAsync(['node', 'cagent', 'run', 'mid', '--', '--json', 'hello'])
      expect(readFileSync(marker, 'utf-8')).toContain('--json')
    } finally {
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('consumes --json before -- for the cagent control plane', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cagent-main-boundary-json-test-'))
    const config = join(tmpDir, 'config.yaml')
    writeTestConfig(config, 'node')

    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = config
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = createMainCommand()
      program.addCommand(createRunCommand())
      await program.parseAsync([
        'node',
        'cagent',
        'run',
        '--dry-run',
        'mid',
        '--json',
        '--',
        'hello',
      ])
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.ok).toBe(true)
      expect(output.data.command.args).not.toContain('--json')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('version option', () => {
    it('registers -V and --version via Commander built-in version', () => {
      const program = createMainCommand()
      const versionOption = program.options.find((option) => option.long === '--version')
      expect(versionOption).toBeDefined()
      expect(versionOption?.short).toBe('-V')
    })

    it('registers -v as a hidden version alias', () => {
      const program = createMainCommand()
      const vOption = program.options.find((option) => option.short === '-v')
      expect(vOption).toBeDefined()
      expect(vOption?.hidden).toBe(true)
    })

    it('displays version with -V via Commander built-in handler', async () => {
      const program = createMainCommand()
      program.exitOverride()
      try {
        await program.parseAsync(['node', 'cagent', '-V'])
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(CommanderError)
        expect((err as CommanderError).exitCode).toBe(0)
      }
    })

    it('displays version with --version via Commander built-in handler', async () => {
      const program = createMainCommand()
      program.exitOverride()
      try {
        await program.parseAsync(['node', 'cagent', '--version'])
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(CommanderError)
        expect((err as CommanderError).exitCode).toBe(0)
      }
    })

    it('displays version with -v via root action handler', async () => {
      const program = createMainCommand()
      program.exitOverride()
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      const restoreTty = mockTty(true, true)
      try {
        await expect(program.parseAsync(['node', 'cagent', '-v'])).rejects.toThrow('process.exit')
        expect(logSpy).toHaveBeenCalled()
      } finally {
        exitSpy.mockRestore()
        logSpy.mockRestore()
        restoreTty()
      }
    })

    it('displays version with -v without a TTY', async () => {
      const program = createMainCommand()
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)
      const logSpy = spyOn(console, 'log').mockImplementation(() => {})
      const restoreTty = mockTty(false, false)
      try {
        await expect(program.parseAsync(['node', 'cagent', '-v'])).rejects.toThrow('process.exit')
        expect(exitSpy).toHaveBeenCalledWith(0)
        expect(logSpy).toHaveBeenCalledWith(VERSION)
      } finally {
        exitSpy.mockRestore()
        logSpy.mockRestore()
        restoreTty()
      }
    })
  })

  describe('unknown option boundary', () => {
    it('rejects --unknown as unknown option, not unknown level', async () => {
      const program = createMainCommand()
      program.exitOverride()
      const restoreTty = mockTty(true, true)
      try {
        try {
          await program.parseAsync(['node', 'cagent', '--unknown'])
          expect.unreachable()
        } catch (err) {
          expect(err).toBeInstanceOf(CommanderError)
          expect((err as CommanderError).message).toContain("unknown option '--unknown'")
          expect((err as CommanderError).exitCode).toBe(1)
        }
      } finally {
        restoreTty()
      }
    })

    it('rejects --flag values as unknown options', async () => {
      const program = createMainCommand()
      program.exitOverride()
      const restoreTty = mockTty(true, true)
      try {
        try {
          await program.parseAsync(['node', 'cagent', '--flag'])
          expect.unreachable()
        } catch (err) {
          expect(err).toBeInstanceOf(CommanderError)
          expect((err as CommanderError).message).toContain("unknown option '--flag'")
        }
      } finally {
        restoreTty()
      }
    })

    it('rejects --unknown as an argument error without a TTY', async () => {
      const program = createMainCommand()
      program.exitOverride()
      const restoreTty = mockTty(false, false)
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)
      try {
        try {
          await program.parseAsync(['node', 'cagent', '--unknown'])
          expect.unreachable()
        } catch (err) {
          expect(err).toBeInstanceOf(CommanderError)
          expect((err as CommanderError).message).toContain("unknown option '--unknown'")
        }
        expect(exitSpy).not.toHaveBeenCalled()
      } finally {
        exitSpy.mockRestore()
        restoreTty()
      }
    })
  })
})
