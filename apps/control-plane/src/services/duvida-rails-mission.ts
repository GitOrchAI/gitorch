import { RAILS_SCHEMAS, buildStepPrompt } from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import {
  destinoDaDuvida,
  textoDaRespostaAoDev,
  citaAlgoConcreto,
  type DestinoDaDuvida,
} from './duvida-do-dev.js'
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
  perguntaExecutivaPtBr?: string
  opcoesPtBr?: Array<{ label: string; value: string }>
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
      '',
      'IMPORTANT — this is NEVER a business decision, even if it looks like one at first: ' +
        'whether existing/prior work already satisfies the issue (bugs already fixed, features ' +
        'already implemented, "should I open an empty PR or is there something else to register"), ' +
        'which approach/file/existing helper to use, or how to resolve a disagreement with a code ' +
        'review tool. Those are process/technical questions — set precisaDoDono=false and answer ' +
        'them (or say plainly you could not determine it from the repository).',
      '',
      'When precisaDoDono=true (a REAL business decision — pricing, scope, what the product ' +
        'should do): the owner is not technical and reads only Portuguese. ALSO fill ' +
        '`perguntaExecutivaPtBr` — the decision translated into Portuguese, framed as a BUSINESS ' +
        'question (what changes for the business, never the technical detail/file names/commit ' +
        'hashes) — and `opcoesPtBr` — 2 to 4 short, objective options in Portuguese the owner can ' +
        'tap instead of typing. If you cannot produce a confident Portuguese translation, leave ' +
        'both empty rather than forcing a bad one; never invent options that misrepresent the ' +
        'decision.',
    ]),
    execute: options.execute,
  })) as FormularioDaDuvida

  const destino = destinoDaDuvida({
    precisaDoDono: formulario.precisaDoDono,
    resposta: formulario.resposta,
    pergunta: options.pergunta,
    ...(formulario.perguntaExecutivaPtBr
      ? { perguntaExecutiva: formulario.perguntaExecutivaPtBr }
      : {}),
    ...(formulario.opcoesPtBr && formulario.opcoesPtBr.length > 0
      ? { opcoes: formulario.opcoesPtBr }
      : {}),
  })

  return {
    destino,
    mensagemParaODev:
      destino.tipo === 'responder-o-dev' ? textoDaRespostaAoDev(destino.resposta) : null,
  }
}

/**
 * A SUPOSIÇÃO do RA quando a dúvida foi ESCALADA ao dono e ele ficou 24h em
 * silêncio (L4-T4, D64).
 *
 * Diferente de `runDuvidaMissionViaRails` acima: aqui não existe mais
 * "perguntar ao dono" como destino — o dono JÁ FOI perguntado
 * (`escalar-duvida-ao-dono.ts`) e não respondeu a tempo. O RA lê o
 * repositório e forma uma suposição TÉCNICA para o dev seguir em frente; o
 * dono continua podendo corrigir depois (`agent-question.ts marcarAssumida`
 * grava a suposição como decisão provisória, não definitiva).
 */
export interface SuposicaoDoRa {
  suposicao: string
  justificativa: string
  arquivosCitados: string[]
}

export interface SuporSemODonoOptions {
  /** O que o dev perguntou, na íntegra — a MESMA pergunta que foi escalada. */
  pergunta: string
  repository: string
  issueNumber: number
  execute: StepExecutor
  contextBlocks: string[]
}

/**
 * Formula a suposição, ou `null` quando ela não passa no freio de
 * concretude. `null` é o sinal para `session-watch.ts` manter a espera e
 * avisar o dono, em vez de entregar ao dev uma opinião genérica travestida
 * de decisão.
 */
export async function suporSemODono(options: SuporSemODonoOptions): Promise<SuposicaoDoRa | null> {
  const formulario = (await runFormStep({
    schema: RAILS_SCHEMAS.duvidaSuposicao,
    prompt: buildStepPrompt('ra', 'duvida-suposicao', RAILS_SCHEMAS.duvidaSuposicao, [
      ...options.contextBlocks,
      `The async developer working on issue #${options.issueNumber} of ${options.repository} ` +
        'asked a question that was ESCALATED to the product owner as a business decision. The ' +
        'owner has been silent for 24 HOURS and the work is still frozen — this is the ' +
        'original question:',
      '',
      options.pergunta,
      '',
      'Since the owner has not answered, form a CONCRETE SUPPOSITION so the developer can keep ' +
        'going — the owner can still correct this later, it is not final. Ground it in the REAL ' +
        'repository: read the actual code, cite real files, real existing patterns, never invent. ' +
        '`suposicao` is the technical decision itself, `justificativa` is why (in one or two ' +
        'sentences), and `arquivosCitados` lists the real file paths you based this on. Never ' +
        'fabricate a file that does not exist.',
    ]),
    execute: options.execute,
  })) as SuposicaoDoRa

  // O MESMO freio de concretude que `duvida-do-dev.ts` aplica à resposta
  // comum (`ehRespostaUtil`): o schema já garante tamanho mínimo e pelo
  // menos um arquivo citado, mas nada impede o modelo de escrever uma
  // suposição vaga ("acho que qualquer abordagem serve") enquanto cita um
  // arquivo qualquer só para passar na forma. Sem apontar para algo REAL no
  // próprio texto da suposição, ela não desbloqueia ninguém — vira null, e
  // `session-watch.ts` mantém a espera em vez de entregar isto ao dev.
  if (!citaAlgoConcreto(formulario.suposicao)) return null

  return formulario
}

/**
 * O texto que chega ao dev quando o RA assume por ele (L4-T4, D64).
 *
 * Vive AQUI, ao lado de `SuposicaoDoRa`/`suporSemODono`, e não em
 * `session-watch.ts` (onde nasceu) nem duplicado no scheduler: fix-up da
 * task a13a42f8-2953-4259-b41f-3f8cddb304cd — a suposição passou a ser
 * FORMADA e APLICADA dentro do mesmo trilho de missão que já responde a
 * dúvida pendente (`scheduler.ts` `suporDuvidaPendente`, irmã de
 * `responderDuvidaPendente`), porque o único `execute: StepExecutor` real
 * nasce dentro de `executeMissionWithFailover` — `session-watch.ts`
 * (`vigiarSessoes`) roda FORA de qualquer missão e nunca teve um `execute`
 * para chamar. Uma função de formatação só, reaproveitada por quem de fato
 * entrega o texto, evita duas cópias divergindo.
 */
export function textoDaSuposicaoParaODev(s: SuposicaoDoRa): string {
  return (
    `Suposição adotada pelo RA (o dono pode corrigir): ${s.suposicao}\n\n` +
    `Por quê: ${s.justificativa}\n` +
    `Arquivos: ${s.arquivosCitados.join(', ')}`
  )
}

/**
 * O comentário que fica registrado na issue do cliente (L4-T4, D64), para
 * quem olhar depois entender por que o trabalho seguiu sem resposta do dono.
 */
export function textoDoComentarioDeSuposicao(s: SuposicaoDoRa): string {
  return `GitOrch: suposição adotada: ${s.suposicao} (o dono pode corrigir)`
}
