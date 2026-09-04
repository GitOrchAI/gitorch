import { sprintCorrente, type Iteracao } from './garantir-sprint.js'
import { lerSecaoDaIssue } from './secao-da-issue.js'
import { PREFIXO_DUVIDA_DEV } from './dedup-key-de-duvida.js'

/**
 * L4-T23 (04/09) — o dono recusou a pergunta de reserva ("O dev está
 * travado numa dúvida técnica na tarefa #3716 de loureng/patinhas-3d-crafts
 * e nem o RA conseguiu resolver. O que fazer?"): não quer saber da dúvida do
 * dev, quer a LÓGICA — o ciclo corrente, o que a tarefa entrega, o que QA/
 * PO/RA já resolveram sozinhos — e só então a decisão de negócio que sobra.
 *
 * Este módulo reúne essas 4 peças a partir de 3 fontes que já existem no
 * produto e nunca tinham sido lidas JUNTAS para uma pergunta ao dono:
 *   - o ciclo corrente do quadro (`garantir-sprint.ts`/`project-v2-client.ts`
 *     — só id/título/início/duração, NUNCA um objetivo de sprint: o recado
 *     de status que o produto escreve não é lido de volta, D73);
 *   - o que a tarefa entrega (a seção "## Goal" do corpo da issue,
 *     `secao-da-issue.ts` — o único texto de negócio garantido é
 *     `usableOutcome`, mas esse é por FASE, não por tarefa; a issue confia
 *     no que o modelo escreveu em "Goal");
 *   - as decisões que o próprio dono já tomou nesta MESMA tarefa (agent
 *     questions `answered` com dedupKey `duvida-dev:<repo>:<issue>:*` —
 *     `dedup-key-de-duvida.ts`). NÃO existe registro do raciocínio de RA/QA
 *     em si (`duvida-rails-mission.ts` é só chamada de modelo, sem
 *     persistência) — a única trilha durável é a resposta anterior do dono.
 *
 * Contrato central, MESMA disciplina do resto do produto ("configuração é
 * indício, teste é prova" + "nunca mascarar"): cada peça é injetada (mesmo
 * padrão de `ClienteDeQuadro`/`PrismaLike` em `garantir-sprint.ts`/
 * `agent-question.ts`) e NUNCA lança — uma fonte que falha vira uma frase em
 * `lacunas`, nunca um dado inventado nem uma exceção que derruba a pergunta
 * inteira (a pergunta TEM de nascer, mesmo incompleta).
 */

/** As 4 peças que compõem a história executiva de uma pergunta ao dono. */
export interface ContextoExecutivoDaPergunta {
  /** Título e período do ciclo corrente, ex.: "Sprint 4 (01/09 a 04/09)".
   *  `null` = não deu para determinar (ver `lacunas`). */
  ciclo: string | null
  /** O que a tarefa entrega, em uma frase (a seção "## Goal" da issue).
   *  `null` = não deu para ler (ver `lacunas`). */
  entrega: string | null
  /** O que o time (o próprio dono, em respostas anteriores) já decidiu
   *  sozinho sobre ESTA tarefa — uma frase por decisão, no máximo
   *  `MAXIMO_DE_DECISOES`. Lista vazia = nenhuma decisão anterior. */
  decisoes: string[]
  /** O que não pôde ser reunido, em português natural, para entrar no texto
   *  da pergunta em vez de um silêncio ou de um dado inventado. */
  lacunas: string[]
}

export const LACUNA_SEM_SPRINT_CONFIGURADA = 'este projeto ainda não tem uma sprint configurada'
export const LACUNA_SEM_CICLO_CORRENTE =
  'o ciclo configurado neste quadro não está em andamento hoje'
export const LACUNA_FALHA_AO_LER_CICLO =
  'não foi possível confirmar o ciclo configurado neste quadro'
export const LACUNA_SEM_OBJETIVO_LEGIVEL = 'não foi possível ler o objetivo desta tarefa'
export const LACUNA_SEM_DECISAO_REGISTRADA =
  'a equipe ainda não tinha registrado nenhuma decisão sobre esta tarefa'
