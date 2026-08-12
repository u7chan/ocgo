#!/usr/bin/env node
import { createConfigCommand } from './config-cmd.js'
import { createDoctorCommand } from './doctor.js'
import { outputJsonFailure } from './json-output.js'
import { createListCommand } from './list.js'
import { createMainCommand } from './main.js'
import { createModelsCommand } from './models.js'
import { createMuxCommand, MuxExecutionError, printMuxExecutionFailure } from './mux/index.js'
import { createRunCommand } from './run.js'

async function main(): Promise<void> {
  const program = createMainCommand()

  program.addCommand(createRunCommand())
  program.addCommand(createModelsCommand())
  program.addCommand(createListCommand())
  program.addCommand(createDoctorCommand())
  program.addCommand(createConfigCommand())
  program.addCommand(createMuxCommand())

  await program.parseAsync(process.argv)
}

main().catch((err) => {
  if (err instanceof MuxExecutionError) {
    if (!err.outputRendered) {
      printMuxExecutionFailure(err.result)
    }
    process.exit(1)
  }

  const separatorIndex = process.argv.indexOf('--')
  const wrapperArgv = process.argv.slice(0, separatorIndex === -1 ? undefined : separatorIndex)
  if (wrapperArgv.includes('--json')) {
    const message = err instanceof Error ? err.message : String(err)
    outputJsonFailure('error', 'INTERNAL_ERROR', message)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
})
