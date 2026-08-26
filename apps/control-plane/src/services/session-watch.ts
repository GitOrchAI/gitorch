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
import { decidirRespostaDaSessao, MAX_NUDGES } from './jules-session-loop.js'
import {
  decidirSobreAPergunta,
  marcarDesistencia,
  marcarTentativa,
} from './pergunta-sem-resposta.js'

/**
 * Cadência mínima entre dois exames da MESMA sessão. Sem ela, cada tick do
 * scheduler reexaminaria toda sessão viva, gastando chamada ao serviço
 * externo (e, para pergunta repetida, quase disparando missão de novo) sem
 * que nada tivesse mudado desde a última olhada.
 */
export const CADENCIA_DE_EXAME_MS = 10 * 60 * 1000

/**
 * O estado da entrega que já produziu pull request e espera julgamento.
 *
 * O dev externo devolve `COMPLETED` tanto para a sessão que entregou um pull
 * request quanto para a que terminou sem produzir nada — quem olha o quadro vê
 * as duas iguais. Este estado separa as duas, porque o dono pediu para saber em
 * que pé está cada entrega, e "concluída" sem dizer o quê não responde isso.
 */
export const ESTADO_AGUARDANDO_QA = 'PR_ENTREGUE_AGUARDANDO_QA'

/**
 * Quantas vezes reentregar um pedido de retrabalho antes de desistir e chamar
 * gente. Sem teto, um serviço fora do ar viraria laço infinito contra a API do
 * cliente; com teto, o silêncio tem prazo e alguém fica sabendo.
 */
export const MAX_TENTATIVAS_DE_AVISO = 5

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
  /** Reentrega o pedido de retrabalho que ficou pendente. */
  reentregarAviso?: (args: { sessionName: string; texto: string }) => Promise<boolean>
  /** Apaga a pendência quando o recado finalmente chega. */
  limparAvisoPendente?: (args: { sessionName: string }) => Promise<void>
  /** Conta mais uma tentativa fracassada. */
  contarTentativaDeAviso?: (args: { sessionName: string }) => Promise<void>
  fecharSessao: (args: {
    sessionName: string
    motivo: MotivoDeFechamento
    agora: Date
  }) => Promise<void>
  /**
   * Grava que já avisamos o dono sobre este estado de falha ('investigar'),
   * para não repetir o aviso a cada ciclo enquanto a sessão continua parada
   * no mesmo estado. NÃO mexe em `nudges` — ver `registrarInvestigacao` em
   * dev-session-store.ts para o porquê.
   */
  registrarInvestigacao: (args: { sessionName: string; hash: string; agora: Date }) => Promise<void>
  /** Avisa o dono quando a sessão é abandonada por teto estourado, ou quando
   *  a falha entra em 'investigar' pela primeira vez (ver o ramo abaixo). */
  avisarDono?: (mensagem: string) => Promise<void>
  agora: Date
  onWarn?: (m: string) => void
}

/**
 * Hash determinístico e curto de uma string, para comparar "já vi isto?" sem
 * guardar o texto inteiro.
 *
 * Exportado porque `qa-rails-mission.ts` (achado 2 da revisão da Tarefa 7)
 * reaproveita esta MESMA função para a idempotência do aviso de verificação
 * parada — mesma disciplina do ramo `investigar` logo abaixo ("SPAM apaga
 * sinal tanto quanto silêncio"), aplicada a um sinal diferente (commit
 * parado, não estado de sessão). Duas funções de hash locais divergiriam
 * cedo ou tarde; uma só, reaproveitada, não.
 */
