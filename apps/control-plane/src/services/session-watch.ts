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
import { decidirSessaoTerminal } from './sessao-terminal.js'
import { ehMarcaDeEscalada } from './pergunta-sem-resposta.js'

/**
 * A pergunta do Jules (AWAITING_USER_FEEDBACK) já foi respondida e mesmo assim
 * a sessão ficou parada por este tempo → a resposta não destravou; fecha e a
 * issue volta para a fila (D52).
 */
export const HORAS_ATE_TIMEOUT_PERGUNTA_MS = 24 * 60 * 60 * 1000

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
  registrarPr: (args: {
    sessionName: string
    numeroDoPr: number
    agora: Date
    /** L4-T1: liga o PR ao incidente de infra aberto por esta issue, se houver. */
    projectId?: string
    issueNumber?: number
  }) => Promise<void>
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
   * A 2ª falha da mesma issue pede a análise de "por que" antes da 3ª tentativa
   * (D51). A vigia só DETECTA e chama — a missão real é do scheduler (T4).
   * Opcional: sem ele, a issue ainda volta para a fila (o motivo redelega).
   */
  pedirAnalise?: (args: { linha: LinhaDeSessao }) => Promise<void>
  /**
   * Grava que já avisamos o dono sobre este estado de falha ('investigar'),
   * para não repetir o aviso a cada ciclo enquanto a sessão continua parada
   * no mesmo estado. NÃO mexe em `nudges` — ver `registrarInvestigacao` em
   * dev-session-store.ts para o porquê.
   */
  registrarInvestigacao: (args: { sessionName: string; hash: string; agora: Date }) => Promise<void>
  /**
   * Avisa o dono quando a sessão é abandonada por teto estourado, ou quando
   * a falha entra em 'investigar' pela primeira vez (ver o ramo abaixo).
   *
   * fix/telegram-notifier-propaga-falha: `Promise<boolean>` (não `Promise<void>`
   * como as outras cópias da família `avisarDono`) porque o ramo de reentrega
   * de aviso (abaixo) precisa saber de verdade se a entrega chegou — ler o
   * retorno é o único jeito, já que `buildTelegramNotifier` nunca rejeita.
   */
  avisarDono?: (mensagem: string) => Promise<boolean>
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
  let fechadasTerminal = 0
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
          donoAvisado = await deps.avisarDono(
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
          // PRAZO DA PERGUNTA (D52): se a pergunta JÁ foi respondida (há
          // `answeredHash`) e mesmo assim a sessão está parada em
          // AWAITING_USER_FEEDBACK há mais de 24h, o Jules não vai andar — a
          // resposta não destravou. Fecha e a issue volta para a fila (D51).
          //
          // L4-T3: `escalada:` NÃO conta como respondida — é o oposto:
          // ninguém respondeu ainda, a pergunta está na mesa do DONO (subiu
          // de verdade como agent_question, dedupKey `duvida-dev:*`) e é a
          // resposta dele que retoma a sessão (`retomar-sessao-com-
          // resposta.ts`). Fechar aqui diria "a dúvida já foi respondida" —
          // mentira. O que fazer quando o prazo vence com o dono ainda
          // calado é a L4-T4 (D64, ramo logo abaixo).
          // C5 (fix-up 3): `ehMarcaDeEscalada` (pergunta-sem-resposta.ts) e'
          // a fonte UNICA desta checagem, ao inves de um `startsWith('escalada:')`
          // proprio deste arquivo (sessao-abandonada.ts fazia a MESMA checagem
          // solta, e uma marca truncada passaria como escalada de verdade em
          // qualquer um dos dois sem o outro saber).
          const escalada = ehMarcaDeEscalada(linha.answeredHash)
          const jaRespondida = Boolean(linha.answeredHash) && !escalada
          if (jaRespondida && paradoHaMs >= HORAS_ATE_TIMEOUT_PERGUNTA_MS) {
            await deps.fecharSessao({
              sessionName: linha.sessionName,
              motivo: 'pergunta-sem-resposta',
              agora: deps.agora,
            })
            fechadasTerminal += 1
            if (deps.avisarDono) {
              await deps
                .avisarDono(
                  `GitOrch: a issue #${linha.issueNumber} ficou 24h parada esperando o dev depois ` +
                    'de a dúvida já ter sido respondida. Fechei a sessão — a esteira vai tentar de novo.'
                )
                .catch(() => undefined)
            }
            break
          }

          // L4-T4 (D64), fix-up task a13a42f8-2953-4259-b41f-3f8cddb304cd: a
          // dúvida foi ESCALADA ao dono (subiu de verdade como
          // agent_question) e ele pode ter ficado 24h em silêncio — ou não,
          // ainda dentro do prazo. A vigia NÃO decide mais isso sozinha:
          // ela só acorda o QA, exatamente como faz para qualquer outra
          // pergunta pendente, um parágrafo abaixo. Quem decide "esperar" x
          // "supor" é `suporDuvidaPendente` (scheduler.ts), irmã de
          // `responderDuvidaPendente`, rodando DENTRO da MESMA missão de QA
          // — porque o único `execute: StepExecutor` real do produto nasce
          // dentro de `executeMissionWithFailover`, e esta função roda por
          // um `setInterval` próprio (`varrerSessoesDoDev`), fora de
          // qualquer missão. Antes desta correção, `deps.suporSemODono` era
          // um hook OPCIONAL que a produção nunca fornecia (não tinha como:
          // não existe `execute` aqui) — todo tique caía sempre no "sem
          // suposição concreta", que é exatamente o defeito que esta task
          // corrige.
          //
          // A vigia AINDA sabe que a pergunta está escalada (linha acima) —
          // é o que a impede de fechar a sessão dizendo "já foi respondida"
          // (mentira, ver comentário no topo deste `case`). O resto —
          // idempotência do aviso, formar a suposição, entregar, comentar na
          // issue, marcar assumida — mora inteiro em `suporDuvidaPendente`.

          // A vigília DETECTA e chama quem responde. Ela não conta tentativa
          // nem avisa o dono: quem faz isso é o caminho que de fato age (a
          // missão de QA, em `responderDuvidaPendente`). Enquanto os dois
          // marcavam, o teto de uma pergunta era consumido em dobro — duas
          // marcas por tentativa real — e a pergunta era abandonada na metade
          // do caminho. Uma coisa, um dono.
          await deps.dispararMissao('qa', linha.projectId)
          respondidas += 1
          break
        }

        case 'fechar-terminal': {
          // O Jules terminou (COMPLETED sem PR, ou FAILED/CANCELLED) e não vai
          // andar sozinho. Até 29/08 isto ia para 'investigar', que acionava o
          // SM em loop e NUNCA fechava a linha — 21 de 23 sessões presas assim.
          //
          // COM PR: a vigia não tem token de GitHub para saber se mesclou, foi
          // descartado ou está reprovado — deixa para o ciclo terminal do
          // scheduler (`varrerCicloTerminalDaSessao`, T2), que tem. Aqui só o
          // caso SEM PR, que é decidível sem rede.
          if (consulta.numeroDoPr !== null) {
            // Já registrado antes do switch — o scheduler pega no próximo ciclo.
            break
          }
          const decisaoTerminal = decidirSessaoTerminal({
            estado: estadoBruto,
            situacaoDoPr: 'sem-pr',
            requeueCount: linha.requeueCount ?? 0,
            analiseJaFeita: (linha.analysisDoneAt ?? null) !== null,
            horasNoTerminal: paradoHaMs / (60 * 60 * 1000),
          })
          if (decisaoTerminal.acao === 'manter') break
          await deps.fecharSessao({
            sessionName: linha.sessionName,
            motivo: decisaoTerminal.acao === 'fechar-concluido' ? 'merged' : decisaoTerminal.motivo,
            agora: deps.agora,
          })
          fechadasTerminal += 1
          if (decisaoTerminal.acao === 'fechar-e-analisar' && deps.pedirAnalise) {
            await deps.pedirAnalise({ linha }).catch(() => undefined)
          }
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
              projectId: linha.projectId,
              issueNumber: linha.issueNumber,
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
  if (fechadasTerminal > 0)
    partes.push(pluralizar(fechadasTerminal, 'sessão encerrada', 'sessões encerradas'))
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
