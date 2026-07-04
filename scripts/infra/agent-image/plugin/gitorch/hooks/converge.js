#!/usr/bin/env node
// GitOrch PostInvocation convergence hook.
// The agy engine tends to keep reading files invocation after invocation and
// runs out of the print budget before ever writing its deliverable. Text
// instructions in the prompt alone do not stop it — a mid-loop injected system
// message does. After SOFT invocations we inject a "write the deliverable NOW"
// message; from HARD on we escalate to an imperative final-call. We do NOT force
// termination: terminating could cut the model off before it writes the
// deliverable. The engine's print-timeout remains the last-resort backstop.
//
// Contract (see agy-customizations/docs/hooks.md): stdin carries invocationNum;
// stdout returns {"injectSteps":[...]}.

const fs = require('fs')

// O gate de comando já impede as background tasks que travavam (builds/servers),
// então a convergência não precisa ser agressiva: se disparar cedo demais, o
// motor entrega um deliverable PARCIAL (ex.: só 2 das 5 seções do brief). Damos
// espaço para o trabalho normal terminar e só cutucamos exploração realmente
// excessiva.
const SOFT = Number(process.env.GITORCH_CONVERGE_SOFT || 10)
const HARD = Number(process.env.GITORCH_CONVERGE_HARD || 18)

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function nudge(message) {
  process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage: message }] }))
}

function main() {
  let payload = {}
  try {
    payload = JSON.parse(readStdin() || '{}')
  } catch {
    payload = {}
  }
  const n = Number(payload.invocationNum || 0)

  if (n >= HARD) {
    nudge(
      'GitOrch: budget reached. Do NOT read, list, or run anything else. Your very next message MUST be the COMPLETE final structured deliverable, written out in full.'
    )
    return
  }

  if (n >= SOFT) {
    nudge(
      'GitOrch: you have gathered enough context. STOP reading more files now and write your COMPLETE final structured deliverable as your next message — the deliverable itself, not a summary of what you did.'
    )
    return
  }

  process.stdout.write(JSON.stringify({ injectSteps: [] }))
}

main()
