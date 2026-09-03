// D63/L4-T2 — "o dono não quer o Jules consertando o robô do Jules": quando o
// achado é de AUTOMAÇÃO do cliente (ou o Dependabot travado), o produto não
// abre incidente P0 delegável. Abre uma PROPOSTA: uma issue rotulada
// `gitorch:proposal` que PERGUNTA (deletar/reajustar/manter/escrever) em vez
// de PEDIR trabalho. `services/decisao-de-automacao.ts` cuida da pergunta em
// si e do que a resposta do dono faz depois.
//
// Idempotente pelo MARCADOR no corpo (mesmo padrão de `gitorch:incident:` em
// `reconciliar-incidentes-legados.ts`): nunca duplica a proposta na mesma
// varredura nem na próxima.

import { GithubExecutionError } from './github-errors.js'
import { nomeDeRepositorioValido } from './nome-de-repositorio.js'
import { marcador } from './marcador-de-issue.js'
import { ghJson, headersGithub } from './github-json.js'

/** O label que toda proposta carrega — NUNCA `jules`, NUNCA P0..P3. */
export const LABEL_PROPOSTA = 'gitorch:proposal'

/** O marcador (HTML comment) que identifica a proposta desta identidade no
 *  corpo da issue — é o que torna `criarProposta` idempotente. */
export function marcadorDaProposta(identidade: string): string {
  return `gitorch:proposta:${identidade}`
}

/** A2/R1: tipo do segundo marcador estruturado — carrega o CAMINHO do
 *  arquivo do workflow, a origem confiável que `processarRespostaDeAutomacao`
 *  (decisao-de-automacao.ts) lê de volta para o "deletar" via `lerMarcador`
 *  (NUNCA o `context` da pergunta, que é texto do dono). */
export const TIPO_MARCADOR_ARQUIVO = 'proposta:arquivo'

/** Texto do título, exatamente como o dono pediu. */
export function tituloDaPropostaDeAutomacao(nome: string, arquivo: string, desde: string): string {
  return `Proposta: workflow "${nome}" (${arquivo}) falha desde ${desde} — deletar, reajustar ou manter?`
}

export interface CorpoDaPropostaArgs {
  nome: string
  arquivo: string
  gatilho: string
  desde: string
  /** O que o workflow faz, deduzido do `name`/`on:` do YAML (frase curta). */
  resumo: string
  /** Link da run que falhou, quando disponível. */
  urlDaRun?: string
}

/** Corpo no padrão da casa: `##` por seção, sem forçar o achado no molde de
 *  DoD (`renderIssueBody`) — a proposta não pede trabalho, pede decisão. */
export function corpoDaPropostaDeAutomacao(args: CorpoDaPropostaArgs): string {
  const linkDaRun = args.urlDaRun ? `\n\nRun: ${args.urlDaRun}` : ''
  return [
    // A2/R1: marcador ESTRUTURADO do caminho do arquivo — a única origem que
    // `processarRespostaDeAutomacao` pode confiar para o "deletar" (nunca o
    // `context` da pergunta, que é texto do dono).
    marcador(TIPO_MARCADOR_ARQUIVO, args.arquivo),
    `## Goal`,
    `\n\nO workflow "${args.nome}" (${args.arquivo}) ${args.resumo} e falha desde ${args.desde}. ` +
      `Isto é automação (bot de Dependabot/Jules/auto-merge/...), não CI do cliente — o GitOrch não abre ` +
      `incidente delegável para o dev assíncrono sozinho: quem decide o que fazer é o dono.${linkDaRun}`,
    `## Notes`,
    `\n\nGatilho (\`on:\`): ${args.gatilho}. Responda a pergunta que o GitOrch mandou para decidir.`,
    `## Related Files`,
    `\n\n- ${args.arquivo}`,
    `## Decisão do dono: pendente`,
    `\n\nEsta issue fecha sozinha quando o dono responder (deletar, reajustar ou manter).`,
  ].join('\n\n')
}

export interface CriarPropostaArgs {
  repo: string
  identidade: string
  titulo: string
  corpo: string
  origem: 'incidente-automacao' | 'retrospectiva'
}

