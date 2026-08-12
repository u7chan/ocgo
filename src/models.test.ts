import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { createMainCommand } from './main.js'
import { createModelsCommand } from './models.js'

function writeTempConfig(agent: string, bin: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cagent-models-test-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(
    file,
    `default_agent: ${agent}
default_profile: balanced
agents:
  ${agent}:
    bin: ${bin}
    provider: ${agent}
profiles:
  balanced:
    agent: ${agent}
    model: test-model
multiplexer:
  default: herdr
  herdr: { enabled: true }
`,
  )
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('models command', () => {
  it('fails bare cagent models with guidance instead of listing configured models', async () => {
    const { file, cleanup } = writeTempConfig('opencode-go', 'opencode')
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    try {
      const program = createMainCommand()
      program.addCommand(createModelsCommand())
      await expect(program.parseAsync(['node', 'cagent', 'models'])).rejects.toThrow('process.exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
      const message = String(errorSpy.mock.calls[0]?.[0])
      expect(message).toContain('`cagent models` no longer lists configured models')
      expect(message).toContain('cagent list')
      expect(message).toContain('cagent models available')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })

  it('outputs a JSON failure for bare cagent models --json', async () => {
    const { file, cleanup } = writeTempConfig('opencode-go', 'opencode')
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    try {
      const program = createMainCommand()
      program.addCommand(createModelsCommand())
      await expect(program.parseAsync(['node', 'cagent', 'models', '--json'])).rejects.toThrow(
        'process.exit',
      )
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.schema_version).toBe(1)
      expect(output.ok).toBe(false)
      expect(output.operation).toBe('models')
      expect(output.error.code).toBe('USAGE_ERROR')
      expect(output.error.message).toContain('cagent list')
    } finally {
      exitSpy.mockRestore()
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })

  it('accepts the deprecated --refresh and routes to the same usage guidance', async () => {
    const { file, cleanup } = writeTempConfig('opencode-go', 'opencode')
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    try {
      const program = createMainCommand()
      program.addCommand(createModelsCommand())
      await expect(program.parseAsync(['node', 'cagent', 'models', '--refresh'])).rejects.toThrow(
        'process.exit',
      )
      expect(exitSpy).toHaveBeenCalledWith(1)
      const message = String(errorSpy.mock.calls[0]?.[0])
      expect(message).toContain('cagent models available')
      expect(message).toContain('cagent list')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })

  it('prints the resolved command for models available with a discovery-capable adapter', async () => {
    const { file, cleanup } = writeTempConfig('opencode-go', 'opencode')
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = new Command().option('--dry-run')
      program.addCommand(createModelsCommand())
      await program.parseAsync(['node', 'cagent', '--dry-run', 'models', 'available', '--refresh'])
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(String(logSpy.mock.calls[0]?.[0])).toContain('opencode models opencode-go')
      expect(String(logSpy.mock.calls[0]?.[0])).toContain('--refresh')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })

  it('fails models available when the adapter has no provider discovery', async () => {
    const { file, cleanup } = writeTempConfig('codex', 'codex')
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    try {
      const program = createMainCommand()
      program.addCommand(createModelsCommand())
      await expect(program.parseAsync(['node', 'cagent', 'models', 'available'])).rejects.toThrow(
        'process.exit',
      )
      expect(exitSpy).toHaveBeenCalledWith(1)
      const message = String(errorSpy.mock.calls[0]?.[0])
      expect(message).toContain('provider model discovery is not supported for agent "codex"')
      expect(message).toContain('cagent list')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })
})
