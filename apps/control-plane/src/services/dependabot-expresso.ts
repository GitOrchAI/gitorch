// Fase 5.3: o caminho expresso do Dependabot. PR de dependência com correção
// pronta e verificação verde mescla sozinho quando o projeto manda
// (`cuidaPorOrigem.dependabot = 'sim'`); em `perguntar` vira pergunta ao dono;
// em `nao` fica quieto.
//
// O vigia (`vigia-do-pr.ts`) continua sem "consertar" Dependabot: não abre
// sessão do dev assíncrono e não fecha o PR. Aqui só existe a decisão de
// mesclar ou deixar como está, com as MESMAS garantias do merge do dev:
//  - a verificação precisa estar verde com job real concluído (a régua única
//    `lerEstadoDoCiDoHead`), lida de novo na porta do merge;
//  - o PR precisa estar mergeável e mirar a branch padrão do repositório;
//  - o commit que entra é o que está no PR AGORA: a cabeça viva é lida logo
//    antes do merge, o `sha` do PUT é ela, e divergência ou falha de leitura
//    recusa com motivo;
//  - PR que sobe junto com outro (prisma + @prisma/client, codeql init +
//    analyze) não é mesclado um a um enquanto o irmão estiver aberto;
//  - o PR do aplicador de segurança do próprio GitOrch nunca é mesclado
//    (porteiro de `mesclarPr`).
//
// Cada decisão deixa o motivo na linha do tempo do painel.

import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { lerCuidaPorOrigem } from './cuidado-por-origem.js'
import { comProjetoDaGuarda } from './guarda-de-autonomia.js'
import { decidirMergeDoDependabot } from './dependabot-auto-merge.js'
import { mesclarPr } from './merge-do-pr.js'
import { lerEstadoDoCiDoHead } from './estado-da-verificacao-do-github.js'
import { baseDoPrDe, branchPadraoLidaDoRepositorio } from './base-do-dev.js'
import { contextoExecutivoVazio } from './contexto-executivo-da-pergunta.js'
import {
  dedupKeyDeCuidaDestePedido,
  perguntarSeCuida,
  type AgentQuestionAskerDeCuidado,
} from './perguntar-se-cuida.js'
import {
  AUTORES_QUE_O_VIGIA_NAO_CONSERTA,
  MAX_PAGINAS_DE_PR,
  descreverTempoParado,
  lerVerificacao,
  type EstadoDaVerificacao,
} from './vigia-do-pr.js'
import type { StepExecutor } from './role-rails.js'

/**
 * Grupos de pacotes que precisam subir juntos para o projeto continuar
 * funcionando. O ÚNICO lugar onde a lista vive: para um grupo novo, basta
 * acrescentar uma linha aqui.
 *
 * Os nomes são os que o Dependabot escreve no título do PR.
 */
export const GRUPOS_DE_IRMAOS: ReadonlyArray<{ nome: string; pacotes: readonly string[] }> = [
  { nome: 'Prisma', pacotes: ['prisma', '@prisma/client'] },
  {
    nome: 'CodeQL',
    pacotes: ['github/codeql-action', 'github/codeql-action/init', 'github/codeql-action/analyze'],
  },
]

/** O pacote e as versões que o título de um PR do Dependabot anuncia. */
export function pacoteDoTitulo(
  titulo: string | null | undefined
): { pacote: string; de: string; para: string } | null {
  const achado = /\b(?:bump|update)\s+(\S+)\s+(?:requirement\s+)?from\s+(\S+)\s+to\s+(\S+)/i.exec(
    titulo ?? ''
  )
  if (!achado) return null
  const [, pacote, de, para] = achado
  if (pacote === undefined || de === undefined || para === undefined) return null
  return { pacote, de, para }
}

function grupoDoPacote(pacote: string): (typeof GRUPOS_DE_IRMAOS)[number] | undefined {
  return GRUPOS_DE_IRMAOS.find((g) => g.pacotes.includes(pacote))
}

/** Um PR aberto, reduzido ao que a busca de irmão precisa. */
export interface PrAbertoParaIrmao {
  numero: number
  titulo: string | null
  autor: string | null
}

