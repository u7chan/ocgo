import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import type { Config } from './config.js'
import { formatList } from './list.js'

function makeMultiProfileConfig(): Config {
  return {
    default_agent: 'codex',
    default_profile: 'balanced',
    agents: {
      codex: {
        bin: 'codex',
        provider: 'codex',
        model_id_prefix: false,
      },
      'opencode-go': {
        bin: 'opencode',
        provider: 'opencode-go',
      },
    },
    profiles: {
      fast: { agent: 'codex', model: 'test-model-fast' },
      balanced: { agent: 'codex', model: 'test-model-balanced' },
      reviewer: { agent: 'codex', model: 'test-model-sol', effort: 'high' },
      'opencode-fast': { agent: 'opencode-go', model: 'test-model-flash' },
    },
    multiplexer: {
      default: 'herdr',
      herdr: { enabled: true },
    },
  }
}

describe('formatList', () => {
  it('lists every profile with agent, model, and effort', () => {
    const output = formatList(makeMultiProfileConfig())
    expect(output).toContain('PROFILE')
    expect(output).toContain('AGENT')
    expect(output).toContain('MODEL')
    expect(output).toContain('EFFORT')
    expect(output).toContain('test-model-fast')
    expect(output).toContain('test-model-sol')
    expect(output).toContain('high')
    expect(output).toContain('opencode-fast')
    expect(output).toContain('test-model-flash')
    expect(output).not.toContain('LEVEL')
  })

  it('marks the default_profile', () => {
    const output = formatList(makeMultiProfileConfig())
    expect(output).toContain('balanced *')
    expect(output).toContain('* = default_profile')
  })

  it('does not add a legend when default_profile is unset', () => {
    const config = makeMultiProfileConfig()
    delete config.default_profile
    const output = formatList(config)
    expect(output).not.toContain('* = default_profile')
  })

  it('handles a config without profiles', () => {
    const config = makeMultiProfileConfig()
    config.profiles = {}
    expect(formatList(config)).toContain('No profiles defined.')
  })
})

describe('list command', () => {
  function writeTempConfig(): { file: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'cagent-list-test-'))
    const file = join(dir, 'config.yaml')
    writeFileSync(
      file,
      `default_agent: codex
default_profile: balanced
agents:
  codex:
    bin: codex
    provider: codex
profiles:
  fast:
    agent: codex
    model: test-model-fast
  balanced:
    agent: codex
    model: test-model-balanced
    effort: high
multiplexer:
  default: herdr
  herdr: { enabled: true }
`,
    )
    return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('outputs the profile list as human text', async () => {
    const { file, cleanup } = writeTempConfig()
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = new Command()
      program.addCommand((await import('./list.js')).createListCommand())
      await program.parseAsync(['node', 'cagent', 'list'])
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = String(logSpy.mock.calls[0]?.[0])
      expect(output).toContain('fast')
      expect(output).toContain('test-model-fast')
      expect(output).toContain('balanced *')
      expect(output).toContain('high')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })

  it('outputs the profile list as JSON with the versioned envelope', async () => {
    const { file, cleanup } = writeTempConfig()
    const originalConfig = process.env.CAGENT_CONFIG
    process.env.CAGENT_CONFIG = file
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const program = new Command().option('--json')
      program.addCommand((await import('./list.js')).createListCommand())
      await program.parseAsync(['node', 'cagent', '--json', 'list'])
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.schema_version).toBe(1)
      expect(output.ok).toBe(true)
      expect(output.operation).toBe('list')
      expect(output.data.default_profile).toBe('balanced')
      expect(output.data.profiles).toEqual([
        { name: 'fast', agent: 'codex', model: 'test-model-fast', effort: null },
        {
          name: 'balanced',
          agent: 'codex',
          model: 'test-model-balanced',
          effort: 'high',
        },
      ])
      expect(output.data.profiles[0]).not.toHaveProperty('level')
    } finally {
      logSpy.mockRestore()
      if (originalConfig === undefined) delete process.env.CAGENT_CONFIG
      else process.env.CAGENT_CONFIG = originalConfig
      cleanup()
    }
  })
})
