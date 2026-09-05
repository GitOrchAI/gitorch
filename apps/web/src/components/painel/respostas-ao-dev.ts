// D69 (02/09) — respostas que o time deu ao DEV em nome do dono, quando o
// QA/RA resolveu uma dúvida técnica sozinho sem nunca escalar (nenhuma dúvida
// de agente nasce nesse caminho — ver services/duvida-do-dev.ts, control-plane).
// A lógica fica fora do React (mesmo padrão de agent-questions.ts): fetch
// defensivo, nunca lança.
//
// LACUNA REAL, e por isso o campo `lacuna` vem do PRÓPRIO servidor
// (control-plane/routes/painel.ts, LACUNA_RESPOSTAS_AO_DEV) — o front nunca
// inventa esse texto, só o exibe: o produto não guarda o texto exato enviado
// ao dev, só um resumo aprendido.

export interface RespostaAoDevView {
  id: string
  /** O repositório (wingId), quando o projeto ainda existe. */
  projeto: string | null
  issueNumber: number | null
  /** ISO. */
  quando: string
  /** O resumo aprendido — nunca o texto literal enviado ao dev (o produto não guarda isso). */
  resumo: string
  /** ISO de quando o dono corrigiu esta resposta, ou `null` se nunca corrigiu. */
  corrigidoEm: string | null
}

export interface RespostasAoDevResultado {
  itens: RespostaAoDevView[]
  /** A lacuna, escrita pelo servidor — nunca vazia no caminho feliz real. */
  lacuna: string
}

export interface FetchRespostasAoDevDeps {
  fetchImpl?: typeof fetch
}

const VAZIO: RespostasAoDevResultado = { itens: [], lacuna: '' }

/**
 * Busca GET /api/v1/painel/respostas-ao-dev. NUNCA lança: sessão ausente,
 * backend fora, rede caída ou um corpo fora do shape esperado sempre viram
 * `{ itens: [], lacuna: '' }` — a seção some da tela, nunca quebra o painel
 * inteiro por causa disto (mesmo contrato de fetchAgentQuestions).
 */
export async function fetchRespostasAoDev(
  apiBaseUrl: string,
  deps: FetchRespostasAoDevDeps = {}
): Promise<RespostasAoDevResultado> {
  const doFetch = deps.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${apiBaseUrl}/api/v1/painel/respostas-ao-dev`, {
      credentials: 'include',
    })
    if (!res.ok) return VAZIO
    const json = await res.json().catch(() => null)
    return parseRespostasAoDev(json)
  } catch {
    return VAZIO
  }
}

// Anti-fachada: qualquer corpo que não seja `{ itens: [...], lacuna: '...' }`
// vira o resultado vazio, em vez de espalhar `undefined` mais adiante no render.
function parseRespostasAoDev(json: unknown): RespostasAoDevResultado {
  if (!json || typeof json !== 'object') return VAZIO
  const body = json as { itens?: unknown; lacuna?: unknown }
  const itens = Array.isArray(body.itens)
    ? body.itens.map(toItemView).filter((i): i is RespostaAoDevView => i !== null)
    : []
  const lacuna = typeof body.lacuna === 'string' ? body.lacuna : ''
  return { itens, lacuna }
}

// Um item torto (sem id/resumo/quando) é descartado em vez de derrubar a
// lista inteira — o resto continua aparecendo.
function toItemView(raw: unknown): RespostaAoDevView | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.resumo !== 'string' || typeof r.quando !== 'string') {
    return null
  }
  return {
    id: r.id,
    projeto: typeof r.projeto === 'string' ? r.projeto : null,
    issueNumber: typeof r.issueNumber === 'number' ? r.issueNumber : null,
    quando: r.quando,
    resumo: r.resumo,
    corrigidoEm: typeof r.corrigidoEm === 'string' ? r.corrigidoEm : null,
  }
}
