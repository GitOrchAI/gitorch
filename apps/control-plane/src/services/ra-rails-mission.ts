import { wrapClientRequest, RAILS_SCHEMAS, buildStepPrompt } from '@gitorch/cadence'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { runRaRails, type StepExecutor } from './role-rails.js'
import { fetchComTeto } from './fetch-com-teto.js'
import { decidirTrabalhoDoRa, marcarComoAnalisado } from './wish-ja-analisada.js'
import { runFormStep } from './rails-runner.js'
import { destinoAposRa, textoDaRespostaAoDev, type DestinoDaDuvida } from './duvida-do-dev.js'

// Missão do RA nos TRILHOS: ancora a análise na WISH ABERTA (mesmo gatilho do
// PO). Sem isso o RA analisa o projeto em abstrato — ou pior, a wish ANTERIOR
// que ficou na memória (visto em prova real de dogfooding). Sem wish aberta, segue
// como scout geral do projeto (útil do mesmo jeito).

export interface RaRailsMissionOptions {
  repository: string
  githubToken?: string | undefined
  execute: StepExecutor
  contextBlocks: string[]
  /**
   * A missão veio da AGENDA (e não do aviso de desejo novo).
   *
   * Separa os dois trabalhos do RA. Pelo webhook, um desejo novo chegou e é ele
   * que precisa de análise. Pela agenda, o trabalho é EXPLORAR o projeto — e
   * ancorar de novo num desejo já analisado é refazer o que já foi feito, duas
   * vezes por dia, em vez de aprender mais sobre o repositório.
   */
  pelaAgenda?: boolean | undefined
  fetchImpl?: typeof fetch
}

export interface RaRailsMissionResult {
  exitCode: number
  output: string
  stderr: string
}

