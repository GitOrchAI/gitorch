// Fase 2 da esteira que fecha o ciclo: olha cada sessão VIVA do dev
// assíncrono e age — sem isso, a Fase 1 só guarda a ligação issue↔sessão↔PR e
// ninguém nunca a lê de volta. Criar sessão sem acompanhar é falar sem ouvir.
//
// Tudo aqui chega por injeção: nada de prisma, fetch ou env dentro desta
// função. É isso que torna a vigia testável sem rede e sem banco — e é o que
// impede que ela vire, sem querer, mais um lugar decidindo sozinha se chama o
// motor. Quem decide a AÇÃO é `decidirRespostaDaSessao` (pura); quem EXECUTA
// e fecha o ciclo é este módulo, por injeção.
//
// `responder` (papel QA) e `investigar` (papel SM) NUNCA chamam o motor
// direto: elas passam por `dispararMissao`, que é o `triggerAgentMission` do
// scheduler — o único portão que aplica o limite de concorrência, o
// orçamento diário por plano e a guarda de gasto. Uma chamada solta aqui
// furaria as três e poderia estourar a cota do motor do cliente sem tarifar.

import { createHash } from 'node:crypto'
import type { LinhaDeSessao, MotivoDeFechamento } from './dev-session-store.js'
import { decidirRespostaDaSessao } from './jules-session-loop.js'

/**
 * Cadência mínima entre dois exames da MESMA sessão. Sem ela, cada tick do
 * scheduler reexaminaria toda sessão viva, gastando chamada ao serviço
 * externo (e, para pergunta repetida, quase disparando missão de novo) sem
 * que nada tivesse mudado desde a última olhada.
 */
export const CADENCIA_DE_EXAME_MS = 10 * 60 * 1000

export interface EstadoLido {
  estado: string
  numeroDoPr: number | null
  ultimaAtualizacao: string | null
}

export interface VigiaDeps {
  sessoes: LinhaDeSessao[]
  /** Lê o estado no serviço externo. Devolve null quando não deu para ler. */
  consultarSessao: (sessionName: string) => Promise<EstadoLido | null>
  /** Última mensagem do dev naquela sessão (para decidir e para o hash de idempotência). */
  ultimaMensagem: (sessionName: string) => Promise<string>
  aprovarPlano: (sessionName: string) => Promise<boolean>
  pedirParaContinuar: (sessionName: string) => Promise<boolean>
  /** Cria missão de verdade para o papel. NUNCA chamar motor direto. */
  dispararMissao: (papel: 'qa' | 'sm', projectId: string) => Promise<void>
  registrarEstado: (args: {
    sessionName: string
    estado: string
    agora: Date
    progrediu?: boolean
  }) => Promise<void>
  registrarResposta: (args: {
    sessionName: string
    hashDaPergunta: string
    agora: Date
  }) => Promise<void>
  registrarPr: (args: { sessionName: string; numeroDoPr: number; agora: Date }) => Promise<void>
  fecharSessao: (args: {
    sessionName: string
    motivo: MotivoDeFechamento
    agora: Date
  }) => Promise<void>
  /** Avisa o dono quando a sessão é abandonada por teto estourado. */
  avisarDono?: (mensagem: string) => Promise<void>
  agora: Date
  onWarn?: (m: string) => void
}

/** Hash determinístico e curto da mensagem, só para comparar "é a mesma pergunta?". */
function hashDaMensagem(mensagem: string): string {
  return createHash('sha256').update(mensagem).digest('hex').slice(0, 16)
}