/**
 * Descrição do irmão que ainda está aberto, ou `null` quando não há. Irmão é
 * PR aberto do Dependabot que atualiza OUTRO membro do mesmo grupo.
 */
export function irmaoPendenteDe(args: {
  numero: number
  titulo: string | null
  abertos: readonly PrAbertoParaIrmao[]
}): string | null {
  const meu = pacoteDoTitulo(args.titulo)
  if (!meu) return null
  const grupo = grupoDoPacote(meu.pacote)
  if (!grupo) return null
  for (const outro of args.abertos) {
    if (outro.numero === args.numero) continue
    if (!AUTORES_QUE_O_VIGIA_NAO_CONSERTA.includes(outro.autor ?? '')) continue
    const dele = pacoteDoTitulo(outro.titulo)
    if (!dele || dele.pacote === meu.pacote || !grupo.pacotes.includes(dele.pacote)) continue
    const versoes =
      dele.para === meu.para
        ? 'na mesma versão'
        : `em versão diferente (${dele.para}, e este vai para ${meu.para})`
    return `o PR #${outro.numero} atualiza \`${dele.pacote}\`, par de \`${meu.pacote}\` (${grupo.nome}), ${versoes}`
  }
  return null
}

export interface ResultadoDoDependabot {
  acao: 'ignorar'
  motivo: string
  /** O merge aconteceu nesta chamada. */
  mesclou: boolean
}

export interface DepsDoDependabotExpresso {
  runtimeConfig: unknown
  agora: Date
  projeto: { id: string; wingId: string }
  token: string
  numero: number
  /** O que a verificação diz. Relida fresca na porta do merge de qualquer jeito. */
  verificacao: EstadoDaVerificacao
  mergeable: boolean | null
  ghGet: (caminho: string, token: string) => Promise<unknown>
  ghSend: (
    method: 'POST' | 'PATCH' | 'PUT',
    caminho: string,
    token: string,
    body: unknown
  ) => Promise<unknown>
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
  prisma: Pick<PrismaClient, 'agentQuestion' | 'repoItem'>
  onWarn: (mensagem: string) => void
  /** Quem pergunta ao dono quando a política é `perguntar`. */
  pergunta?:
    | { userId: string; agentQuestion: AgentQuestionAskerDeCuidado; execute?: StepExecutor }
    | undefined
}

interface PrLido {
  estado: string | null
  titulo: string | null
  autor: string | null
  sha: string | null
  ramo: string | null
  corpo: string | null
  base: string | null
  criadoEm: string | null
  mergeable: boolean | null
}

function texto(valor: unknown, ...caminho: string[]): string | null {
  let atual: unknown = valor
  for (const chave of caminho) {
    if (typeof atual !== 'object' || atual === null) return null
    atual = Reflect.get(atual, chave)
  }
  return typeof atual === 'string' && atual !== '' ? atual : null
}

function lerPrCru(cru: unknown): PrLido {
  const mergeable = typeof cru === 'object' && cru !== null ? Reflect.get(cru, 'mergeable') : null
  return {
    estado: texto(cru, 'state'),
    titulo: texto(cru, 'title'),
    autor: texto(cru, 'user', 'login'),
    sha: texto(cru, 'head', 'sha'),
    ramo: texto(cru, 'head', 'ref'),
    corpo: typeof cru === 'object' && cru !== null ? (texto(cru, 'body') ?? null) : null,
    base: baseDoPrDe(cru),
    criadoEm: texto(cru, 'created_at'),
    mergeable: typeof mergeable === 'boolean' ? mergeable : null,
  }
}

function resultado(motivo: string, mesclou = false): ResultadoDoDependabot {
  return { acao: 'ignorar', motivo, mesclou }
}

function chaveDaRecusa(
  deps: Pick<DepsDoDependabotExpresso, 'projeto' | 'numero'>,
  sha: string | null,
  motivo: string
): string {
  const digest = createHash('sha1').update(motivo).digest('hex').slice(0, 8)
  return `dependabot-expresso:${deps.projeto.wingId}:${deps.numero}:${(sha ?? 'sem-sha').slice(0, 7)}:${digest}`
}

