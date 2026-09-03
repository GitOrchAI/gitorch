// D63/D71 (L4-T2) — a metade "human-in-the-loop" da proposta
// (`services/proposta.ts`): pergunta ao dono o que fazer com uma automação
// que falhou, e executa a decisão quando ela chega.
//
// D71: toda pergunta ao dono é 3 opções objetivas + "Vou escrever" — nunca
// texto solto sem botão.

import { normalizarNivel } from '@gitorch/cadence'
import { LABEL_PROPOSTA } from './proposta.js'

/** Prefixo do dedupKey de toda pergunta de decisão de automação. */
export const DEDUP_PREFIXO_AUTOMACAO = 'automacao:'

export interface OpcaoDeDecisao {
  label: string
  value: string
}

/** D71: 3 opções objetivas + "Vou escrever" — nesta ordem, sempre. */
export const OPCOES_DE_DECISAO_DE_AUTOMACAO: OpcaoDeDecisao[] = [
  { label: 'Deletar o workflow', value: 'deletar' },
  { label: 'Reajustar (vira tarefa)', value: 'reajustar' },
  { label: 'Manter como está', value: 'manter' },
  { label: 'Vou escrever', value: 'escrever' },
]

/**
 * `automacao:<repo>:<identidade>`. A identidade (`wf:<id>`) já carrega um
 * `:` — o parse (`parseDedupKeyDeAutomacao`) corta só no PRIMEIRO `:` depois
 * do repo, nunca faz `split(':')` ingênuo.
 */
export function dedupKeyDeAutomacao(repo: string, identidade: string): string {
  return `${DEDUP_PREFIXO_AUTOMACAO}${repo}:${identidade}`
}

export function parseDedupKeyDeAutomacao(
  dedupKey: string
): { repo: string; identidade: string } | null {
  if (!dedupKey.startsWith(DEDUP_PREFIXO_AUTOMACAO)) return null
  const resto = dedupKey.slice(DEDUP_PREFIXO_AUTOMACAO.length)
  const i = resto.indexOf(':')
  if (i < 0) return null
  const repo = resto.slice(0, i)
  const identidade = resto.slice(i + 1)
  if (!repo || !identidade) return null
  return { repo, identidade }
}

/** O `context` da pergunta carrega `· proposta #<n>` — extrai o número. */
export function propostaDoContexto(context: string | null | undefined): number | null {
  const m = context?.match(/proposta #(\d+)/)
  if (!m || !m[1]) return null
  return Number(m[1])
}

/** O `context` da pergunta carrega `· arquivo:<caminho>` — extrai o caminho. */
export function arquivoDoContexto(context: string | null | undefined): string | null {
  const m = context?.match(/arquivo:(\S+)/)
  return m?.[1] ?? null
}

function textoDaPerguntaDeAutomacao(
  nome: string,
  arquivo: string,
  gatilho: string,
  desde: string
): string {
  return `O workflow "${nome}" (${arquivo}, gatilho ${gatilho}) falha desde ${desde}. O que fazer?`
}

function contextoDaPerguntaDeAutomacao(args: {
  resumo: string
  numeroProposta: number
  arquivo: string
}): string {
  return `${args.resumo} · proposta #${args.numeroProposta} · arquivo:${args.arquivo}`
}

export interface PerguntarAoDonoArgs {
  userId: string
  projectId: string
  repo: string
  identidade: string
  nome: string
  arquivo: string
  gatilho: string
  desde: string
  /** O que o workflow faz, deduzido do `name`/`on:` do YAML. */
  resumo: string
  numeroProposta: number
}

/** Só o que `perguntarAoDono` precisa de `AgentQuestionService.ask`. */
export interface AgentQuestionAsker {
  ask: (
    userId: string,
    projectId: string,
    input: {
      text: string
      context?: string
      options?: OpcaoDeDecisao[]
      dedupKey?: string
    }
  ) => Promise<unknown>
}

/**
 * D71: pergunta ao dono (3 opções objetivas + "Vou escrever"), dedupada por
 * `automacao:<repo>:<identidade>` — a mesma automação nunca pergunta duas
 * vezes (o dono já respondeu uma vez, a resposta vale).
 */
export async function perguntarAoDono(
  args: PerguntarAoDonoArgs,
  deps: { agentQuestion: AgentQuestionAsker }
): Promise<void> {
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: textoDaPerguntaDeAutomacao(args.nome, args.arquivo, args.gatilho, args.desde),
    context: contextoDaPerguntaDeAutomacao({
      resumo: args.resumo,
      numeroProposta: args.numeroProposta,
      arquivo: args.arquivo,
    }),
    options: OPCOES_DE_DECISAO_DE_AUTOMACAO,
    dedupKey: dedupKeyDeAutomacao(args.repo, args.identidade),
  })
}