export interface CriarPropostaDeps {
  /** `fetch` JÁ GUARDADO com o nível de autonomia do projeto
   *  (`fetchDoRepositorio`) — nunca um `fetch` cru. Em "só olhar" a criação
   *  é RECUSADA pela guarda (`EscritaNaoAutorizadaError`), e o chamador loga
   *  o motivo; esta função nunca engole essa recusa. */
  fetchImpl: typeof fetch
  token: string
  /** Best-effort — reaproveita `anexarIssueDeIncidenteAoQuadro` (scheduler). */
  anexarAoQuadro?: (args: { issueNodeId: string; issueNumber: number }) => Promise<void>
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

interface IssueDeBusca {
  number: number
  body?: string | null
}

interface IssueCriada {
  number?: number
  node_id?: string
}

/** C2: teto de páginas ao buscar issues abertas com `LABEL_PROPOSTA` —
 *  `per_page=100`, para de pedir a próxima assim que uma página vier com
 *  menos de 100 (a última). Protege contra um repo patológico. */
const MAX_PAGINAS_DE_BUSCA_DE_PROPOSTAS = 10
const PER_PAGE_DE_BUSCA_DE_PROPOSTAS = 100

/**
 * Cria (ou acha, idempotente) a proposta ao dono para `identidade`. Devolve o
 * número da issue — nova ou já existente. NUNCA `jules`, NUNCA P0..P3: só
 * `LABEL_PROPOSTA`.
 */
export async function criarProposta(
  args: CriarPropostaArgs,
  deps: CriarPropostaDeps
): Promise<number> {
  // S1: `repo` vai colado numa URL que carrega o token — mesmo padrão de
  // `desejo-no-github.ts`: recusa ANTES de montar qualquer URL/tocar rede.
  if (!nomeDeRepositorioValido(args.repo)) {
    throw new GithubExecutionError(
      `proposta: repositório em formato inválido, não é "dono/repositorio": ${JSON.stringify(args.repo).slice(0, 80)}`
    )
  }

  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const marcadorTexto = marcador('proposta', args.identidade)

  // 1. Idempotência: uma proposta ABERTA para esta identidade já existe?
  //    C2: pagina — uma página cheia (100) pode esconder a proposta antiga
  //    numa página seguinte; para assim que uma página vier incompleta.
  let existentes: IssueDeBusca[] = []
  for (let pagina = 1; pagina <= MAX_PAGINAS_DE_BUSCA_DE_PROPOSTAS; pagina++) {
    const lote = await ghJson<IssueDeBusca[]>(
      deps.fetchImpl,
      deps.token,
      'GET',
      `https://api.github.com/repos/${args.repo}/issues?labels=${encodeURIComponent(LABEL_PROPOSTA)}&state=open&per_page=${PER_PAGE_DE_BUSCA_DE_PROPOSTAS}&page=${pagina}`
    )
    const pedaco = Array.isArray(lote) ? lote : []
    existentes = existentes.concat(pedaco)
    if (pedaco.length < PER_PAGE_DE_BUSCA_DE_PROPOSTAS) break
  }
  const jaExiste = existentes.find((i) => (i.body ?? '').includes(marcadorTexto))
  if (jaExiste) {
    info(`proposta: já existe #${jaExiste.number} para ${args.identidade} — não duplica`)
    return jaExiste.number
  }

  // 2. Garante a label (cor e descrição deliberadas, em PT-BR — não a
  //    aleatória que o GitHub daria criando "na mão" via /issues).
  //    422 = já existe. Best-effort: a issue nasce mesmo se isto falhar —
  //    por isso não usa `ghJson` (que lançaria em qualquer !ok).
  const labelResp = await deps.fetchImpl(`https://api.github.com/repos/${args.repo}/labels`, {
    method: 'POST',
    headers: headersGithub(deps.token, true),
    body: JSON.stringify({
      name: LABEL_PROPOSTA,
      color: '5319e7',
      description: 'Proposta ao dono — decisão pendente, nunca uma tarefa delegável',
    }),
  })
  if (!labelResp.ok && labelResp.status !== 422) {
    warn(`proposta: não criei a label ${LABEL_PROPOSTA} em ${args.repo} (${labelResp.status})`)
  }

  // 3. Cria a issue — marcador PRIMEIRO (mesmo padrão de `renderIssueBody`).
  const corpo = `${marcadorTexto}\n\n${args.corpo}`
  const issue = await ghJson<IssueCriada>(
    deps.fetchImpl,
    deps.token,
    'POST',
    `https://api.github.com/repos/${args.repo}/issues`,
    { title: args.titulo, body: corpo, labels: [LABEL_PROPOSTA] }
  )
  if (!issue.number) throw new GithubExecutionError(`proposta criada em ${args.repo} sem número`)

  if (issue.node_id && deps.anexarAoQuadro) {
    const nodeId = issue.node_id
    const numero = issue.number
    await deps
      .anexarAoQuadro({ issueNodeId: nodeId, issueNumber: numero })
      .catch((err) =>
        warn(
          `proposta: não anexei #${numero} de ${args.repo} ao quadro (${String(err).slice(0, 120)})`
        )
      )
  }

  info(`proposta: criada #${issue.number} para ${args.identidade} (${args.origem})`)
  return issue.number
}
