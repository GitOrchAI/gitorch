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

/** O label que toda proposta carrega — NUNCA `jules`, NUNCA P0..P3. */
export const LABEL_PROPOSTA = 'gitorch:proposal'

/** O marcador (HTML comment) que identifica a proposta desta identidade no
 *  corpo da issue — é o que torna `criarProposta` idempotente. */
export function marcadorDaProposta(identidade: string): string {
  return `gitorch:proposta:${identidade}`
}

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

/**
 * Cria (ou acha, idempotente) a proposta ao dono para `identidade`. Devolve o
 * número da issue — nova ou já existente. NUNCA `jules`, NUNCA P0..P3: só
 * `LABEL_PROPOSTA`.
 */
export async function criarProposta(
  args: CriarPropostaArgs,
  deps: CriarPropostaDeps
): Promise<number> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const headers = {
    authorization: `token ${deps.token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'gitorch',
  }
  const marcador = marcadorDaProposta(args.identidade)

  // 1. Idempotência: uma proposta ABERTA para esta identidade já existe?
  const buscaResp = await deps.fetchImpl(
    `https://api.github.com/repos/${args.repo}/issues?labels=${encodeURIComponent(LABEL_PROPOSTA)}&state=open&per_page=100`,
    { headers }
  )
  if (!buscaResp.ok) {
    throw new Error(`GET issues (proposta) /repos/${args.repo} → ${buscaResp.status}`)
  }
  const existentes = (await buscaResp.json()) as IssueDeBusca[]
  const jaExiste = (Array.isArray(existentes) ? existentes : []).find((i) =>
    (i.body ?? '').includes(marcador)
  )
  if (jaExiste) {
    info(`proposta: já existe #${jaExiste.number} para ${args.identidade} — não duplica`)
    return jaExiste.number
  }

  // 2. Garante a label (cor e descrição deliberadas, em PT-BR — não a
  //    aleatória que o GitHub daria criando "na mão" via /issues).
  //    422 = já existe. Best-effort: a issue nasce mesmo se isto falhar.
  const labelResp = await deps.fetchImpl(`https://api.github.com/repos/${args.repo}/labels`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
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
  const corpo = `<!-- ${marcador} -->\n\n${args.corpo}`
  const criaResp = await deps.fetchImpl(`https://api.github.com/repos/${args.repo}/issues`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ title: args.titulo, body: corpo, labels: [LABEL_PROPOSTA] }),
  })
  if (!criaResp.ok) {
    const detail = await criaResp.text().catch(() => '')
    throw new Error(
      `POST /repos/${args.repo}/issues (proposta) → ${criaResp.status}: ${detail.slice(0, 150)}`
    )
  }
  const issue = (await criaResp.json()) as IssueCriada
  if (!issue.number) throw new Error(`proposta criada em ${args.repo} sem número`)

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