async function registrar(
  deps: Pick<DepsDoDependabotExpresso, 'registrarNoPainel' | 'projeto' | 'onWarn'>,
  chave: string,
  textoDoPainel: string
): Promise<void> {
  try {
    await deps.registrarNoPainel(deps.projeto.id, chave, textoDoPainel)
  } catch (err) {
    deps.onWarn(`dependabot-expresso: não consegui registrar no painel: ${(err as Error).message}`)
  }
}

async function recusar(
  deps: DepsDoDependabotExpresso,
  sha: string | null,
  motivo: string
): Promise<ResultadoDoDependabot> {
  await registrar(
    deps,
    chaveDaRecusa(deps, sha, motivo),
    `GitOrch: o PR #${deps.numero} do Dependabot não foi mesclado: ${motivo}.`
  )
  return resultado(`Dependabot expresso não mesclado: ${motivo}`)
}

/** Os PRs abertos do Dependabot (paginado); lança se a lista não couber. */
async function listarAbertos(deps: DepsDoDependabotExpresso): Promise<PrAbertoParaIrmao[]> {
  const saida: PrAbertoParaIrmao[] = []
  for (let pagina = 1; pagina <= MAX_PAGINAS_DE_PR; pagina += 1) {
    const lote = await deps.ghGet(
      `/repos/${deps.projeto.wingId}/pulls?state=open&per_page=100&page=${pagina}`,
      deps.token
    )
    if (!Array.isArray(lote)) throw new Error('a lista de PRs abertos veio em formato inesperado')
    for (const item of lote) {
      const numero: unknown =
        typeof item === 'object' && item !== null ? Reflect.get(item, 'number') : null
      if (typeof numero !== 'number') continue
      saida.push({ numero, titulo: texto(item, 'title'), autor: texto(item, 'user', 'login') })
    }
    if (lote.length < 100) return saida
  }
  throw new Error(`mais de ${MAX_PAGINAS_DE_PR * 100} PRs abertos`)
}

async function perguntarAoDono(
  deps: DepsDoDependabotExpresso,
  pr: PrLido
): Promise<ResultadoDoDependabot> {
  if (!deps.pergunta) {
    deps.onWarn(
      `dependabot-expresso: sem serviço de perguntas ou dono para perguntar sobre o PR #${deps.numero}`
    )
    return resultado('Dependabot expresso: política "perguntar", mas não há como perguntar ao dono')
  }
  const dedupKey = dedupKeyDeCuidaDestePedido(deps.projeto.wingId, deps.numero)
  // `ask` só deduplica contra pergunta JÁ RESPONDIDA: pergunta aberta precisa
  // ser conferida aqui, senão cada passada gera outra mensagem ao dono.
  const aberta = await deps.prisma.agentQuestion.findFirst({
    where: { projectId: deps.projeto.id, dedupKey, status: 'open' },
  })
  if (aberta)
    return resultado('Dependabot expresso: já há uma pergunta aberta ao dono sobre este PR')

  const idadeMs = pr.criadoEm ? deps.agora.getTime() - new Date(pr.criadoEm).getTime() : 0
  await perguntarSeCuida(
    {
      userId: deps.pergunta.userId,
      projectId: deps.projeto.id,
      numeroDoPr: deps.numero,
      repository: deps.projeto.wingId,
      origem: 'dependabot',
      contexto: contextoExecutivoVazio(),
      contextoPr: {
        titulo: pr.titulo ?? `PR #${deps.numero}`,
        idadeDias: Math.max(0, Math.floor(idadeMs / (24 * 60 * 60 * 1000))),
        idadeTexto: descreverTempoParado(Math.max(0, idadeMs)),
        estadoCi: deps.verificacao,
        conflitos: deps.mergeable === false,
      },
    },
    {
      agentQuestion: deps.pergunta.agentQuestion,
      ...(deps.pergunta.execute ? { execute: deps.pergunta.execute } : {}),
      onWarn: deps.onWarn,
      prisma: deps.prisma,
    }
  )
  await registrar(
    deps,
    chaveDaRecusa(deps, pr.sha, 'pergunta ao dono'),
    `GitOrch: o PR #${deps.numero} do Dependabot espera a sua decisão: a política do projeto é "perguntar".`
  )
  return resultado('Dependabot expresso: pergunta "cuido deste pedido?" enviada ao dono')
}

