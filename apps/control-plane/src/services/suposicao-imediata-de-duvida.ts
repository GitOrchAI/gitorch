import type { StepExecutor } from './role-rails.js'
import {
  suporSemODono,
  textoDaSuposicaoParaODev,
  textoDoComentarioDeSuposicao,
} from './duvida-rails-mission.js'
import { registrarResposta, type PrismaDevSession } from './dev-session-store.js'
import { marcarRespondida } from './pergunta-sem-resposta.js'
import { responderSessaoJules as responderSessaoJulesReal } from './jules-client.js'

/**
 * D72 (02/09), item 2 — palavras do dono: "antes de responder vai ter que
 * ... ler o que o RA está passando, ou o próprio RA responda". Até esta
 * task, quando QA e RA esgotavam uma dúvida técnica
 * (`runDuvidaTecnicaViaRa` também devolvia `perguntar-ao-dono`), a única
 * saída era escalar direto ao dono (`escalar-duvida-ao-dono.ts`) e esperar
 * até 24h em silêncio (`supor-duvida-pendente.ts`, L4-T4/D64) para o RA
 * formar uma suposição.
 *
 * `tentarSuposicaoImediata` tenta a suposição JÁ — no MESMO tique, com o
 * MESMO `execute` que já está rodando esta missão de QA — assim que a
 * dúvida técnica esgota QA e RA. Só quando a suposição NÃO é concreta (ou
 * não dá para entregá-la) é que a dúvida de fato vira uma pergunta ao dono.
 *
 * Deliberadamente NÃO cria nenhuma `agent_question` nem chama
 * `marcarAssumida`: se a suposição resolve, o dono não precisa saber que
 * isto aconteceu — é exatamente o ponto de tentar ANTES de perguntar.
 * (`supor-duvida-pendente.ts` marca `assumida` porque roda DEPOIS de o dono
 * já ter sido perguntado de verdade e ficado 24h em silêncio — ali já
 * existe uma pergunta aberta para fechar; aqui nunca existiu nenhuma.)
 */
export interface DepsDeSuposicaoImediata {
  prisma: PrismaDevSession
  /** Injetável para teste; produção passa `responderSessaoJules` de verdade. */
  responder?: typeof responderSessaoJulesReal
  /**
   * Comenta na issue do repositório do CLIENTE — sempre pelo fetch guardado
   * pela autonomia do projeto, nunca um `fetch` cru (mesmo contrato de
   * `supor-duvida-pendente.ts`). Best-effort: a suposição já foi entregue
   * ao dev quando isto roda.
   */
  comentarNaIssue: (args: { issueNumber: number; texto: string }) => Promise<void>
  onWarn: (mensagem: string) => void
  /** O relógio, injetado — mesmo padrão de `supor-duvida-pendente.ts`. */
  agora?: Date
}

export interface ArgsDeSuposicaoImediata {
  /** A pergunta original do dev, na íntegra — a MESMA que QA e RA já viram. */
  pergunta: string
  repository: string
  issueNumber: number
  execute: StepExecutor
  contextBlocks: string[]
  apiKey: string | undefined
  sessionName: string
  hashDaPergunta: string
}

/**
 * Devolve `true` quando a suposição resolveu (o dev já foi respondido — o
 * chamador NÃO deve escalar ao dono) e `false` quando é preciso escalar de
 * verdade (`escalar-duvida-ao-dono.ts`).
 */
