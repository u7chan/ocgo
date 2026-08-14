import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import YAML from 'yaml'
import { getAgentAdapter } from '../src/agents/registry.js'
import { formatCommandSpec } from '../src/command.js'
import { checkHerdrBin, closePane, getCurrentPane, runInPane, splitPane } from '../src/mux/herdr.js'

type ValidationHerdrStepRecord = {
  step: 'current' | 'split' | 'run' | 'close'
  status: 'pass' | 'fail'
  pane_id?: string
  error?: string
}

type AgentProfileEntry = { expected_model: string }
type AgentProfileMatrix = Record<string, AgentProfileEntry>
type Matrix = Record<string, AgentProfileMatrix>

export type CommandOutput = { status: number; stdout: string; stderr: string }
type Status = 'pass' | 'fail'
export type EvaluationStatus = Status | 'inconclusive'

export type EvaluationCase = {
  id: string
  level: 'low' | 'mid' | 'high'
  fixture: string
  rubric: { required: string[]; forbidden: string[] }
}

export type EvaluationConfig = {
  baseline: string
  trials: number
  timeout_ms: number
  cases: EvaluationCase[]
  hidden_checks: { forbidden: string[] }
}

type ProfileResult = {
  agent: string
  profile: string
  expectedModel: string
  dryRun: CommandOutput
  routingStatus: Status
  live?: { status: Status; exitCode: number; diagnostic?: string }
}

export type ManualAttestation = {
  method: 'herdr-pane'
  verified_by: string
  verified_at: string
  expected_model: string
  observed_cli_model: string
  status: 'pass'
}

export type ManualAttestationResult = {
  status: Status | 'not_provided'
  attestation?: ManualAttestation
  diagnostic?: string
}

type LiveAuthorization = {
  liveFlag: boolean
  sideEffectConfirmation: boolean
}

type HerdrLiveSummary = {
  authorized: boolean
  diagnostic?: string
  plan?: {
    pane_count: number
    agent: string
    profile: string
    expected_model: string
    command_summary: string
    cleanup_policy: 'keep' | 'close'
  }
  steps: ValidationHerdrStepRecord[]
  created_panes: string[]
}

const root = resolve(import.meta.dir, '..')
const validationRoot = join(root, 'validation')
const builtEntryPoint = join(root, 'dist', 'index.js')
const configPath = join(validationRoot, 'config', 'cagent.yaml')
const matrixPath = join(validationRoot, 'config', 'matrix.yaml')
const promptPath = join(validationRoot, 'smoke', 'cases', 'model-routing', 'prompt.md')
const evaluationConfigPath = join(validationRoot, 'config', 'evaluation.yaml')

export function loadMatrix(path = matrixPath): Matrix {
  return YAML.parse(readFileSync(path, 'utf8')) as Matrix
}

export function loadEvaluationConfig(path = evaluationConfigPath): EvaluationConfig {
  const config = YAML.parse(readFileSync(path, 'utf8')) as EvaluationConfig
  if (
    !config ||
    typeof config.baseline !== 'string' ||
    config.trials !== 3 ||
    !Number.isInteger(config.timeout_ms) ||
    !Array.isArray(config.cases) ||
    config.cases.length !== 3 ||
    !Array.isArray(config.hidden_checks?.forbidden)
  )
    throw new Error('Invalid evaluation config')
  for (const item of config.cases) {
    if (!['low', 'mid', 'high'].includes(item.level) || !item.id || !item.fixture)
      throw new Error('Invalid evaluation case')
  }
  return config
}

export function parseCandidate(value: string): { agent: string; model: string } | undefined {
  const slash = value.indexOf('/')
  if (slash < 1 || slash === value.length - 1) return undefined
  return { agent: value.slice(0, slash), model: value.slice(slash + 1) }
}

function run(command: string, args: string[], cwd = root, env = process.env): CommandOutput {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: false })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function configHash(): string {
  return fileHash(configPath)
}