export const LACUNA_FALHA_AO_LER_DECISOES =
  'não foi possível ler as decisões anteriores desta tarefa'

/**
 * Um contexto totalmente vazio — as 3 peças (ciclo/entrega/decisões) são
 * lacuna, nada inventado. Uso: quem escala uma dúvida sem ter (ou sem valer
 * a pena montar) acesso a quadro/issue/histórico — hoje só a reconciliação
 * histórica (`reconciliar-duvidas-escaladas.ts`, migração pontual das 24
 * sessões presas de 02/09, não o caminho vivo de escalada).
 */
export function contextoExecutivoVazio(): ContextoExecutivoDaPergunta {
  return {
    ciclo: null,
    entrega: null,
    decisoes: [],
    lacunas: [
      LACUNA_SEM_SPRINT_CONFIGURADA,
      LACUNA_SEM_OBJETIVO_LEGIVEL,
      LACUNA_SEM_DECISAO_REGISTRADA,
    ],
  }
}

/** Só o que este módulo usa do `ClienteDeQuadro` (garantir-sprint.ts) —
 *  permite injetar um fake nos testes, mesmo padrão do resto do produto. */
export interface ClienteDeQuadroParaContexto {
  getIterationField(input: {
    projectId: string
    fieldName: string
  }): Promise<{ fieldId: string; iterations: Iteracao[] }>
}

export interface AgentQuestionAnteriorParaContexto {
  answer: string | null
}

/** Só o que este módulo usa do Prisma — permite injetar um fake nos testes,
 *  nunca banco real (mesmo padrão de `agent-question.ts`/PrismaLike). */
export interface PrismaParaContextoExecutivo {
  agentQuestion: {
    findMany: (args: unknown) => Promise<AgentQuestionAnteriorParaContexto[]>
  }
}

export interface DepsDoContextoExecutivo {
  /** `undefined` = projeto sem quadro de GitHub Projects V2 vinculado (ou
   *  quem chama decidiu não buscar). */
  clienteDeQuadro?: ClienteDeQuadroParaContexto
  /** O node id do quadro (GitHub Projects V2) — exigido junto de
   *  `clienteDeQuadro` para o ciclo ser lido. */
  quadroId?: string
  /** Busca o corpo bruto da issue no GitHub. `null` = não deu para ler (sem
   *  credencial, issue apagada, etc.) — nunca lança por si (mas esta função
   *  trata mesmo que lance). */
  buscarCorpoDaIssue: () => Promise<string | null>
  prisma: PrismaParaContextoExecutivo
  /** Data base (YYYY-MM-DD) para achar o ciclo corrente. Padrão: hoje (UTC). */
  hoje?: string
  /** Nome do campo de iteração no quadro. Padrão: `CAMPO_DE_SPRINT` (garantir-sprint.ts). */
  nomeDoCampoDeSprint?: string
}

export interface ArgsDoContextoExecutivo {
  /** O projeto no NOSSO banco — escopa a busca de decisões anteriores. */
  projectId: string
  /** "dono/nome" do repositório no GitHub. */
  repository: string
  issueNumber: number
}

const TETO_DO_CICLO = 120
const TETO_DA_ENTREGA = 220
const TETO_DA_DECISAO = 180
const MAXIMO_DE_DECISOES = 3
const NOME_PADRAO_DO_CAMPO_DE_SPRINT = 'Sprint'

/**
 * Monta a história executiva de uma pergunta ao dono. NUNCA lança — cada
 * fonte roda isolada; a que falhar vira lacuna, e a função sempre resolve.
 */
export async function montarContextoExecutivoDaPergunta(
  args: ArgsDoContextoExecutivo,
  deps: DepsDoContextoExecutivo
): Promise<ContextoExecutivoDaPergunta> {
  const lacunas: string[] = []

  const ciclo = await lerCicloCorrente(deps, lacunas)
  const entrega = await lerEntrega(deps, lacunas)
  const decisoes = await lerDecisoesAnteriores(args, deps, lacunas)

  return { ciclo, entrega, decisoes, lacunas }
}