export async function tentarSuposicaoImediata(
  args: ArgsDeSuposicaoImediata,
  deps: DepsDeSuposicaoImediata
): Promise<boolean> {
  const responder = deps.responder ?? responderSessaoJulesReal

  let suposicao: Awaited<ReturnType<typeof suporSemODono>>
  try {
    suposicao = await suporSemODono({
      pergunta: args.pergunta,
      repository: args.repository,
      issueNumber: args.issueNumber,
      execute: args.execute,
      contextBlocks: args.contextBlocks,
    })
  } catch (err) {
    // Erro do MOTOR ao formar a suposição é "sem suposição concreta" — MESMO
    // comportamento já testado de `supor-duvida-pendente.ts`: nunca derruba
    // o chamador, a escalada normal ao dono é a rede de segurança.
    deps.onWarn(
      `tentarSuposicaoImediata: suporSemODono falhou para ${args.repository}#${args.issueNumber}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
  if (!suposicao) return false

  const suposicaoFormada = suposicao
  const entregue = await responder({
    apiKey: args.apiKey,
    sessionName: args.sessionName,
    texto: textoDaSuposicaoParaODev(suposicaoFormada),
    onWarn: deps.onWarn,
  })
  if (!entregue) {
    deps.onWarn(
      `tentarSuposicaoImediata: formei uma suposição do RA para ${args.sessionName} mas não ` +
        'consegui entregá-la ao dev — escalando ao dono normalmente'
    )
    return false
  }

  // Best-effort, MESMA disciplina de `supor-duvida-pendente.ts`: a entrega
  // ao dev já aconteceu quando isto roda — uma falha aqui só piora a
  // rastreabilidade, nunca desfaz a entrega.
  await deps
    .comentarNaIssue({
      issueNumber: args.issueNumber,
      texto: textoDoComentarioDeSuposicao(suposicaoFormada),
    })
    .catch((err: unknown) =>
      deps.onWarn(
        `tentarSuposicaoImediata: suposição entregue ao dev, mas não consegui comentar na issue ` +
          `#${args.issueNumber}: ${err instanceof Error ? err.message : String(err)}`
      )
    )

  await registrarResposta({
    prisma: deps.prisma,
    sessionName: args.sessionName,
    hashDaPergunta: marcarRespondida(args.hashDaPergunta),
    agora: deps.agora ?? new Date(),
  })
  return true
}

export interface DepsDeComentarNaIssue {
  /** O `fetch` já guardado pela autonomia do projeto — nunca um `fetch` cru. */
  fetchDoCliente: typeof fetch
  repository: string
  /** `undefined` quando o produto não tem credencial do GitHub para este
   *  projeto (nenhum token de instalação, nenhum `GITORCH_GITHUB_TOKEN`). */
  githubToken: string | undefined
  onWarn: (mensagem: string) => void
}

/**
 * Constrói o `comentarNaIssue` que `tentarSuposicaoImediata` (e
 * `supor-duvida-pendente.ts`, mesmo padrão) chamam, best-effort, para
 * registrar a suposição do RA na issue do repositório do CLIENTE.
 *
 * Extraído de `plugins/scheduler.ts` para ser testável sem a máquina de
 * missão/motor — mesmo princípio de `escalar-duvida-ao-dono.ts`. O defeito
 * real: `railsToken as string` (scheduler.ts) mentia sobre o tipo — o token
 * pode não existir — e a chamada saía com o cabeçalho literal
 * `authorization: token undefined`, morrendo com 401 do GitHub dentro do
 * `.catch` best-effort de `tentarSuposicaoImediata`, que só loga "não
 * consegui comentar" sem dizer que a causa era a falta de token. Agora: sem
 * token, NENHUMA chamada de rede acontece — só um aviso claro.
 */
export function criarComentarNaIssue(
  deps: DepsDeComentarNaIssue
): (args: { issueNumber: number; texto: string }) => Promise<void> {
  return async ({ issueNumber, texto }) => {
    if (!deps.githubToken) {
      deps.onWarn(
        `criarComentarNaIssue: suposição formada para a tarefa #${issueNumber} de ` +
          `${deps.repository}, mas não há token do GitHub para publicar o comentário na issue — pulei a chamada`
      )
      return
    }
    const resp = await deps.fetchDoCliente(
      `https://api.github.com/repos/${deps.repository}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          authorization: `token ${deps.githubToken}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'gitorch',
        },
        body: JSON.stringify({ body: texto }),
      }
    )
    if (!resp.ok) {
      throw new Error(
        `comentarNaIssue: POST /repos/${deps.repository}/issues/${issueNumber}/comments -> ${resp.status}`
      )
    }
  }
}
