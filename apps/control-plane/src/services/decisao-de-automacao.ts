// D63/D71 (L4-T2) — a metade "human-in-the-loop" da proposta
// (`services/proposta.ts`): pergunta ao dono o que fazer com uma automação
// que falhou, e executa a decisão quando ela chega.
//
// D71: toda pergunta ao dono é 3 opções objetivas + "Vou escrever" — nunca
// texto solto sem botão.

import { normalizarNivel } from '@gitorch/cadence'
import { LABEL_PROPOSTA, TIPO_MARCADOR_ARQUIVO } from './proposta.js'
import { GithubExecutionError } from './github-errors.js'
import { nomeDeRepositorioValido } from './nome-de-repositorio.js'
import { lerMarcador } from './marcador-de-issue.js'
import { ghJson } from './github-json.js'
import { buildFreeTextOption } from './telegram-bot.js'

/** Prefixo do dedupKey de toda pergunta de decisão de automação. */
export const DEDUP_PREFIXO_AUTOMACAO = 'automacao:'

export interface OpcaoDeDecisao {
  label: string
  value: string
}

/**
 * D71: 3 opções objetivas + "Vou escrever" — nesta ordem, sempre.
 *
 * L4-T18 (item 3): o botão de escrever usa o SENTINEL de
 * `buildFreeTextOption` — mesmo padrão de `duvida-dev:`
 * (escalar-duvida-ao-dono.ts) e `retomada-travada:` (plugins/scheduler.ts).
 * ANTES desta task era um valor literal (`value: 'escrever'`): clicar no
 * botão gravava a STRING "escrever" direto como se fosse a decisão do dono
 * (`processarRespostaDeAutomacao` via `default`, abaixo, tratava isso como
 * "texto livre: escrever" e comentava isso mesmo na proposta) — nunca abria
 * o "digite sua resposta" de verdade. O sentinel corrige: o clique arma
 * `setActiveTypingQuestion` (telegram-bot.ts) e só o texto REAL que o dono
 * digitar depois vira `args.resposta` no `default` abaixo.
 */
export const OPCOES_DE_DECISAO_DE_AUTOMACAO: OpcaoDeDecisao[] = [
  { label: 'Deletar o workflow', value: 'deletar' },
  { label: 'Reajustar (vira tarefa)', value: 'reajustar' },
  { label: 'Manter como está', value: 'manter' },
  buildFreeTextOption('Vou escrever'),
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

function textoDaPerguntaDeAutomacao(
  nome: string,
  arquivo: string,
  gatilho: string,
  desde: string
): string {
  return `O workflow "${nome}" (${arquivo}, gatilho ${gatilho}) falha desde ${desde}. O que fazer?`
}

/** Só para HUMANO ler no Telegram/painel — nunca reparseado de volta (ver
 *  A2: `processarRespostaDeAutomacao` resolve pela `dedupKey`, não daqui). */
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

const API = 'https://api.github.com'

/** Encapsula `ghJson` (R2) com o prefixo da API do GitHub — só o `path`
 *  relativo (`/repos/...`) muda de chamada para chamada. */
async function gh<T = unknown>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  return ghJson<T>(fetchImpl, token, method, `${API}${path}`, body)
}

/**
 * S2: o caminho do arquivo a apagar tem que ser exatamente um workflow do
 * Actions — sem `..`, sem barra extra, sem esconder outro arquivo do repo
 * atrás do nome. A ORIGEM do caminho é o marcador estruturado da proposta
 * (R1/A2), nunca texto do dono — mas valida aqui também, defesa em
 * profundidade (mesma doutrina de `nome-de-repositorio.ts`: a checagem mora
 * na PORTA, não só em quem produz o valor).
 */
const CAMINHO_DE_WORKFLOW_VALIDO = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/

export function caminhoDeWorkflowValido(caminho: string): boolean {
  return CAMINHO_DE_WORKFLOW_VALIDO.test(caminho)
}