/**
 * A decisão e, se for o caso, o merge. Nunca retoma sessão nem fecha o PR.
 *
 * O merge sai pela guarda de autonomia por endereço, que só conhece o
 * repositório; o projeto em andamento é informado a ela para que dois projetos
 * do mesmo repositório não herdem a autonomia um do outro.
 */
export function decidirDependabotExpresso(
  deps: DepsDoDependabotExpresso
): Promise<ResultadoDoDependabot> {
  return comProjetoDaGuarda(deps.projeto.id, () => decidirDoProjeto(deps))
}

async function decidirDoProjeto(deps: DepsDoDependabotExpresso): Promise<ResultadoDoDependabot> {
  const { projeto, numero, token } = deps
  const politica = lerCuidaPorOrigem(deps.runtimeConfig, false).dependabot
  if (politica === 'nao') {
    return resultado('configuração do Dependabot é "nao", este PR não é cuidado')
  }

  let pr: PrLido
  try {
    pr = lerPrCru(await deps.ghGet(`/repos/${projeto.wingId}/pulls/${numero}`, token))
  } catch (err) {
    return recusar(deps, null, `não deu para ler o PR (${(err as Error).message})`)
  }
  if (pr.estado !== null && pr.estado !== 'open') {
    return resultado(`Dependabot expresso: o PR #${numero} não está aberto (${pr.estado})`)
  }
  // Autor ausente não prova nada: só quem a leitura NOMEIA como o Dependabot
  // passa. O merge sozinho exige saber de quem é o pedido.
  if (pr.autor === null) {
    return recusar(
      deps,
      pr.sha,
      'não deu para saber o autor do PR, então não é provado que é do Dependabot'
    )
  }
  if (!AUTORES_QUE_O_VIGIA_NAO_CONSERTA.includes(pr.autor)) {
    return recusar(deps, pr.sha, `o autor é ${pr.autor}, não o Dependabot`)
  }

  if (politica === 'perguntar') {
    try {
      return await perguntarAoDono(deps, pr)
    } catch (err) {
      deps.onWarn(`dependabot-expresso: erro ao perguntar sobre o PR #${numero}: ${err}`)
      return resultado(
        `Dependabot expresso: não consegui perguntar ao dono (${(err as Error).message})`
      )
    }
  }

  // Membro de grupo que sobe junto: o irmão aberto segura o merge. Só gasta a
  // listagem quando o pacote pertence a algum grupo; sem conseguir listar, não
  // dá para afirmar que não há irmão.
  let irmaoPendente: string | null = null
  const meu = pacoteDoTitulo(pr.titulo)
  if (meu && grupoDoPacote(meu.pacote)) {
    try {
      irmaoPendente = irmaoPendenteDe({
        numero,
        titulo: pr.titulo,
        abertos: await listarAbertos(deps),
      })
    } catch (err) {
      irmaoPendente = `não deu para conferir se há PR irmão aberto (${(err as Error).message})`
    }
  }

  const decisao = decidirMergeDoDependabot({
    politica,
    verificacao: deps.verificacao,
    mergeable: deps.mergeable,
    irmaoPendente,
  })
  if (!decisao.mesclar) return recusar(deps, pr.sha, decisao.motivo)

  // Porta do merge: a cabeça viva e a base, lidas agora. O que entra na
  // principal é o que está no PR neste instante, não o que foi avaliado antes.
  let viva: PrLido
  try {
    viva = lerPrCru(await deps.ghGet(`/repos/${projeto.wingId}/pulls/${numero}`, token))
  } catch (err) {
    deps.onWarn(
      `dependabot-expresso: não deu para ler o commit atual do PR #${numero}: ${(err as Error).message}`
    )
    viva = lerPrCru(null)
  }
  if (viva.sha === null) {
    return recusar(
      deps,
      pr.sha,
      'não deu para ler o commit atual deste pull request no instante do merge — por segurança não mescla agora'
    )
  }
  const cabecaViva = viva.sha
  const branchPadrao = await branchPadraoLidaDoRepositorio(
    async () => deps.ghGet(`/repos/${projeto.wingId}`, token),
    deps.onWarn
  )
  if (branchPadrao === null) {
    return recusar(
      deps,
      pr.sha,
      'não deu para ler a branch padrão do repositório — por segurança não mescla sem saber para onde o PR deve apontar'
    )
  }

  const feito = await mesclarPr({
    numeroDoPr: numero,
    ciState: deps.verificacao === 'verde' ? 'green' : 'red',
    // Não há QA no caminho expresso: o lugar do veredito é ocupado pelas
    // provas acima (verificação real, mergeável, irmão, política). Só chega
    // aqui quem passou por todas.
    vereditoDoQa: decisao.mesclar ? 'approve' : 'unknown',
    diffTruncado: false,
    // O autor foi conferido acima e a política permite: é o pedido do dono.
    delegado: true,
    baseDoPr: viva.base,
    ramoDoPr: viva.ramo,
    corpoDoPr: viva.corpo,
    branchPadrao,
    shaRevisado: pr.sha ?? '',
    shaAtual: cabecaViva,
    entendimentoPresente: decisao.mesclar,
    lerCiAgora: async (sha) =>
      (
        await lerEstadoDoCiDoHead({
          repositorio: projeto.wingId,
          sha,
          ghGet: (caminho) => deps.ghGet(caminho, token),
        })
      ).estado,
    // Lança em falha: o motivo do GitHub sobe por `mesclarPr` até o painel.
    merge: async () => {
      await deps.ghSend('PUT', `/repos/${projeto.wingId}/pulls/${numero}/merge`, token, {
        sha: cabecaViva,
        commit_title: `Merge pull request #${numero} from Dependabot`,
        commit_message: 'Auto-merged by GitOrch (Dependabot policy)',
      })
      return true
    },
  })
  if (!feito.mesclado) return recusar(deps, cabecaViva, feito.motivo)

  await registrar(
    deps,
    `dependabot-merge:${projeto.wingId}:${numero}`,
    `GitOrch: o PR #${numero} do Dependabot estava verde e a política manda mesclar sozinho. Merge feito e issue associada pode ser fechada caso exista.`
  )
  return resultado('Mesclado pelo caminho expresso do Dependabot', true)
}