export function hashDaMensagem(mensagem: string): string {
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
  let avisosReentregues = 0

  for (const linha of deps.sessoes) {
    // Cadência por sessão: pula quem foi examinada há menos de 10 minutos.
    if (linha.stateCheckedAt) {
      const desdeOUltimoExame = deps.agora.getTime() - linha.stateCheckedAt.getTime()
      if (desdeOUltimoExame < CADENCIA_DE_EXAME_MS) continue
    }

    // ANTES de qualquer outra decisão desta sessão: se ficou um pedido de
    // retrabalho sem entregar, ele vem primeiro. Enquanto o dev não recebe o
    // recado, nada mais que a gente decida sobre esta entrega faz sentido —
    // ela está parada esperando exatamente isso.
    if (linha.reworkNoticePending && deps.reentregarAviso) {
      // ACHADO 1 DA LENTE: o teto tem que ser medido em TEMPO, não em número de
      // passagens. `stateCheckedAt` só avança quando o exame da sessão dá certo
      // — e num erro de rede ele NÃO dá. Sem carimbar aqui, a reentrega roda a
      // cada tique (1 min) e cinco tentativas queimam em cinco minutos: o
      // apagão de oito minutos que motivou esta feature esgotaria o teto e
      // apagaria o recado ANTES de o serviço voltar. Carimbamos em todo
      // desfecho deste ramo, para a próxima tentativa respeitar a cadência.
      const carimbarCadencia = async () => {
        await deps
          .registrarEstado({
            sessionName: linha.sessionName,
            estado: linha.state,
            agora: deps.agora,
          })
          .catch(() => undefined)
      }

      if (linha.reworkNoticeAttempts >= MAX_TENTATIVAS_DE_AVISO) {
        // ACHADO 2: o recado só sai do banco se alguém FOI de fato avisado.
        // Apagar sem avisar destruiria justamente a evidência que esta feature
        // veio preservar — o defeito original de volta, e pior.
        let donoAvisado = false
        if (deps.avisarDono) {
          donoAvisado = await deps
            .avisarDono(
              // Escrito para GENTE, não para máquina. O identificador da
              // sessão fica no log (quem depura precisa dele) e FORA daqui
              // (quem decide, não). O recado nomeia o trabalho pelo número que
              // aparece no quadro e diz a AÇÃO — sem isso vira só um alarme.
              `GitOrch: pedi ${MAX_TENTATIVAS_DE_AVISO} vezes para o dev refazer a tarefa ` +
                `#${linha.issueNumber} e o recado não chegou.` +
                (linha.pullRequestNumber
                  ? ` O que ele precisa mudar está escrito no pull request #${linha.pullRequestNumber}.`
                  : '') +
                ' Ele não vai refazer sozinho: alguém precisa avisá-lo à mão, ou a entrega fica parada.'
            )
            .then(() => true)
            .catch(() => false)
        }
        if (donoAvisado && deps.limparAvisoPendente) {
          await deps.limparAvisoPendente({ sessionName: linha.sessionName }).catch(() => undefined)
          warn(
            `[vigia] desisti de reentregar o pedido de retrabalho de ${linha.sessionName} ` +
              `após ${MAX_TENTATIVAS_DE_AVISO} tentativas; dono avisado`
          )
        } else {
          warn(
            `[vigia] teto de reentrega estourado em ${linha.sessionName} e NÃO consegui avisar o dono; ` +
              'o pedido de retrabalho fica guardado — apagar sem avisar seria perder a evidência'
          )
        }
        await carimbarCadencia()
        continue
      }

      const entregue = await deps
        .reentregarAviso({ sessionName: linha.sessionName, texto: linha.reworkNoticePending })
        .catch(() => false)

      if (entregue) {
        let limpou = false
        if (deps.limparAvisoPendente) {
          limpou = await deps
            .limparAvisoPendente({ sessionName: linha.sessionName })
            .then(() => true)
            .catch(() => false)
        }
        if (limpou) {
          avisosReentregues += 1
        } else if (deps.contarTentativaDeAviso) {
          // ACHADO 3: entregou mas não conseguiu apagar a marca. Sem contar
          // aqui, uma escrita que falha de forma persistente reenviaria o mesmo
          // texto ao dev a cada passagem, para sempre, sem teto nenhum.
          warn(
            `[vigia] reentreguei o pedido de retrabalho de ${linha.sessionName} mas não consegui ` +
              'apagar a marca; contando a tentativa para não reenviar sem fim'
          )
          await deps
            .contarTentativaDeAviso({ sessionName: linha.sessionName })
            .catch(() => undefined)
        }
      } else if (deps.contarTentativaDeAviso) {
        await deps.contarTentativaDeAviso({ sessionName: linha.sessionName }).catch(() => undefined)
      }
      await carimbarCadencia()
      // Segue o exame normal da sessão no MESMO ciclo: reentregar o recado não
      // substitui olhar o estado dela.
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

      // REGISTRA O QUE VIU, ANTES de decidir o que fazer.
      //
      // Cada ramo carimbava por conta própria, e bastava um esquecer para a
      // linha congelar no banco. Foi o que aconteceu com `responder`: quando a
      // pergunta é a MESMA de antes, ele sai por um `break` sem registrar — e
      // como `registrarEstado` é quem move `stateCheckedAt`, a sessão ficava
      // parada para sempre no último estado conhecido.
      //
      // Medido em 25/08: seis sessões que o dev externo dava como
      // AWAITING_USER_FEEDBACK estavam gravadas aqui como IN_PROGRESS, com o
      // relógio de exame parado havia NOVE HORAS, enquanto as outras vinte
      // tinham sido examinadas havia sete minutos. Seis das quinze vagas do
      // plano presas assim — e vaga presa é delegação recusada.
      //
      // O ramo `aprovar-plano` já tinha levado esse mesmo remédio (commit
      // 0193bd8, ramo `investigar`), duas vezes, cada uma depois de o defeito
      // aparecer em produção. Registrar ANTES do `switch` mata a classe
      // inteira: nenhum ramo novo pode esquecer o que não precisa lembrar.
      await deps.registrarEstado({
        sessionName: linha.sessionName,
        estado: estadoBruto,
        agora: deps.agora,
        ...(progrediu ? { progrediu: true } : {}),
      })

      switch (decisao.acao) {
        case 'aguardar': {
          // Já registrado acima.
          break
        }

        case 'aprovar-plano': {
          const ok = await deps.aprovarPlano(linha.sessionName)
          if (ok) {
            aprovacoes += 1
          } else {
            warn(`[vigia] não foi possível aprovar o plano de ${linha.sessionName}`)
          }
          // O exame já foi marcado antes do `switch`, aprovando ou não.
          break
        }

        case 'responder': {
          const hash = hashDaMensagem(ultimaMensagem)
          // TUDO sai da marca: o que aconteceu, com qual pergunta, e quantas
          // vezes se tentou ESTA. Nenhum contador emprestado de outro ramo —
          // era assim antes, e o orçamento de uma pergunta acabava consumido
          // por uma sessão travada sem relação nenhuma, fazendo o produto
          // avisar o dono de "três tentativas" que nunca aconteceram.
          const decisao = decidirSobreAPergunta({ hashDaPergunta: hash, marca: linha.answeredHash })

          if (decisao.acao === 'nada') break

          if (decisao.acao === 'desistir') {
            // Uma vez só. A marca carrega a pergunta dentro, então o ciclo
            // seguinte reconhece "já desisti DESTA" em vez de achar que é
            // pergunta nova — que era a oscilação que queimava motor para
            // sempre e repetia o aviso a cada dois ciclos.
            await deps.registrarResposta({
              sessionName: linha.sessionName,
              hashDaPergunta: marcarDesistencia(hash, decisao.tentativas),
              agora: deps.agora,
            })
            await deps.avisarDono?.(
              `GitOrch: o dev perguntou algo na entrega da tarefa #${linha.issueNumber} e eu ` +
                `tentei responder ${decisao.tentativas} vezes sem conseguir. O trabalho está ` +
                `parado esperando essa resposta.`
            )
            break
          }

          // Marca a TENTATIVA com o número desta pergunta. Quem responde de
          // verdade é a missão de QA (ela roda com o motor e o repositório em
          // mãos) e é ela que grava a marca de RESPONDIDA quando a mensagem
          // chega ao dev — a diferença entre "tentei" e "respondi" é o que
          // impede tanto o silêncio eterno quanto a rajada.
          await deps.registrarResposta({
            sessionName: linha.sessionName,
            hashDaPergunta: marcarTentativa(hash, decisao.tentativa),
            agora: deps.agora,
          })
          await deps.dispararMissao('qa', linha.projectId)
          respondidas += 1
          break
        }

        case 'investigar': {
          // O sm-watchdog aposentado lia os comentários de falha do próprio
          // dev ("Jules has failed...") e, depois de 3 ocorrências, travava
          // a issue e avisava o dono. Essa via saiu porque era inerte para a
          // fila — mas o alarme foi junto, e o workflow que serviria de rede
          // (jules-apology-handler.yml) está morto por falta do
          // SECURITY_PAT. Sem este aviso, uma sessão que falha
          // explicitamente aciona o SM para investigar, mas se a
          // investigação não resolver, ninguém é avisado — o trabalho fica
          // parado em silêncio.
          //
          // Idempotência por estado, no mesmo espírito do hash de pergunta
          // já respondida (ver `responder` acima): sem ela, uma sessão presa
          // em FAILED geraria um aviso a CADA ciclo em que a vigia a
          // reexamina, porque o SM continua sendo acionado todo ciclo
          // (decisão D5) — e SPAM apaga sinal tanto quanto silêncio.
          const hashDoEstado = hashDaMensagem(`investigar:${estadoBruto}`)
          const jaAvisado = hashDoEstado === linha.answeredHash
          if (!jaAvisado) {
            await deps.registrarInvestigacao({
              sessionName: linha.sessionName,
              hash: hashDoEstado,
              agora: deps.agora,
            })
            if (deps.avisarDono) {
              await deps
                .avisarDono(
                  `GitOrch: a sessão da issue #${linha.issueNumber} (${linha.sessionName}) chegou ` +
                    `ao estado ${estadoBruto} sem entregar PR. O SM foi acionado para investigar ` +
                    `o impedimento.`
                )
                .catch(() => undefined)
            }
          }
          // O exame já foi marcado antes do `switch`. Sem isso, uma sessão
          // presa em FAILED seria reexaminada a cada tique em vez de a cada
          // dez minutos, acionando o SM sessenta vezes por hora e queimando a
          // cota do motor do cliente. O `registrarInvestigacao` acima não
          // serve para isso: ele só grava o hash, e só na primeira vez.
          //
          // "falhou? manda continuar" — ordem do dono, 25/08. Acionar o SM
          // para investigar não destrava a sessão: ela continua parada lá,
          // ocupando uma das quinze vagas do plano, e vaga presa é delegação
          // recusada. Medido no mesmo dia: seis sessões falhadas vivas sem
          // ninguém pedir retomada.
          //
          // O pedido é uma MENSAGEM, não uma chamada de "continuar": esse
          // endpoint não existe na API do dev externo (sempre respondeu 404) e
          // há um teste no repositório que impede alguém de recriá-lo.
          //
          // Com o MESMO teto do ramo `insistir`, e pelo mesmo motivo: pedir
          // sem parar a uma sessão que não sai do lugar queima cota e enche o
          // dev de mensagem. Passado o teto, quem decide é o abandono.
          if (linha.nudges < MAX_NUDGES) {
            const pediu = await deps.pedirParaContinuar(linha.sessionName)
            // Conta a tentativa nos DOIS casos, sucesso ou falha de envio: o
            // teto mede quantas vezes TENTAMOS, não quantas chegaram. Contar
            // só o sucesso faria uma falha persistente de rede girar para
            // sempre sem nunca alcançar o teto — o mesmo padrão de falha
            // silenciosa que este arquivo já corrigiu três vezes.
            await deps.registrarResposta({
              sessionName: linha.sessionName,
              hashDaPergunta: linha.answeredHash ?? '',
              agora: deps.agora,
            })
            if (!pediu) {
              warn(`[vigia] não foi possível pedir retomada a ${linha.sessionName}`)
            }
          }

          // Regra D5 do dono: o SM investiga o impedimento. Isso não muda —
          // o aviso acima é ADICIONAL, nunca substitui o SM.
          await deps.dispararMissao('sm', linha.projectId)
          investigacoes += 1
          break
        }

        case 'julgar': {
          // PEDIR JULGAMENTO SÓ QUANDO ALGO MUDOU.
          //
          // Este ramo pedia julgamento a cada exame — dez em dez minutos, para
          // toda sessão viva com pull request, até a publicação ser
          // confirmada. Como a entrega já julgada continua viva até lá, o
          // pedido se repetia para sempre. Medido em 23/08/2026: das 48
          // acordadas de julgamento vindas da vigília naquele dia, as 48
          // voltaram vazias, e o motivo era sempre o mesmo — "no delegated PR
          // awaiting judgment", 140 vezes em dois dias.
          //
          // O descanso pós-acordada-vazia não estava quebrado: ele disparou 73
          // vezes no mesmo dia, exatamente como desenhado. Ele segurava o que
          // foi feito para segurar. O que ninguém tinha atacado era a raiz —
          // PERGUNTAR sem saber se há resposta.
          //
          // POR QUE ISTO NÃO DEIXA ENTREGA SEM PARECER, que seria um desfecho
          // muito pior: o pedido não some, só para de se repetir sem motivo. O
          // primeiro avistamento do pull request continua pedindo, um pull
          // request NOVO na mesma sessão continua pedindo, e continuam
          // existindo três outros caminhos independentes que acordam o
          // julgamento quando algo de fato acontece — o aviso do GitHub
          // (verificação concluída), a fila que o SM levanta, e a agenda
          // própria do QA.
          const ehPrNovo =
            consulta.numeroDoPr !== null && linha.pullRequestNumber !== consulta.numeroDoPr

          if (ehPrNovo) {
            await deps.registrarPr({
              sessionName: linha.sessionName,
              numeroDoPr: consulta.numeroDoPr!,
              agora: deps.agora,
            })
            prsCapturados += 1
            // "PR entregue e aguardando QA" — ordem do dono, 25/08: "Se o Dev
            // assincrono entregar o PR é ajustado para PR entregue e aguardando
            // QA entao o QA é acordado".
            //
            // O estado que o dev externo devolve é COMPLETED, e ele não
            // distingue a entrega que produziu pull request da que não
            // produziu nada. Quem olha o quadro via as duas iguais, e o dono
            // pediu para saber em que pé está cada entrega. O carimbo de cima
            // gravaria o COMPLETED cru; aqui ele é substituído pelo estado que
            // conta a verdade do momento.
            await deps.registrarEstado({
              sessionName: linha.sessionName,
              estado: ESTADO_AGUARDANDO_QA,
              agora: deps.agora,
            })
            // A linha só fecha na publicação — Fase 3.
            await deps.dispararMissao('qa', linha.projectId)
            break
          }

          // Nada novo. O exame já foi carimbado antes do `switch` — sem isso,
          // esta sessão seria reexaminada a cada tique do relógio em vez de a
          // cada dez minutos.
          break
        }

        case 'insistir': {
          const ok = await deps.pedirParaContinuar(linha.sessionName)
          // Conta a tentativa e marca o exame nos DOIS casos — sucesso ou
          // falha de envio. Antes, uma falha de envio não chamava
          // `registrarResposta`: `stateCheckedAt` não avançava (a sessão
          // seria reexaminada a cada tick, sessenta vezes por hora em vez
          // de seis) E `nudges` — o teto que decide abandono — ficava
          // parado. `nudges` mede "quantas vezes TENTAMOS pedir para
          // continuar", não "quantas vezes o pedido chegou": uma falha de
          // envio persistente (rede fora do ar, por exemplo) girava em
          // 'insistir' para sempre, sem jamais alcançar MAX_NUDGES nem
          // avisar o dono — o mesmo padrão de falha silenciosa que esta
          // branch já corrigiu duas vezes. Não há pergunta para marcar como
          // respondida aqui — reaproveita `registrarResposta` só pelo
          // efeito de contar a insistência e mover `stateCheckedAt`,
          // preservando o hash já guardado (string vazia quando nunca
          // houve um).
          await deps.registrarResposta({
            sessionName: linha.sessionName,
            hashDaPergunta: linha.answeredHash ?? '',
            agora: deps.agora,
          })
          if (ok) {
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
  if (avisosReentregues > 0)
    partes.push(
      pluralizar(
        avisosReentregues,
        'pedido de retrabalho reentregue',
        'pedidos de retrabalho reentregues'
      )
    )

  const resumo = partes.length > 0 ? partes.join(', ') : 'nada novo'
  return `vigia: ${pluralizar(deps.sessoes.length, 'sessão', 'sessões')}, ${resumo}.`
}