const ZERO_WIDTH_SPACE = '\u200B'

/** S3: teto de caracteres da resposta livre ("Vou escrever") antes de virar
 *  comentário público na proposta. */
export const TETO_DE_CARACTERES_DA_RESPOSTA_LIVRE = 2000

/**
 * S3: a resposta de "Vou escrever" é TEXTO LIVRE do dono, e vira um
 * COMENTÁRIO PÚBLICO na proposta (repo do cliente) — sanitiza antes de
 * publicar:
 *   - vazio/só espaços → `null` (o chamador não comenta, só loga info);
 *   - teto de 2000 caracteres;
 *   - `@nome` quebrado com um espaço de largura zero (nunca vira notificação
 *     real ao colar cru num comentário do GitHub);
 *   - `/comando` neutralizado (barra invertida) no início da string, de
 *     qualquer linha, ou depois de espaço — um bot de ChatOps do repositório
 *     do cliente (ex.: `/close`, `/label`) não pode agir sobre texto que é
 *     só a resposta de uma pergunta;
 *   - bloco de citação (`> `) em cada linha, deixando claro que é fala do
 *     dono, não do GitOrch.
 */
export function sanitizarRespostaLivre(texto: string): string | null {
  const bruto = texto.trim()
  if (!bruto) return null
  const cortado = bruto.slice(0, TETO_DE_CARACTERES_DA_RESPOSTA_LIVRE)
  const semMencao = cortado.replace(/@(?=\w)/g, `@${ZERO_WIDTH_SPACE}`)
  const semComando = semMencao.replace(/(^|\s)\/(?=[A-Za-z])/gm, '$1\\/')
  return semComando
    .split('\n')
    .map((linha) => `> ${linha}`)
    .join('\n')
}

export interface ProcessarRespostaDeAutomacaoArgs {
  dedupKey: string | null
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
  /**
   * A2 (fix-up L4-T2): resolve o NÚMERO DA PROPOSTA pela linha de
   * `infra_incidents` (projectId + identidadeEstavel, ambos vindos da
   * `dedupKey` — nunca do `context` da pergunta, texto do dono e portanto
   * não confiável). `issueNumber` é o mesmo número que `criarProposta`
   * devolveu e `registrarIncidente` gravou.
   */
  buscarIncidente: (args: {
    projectId: string
    identidadeEstavel: string
  }) => Promise<{ issueNumber: number | null } | null>
  /** `infra_incidents.cleared_at = now` — mesmo efeito de `limparIncidente`
   *  em `fechar-incidente-resolvido.ts`. */
  marcarIncidenteResolvido: (args: {
    projectId: string
    identidadeEstavel: string
  }) => Promise<void>
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

async function comentarNaProposta(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  numeroProposta: number,
  corpo: string
): Promise<void> {
  await gh(fetchImpl, token, 'POST', `/repos/${repo}/issues/${numeroProposta}/comments`, {
    body: corpo,
  })
}

/**
 * S4: dois cliques na mesma proposta não podem abrir dois PRs de remoção —
 * confere se já existe um PR ABERTO para a branch determinística
 * (`chore/remover-workflow-<basename>`) ANTES de criar branch/apagar
 * arquivo/abrir PR. `reaproveitado: true` → o chamador comenta o link em vez
 * de repetir o trabalho.
 */
async function abrirPrDeRemocao(
  repo: string,
  arquivo: string,
  numeroProposta: number,
  fetchImpl: typeof fetch,
  token: string
): Promise<{ numero: number; reaproveitado: boolean }> {
  const basename = arquivo.split('/').pop() ?? arquivo
  const branch = `chore/remover-workflow-${basename}`
  const owner = repo.split('/')[0]

  const existentes = await gh<Array<{ number?: number }>>(
    fetchImpl,
    token,
    'GET',
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`
  )
  const existente = Array.isArray(existentes) ? existentes[0] : undefined
  if (existente?.number) {
    return { numero: existente.number, reaproveitado: true }
  }

  const repoInfo = await gh<{ default_branch?: string }>(fetchImpl, token, 'GET', `/repos/${repo}`)
  const base = repoInfo.default_branch ?? 'main'

  const ref = await gh<{ object?: { sha?: string } }>(
    fetchImpl,
    token,
    'GET',
    `/repos/${repo}/git/ref/heads/${base}`
  )
  const baseSha = ref.object?.sha
  if (!baseSha) throw new Error(`abrir-pr-de-remocao: sem sha da branch base (${repo}@${base})`)

  await gh(fetchImpl, token, 'POST', `/repos/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  })