/**
 * A porta do vigia: a listagem de PRs não enriquece o Dependabot (poupa
 * rede), então o estado que a decisão exige é lido AQUI, agora.
 */
export async function decidirDependabotDoVigia(
  deps: Omit<DepsDoDependabotExpresso, 'verificacao' | 'mergeable'>
): Promise<ResultadoDoDependabot> {
  if (lerCuidaPorOrigem(deps.runtimeConfig, false).dependabot === 'nao') {
    return resultado('configuração do Dependabot é "nao", este PR não é cuidado')
  }
  let verificacao: EstadoDaVerificacao
  let mergeable: boolean | null
  let sha: string | null = null
  try {
    const pr = lerPrCru(
      await deps.ghGet(`/repos/${deps.projeto.wingId}/pulls/${deps.numero}`, deps.token)
    )
    sha = pr.sha
    mergeable = pr.mergeable
    verificacao = sha
      ? await lerVerificacao({
          repo: deps.projeto.wingId,
          sha,
          ghGet: (caminho) => deps.ghGet(caminho, deps.token),
        })
      : 'ausente'
  } catch (err) {
    return recusar(
      { ...deps, verificacao: 'pendente', mergeable: null },
      sha,
      `não deu para ler o estado do PR (${(err as Error).message})`
    )
  }
  return decidirDependabotExpresso({ ...deps, verificacao, mergeable })
}