export function assertDryRunModel(
  output: string,
  expectedModel: string,
  agentName: string,
): boolean {
  const normalized = output.replace(/'/g, '')
  if (agentName === 'codex') return normalized.includes(`codex exec --model ${expectedModel}`)
  if (agentName === 'opencode-go')
    return normalized.includes(`opencode run --model ${expectedModel}`)
  return false
}

export function validateManualAttestation(
  path: string | undefined,
  expectedModel: string,
): ManualAttestationResult {
  if (!path) return { status: 'not_provided', diagnostic: 'manual attestation was not provided' }
  try {
    const value = YAML.parse(readFileSync(path, 'utf8')) as { manual_attestation?: unknown }
    const attestation = value?.manual_attestation
    if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
      return { status: 'fail', diagnostic: 'manual_attestation mapping is required' }
    }
    const entry = attestation as Record<string, unknown>
    const requiredStrings = [
      'method',
      'verified_by',
      'verified_at',
      'expected_model',
      'observed_cli_model',
      'status',
    ]
    if (requiredStrings.some((key) => typeof entry[key] !== 'string' || entry[key].trim() === '')) {
      return { status: 'fail', diagnostic: 'manual_attestation has missing required string fields' }
    }
    if (entry.method !== 'herdr-pane')
      return { status: 'fail', diagnostic: 'method must be herdr-pane' }
    if (entry.status !== 'pass') return { status: 'fail', diagnostic: 'status must be pass' }
    if (Number.isNaN(Date.parse(entry.verified_at as string))) {
      return { status: 'fail', diagnostic: 'verified_at must be an ISO-8601 timestamp' }
    }
    if (entry.expected_model !== expectedModel || entry.observed_cli_model !== expectedModel) {
      return {
        status: 'fail',
        diagnostic: `expected and observed models must equal ${expectedModel}`,
      }
    }
    return { status: 'pass', attestation: entry as unknown as ManualAttestation }
  } catch (error) {
    return { status: 'fail', diagnostic: `could not read manual attestation: ${String(error)}` }
  }
}

function cagentArgs(agentName: string, profile: string, prompt: string, live: boolean): string[] {
  const extras =
    agentName === 'codex'
      ? ['--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', prompt]
      : [prompt]
  return [builtEntryPoint, ...(live ? [] : ['--dry-run']), 'run', profile, '--', ...extras]
}

function runLive(
  agentName: string,
  profile: string,
  prompt: string,
): { status: Status; exitCode: number; diagnostic?: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'cagent-validation-'))
  try {
    const result = run('node', cagentArgs(agentName, profile, prompt, true), workspace, {
      ...process.env,
      CAGENT_CONFIG: configPath,
    })
    const diagnostic = [result.stderr, result.stdout]
      .join('\n')
      .split('\n')
      .filter((line) => /error|failed|not supported/i.test(line))
      .slice(0, 3)
      .join('\n')
    return {
      status: result.status === 0 ? 'pass' : 'fail',
      exitCode: result.status,
      ...(diagnostic ? { diagnostic } : {}),
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function getCliVersion(bin: string): string {
  const result = run(bin, ['--version'])
  return result.status === 0 ? result.stdout.trim() : 'not installed'
}

function writeReport(
  reportDir: string,
  manifest: Record<string, unknown>,
  scores: Record<string, unknown>,
  lines: string[],
): void {
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'manifest.yaml'), YAML.stringify(manifest))
  writeFileSync(join(reportDir, 'scores.json'), `${JSON.stringify(scores, null, 2)}\n`)
  writeFileSync(join(reportDir, 'report.md'), `${lines.join('\n')}\n`)
}

function writeEvaluationReport(
  reportDir: string,
  manifest: Record<string, unknown>,
  scores: Record<string, unknown>,
  lines: string[],
): void {
  writeReport(reportDir, manifest, scores, lines)
  const indexPath = join(validationRoot, '.artifacts', 'index.md')
  mkdirSync(join(validationRoot, '.artifacts'), { recursive: true })
  if (!existsSync(indexPath)) writeFileSync(indexPath, '# Candidate evaluation index\n\n')
  appendFileSync(indexPath, `- ${manifest.run_id}: ${reportDir}\n`)
}

function isTransient(result: CommandOutput): boolean {
  return (
    result.status === 124 ||
    /\b429\b|\b5\d\d\b|network|connection|timed? out/i.test(`${result.stderr}\n${result.stdout}`)
  )
}