  const arquivoCodificado = encodeURIComponent(arquivo)
  const conteudo = await gh<{ sha?: string }>(
    fetchImpl,
    token,
    'GET',
    `/repos/${repo}/contents/${arquivoCodificado}?ref=${encodeURIComponent(base)}`
  )
  const fileSha = conteudo.sha
  if (!fileSha) throw new Error(`abrir-pr-de-remocao: sem sha do arquivo (${repo}/${arquivo})`)

  await gh(fetchImpl, token, 'DELETE', `/repos/${repo}/contents/${arquivoCodificado}`, {
    message: `chore: remover workflow ${basename} (decisão do dono — proposta #${numeroProposta})`,
    sha: fileSha,
    branch,
  })

  const pr = await gh<{ number?: number }>(fetchImpl, token, 'POST', `/repos/${repo}/pulls`, {
    title: `chore: remover workflow ${basename}`,
    head: branch,
    base,
    body:
      `O dono decidiu DELETAR este workflow de automação (proposta #${numeroProposta}).\n\n` +
      `Closes #${numeroProposta}`,
  })
  if (!pr.number) throw new Error(`abrir-pr-de-remocao: PR criado sem número (${repo})`)
  return { numero: pr.number, reaproveitado: false }
}

/**
 * A resposta do dono a uma pergunta de automação vira ação. Chamada de
 * `AgentQuestionService.answer()` (via `aoResponderAutomacao`) — desde o
 * fix-up C4, ANTES de a pergunta ser marcada `answered`: uma falha aqui
 * mantém a pergunta `open` (nova tentativa) em vez de fingir que a ação
 * aconteceu.
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
  const { repo, identidade } = parsed

  // S1: `repo` vem embutido na dedupKey (gerada pelo nosso próprio código,
  // mas a checagem mora na PORTA de saída de rede — nunca só em quem
  // produz o valor, mesma doutrina de `desejo-no-github.ts`). Recusa ANTES
  // de montar qualquer URL.
  if (!nomeDeRepositorioValido(repo)) {
    throw new GithubExecutionError(
      `decisao-de-automacao: repositório em formato inválido (${JSON.stringify(repo).slice(0, 80)})`
    )
  }

  // A2: o número da proposta vem da linha de `infra_incidents` — NUNCA do
  // `context` da pergunta (texto do dono, não confiável).
  const incidente = await deps.buscarIncidente({
    projectId: args.projectId,
    identidadeEstavel: identidade,
  })
  const numeroProposta = incidente?.issueNumber ?? null
  if (numeroProposta === null) {
    warn(
      `decisao-de-automacao: sem incidente/issue registrado para ${identidade} em ${args.projectId} (${args.dedupKey})`
    )
    return
  }

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

      // A2: o caminho do arquivo vem do SEGUNDO marcador estruturado no
      // corpo da própria proposta (R1) — nunca do `context` da pergunta.
      const proposta = await gh<{ body?: string | null }>(
        deps.fetchImpl,
        deps.token,
        'GET',
        `/repos/${repo}/issues/${numeroProposta}`
      )
      const arquivo = lerMarcador(proposta.body, TIPO_MARCADOR_ARQUIVO)
      // S2: sem regex frouxa — o caminho tem que casar exatamente um
      // workflow do Actions (sem `..`, sem barra extra).
      if (!arquivo || !caminhoDeWorkflowValido(arquivo)) {
        warn(
          `decisao-de-automacao: caminho de arquivo ausente/inválido na proposta #${numeroProposta} (${arquivo ?? 'nenhum'})`
        )
        await comentarNaProposta(
          deps.fetchImpl,
          deps.token,
          repo,
          numeroProposta,
          'Não encontrei um caminho de workflow válido para apagar nesta proposta — nada foi ' +
            'alterado. Isto não deveria acontecer; fale com o suporte.'
        )
        return
      }

      // S4: idempotência — dois cliques não abrem dois PRs.
      const { numero: prNumero, reaproveitado } = await abrirPrDeRemocao(
        repo,
        arquivo,
        numeroProposta,
        deps.fetchImpl,
        deps.token
      )
      if (reaproveitado) {
        await comentarNaProposta(
          deps.fetchImpl,
          deps.token,
          repo,
          numeroProposta,
          `Já existe um PR aberto removendo este workflow: #${prNumero}. Não abri outro.`
        )
        info(
          `decisao-de-automacao: PR #${prNumero} já existia (reaproveitado) — proposta #${numeroProposta}`
        )
      } else {
        info(
          `decisao-de-automacao: PR #${prNumero} de remoção aberto (proposta #${numeroProposta})`
        )
      }
      return
    }

    case 'reajustar': {
      // C1: POST `gitorch:incident` ANTES de DELETE `gitorch:proposal` — as
      // duas por `gh` (lança em qualquer falha, nunca engole): se qualquer
      // uma falhar, a issue não pode ficar SEM NENHUM label de rota (nem
      // proposta, nem incidente) — por isso o incidente entra primeiro, e só
      // depois de confirmado é que a proposta sai.
      await gh(
        deps.fetchImpl,
        deps.token,
        'POST',
        `/repos/${repo}/issues/${numeroProposta}/labels`,
        {
          labels: ['gitorch:incident'],
        }
      )
      await gh(
        deps.fetchImpl,
        deps.token,
        'DELETE',
        `/repos/${repo}/issues/${numeroProposta}/labels/${encodeURIComponent(LABEL_PROPOSTA)}`
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
      // C3: marca o incidente resolvido ANTES de fechar a issue. Se o PATCH
      // de fechamento falhar DEPOIS (rede, permissão), a issue fica aberta —
      // e como o incidente já está limpo, uma nova varredura/resposta não
      // reabre pergunta nenhuma; só falta fechar a issue manualmente. A
      // ordem INVERSA seria pior: uma issue fechada com o incidente ainda
      // "aberto" no banco para sempre (nada mais o limparia).
      await deps.marcarIncidenteResolvido({
        projectId: args.projectId,
        identidadeEstavel: identidade,
      })
      await gh(deps.fetchImpl, deps.token, 'PATCH', `/repos/${repo}/issues/${numeroProposta}`, {
        state: 'closed',
        state_reason: 'not_planned',
      })
      info(`decisao-de-automacao: proposta #${numeroProposta} mantida — incidente resolvido`)
      return
    }

    default: {
      // "Vou escrever": texto livre, vira comentário — sem ação automática.
      const sanitizado = sanitizarRespostaLivre(args.resposta)
      if (sanitizado === null) {
        info(
          `decisao-de-automacao: resposta livre vazia/só espaços em #${numeroProposta} — não comento`
        )
        return
      }
      await comentarNaProposta(
        deps.fetchImpl,
        deps.token,
        repo,
        numeroProposta,
        `Resposta do dono:\n\n${sanitizado}`
      )
      info(`decisao-de-automacao: resposta livre registrada em #${numeroProposta}`)
      return
    }
  }
}