async function lerCicloCorrente(
  deps: DepsDoContextoExecutivo,
  lacunas: string[]
): Promise<string | null> {
  if (!deps.clienteDeQuadro || !deps.quadroId) {
    lacunas.push(LACUNA_SEM_SPRINT_CONFIGURADA)
    return null
  }
  try {
    const campo = await deps.clienteDeQuadro.getIterationField({
      projectId: deps.quadroId,
      fieldName: deps.nomeDoCampoDeSprint ?? NOME_PADRAO_DO_CAMPO_DE_SPRINT,
    })
    const hoje = deps.hoje ?? new Date().toISOString().slice(0, 10)
    const atual = sprintCorrente(campo.iterations, hoje)
    if (!atual) {
      lacunas.push(LACUNA_SEM_CICLO_CORRENTE)
      return null
    }
    return sanitizar(`${atual.title} (${formatarPeriodo(atual)})`, TETO_DO_CICLO)
  } catch {
    // Rede, GraphQL, token sem autorização — nunca deixa a pergunta inteira
    // cair por causa do quadro estar inacessível.
    lacunas.push(LACUNA_FALHA_AO_LER_CICLO)
    return null
  }
}

async function lerEntrega(
  deps: DepsDoContextoExecutivo,
  lacunas: string[]
): Promise<string | null> {
  try {
    const corpo = await deps.buscarCorpoDaIssue()
    const goal = lerSecaoDaIssue(corpo, 'Goal')
    if (!goal) {
      lacunas.push(LACUNA_SEM_OBJETIVO_LEGIVEL)
      return null
    }
    return sanitizar(primeiraFrase(goal), TETO_DA_ENTREGA)
  } catch {
    lacunas.push(LACUNA_SEM_OBJETIVO_LEGIVEL)
    return null
  }
}

async function lerDecisoesAnteriores(
  args: ArgsDoContextoExecutivo,
  deps: DepsDoContextoExecutivo,
  lacunas: string[]
): Promise<string[]> {
  try {
    const prefixo = `${PREFIXO_DUVIDA_DEV}${args.repository}:${args.issueNumber}:`
    const anteriores = await deps.prisma.agentQuestion.findMany({
      where: { projectId: args.projectId, status: 'answered', dedupKey: { startsWith: prefixo } },
      orderBy: { createdAt: 'asc' },
    })
    const decisoes = anteriores
      .map((q) => (q.answer ?? '').trim())
      .filter((texto) => texto.length > 0)
      .slice(0, MAXIMO_DE_DECISOES)
      .map((texto) => sanitizar(texto, TETO_DA_DECISAO))
    if (decisoes.length === 0) {
      lacunas.push(LACUNA_SEM_DECISAO_REGISTRADA)
    }
    return decisoes
  } catch {
    // Banco fora do ar não pode derrubar a pergunta — a decisão anterior é
    // só UMA das 4 peças da história.
    lacunas.push(LACUNA_FALHA_AO_LER_DECISOES)
    return []
  }
}

/**
 * Tira caracteres de controle (quebra de linha inclusive) e colapsa espaço —
 * texto de terceiro (corpo de issue escrito pelo modelo, resposta anterior
 * do dono) não pode quebrar o layout de uma mensagem de uma frase por peça.
 * Corta no teto com reticências em vez de estourar o tamanho da pergunta.
 */
function sanitizar(texto: string, teto: number): string {
  const regexDeControle = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g')
  const semControle = texto.replace(regexDeControle, ' ').replace(/\s+/g, ' ').trim()
  if (semControle.length <= teto) return semControle
  return `${semControle.slice(0, Math.max(0, teto - 1)).trim()}…`
}

/** A primeira frase de um texto livre (corta na 1ª pontuação de fim de frase). */
function primeiraFrase(texto: string): string {
  const limpo = texto.replace(/\s+/g, ' ').trim()
  const casado = limpo.match(/^[^.!?\n]+[.!?]?/)
  return (casado ? casado[0] : limpo).trim()
}

function formatarPeriodo(it: Iteracao): string {
  const inicio = new Date(`${it.startDate}T00:00:00Z`)
  const fim = new Date(inicio.getTime() + it.duration * 86400000)
  return `${formatarData(inicio)} a ${formatarData(fim)}`
}

function formatarData(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(d)
}