// --- Resposta vira ação ----------------------------------------------------

function headersPadrao(token: string): Record<string, string> {
  return {
    authorization: `token ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'gitorch',
  }
}

export interface ProcessarRespostaDeAutomacaoArgs {
  dedupKey: string | null
  context: string | null
  /** O `value` da opção escolhida, ou o texto livre de "Vou escrever". */
  resposta: string
  projectId: string
  autonomia: string | null | undefined
}

export interface ProcessarRespostaDeAutomacaoDeps {
  /** `fetch` JÁ GUARDADO com o nível de autonomia do projeto — nunca cru. */
  fetchImpl: typeof fetch
  /** Credencial do CLIENTE (mesma que criou a proposta) — a guarda de
   *  autonomia decide SE escreve, o token decide COMO se autentica; as duas
   *  camadas são independentes, igual em `ghIssue`/`services/proposta.ts`. */
  token: string
  /** `infra_incidents.cleared_at = now` — mesmo efeito de `limparIncidente`
   *  em `fechar-incidente-resolvido.ts`. */
  marcarIncidenteResolvido: (args: {
    projectId: string
    identidadeEstavel: string
  }) => Promise<void>
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

async function ghFetch(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const resp = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: { ...headersPadrao(token), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`GitHub ${method} ${path} → ${resp.status}: ${detail.slice(0, 150)}`)
  }
  return resp.json().catch(() => ({}))
}

/**
 * Abre um PR removendo o arquivo do workflow — só chamado com autonomia
 * `cuidar` já confirmada por quem chama. `Closes #<numeroProposta>` fecha a
 * proposta sozinha quando o PR mesclar.
 */
async function abrirPrDeRemocao(
  repo: string,
  arquivo: string,
  numeroProposta: number,
  fetchImpl: typeof fetch,
  token: string
): Promise<number> {
  const basename = arquivo.split('/').pop() ?? arquivo
  const branch = `chore/remover-workflow-${basename}`

  const repoInfo = (await ghFetch(fetchImpl, token, 'GET', `/repos/${repo}`)) as {
    default_branch?: string
  }
  const base = repoInfo.default_branch ?? 'main'

  const ref = (await ghFetch(fetchImpl, token, 'GET', `/repos/${repo}/git/ref/heads/${base}`)) as {
    object?: { sha?: string }
  }
  const baseSha = ref.object?.sha
  if (!baseSha) throw new Error(`abrir-pr-de-remocao: sem sha da branch base (${repo}@${base})`)

  await ghFetch(fetchImpl, token, 'POST', `/repos/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  })

  const arquivoCodificado = encodeURIComponent(arquivo)
  const conteudo = (await ghFetch(
    fetchImpl,
    token,
    'GET',
    `/repos/${repo}/contents/${arquivoCodificado}?ref=${encodeURIComponent(base)}`
  )) as { sha?: string }
  const fileSha = conteudo.sha
  if (!fileSha) throw new Error(`abrir-pr-de-remocao: sem sha do arquivo (${repo}/${arquivo})`)

  await ghFetch(fetchImpl, token, 'DELETE', `/repos/${repo}/contents/${arquivoCodificado}`, {
    message: `chore: remover workflow ${basename} (decisão do dono — proposta #${numeroProposta})`,
    sha: fileSha,
    branch,
  })

  const pr = (await ghFetch(fetchImpl, token, 'POST', `/repos/${repo}/pulls`, {
    title: `chore: remover workflow ${basename}`,
    head: branch,
    base,
    body:
      `O dono decidiu DELETAR este workflow de automação (proposta #${numeroProposta}).\n\n` +
      `Closes #${numeroProposta}`,
  })) as { number?: number }
  if (!pr.number) throw new Error(`abrir-pr-de-remocao: PR criado sem número (${repo})`)
  return pr.number
}

async function comentarNaProposta(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  numeroProposta: number,
  corpo: string
): Promise<void> {
  await ghFetch(fetchImpl, token, 'POST', `/repos/${repo}/issues/${numeroProposta}/comments`, {
    body: corpo,
  })
}

/**
 * A resposta do dono a uma pergunta de automação vira ação. Chamada de
 * `AgentQuestionService.answer()` (via `aoResponderAutomacao`, best-effort —
 * uma falha aqui NUNCA desfaz o `answer` já gravado no banco).
 */
export async function processarRespostaDeAutomacao(
  args: ProcessarRespostaDeAutomacaoArgs,
  deps: ProcessarRespostaDeAutomacaoDeps
): Promise<void> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)

  if (!args.dedupKey) return
  const parsed = parseDedupKeyDeAutomacao(args.dedupKey)
  if (!parsed) return

  const numeroProposta = propostaDoContexto(args.context)
  if (numeroProposta === null) {
    warn(`decisao-de-automacao: sem número da proposta no contexto (${args.dedupKey})`)
    return
  }
  const { repo, identidade } = parsed

  switch (args.resposta) {
    case 'deletar': {
      const nivel = normalizarNivel(args.autonomia)
      if (nivel !== 'cuidar') {
        await comentarNaProposta(
          deps.fetchImpl,
          deps.token,
          repo,
          numeroProposta,
          'No nível "Sugerir" o GitOrch organiza o quadro e propõe trabalho, mas não mexe no código do ' +
            'seu repositório sozinho. Para eu remover este workflow, mude a autonomia deste projeto para ' +
            '"Cuidar" no painel e responda de novo (ou peça para reajustar).'
        )
        info(
          `decisao-de-automacao: deletar recusado (nivel=${args.autonomia ?? 'so_olhar'}) — comentário em #${numeroProposta}`
        )
        return
      }
      const arquivo = arquivoDoContexto(args.context)
      if (!arquivo) {
        warn(`decisao-de-automacao: sem caminho do arquivo no contexto (#${numeroProposta})`)
        return
      }
      const prNumero = await abrirPrDeRemocao(
        repo,
        arquivo,
        numeroProposta,
        deps.fetchImpl,
        deps.token
      )
      info(`decisao-de-automacao: PR #${prNumero} de remoção aberto (proposta #${numeroProposta})`)
      return
    }

    case 'reajustar': {
      await deps
        .fetchImpl(
          `https://api.github.com/repos/${repo}/issues/${numeroProposta}/labels/${encodeURIComponent(LABEL_PROPOSTA)}`,
          { method: 'DELETE', headers: headersPadrao(deps.token) }
        )
        .catch((err) =>
          warn(
            `decisao-de-automacao: não tirei ${LABEL_PROPOSTA} de #${numeroProposta} (${String(err).slice(0, 120)})`
          )
        )
      await ghFetch(
        deps.fetchImpl,
        deps.token,
        'POST',
        `/repos/${repo}/issues/${numeroProposta}/labels`,
        {
          labels: ['gitorch:incident'],
        }
      )
      await comentarNaProposta(
        deps.fetchImpl,
        deps.token,
        repo,
        numeroProposta,
        'Decisão do dono: reajustar. Esta proposta virou um incidente normal — o PO vai triar a ' +
          'prioridade e o Scrum Master delega para o dev assíncrono.'
      )
      info(`decisao-de-automacao: proposta #${numeroProposta} virou incidente (reajustar)`)
      return
    }

    case 'manter': {
      await comentarNaProposta(
        deps.fetchImpl,
        deps.token,
        repo,
        numeroProposta,
        'Decisão do dono: manter como está. Encerrando esta proposta — o GitOrch não pergunta de novo ' +
          'sobre esta automação.'
      )
      await ghFetch(
        deps.fetchImpl,
        deps.token,
        'PATCH',
        `/repos/${repo}/issues/${numeroProposta}`,
        {
          state: 'closed',
          state_reason: 'not_planned',
        }
      )
      await deps.marcarIncidenteResolvido({
        projectId: args.projectId,
        identidadeEstavel: identidade,
      })
      info(`decisao-de-automacao: proposta #${numeroProposta} mantida — incidente resolvido`)
      return
    }

    default: {
      // "Vou escrever": texto livre, vira comentário — sem ação automática.
      await comentarNaProposta(
        deps.fetchImpl,
        deps.token,
        repo,
        numeroProposta,
        `Resposta do dono: ${args.resposta}`
      )
      info(`decisao-de-automacao: resposta livre registrada em #${numeroProposta}`)
      return
    }
  }
}