export function evaluateInvocation(
  command: string,
  model: string,
  fixture: string,
  timeout: number,
): CommandOutput {
  const workspace = mkdtempSync(join(tmpdir(), 'cagent-evaluate-'))
  const copiedFixture = join(workspace, basename(fixture))
  try {
    copyFileSync(fixture, copiedFixture)
    const result = spawnSync(command, ['--model', model, '--case', copiedFixture], {
      cwd: workspace,
      env: process.env,
      encoding: 'utf8',
      shell: false,
      timeout,
    })
    return {
      status:
        (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
          ? 124
          : (result.status ?? 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? String(result.error ?? ''),
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function scoreOutput(
  output: string,
  rubric: EvaluationCase['rubric'],
): {
  status: EvaluationStatus
  missing: string[]
  critical: string[]
} {
  const missing = rubric.required.filter((text) => !output.includes(text))
  const critical = rubric.forbidden.filter((text) => output.includes(text))
  return { status: critical.length || missing.length ? 'fail' : 'pass', missing, critical }
}

export function evaluate(args: string[], config = loadEvaluationConfig()): number {
  const candidateValue = option(args, '--candidate')
  const candidate = candidateValue && parseCandidate(candidateValue)
  const reportDir = option(args, '--report-dir') ?? join(validationRoot, '.artifacts', runId())
  if (!candidate) {
    console.error('A candidate in <agent/model> form is required')
    return 1
  }
  const plannedCalls = config.cases.length * config.trials * 2
  const plan = [
    '# Candidate model evaluation plan',
    '',
    `- Candidate: ${candidateValue}`,
    `- Baseline: ${config.baseline}`,
    `- Cases: ${config.cases.map((item) => `${item.id} (${item.level})`).join(', ')}`,
    `- Trials per model/case: ${config.trials}`,
    `- Planned model calls: ${plannedCalls}`,
  ]
  console.log(plan.slice(2).join('\n'))
  const execute = args.includes('--execute')
  const confirmed = args.includes('--confirm-live')
  if (!execute || !confirmed) {
    const diagnostic = execute
      ? 'Live execution requires explicit --confirm-live acknowledgement.'
      : 'Plan only. Add --execute --confirm-live to make external model calls.'
    console.log(diagnostic)
    writeEvaluationReport(
      reportDir,
      {
        ...reportBase('evaluate', false),
        candidate: candidateValue,
        baseline: config.baseline,
        planned_calls: plannedCalls,
      },
      { status: 'not_run', planned_calls: plannedCalls },
      [...plan, '', `- Status: **not_run**`, `- ${diagnostic}`],
    )
    return execute ? 1 : 0
  }
  const command = process.env.CAGENT_EVALUATE_COMMAND
  if (!command) {
    console.error('CAGENT_EVALUATE_COMMAND is required for live evaluation')
    return 1
  }
  const records: Array<Record<string, unknown>> = []
  let executedCalls = 0
  for (const item of config.cases) {
    const fixture = join(validationRoot, item.fixture)
    for (let trial = 1; trial <= config.trials; trial++) {
      for (const subject of [candidateValue, config.baseline]) {
        const parsed = parseCandidate(subject)
        if (!parsed) throw new Error(`Invalid configured model: ${subject}`)
        executedCalls++
        let result = evaluateInvocation(command, parsed.model, fixture, config.timeout_ms)
        let retried = false
        if (isTransient(result)) {
          retried = true
          executedCalls++
          result = evaluateInvocation(command, parsed.model, fixture, config.timeout_ms)
        }
        const retryExhausted = result.status !== 0 && isTransient(result)
        const scored =
          result.status === 0
            ? scoreOutput(result.stdout, {
                required: item.rubric.required,
                forbidden: [...item.rubric.forbidden, ...config.hidden_checks.forbidden],
              })
            : {
                status: retryExhausted ? 'inconclusive' : ('fail' as EvaluationStatus),
                missing: [],
                critical: [],
              }
        records.push({
          case: item.id,
          level: item.level,
          trial,
          subject,
          status: scored.status,
          retried,
          missing: scored.missing,
          critical: scored.critical,
        })
      }
    }
  }
  const candidateRecords = records.filter((record) => record.subject === candidateValue)
  const critical = candidateRecords.some((record) => (record.critical as string[]).length > 0)
  const inconclusive = candidateRecords.some((record) => record.status === 'inconclusive')
  const passedCases = config.cases.filter(
    (item) =>
      candidateRecords.filter((record) => record.case === item.id && record.status === 'pass')
        .length >= 2,
  ).length
  const status: EvaluationStatus = inconclusive
    ? 'inconclusive'
    : !critical && passedCases === config.cases.length
      ? 'pass'
      : 'fail'
  writeEvaluationReport(
    reportDir,
    {
      ...reportBase('evaluate', true),
      candidate: candidateValue,
      baseline: config.baseline,
      planned_calls: plannedCalls,
      executed_calls: executedCalls,
    },
    { status, candidate: candidateValue, baseline: config.baseline, records },
    [
      '# Candidate model evaluation report',
      '',
      `- Status: **${status}**`,
      `- Candidate: ${candidateValue}`,
      `- Baseline: ${config.baseline}`,
      `- Rule: 2/3 successes for every case and zero critical violations`,
      '',
      '| Case | Trial | Subject | Status | Retried |',
      '| --- | --- | --- | --- | --- |',
      ...records.map(
        (record) =>
          `| ${record.case} | ${record.trial} | ${record.subject} | ${record.status} | ${record.retried} |`,
      ),
    ],
  )
  console.log(`Validation report: ${reportDir}`)
  return status === 'pass' ? 0 : 1
}

function reportBase(profile: string, live: boolean): Record<string, unknown> {
  return {
    run_id: runId(),
    tested_commit: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
    config_sha256: configHash(),
    ...(profile === 'evaluate' ? { evaluation_config_sha256: fileHash(evaluationConfigPath) } : {}),
    codex_cli: getCliVersion('codex'),
    opencode_cli: getCliVersion('opencode'),
    profile,
    mode: live ? 'live' : 'routing-only',
    backend_attestation: 'unobservable',
  }
}

function buildAndCheckCli(): {
  status: Status
  help: Status
  version: Status
  diagnostic?: string
} {
  const build = run('bun', ['run', 'build'])
  if (build.status !== 0 || !existsSync(builtEntryPoint))
    return {
      status: 'fail',
      help: 'fail',
      version: 'fail',
      diagnostic: build.stderr || 'Build did not create dist/index.js',
    }
  const help = run('node', [builtEntryPoint, '--help'])
  const version = run('node', [builtEntryPoint, '--version'])
  const helpStatus: Status = help.status === 0 && /Usage:/i.test(help.stdout) ? 'pass' : 'fail'
  const versionStatus: Status = version.status === 0 ? 'pass' : 'fail'
  return {
    status: helpStatus === 'pass' && versionStatus === 'pass' ? 'pass' : 'fail',
    help: helpStatus,
    version: versionStatus,
  }
}

function smokeCore(args: string[], reportDir: string): number {
  const requestedAgent = option(args, '--agent')
  const live = args.includes('--live')
  const cli = buildAndCheckCli()
  if (cli.status === 'fail') return 1
  const matrix = loadMatrix()
  const agentNames = requestedAgent ? [requestedAgent] : Object.keys(matrix)
  if (agentNames.some((name) => !matrix[name])) {
    console.error(`Unknown agent: ${requestedAgent}`)
    return 1
  }
  const prompt = readFileSync(promptPath, 'utf8').trim()
  const results: ProfileResult[] = []
  for (const agentName of agentNames)
    for (const [profile, value] of Object.entries(matrix[agentName])) {
      const dryRun = run('node', cagentArgs(agentName, profile, prompt, false), root, {
        ...process.env,
        CAGENT_CONFIG: configPath,
      })
      const result: ProfileResult = {
        agent: agentName,
        profile,
        expectedModel: value.expected_model,
        dryRun,
        routingStatus:
          dryRun.status === 0 && assertDryRunModel(dryRun.stdout, value.expected_model, agentName)
            ? 'pass'
            : 'fail',
      }
      if (live) result.live = runLive(agentName, profile, prompt)
      results.push(result)
    }
  const passed =
    cli.status === 'pass' &&
    results.every((result) => result.routingStatus === 'pass' && result.live?.status !== 'fail')
  const baseManifest = reportBase('core', live)
  const manifest = {
    ...baseManifest,
    cli_help: cli.help,
    cli_version: cli.version,
  }
  writeReport(reportDir, manifest, { routing: results }, [
    '# Model routing smoke report',
    '',
    `- Status: **${passed ? 'pass' : 'fail'}**`,
    `- Mode: ${baseManifest.mode}`,
    `- Tested commit: ${baseManifest.tested_commit}`,
    `- Codex CLI: ${baseManifest.codex_cli}`,
    `- OpenCode CLI: ${baseManifest.opencode_cli}`,
    '- Profile: core',
    `- Backend attestation: ${baseManifest.backend_attestation}`,
    `- CLI --help: ${cli.help}`,
    `- CLI --version: ${cli.version}`,
    '',
    '| Agent | Profile | Expected model | Routing | Live run |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.agent} | ${r.profile} | ${r.expectedModel} | ${r.routingStatus} | ${r.live?.status ?? 'not run'} |`,
    ),
    '',
    'Automatic routing is verified at the cagent-to-CLI boundary. Provider-reported model IDs are not collected by this runner.',
  ])
  return passed ? 0 : 1
}

function resolveLiveAuthorization(args: string[]): LiveAuthorization {
  return {
    liveFlag: args.includes('--live'),
    sideEffectConfirmation: args.includes('--confirm-herdr-side-effects'),
  }
}

function runHerdrLive(
  agent: string,
  profile: string,
  prompt: string,
  expectedModel: string,
  cleanup: boolean,
): HerdrLiveSummary {
  const steps: ValidationHerdrStepRecord[] = []
  const createdPanes: string[] = []
  const cwd = process.cwd()

  const adapter = getAgentAdapter(agent)
  const commandSpec = adapter.buildRunCommand({
    bin: adapter.defaultBin,
    modelId: expectedModel,
    cwd,
    extraArgs: [prompt],
    config: { bin: adapter.defaultBin, provider: agent },
  })
  const formattedCommand = formatCommandSpec(commandSpec)
  const commandSummary =
    formattedCommand.length > 100 ? `${formattedCommand.slice(0, 100)}...` : formattedCommand

  const plan = {
    pane_count: 1,
    agent,
    profile,
    expected_model: expectedModel,
    command_summary: commandSummary,
    cleanup_policy: (cleanup ? 'close' : 'keep') as 'keep' | 'close',
  }

  console.log('## Herdr live plan')
  console.log(`- Agent: ${agent}`)
  console.log(`- Profile: ${profile}`)
  console.log(`- Expected model: ${expectedModel}`)
  console.log(`- Planned panes: ${plan.pane_count}`)
  console.log(`- Command: ${commandSummary}`)
  console.log(`- Cleanup policy: ${plan.cleanup_policy}`)

  let currentPane: string
  try {
    checkHerdrBin()
    currentPane = getCurrentPane()
    steps.push({ step: 'current', status: 'pass', pane_id: currentPane })
  } catch (error) {
    steps.push({
      step: 'current',
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
    })
    return { authorized: true, plan, steps, created_panes: createdPanes }
  }

  let newPane: string
  try {
    newPane = splitPane(currentPane, cwd)
    createdPanes.push(newPane)
    steps.push({ step: 'split', status: 'pass', pane_id: newPane })
  } catch (error) {
    steps.push({
      step: 'split',
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
    })
    if (createdPanes.length > 0) {
      tryCleanup(createdPanes, steps)
    }
    return { authorized: true, plan, steps, created_panes: createdPanes }
  }

  try {
    runInPane(newPane, formattedCommand)
    steps.push({ step: 'run', status: 'pass', pane_id: newPane })
  } catch (error) {
    steps.push({
      step: 'run',
      status: 'fail',
      pane_id: newPane,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (cleanup) {
    tryCleanup(createdPanes, steps)
  } else {
    console.log(`Keeping pane(s): ${createdPanes.join(', ')}`)
  }

  return { authorized: true, plan, steps, created_panes: createdPanes }
}

function tryCleanup(createdPanes: string[], steps: ValidationHerdrStepRecord[]): void {
  const remaining = [...createdPanes]
  for (const pane of createdPanes) {
    try {
      closePane(pane)
      steps.push({ step: 'close', status: 'pass', pane_id: pane })
      remaining.splice(remaining.indexOf(pane), 1)
    } catch (error) {
      steps.push({
        step: 'close',
        status: 'fail',
        pane_id: pane,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (remaining.length > 0) {
    console.log(`Failed to close pane(s), IDs retained: ${remaining.join(', ')}`)
  }
}

function smokeExtended(args: string[], reportDir: string): number {
  const agent = option(args, '--agent') ?? 'codex'
  const profile =
    option(args, '--target') ?? (agent === 'codex' ? 'codex-balanced' : 'opencode-balanced')
  const expectedModel = loadMatrix()[agent]?.[profile]?.expected_model
  if (!expectedModel) {
    console.error(`Unknown agent or profile: ${agent}:${profile}`)
    return 1
  }
  const cli = buildAndCheckCli()
  const prompt = readFileSync(promptPath, 'utf8').trim()
  const env = { ...process.env, CAGENT_CONFIG: configPath }

  const doctor =
    cli.status === 'pass'
      ? run('node', [builtEntryPoint, 'doctor'], root, { ...env, CAGENT_AGENT: agent })
      : { status: 1, stdout: '', stderr: cli.diagnostic ?? 'build failed' }

  const supportsModelListing = Boolean(getAgentAdapter(agent).buildModelListCommand)
  let modelsStatus: Status | 'skip'
  if (cli.status !== 'pass') {
    modelsStatus = 'fail'
  } else if (!supportsModelListing) {
    modelsStatus = 'skip'
  } else {
    modelsStatus = doctor.status === 0 ? 'pass' : 'fail'
  }

  const muxDryRun =
    cli.status === 'pass'
      ? run('node', [builtEntryPoint, '--dry-run', 'mux', 'run', profile, '--', prompt], root, env)
      : doctor

  const routing: Status =
    muxDryRun.status === 0 && assertDryRunModel(muxDryRun.stdout, expectedModel, agent)
      ? 'pass'
      : 'fail'

  const attestation = validateManualAttestation(option(args, '--attestation'), expectedModel)

  const auth = resolveLiveAuthorization(args)
  const liveEnabled = auth.liveFlag && auth.sideEffectConfirmation

  if (auth.liveFlag !== auth.sideEffectConfirmation) {
    const diagnostic = auth.liveFlag
      ? '--confirm-herdr-side-effects is required alongside --live to launch real Herdr panes.'
      : '--live is required alongside --confirm-herdr-side-effects to launch real Herdr panes.'

    const checkStatus = {
      cli: cli.status,
      doctor: doctor.status === 0 ? ('pass' as Status) : ('fail' as Status),
      models: modelsStatus,
      mux_routing: routing,
    }

    const manifest = {
      ...reportBase('extended', false),
      expected_model: expectedModel,
      live_authorization: {
        live_flag: auth.liveFlag,
        side_effect_confirmation: auth.sideEffectConfirmation,
      },
    }

    writeReport(
      reportDir,
      manifest,
      {
        automatic_routing: { agent, profile, expected_model: expectedModel, status: routing },
        environment_checks: checkStatus,
        manual_attestation: attestation,
        backend_attestation: 'unobservable',
        herdr_live: {
          authorized: false,
          diagnostic,
        },
      },
      [
        '# Herdr extended smoke report',
        '',
        `- Status: **fail**`,
        '- Profile: extended',
        `- Expected model: ${expectedModel}`,
        `- Automatic routing: ${routing}`,
        `- Doctor: ${checkStatus.doctor}`,
        `- Models: ${checkStatus.models}`,
        '- Herdr live: **not authorized**',
        `- Live diagnostic: ${diagnostic}`,
        `- Manual attestation: ${attestation.status}`,
        '- Backend attestation: unobservable',
        ...(attestation.diagnostic
          ? [`- Manual attestation diagnostic: ${attestation.diagnostic}`]
          : []),
        '',
        'Automatic routing, human Herdr-pane attestation, and provider-side backend attestation are separate evidence sources.',
      ],
    )
    console.error(diagnostic)
    return 1
  }

  let herdrSummary: HerdrLiveSummary | undefined

  if (liveEnabled) {
    const cleanup = args.includes('--cleanup-created-panes')
    herdrSummary = runHerdrLive(agent, profile, prompt, expectedModel, cleanup)
  }

  const checks = {
    cli,
    doctor: doctor.status === 0 ? ('pass' as Status) : ('fail' as Status),
    models: modelsStatus,
    mux_routing: routing,
  }

  const herdrStepsAllPass = herdrSummary
    ? herdrSummary.steps.every((s) => s.status === 'pass')
    : true

  const passed =
    cli.status === 'pass' &&
    checks.doctor === 'pass' &&
    (checks.models === 'pass' || checks.models === 'skip') &&
    checks.mux_routing === 'pass' &&
    attestation.status === 'pass' &&
    herdrStepsAllPass

  const manifest = {
    ...reportBase('extended', liveEnabled),
    expected_model: expectedModel,
    live_authorization: {
      live_flag: auth.liveFlag,
      side_effect_confirmation: auth.sideEffectConfirmation,
    },
    ...(herdrSummary
      ? {
          herdr_plan: herdrSummary.plan,
          herdr_created_panes: herdrSummary.created_panes,
        }
      : {}),
  }

  const scoresData: Record<string, unknown> = {
    automatic_routing: { agent, profile, expected_model: expectedModel, status: routing },
    environment_checks: checks,
    manual_attestation: attestation,
    backend_attestation: 'unobservable',
  }

  if (herdrSummary) {
    scoresData.herdr_live = {
      authorized: herdrSummary.authorized,
      plan: herdrSummary.plan,
      steps: herdrSummary.steps,
      created_panes: herdrSummary.created_panes,
    }
  }

  writeReport(reportDir, manifest, scoresData, [
    '# Herdr extended smoke report',
    '',
    `- Status: **${passed ? 'pass' : 'fail'}**`,
    '- Profile: extended',
    `- Expected model: ${expectedModel}`,
    `- Automatic routing: ${routing}`,
    `- Doctor: ${checks.doctor}`,
    `- Models: ${checks.models}`,
    ...(herdrSummary
      ? [
          '- Herdr live: **executed**',
          ...herdrSummary.steps.map(
            (s) =>
              `  - ${s.step} (${s.status})${s.pane_id ? ` id=${s.pane_id}` : ''}${s.error ? ` error="${s.error}"` : ''}`,
          ),
          ...(herdrSummary.created_panes.length > 0
            ? [`- Created panes: ${herdrSummary.created_panes.join(', ')}`]
            : []),
        ]
      : ['- Herdr live: **not requested**']),
    `- Manual attestation: ${attestation.status}`,
    '- Backend attestation: unobservable',
    ...(attestation.diagnostic
      ? [`- Manual attestation diagnostic: ${attestation.diagnostic}`]
      : []),
    '',
    'Automatic routing, human Herdr-pane attestation, and provider-side backend attestation are separate evidence sources.',
  ])

  console.log(`Validation report: ${reportDir}`)
  return passed ? 0 : 1
}

function smoke(args: string[]): number {
  const mode = option(args, '--profile') ?? 'core'
  const reportDir = option(args, '--report-dir') ?? join(validationRoot, '.artifacts', runId())
  const exitCode =
    mode === 'core'
      ? smokeCore(args, reportDir)
      : mode === 'extended'
        ? smokeExtended(args, reportDir)
        : 1
  if (mode !== 'core' && mode !== 'extended') console.error(`Unsupported profile: ${mode}`)
  console.log(`Validation report: ${reportDir}`)
  return exitCode
}

function main(): number {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'smoke') return smoke(args)
  if (command === 'evaluate') return evaluate(args)
  console.error(
    'Usage: bun run validate <smoke|evaluate> ...\n  evaluate --candidate <agent/model> [--execute --confirm-live] [--report-dir <path>]',
  )
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.path))
  process.exitCode = main()
