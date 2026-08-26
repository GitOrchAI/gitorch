import { RAILS_SCHEMAS, buildStepPrompt } from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import { destinoDaDuvida, textoDaRespostaAoDev, type DestinoDaDuvida } from './duvida-do-dev.js'
import type { StepExecutor } from './role-rails.js'

/**
 * A missão que RESPONDE a pergunta do dev assíncrono.
 *
 * Existe porque nenhuma respondia. A vigília acordava o QA — que só sabe
 * julgar pull request — e contava a linha como respondida. A pergunta ficava
 * na mesa, a sessão congelava uma vaga, e o teto de simultâneas estourava.
 *
 * O desenho segue os trilhos do resto do produto: o modelo preenche um
 * formulário validado, e QUEM DECIDE o destino é código determinístico
 * (`duvida-do-dev.ts`). O modelo nunca escolhe sozinho mandar mensagem para o
 * dev — ele só diz o que sabe e se aquilo é decisão de negócio.
 */

export interface DuvidaRailsMissionOptions {
  /** O que o dev perguntou, na íntegra. */
  pergunta: string
  repository: string
  /** Número da tarefa que o dev está executando, para dar contexto. */
  issueNumber: number
  execute: StepExecutor
  contextBlocks: string[]
}

export interface DuvidaRailsMissionResult {
  destino: DestinoDaDuvida
  /** Pronto para `responderSessaoJules` — só existe quando o destino é o dev. */
  mensagemParaODev: string | null
}

interface FormularioDaDuvida {
  precisaDoDono: boolean
  resposta: string
}

export async function runDuvidaMissionViaRails(
  options: DuvidaRailsMissionOptions
): Promise<DuvidaRailsMissionResult> {
  const formulario = (await runFormStep({
    schema: RAILS_SCHEMAS.devQuestion,
    prompt: buildStepPrompt('qa', 'dev-question', RAILS_SCHEMAS.devQuestion, [
      ...options.contextBlocks,
      `The async developer working on issue #${options.issueNumber} of ${options.repository} ` +
        `STOPPED and asked this question. Until someone answers, that work is frozen:`,
      '',
      options.pergunta,
      '',
      'Answer it by READING THE REPOSITORY — cite real files and real code, never invent. ' +
        'Set precisaDoDono=true ONLY when answering would mean deciding something that belongs ' +
        'to the product owner (pricing, scope, product behaviour, what the business wants) — ' +
        'those are never yours to guess. For anything technical, answer it: which approach, ' +
        'which file, which existing helper. If you genuinely cannot tell from the repository, ' +
        'say so plainly in `resposta` and leave precisaDoDono=false — an empty answer is never ' +
        'sent to the developer, it is escalated instead.',
    ]),
    execute: options.execute,
  })) as FormularioDaDuvida

  const destino = destinoDaDuvida({
    precisaDoDono: formulario.precisaDoDono,
    resposta: formulario.resposta,
  })

  return {
    destino,
    mensagemParaODev:
      destino.tipo === 'responder-o-dev' ? textoDaRespostaAoDev(destino.resposta) : null,
  }
}