export async function runRaMissionViaRails(
  options: RaRailsMissionOptions
): Promise<RaRailsMissionResult> {
  // IMPORTANTE (leva D): alcançável pelo tique (scheduler.ts, wake do RA)
  // sob `tickEmAndamento` — mesma classe de defeito do Crítico.
  // `fetchSemPermissao` e nao `fetch` cru: quem chama sem passar um fetch com
  // a autonomia do projeto tem que falhar FECHADO. Com `?? fetch` o
  // esquecimento escrevia no repositorio do cliente sem guarda nenhuma.
  const f = fetchComTeto(options.fetchImpl ?? fetchSemPermissao())

  // A wish é o ponto de ancoragem — best-effort: sem token ou sem wish aberta,
  // o RA roda como scout geral (não é erro).
  let wishBlock: string[] = []
  if (options.githubToken) {
    try {
      const resp = await f(
        `https://api.github.com/repos/${options.repository}/issues?labels=wishlist&state=open&sort=created&direction=desc&per_page=1`,
        {
          headers: {
            authorization: `token ${options.githubToken}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'gitorch',
          },
        }
      )
      if (resp.ok) {
        const wishes = (await resp.json()) as Array<{
          number: number
          title: string
          body?: string
          updated_at?: string
        }>
        const wish = Array.isArray(wishes) ? wishes[0] : undefined
        const decisao = decidirTrabalhoDoRa({
          desejo: wish
            ? { numero: wish.number, corpo: wish.body, atualizadoEm: wish.updated_at }
            : null,
          pelaAgenda: options.pelaAgenda ?? false,
        })
        if (wish && decisao.acao === 'ancorar-no-desejo') {
          // Item 6 (leva B2): `wish.body` é texto livre do cliente — nunca
          // uma instrução ao RA. `wrapClientRequest` (packages/cadence)
          // marca isso explicitamente, bem ao lado do texto.
          wishBlock = [
            `Wish under analysis (the client's CURRENT desire — anchor every area and journey on THIS, not on past work): #${wish.number} ${wish.title}\n${wrapClientRequest(wish.body ?? '')}`,
          ]
          // Marca DEPOIS de decidir analisar, para a agenda seguinte não
          // reancorar no mesmo desejo. A marca vive no CORPO da issue, como o
          // PO já faz com as dele: corpo de issue sobrevive a reinício, a
          // redeploy e a troca de banco.
          //
          // Best-effort: falhar em marcar não pode impedir a análise de
          // acontecer — o pior caso é reanalisar uma vez, que é exatamente o
          // comportamento de antes desta mudança.
          try {
            await f(`https://api.github.com/repos/${options.repository}/issues/${wish.number}`, {
              method: 'PATCH',
              headers: {
                authorization: `token ${options.githubToken}`,
                accept: 'application/vnd.github+json',
                'user-agent': 'gitorch',
                'content-type': 'application/json',
              },
              body: JSON.stringify({ body: marcarComoAnalisado(wish.body) }),
            })
          } catch {
            /* marcar é otimização, não pré-requisito */
          }
        }
      }
    } catch {
      /* wish é ancoragem, não pré-requisito */
    }
  }

  const ra = await runRaRails(options.execute, [...wishBlock, ...options.contextBlocks])
  return { exitCode: 0, output: ra.text, stderr: '' }
}

// ESTEIRA-T14 (decisão do dono 29/08): quando o QA não consegue responder uma
// dúvida técnica do dev assíncrono, ela NUNCA sobe direto ao dono — o RA tenta
// primeiro, com mais tempo e o mesmo contexto de codegraph que o QA já tinha.
// Caso real que motivou: Jules perguntou algo técnico (sync do MercadoLivre,
// upsert do Prisma) na tarefa #3884 do patinhas, e o GitOrch escalou ao dono
// via Telegram — "se o gitorch me entrega decisões técnicas, eu mesmo faria".

export interface DuvidaTecnicaViaRaOptions {
  /** O que o dev perguntou, na íntegra. */
  pergunta: string
  repository: string
  /** Número da tarefa que o dev está executando, para dar contexto. */
  issueNumber: number
  /** Por que o QA não conseguiu responder — vai no prompt do RA, não é enfeite. */
  motivoDaEscalada: string
  execute: StepExecutor
  contextBlocks: string[]
}

export interface DuvidaTecnicaViaRaResult {
  destino: DestinoDaDuvida
  /** Pronto para `responderSessaoJules` — só existe quando o destino é o dev. */
  mensagemParaODev: string | null
  /**
   * A resposta do RA, quando útil — vira aprendizado (memoria-do-jules,
   * origem 'resposta-tecnica') para o QA responder sozinho da próxima vez que
   * o mesmo tema aparecer. Nulo quando o RA também não soube.
   */
  aprendizadoParaGravar: string | null
}

interface FormularioDaDuvida {
  precisaDoDono: boolean
  resposta: string
}

/**
 * O RA tenta a dúvida técnica que o QA não conseguiu responder.
 *
 * Reusa `RAILS_SCHEMAS.devQuestion` (o mesmo formulário do QA) — o campo
 * `precisaDoDono` é ignorado aqui de propósito: já sabemos que não é decisão
 * de negócio, foi assim que a dúvida chegou até o RA.
 */
export async function runDuvidaTecnicaViaRa(
  options: DuvidaTecnicaViaRaOptions
): Promise<DuvidaTecnicaViaRaResult> {
  const formulario = (await runFormStep({
    schema: RAILS_SCHEMAS.devQuestion,
    prompt: buildStepPrompt('ra', 'ra-duvida-tecnica', RAILS_SCHEMAS.devQuestion, [
      ...options.contextBlocks,
      `O QA já tentou responder a dúvida técnica do dev assíncrono na tarefa ` +
        `#${options.issueNumber} de ${options.repository} e não conseguiu (${options.motivoDaEscalada}). ` +
        'Você é o RA: tem mais tempo e deve ir mais fundo no repositório (o resumo do codegraph ' +
        'está no contexto acima) antes de decidir que ninguém sabe.',
      '',
      options.pergunta,
      '',
      'Responda citando arquivo/função/símbolo real, lido do codegraph acima — nunca invente. ' +
        'Se depois de examinar o codegraph você genuinamente não souber, diga isso claramente em ' +
        '`resposta` (a pergunta sobe para o dono). Ignore o campo precisaDoDono — já sabemos que ' +
        'isto não é decisão de negócio.',
    ]),
    execute: options.execute,
  })) as FormularioDaDuvida

  const destino = destinoAposRa(formulario.resposta)
  if (destino.tipo !== 'responder-o-dev') {
    return { destino, mensagemParaODev: null, aprendizadoParaGravar: null }
  }
  return {
    destino,
    mensagemParaODev: textoDaRespostaAoDev(destino.resposta),
    aprendizadoParaGravar: destino.resposta,
  }
}