function pluralizar(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`
}

/**
 * Examina cada sessão viva e age conforme `decidirRespostaDaSessao`.
 *
 * Escopada, não global: sem sessão viva, zero chamada ao serviço externo —
 * `deps.sessoes` já vem filtrado por projeto (`sessoesVivas`), então esta
 * função nunca precisa saber de "todos os projetos".
 *
 * Falha numa sessão nunca contamina as outras: cada sessão roda no seu
 * try/catch, com aviso acionável, e o laço segue para a próxima.
 */
export async function vigiarSessoes(deps: VigiaDeps): Promise<string> {
  const warn = deps.onWarn ?? (() => undefined)

  if (deps.sessoes.length === 0) {
    return 'vigia: nenhuma sessão viva.'
  }

  let respondidas = 0
  let prsCapturados = 0
  let investigacoes = 0
  let aprovacoes = 0
  let insistidas = 0
  let abandonadas = 0
  let falhas = 0

  for (const linha of deps.sessoes) {
    // Cadência por sessão: pula quem foi examinada há menos de 10 minutos.
    if (linha.stateCheckedAt) {
      const desdeOUltimoExame = deps.agora.getTime() - linha.stateCheckedAt.getTime()
      if (desdeOUltimoExame < CADENCIA_DE_EXAME_MS) continue
    }

    try {
      const consulta = await deps.consultarSessao(linha.sessionName)
      if (!consulta) {
        warn(
          `[vigia] não foi possível ler o estado de ${linha.sessionName}; tenta no próximo ciclo`
        )
        continue
      }

      const estadoBruto = consulta.estado
      const estadoNormalizado = estadoBruto.toUpperCase()

      const progrediu = Boolean(
        consulta.ultimaAtualizacao &&
        (!linha.lastProgressAt ||
          new Date(consulta.ultimaAtualizacao).getTime() > linha.lastProgressAt.getTime())
      )
      const paradoHaMs = linha.lastProgressAt
        ? deps.agora.getTime() - linha.lastProgressAt.getTime()
        : Number.POSITIVE_INFINITY

      // Só busca a mensagem quando ela de fato entra na decisão — o resto dos
      // estados nem olha para `ultimaMensagem`, e é uma chamada de rede a mais.
      const ultimaMensagem =
        estadoNormalizado === 'AWAITING_USER_FEEDBACK'
          ? await deps.ultimaMensagem(linha.sessionName)
          : ''

      const decisao = decidirRespostaDaSessao({
        estado: estadoBruto,
        ultimaMensagem,
        // Título e corpo reais não entram aqui de propósito: o texto que
        // `decidirRespostaDaSessao` monta para o motor (`contextoParaOMotor`)
        // não é usado por esta função — quem responde de verdade é a missão
        // de QA disparada via `dispararMissao`, que busca o contexto da issue
        // pela via que já usa hoje. Buscar título/corpo aqui só para descartar
        // seria uma chamada de rede a mais sem efeito nenhum na decisão: ela
        // depende só de estado, PR, tempo parado e nudges.
        contextoDaTask: { issueNumber: linha.issueNumber, tituloDaIssue: '', corpoDaIssue: '' },
        temPr: consulta.numeroDoPr !== null,
        paradoHaMs,
        nudges: linha.nudges,
      })

      switch (decisao.acao) {
        case 'aguardar': {
          await deps.registrarEstado({
            sessionName: linha.sessionName,
            estado: estadoBruto,
            agora: deps.agora,
            ...(progrediu ? { progrediu: true } : {}),
          })
          break
        }

        case 'aprovar-plano': {
          const ok = await deps.aprovarPlano(linha.sessionName)
          if (ok) {
            aprovacoes += 1
          } else {
            warn(`[vigia] não foi possível aprovar o plano de ${linha.sessionName}`)
          }
          break
        }

        case 'responder': {
          const hash = hashDaMensagem(ultimaMensagem)
          if (hash === linha.answeredHash) {
            // Mesma pergunta de antes: a sessão pode levar mais de um ciclo
            // para sair de AWAITING_USER_FEEDBACK depois de receber a
            // resposta. Disparar de novo gastaria motor à toa.
            break
          }
          await deps.registrarResposta({
            sessionName: linha.sessionName,
            hashDaPergunta: hash,
            agora: deps.agora,
          })
          await deps.dispararMissao('qa', linha.projectId)
          respondidas += 1
          break
        }

        case 'investigar': {
          await deps.dispararMissao('sm', linha.projectId)
          investigacoes += 1
          break
        }

        case 'julgar': {
          // `temPr` já garantiu `consulta.numeroDoPr !== null` para chegar
          // aqui; o guard é só para o TypeScript, não muda o caminho.
          if (consulta.numeroDoPr !== null) {
            await deps.registrarPr({
              sessionName: linha.sessionName,
              numeroDoPr: consulta.numeroDoPr,
              agora: deps.agora,
            })
            prsCapturados += 1
          }
          // O QA julga a entrega. A linha só fecha no merge — Fase 3.
          await deps.dispararMissao('qa', linha.projectId)
          break
        }

        case 'insistir': {
          const ok = await deps.pedirParaContinuar(linha.sessionName)
          if (ok) {
            // Não há pergunta para marcar como respondida aqui — reaproveita
            // `registrarResposta` só pelo efeito de contar a insistência
            // (nudges) e mover `stateCheckedAt`, preservando o hash já
            // guardado (string vazia quando nunca houve um).
            await deps.registrarResposta({
              sessionName: linha.sessionName,
              hashDaPergunta: linha.answeredHash ?? '',
              agora: deps.agora,
            })
            insistidas += 1
          } else {
            warn(`[vigia] não foi possível pedir para ${linha.sessionName} continuar`)
          }
          break
        }

        case 'abandonar': {
          await deps.fecharSessao({
            sessionName: linha.sessionName,
            motivo: 'abandoned',
            agora: deps.agora,
          })
          abandonadas += 1
          if (deps.avisarDono) {
            await deps
              .avisarDono(
                `GitOrch: a sessão da issue #${linha.issueNumber} (${linha.sessionName}) foi ` +
                  `abandonada depois de ${linha.nudges} tentativa(s) de retomada sem sucesso.`
              )
              .catch(() => undefined)
          }
          break
        }
      }
    } catch (err) {
      falhas += 1
      warn(`[vigia] falha ao processar ${linha.sessionName}: ${(err as Error).message}`)
    }
  }

  const partes: string[] = []
  if (respondidas > 0) partes.push(pluralizar(respondidas, 'respondida', 'respondidas'))
  if (prsCapturados > 0)
    partes.push(`${pluralizar(prsCapturados, 'PR capturado', 'PRs capturados')}`)
  if (investigacoes > 0) partes.push(pluralizar(investigacoes, 'investigação', 'investigações'))
  if (aprovacoes > 0) partes.push(pluralizar(aprovacoes, 'plano aprovado', 'planos aprovados'))
  if (insistidas > 0) partes.push(pluralizar(insistidas, 'insistência', 'insistências'))
  if (abandonadas > 0) partes.push(pluralizar(abandonadas, 'abandonada', 'abandonadas'))
  if (falhas > 0) partes.push(pluralizar(falhas, 'falha', 'falhas'))

  const resumo = partes.length > 0 ? partes.join(', ') : 'nada novo'
  return `vigia: ${pluralizar(deps.sessoes.length, 'sessão', 'sessões')}, ${resumo}.`
}
