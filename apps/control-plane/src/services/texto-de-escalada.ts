import {
  LACUNA_SEM_SPRINT_CONFIGURADA,
  LACUNA_SEM_CICLO_CORRENTE,
  LACUNA_FALHA_AO_LER_CICLO,
  LACUNA_SEM_OBJETIVO_LEGIVEL,
  LACUNA_SEM_DECISAO_REGISTRADA,
  LACUNA_FALHA_AO_LER_DECISOES,
  type ContextoExecutivoDaPergunta,
} from './contexto-executivo-da-pergunta.js'

/**
 * A pergunta EXECUTIVA de RESERVA (PT-BR, determinística, sempre com 3
 * opções objetivas) para escalar uma dúvida do dev assíncrono ao dono,
 * quando nem o modelo (QA) nem o RA deixaram uma tradução executiva pronta
 * (`perguntaExecutivaPtBr`/`opcoesPtBr`).
 *
 * D72 (02/09) — SUBSTITUI a versão anterior (`textoDeEscaladaParaODono`),
 * que encaminhava a MENSAGEM CRUA do dev (em inglês) ao dono, com um único
 * botão "Outro". O dono flagrou ao vivo, com print do painel/Telegram:
 * "O dev assíncrono está parado na tarefa #309 de GitOrchAI/gitorch
 * esperando uma decisão sua. Pergunta original do dev: 'I have successfully
 * modified the code...'" — nas palavras dele: "não são perguntas
 * formuladas ... não são três opções ... não é pra fazer isso para dúvidas
 * técnicas, seja executivo".
 *
 * D73/L4-T23 (04/09) — a PRÓPRIA reserva executiva que D72 criou foi
 * recusada de novo: "O dev está travado numa dúvida técnica na tarefa #3716
 * de loureng/patinhas-3d-crafts e nem o RA conseguiu resolver. O que
 * fazer?" chegou ao dono, que recusou responder. Nas palavras dele: a
 * pergunta do desenvolvedor não importa — importa a LÓGICA: o que é a
 * sprint, o que é a tarefa em geral, o que QA/PO/RA já ajustaram sozinhos, e
 * qual é a decisão que resta, em termos de negócio.
 *
 * A partir de D73, a reserva CONTA A HISTÓRIA — sempre nesta ordem: o ciclo
 * corrente e o período; o que a tarefa entrega; o que o time já resolveu
 * sozinho; a decisão de negócio que resta. As 4 peças vêm de
 * `ContextoExecutivoDaPergunta` (contexto-executivo-da-pergunta.ts) — quem
 * não pôde ser reunido vira uma frase de LACUNA no lugar da peça, nunca um
 * dado inventado. O texto NUNCA usa "dev"/"desenvolvedor"/"técnica", nome de
 * arquivo, de função ou de motor — e nunca cita a pergunta original do dev
 * (continuação da garantia de D72).
 */

export interface OpcaoDeReserva {
  label: string
  value: string
}

/**
 * As 3 opções — MESMOS `value`s internos de sempre (D72): quem já trata
 * `pausar`/`seguir-suposicao-ra`/`pedir-pr` rio abaixo (`retomar-sessao-
 * com-resposta.ts` casa só pelo `value`, nunca pelo `label`) continua
 * funcionando sem mudança nenhuma.
 *
 * D73: os LABELS mudam de vocabulário de PROCESSO para escolha de NEGÓCIO —
 * o que um CEO reconhece sem ler uma linha de código:
 *   - `pausar`               : "Pausar a tarefa e revisar depois" (processo)
 *                             → "Pausar esta tarefa até eu decidir com calma"
 *                               (a MESMA pausa, na primeira pessoa de quem decide)
 *   - `seguir-suposicao-ra`  : "Seguir com a melhor suposição do RA mesmo
 *                               assim" (cita um papel interno, "RA")
 *                             → "Seguir com a melhor decisão da equipe por
 *                               agora" (o mesmo "seguir o palpite informado",
 *                               sem o jargão do papel)
 *   - `pedir-pr`             : "Pedir ao dev que abra o PR com o que tem"
 *                               (cita "dev" e "PR", ambos técnicos)
 *                             → "Entregar o que já está pronto para revisão"
 *                               (o mesmo "fechar o que existe e mandar para
 *                               revisão", sem "dev"/"PR")
 *
 * A 4ª opção ("Outro / respondo por texto") é sempre adicionada por quem
 * chama `ask()` (`buildFreeTextOption`, telegram-bot.ts) — nunca duplicada
 * aqui.
 */
export const OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA: OpcaoDeReserva[] = [
  { label: 'Pausar esta tarefa até eu decidir com calma', value: 'pausar' },
  { label: 'Seguir com a melhor decisão da equipe por agora', value: 'seguir-suposicao-ra' },
  { label: 'Entregar o que já está pronto para revisão', value: 'pedir-pr' },
]

export interface PerguntaExecutivaDeReserva {
  text: string
  options: OpcaoDeReserva[]
}

const LACUNAS_DE_CICLO = new Set([
  LACUNA_SEM_SPRINT_CONFIGURADA,
  LACUNA_SEM_CICLO_CORRENTE,
  LACUNA_FALHA_AO_LER_CICLO,
])
const LACUNAS_DE_ENTREGA = new Set([LACUNA_SEM_OBJETIVO_LEGIVEL])
const LACUNAS_DE_DECISAO = new Set([LACUNA_SEM_DECISAO_REGISTRADA, LACUNA_FALHA_AO_LER_DECISOES])

function capitalizar(frase: string): string {
  return frase.length === 0 ? frase : frase.charAt(0).toUpperCase() + frase.slice(1)
}

function garantirPontoFinal(frase: string): string {
  return /[.!?…]$/.test(frase) ? frase : `${frase}.`
}

function tirarPontoFinal(frase: string): string {
  return frase.replace(/[.!?…]+$/, '')
}

function acharLacuna(lacunas: readonly string[], candidatas: ReadonlySet<string>): string | null {
  return lacunas.find((l) => candidatas.has(l)) ?? null
}

/** 1ª parte: o ciclo corrente e o período. */
function fraseDoCiclo(contexto: ContextoExecutivoDaPergunta): string {
  if (contexto.ciclo) return `O time está no ciclo "${contexto.ciclo}".`
  const lacuna = acharLacuna(contexto.lacunas, LACUNAS_DE_CICLO)
  return `${capitalizar(lacuna ?? 'não foi possível confirmar o ciclo atual')}.`
}

/** 2ª parte: o que a tarefa entrega, em uma frase. */
function fraseDaEntrega(contexto: ContextoExecutivoDaPergunta): string {
  if (contexto.entrega) return `Esta tarefa entrega: ${garantirPontoFinal(contexto.entrega)}`
  const lacuna = acharLacuna(contexto.lacunas, LACUNAS_DE_ENTREGA)
  return `${capitalizar(lacuna ?? 'não foi possível confirmar o que esta tarefa entrega')}.`
}

/** 3ª parte: o que o time já resolveu sozinho. */
function fraseDasDecisoes(contexto: ContextoExecutivoDaPergunta): string {
  if (contexto.decisoes.length > 0) {
    const lista = contexto.decisoes.map(tirarPontoFinal).join('; ')
    return `A equipe já resolveu sozinha: ${lista}.`
  }
  const lacuna = acharLacuna(contexto.lacunas, LACUNAS_DE_DECISAO)
  return `${capitalizar(lacuna ?? 'não há decisões anteriores registradas para esta tarefa')}.`
}

/** 4ª parte: a decisão que resta, sempre presente — nunca uma lacuna. */
function fraseDaDecisaoQueResta(issueNumber: number, repository: string): string {
  return (
    `Falta uma decisão de negócio: como você quer seguir com a tarefa #${issueNumber} de ` +
    `${repository}?`
  )
}

/**
 * Monta a pergunta executiva de reserva. NUNCA recebe (nem cita) a pergunta
 * original do dev — é texto determinístico, sempre em português, sempre com
 * as mesmas 3 opções, montado a partir de `contexto` (nunca inventado — ver
 * `ContextoExecutivoDaPergunta.lacunas`).
 */
export function perguntaExecutivaDeReserva(args: {
  issueNumber: number
  repository: string
  contexto: ContextoExecutivoDaPergunta
}): PerguntaExecutivaDeReserva {
  const text = [
    fraseDoCiclo(args.contexto),
    fraseDaEntrega(args.contexto),
    fraseDasDecisoes(args.contexto),
    fraseDaDecisaoQueResta(args.issueNumber, args.repository),
  ].join('\n\n')

  return { text, options: OPCOES_DE_RESERVA_DE_DUVIDA_TECNICA }
}
