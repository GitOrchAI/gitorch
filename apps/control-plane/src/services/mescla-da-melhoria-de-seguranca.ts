// A mescla das melhorias de segurança que o próprio produto abriu.
//
// O aplicador abre pull requests no repositório do cliente (permissões mínimas
// dos workflows, varredura gratuita de senhas). Antes, quem os mesclava era o
// dono, e como ninguém era avisado eles ficavam parados. A regra agora segue o
// nível de autonomia do projeto:
//
//  - cuidar: o produto mescla sozinho, avisa depois (painel e Telegram) e deixa
//    o "como desfazer" no registro;
//  - sugerir: o produto pergunta ao dono (o que muda, por que é mais seguro,
//    risco, como desfazer) e só mescla com o "sim"; com o "não", fecha o pull
//    request com um comentário curto;
//  - so_olhar: nada (o projeto nem entra na passada).
//
// A mescla passa pelos MESMOS porteiros de `mesclarPr` (base = branch padrão,
// commit relido na hora, verificação verde com job real concluído, relida no
// instante do merge). O que muda é só o porteiro "pull request de segurança",
// que libera o ramo do próprio aplicador quando o projeto autoriza.
//
// Verificação de segredos vermelha NUNCA mescla: vira UM alerta ao dono (por
// pull request e commit), sem valor nem trecho do achado. Qualquer outro
// vermelho, conflito ou base errada só fica registrado, e o produto espera.
//
// O GitHub recusar o merge (405/409/422) não vira laço: o produto lembra o
// commit recusado e só tenta de novo com commit novo, até um teto.

import type { Ambiente } from './interruptores-de-seguranca.js'
import {
  motivoDoPrNaoSerDoAplicador,
  type ContextoDeExecucao,
  type RegistroDaMelhoria,
  type TentativaDeMescla,
} from './executores-de-seguranca.js'
import { campoDe } from './leitor-de-seguranca.js'
import { lerEstadoDoCiDoHead } from './estado-da-verificacao-do-github.js'
import { baseDoPrDe, branchPadraoLidaDoRepositorio } from './base-do-dev.js'
import { mesclarPr } from './merge-do-pr.js'
import { cortarPorPontoDeCodigo, mascararCredenciais, mensagemDoErro } from './texto-seguro.js'

// ------------------------------------------------------------------ segredos

/** Variável que troca a lista de nomes de verificação de segredos (separados por vírgula). */
export const VARIAVEL_DOS_NOMES_DE_VERIFICACAO_DE_SEGREDOS =
  'GITORCH_SEGURANCA_VERIFICACOES_DE_SEGREDOS'

/**
 * Regra: a verificação é "de segredos" quando o NOME do check-run contém, sem
 * diferenciar maiúscula, um destes trechos. Errar para o lado de enxergar
 * segredo demais só faz o produto não mesclar e avisar o dono.
 */
export const NOMES_PADRAO_DE_VERIFICACAO_DE_SEGREDOS: readonly string[] = [
  'gitleaks',
  'secret',
  'trufflehog',
  'detect-secrets',
  'segredo',
]

function nomesDeSegredos(env: Ambiente): readonly string[] {
  const bruto = env[VARIAVEL_DOS_NOMES_DE_VERIFICACAO_DE_SEGREDOS]
  if (bruto === undefined) return NOMES_PADRAO_DE_VERIFICACAO_DE_SEGREDOS
  const lista = bruto
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n !== '')
  return lista.length > 0 ? lista : NOMES_PADRAO_DE_VERIFICACAO_DE_SEGREDOS
}

export function ehVerificacaoDeSegredos(nome: string, env: Ambiente = {}): boolean {
  const minusculo = nome.toLowerCase()
  return nomesDeSegredos(env).some((trecho) => minusculo.includes(trecho))
}

// ------------------------------------------------------------------ modo

export type ModoDaSeguranca = 'cuidar' | 'sugerir' | 'so_olhar'

const RANK: Record<ModoDaSeguranca, number> = { so_olhar: 0, sugerir: 1, cuidar: 2 }

function nivelDe(valor: string | null | undefined): ModoDaSeguranca {
  return valor === 'cuidar' || valor === 'sugerir' ? valor : 'so_olhar'
}

/**
 * O modo da mescla é o MENOR entre a autonomia do projeto e a de segurança:
 * os dois campos podem divergir por desenho, e vale o mais restrito.
 */
export function modoDaSeguranca(projeto: {
  autonomia: string | null
  autonomiaDeSeguranca: string | null
}): ModoDaSeguranca {
  const a = nivelDe(projeto.autonomia)
  const b = nivelDe(projeto.autonomiaDeSeguranca)
  return RANK[a] <= RANK[b] ? a : b
}

// ------------------------------------------------------------------ leitura

/** Teto de recusas do GitHub por pull request; passou disso o produto desiste e deixa para o dono. */
export const TETO_DE_RECUSAS_DO_MERGE = 3

function leitorDeCaminhoCompleto(ctx: ContextoDeExecucao): (caminho: string) => Promise<unknown> {
  const prefixo = `/repos/${ctx.repositorio}`
  return async (caminho) => {
    if (!caminho.startsWith(prefixo)) throw new Error('caminho fora do repositório')
    const r = await ctx.ler(caminho.slice(prefixo.length))
    if (!r.ok) throw new Error(`o GitHub respondeu ${r.status}`)
    return r.corpo
  }
}

interface CheckLido {
  nome: string
  falhou: boolean
  url: string | null
}

async function lerChecksDoCommit(ctx: ContextoDeExecucao, sha: string): Promise<CheckLido[]> {
  const r = await ctx.ler(`/commits/${sha}/check-runs?per_page=100`)
  if (!r.ok) throw new Error(`o GitHub respondeu ${r.status}`)
  const lista = campoDe(r.corpo, 'check_runs')
  if (!Array.isArray(lista)) return []
  const saida: CheckLido[] = []
  for (const c of lista) {
    const nome = campoDe(c, 'name')
    if (typeof nome !== 'string') continue
    const conclusao = campoDe(c, 'conclusion')
    saida.push({
      nome,
      falhou: conclusao === 'failure' || conclusao === 'timed_out',
      url: urlDoGitHub(campoDe(c, 'html_url')),
    })
  }
  return saida
}

/** Só endereço do próprio GitHub entra em aviso ao dono. */
function urlDoGitHub(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.length > 300) return null
  try {
    const u = new URL(valor)
    return u.protocol === 'https:' && u.hostname === 'github.com' ? u.toString() : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ avaliação

export type AvaliacaoDoPrAberto =
  | { tipo: 'espera'; motivo: string }
  | { tipo: 'segredo'; sha: string; checks: string[]; url: string | null }
  | { tipo: 'impedido'; sha: string; motivo: string }
  | { tipo: 'pronto'; sha: string }

/**
 * Olha um pull request ABERTO do aplicador (o corpo vem de `acompanhar`, já
 * conferido como sendo dele) e diz se dá para mesclar. Só leitura.
 */
export async function avaliarPrAbertoDaMelhoria(args: {
  corpoDoPr: unknown
  ctx: ContextoDeExecucao
  env: Ambiente
}): Promise<AvaliacaoDoPrAberto> {
  const { corpoDoPr, ctx, env } = args
  const sha = campoDe(corpoDoPr, 'head', 'sha')
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    return { tipo: 'espera', motivo: 'não consegui ler o commit atual do pull request' }
  }
  const base = baseDoPrDe(corpoDoPr)
  const padrao = ctx.sondagem.branchPadrao
  if (base !== null && padrao !== null && base !== padrao) {
    return {
      tipo: 'impedido',
      sha,
      motivo: `o pull request aponta para ${base}, e não para a branch padrão ${padrao}`,
    }
  }
  const mergeable = campoDe(corpoDoPr, 'mergeable')
  if (mergeable === false) {
    return {
      tipo: 'impedido',
      sha,
      motivo: 'o pull request tem conflito com a branch padrão; o produto não refaz a mudança',
    }
  }
  if (mergeable !== true) {
    return {
      tipo: 'espera',
      motivo: 'o GitHub ainda não calculou se o pull request pode ser mesclado',
    }
  }

  let estado: string
  try {
    estado = (
      await lerEstadoDoCiDoHead({
        repositorio: ctx.repositorio,
        sha,
        ghGet: leitorDeCaminhoCompleto(ctx),
      })
    ).estado
  } catch (erro) {
    return { tipo: 'espera', motivo: `não consegui ler a verificação (${mensagemDoErro(erro)})` }
  }

  if (estado === 'green') return { tipo: 'pronto', sha }
  if (estado !== 'red') {
    return { tipo: 'espera', motivo: `a verificação automática ainda não está verde (${estado})` }
  }

  let checks: CheckLido[]
  try {
    checks = await lerChecksDoCommit(ctx, sha)
  } catch (erro) {
    return { tipo: 'espera', motivo: `não consegui ler as verificações (${mensagemDoErro(erro)})` }
  }
  const reprovados = checks.filter((c) => c.falhou)
  const deSegredos = reprovados.filter((c) => ehVerificacaoDeSegredos(c.nome, env))
  if (deSegredos.length > 0) {
    return {
      tipo: 'segredo',
      sha,
      checks: [...new Set(deSegredos.map((c) => c.nome))],
      url: deSegredos.find((c) => c.url !== null)?.url ?? null,
    }
  }
  const nomes = [...new Set(reprovados.map((c) => c.nome))].slice(0, 3)
  return {
    tipo: 'impedido',
    sha,
    motivo:
      nomes.length > 0
        ? `a verificação ${nomes.map((n) => `"${n}"`).join(', ')} falhou; espero ela passar`
        : 'a verificação automática está vermelha; espero ela passar',
  }
}

// ------------------------------------------------------------------ mesclar

export type DesfechoDoMerge =
  | { tipo: 'mesclado' }
  | { tipo: 'barrado'; motivo: string }
  | { tipo: 'recusado'; status: number | null; motivo: string }
  | { tipo: 'incerto'; motivo: string }

/**
 * A mescla de verdade, pelos porteiros de `mesclarPr`. Relê o pull request
 * (commit, base, ramo, corpo) e a verificação na porta do merge, e o PUT leva o
 * commit esperado: se alguém empurrou algo depois, o GitHub recusa (409).
 */
export async function mesclarPrDaMelhoria(args: {
  registro: Pick<RegistroDaMelhoria, 'pr'>
  ctx: ContextoDeExecucao
  shaAvaliada: string
}): Promise<DesfechoDoMerge> {
  const { registro, ctx, shaAvaliada } = args
  const pr = registro.pr
  if (!pr) return { tipo: 'barrado', motivo: 'o registro não tem o número do pull request' }
  if (ctx.tokenDoApp === null) {
    return { tipo: 'barrado', motivo: 'não tenho a credencial do App neste repositório' }
  }
  const token = ctx.tokenDoApp
  const ghGet = leitorDeCaminhoCompleto(ctx)

  let viva: unknown
  try {
    const r = await ctx.ler(`/pulls/${pr.numero}`)
    if (!r.ok) return { tipo: 'barrado', motivo: `não consegui reler o pull request (${r.status})` }
    viva = r.corpo
  } catch (erro) {
    return {
      tipo: 'barrado',
      motivo: `não consegui reler o pull request (${mensagemDoErro(erro)})`,
    }
  }
  const naoEh = motivoDoPrNaoSerDoAplicador(viva, pr)
  if (naoEh !== null) return { tipo: 'barrado', motivo: naoEh }
  if (campoDe(viva, 'state') !== 'open') {
    return { tipo: 'incerto', motivo: `o pull request #${pr.numero} já não está aberto` }
  }
  const shaViva = campoDe(viva, 'head', 'sha')
  const branchPadrao = await branchPadraoLidaDoRepositorio(() => ghGet(`/repos/${ctx.repositorio}`))
  if (typeof shaViva !== 'string' || branchPadrao === null) {
    return {
      tipo: 'barrado',
      motivo: 'não consegui ler o commit atual ou a branch padrão no instante do merge',
    }
  }
  const corpoTexto = campoDe(viva, 'body')

  let chamou = false
  let status: number | null = null
  const feito = await mesclarPr({
    numeroDoPr: pr.numero,
    // As provas reais estão acima e na releitura abaixo; estes campos só
    // existem porque o caminho de entrega do dev tem QA e o daqui não.
    ciState: 'green',
    vereditoDoQa: 'approve',
    diffTruncado: false,
    delegado: true,
    entendimentoPresente: true,
    baseDoPr: baseDoPrDe(viva),
    ramoDoPr:
      typeof campoDe(viva, 'head', 'ref') === 'string'
        ? (campoDe(viva, 'head', 'ref') as string)
        : null,
    corpoDoPr: typeof corpoTexto === 'string' ? corpoTexto : null,
    branchPadrao,
    shaRevisado: shaAvaliada,
    shaAtual: shaViva,
    lerCiAgora: async (sha) =>
      (await lerEstadoDoCiDoHead({ repositorio: ctx.repositorio, sha, ghGet })).estado,
    melhoriaDeSegurancaDoProduto: true,
    merge: async () => {
      chamou = true
      const resposta = await ctx.escritor.enviar({
        acao: 'mesclar-pr-de-seguranca',
        caminho: `/pulls/${pr.numero}/merge`,
        corpo: {
          sha: shaViva,
          commit_title: `Segurança: mescla o pull request #${pr.numero} (GitOrch)`,
          commit_message: 'Mesclado pelo GitOrch: o projeto está em Cuidar e a verificação passou.',
        },
        token,
      })
      status = resposta.status
      if (!resposta.ok) {
        throw new Error(
          `o GitHub recusou (${resposta.status}): ${resposta.mensagem ?? 'sem detalhe'}`
        )
      }
      return true
    },
  })

  if (!feito.mesclado) {
    const motivo = cortarPorPontoDeCodigo(mascararCredenciais(feito.motivo, [token]), 400)
    return chamou ? { tipo: 'recusado', status, motivo } : { tipo: 'barrado', motivo }
  }

  // 2xx sem confirmação nunca é "mesclado": relê.
  try {
    const depois = await ctx.ler(`/pulls/${pr.numero}`)
    const mesclado =
      depois.ok &&
      (campoDe(depois.corpo, 'merged') === true ||
        typeof campoDe(depois.corpo, 'merged_at') === 'string')
    if (mesclado) return { tipo: 'mesclado' }
  } catch {
    // cai no incerto abaixo
  }
  return { tipo: 'incerto', motivo: 'o GitHub aceitou o merge, mas a releitura não confirmou' }
}

/** O "não" do dono: fecha o pull request, comenta e apaga o ramo (o ramo é best-effort). */
export async function fecharPrRecusadoPeloDono(args: {
  registro: Pick<RegistroDaMelhoria, 'pr'>
  ctx: ContextoDeExecucao
}): Promise<{ fechado: boolean; motivo: string }> {
  const { registro, ctx } = args
  const pr = registro.pr
  if (!pr || ctx.tokenDoApp === null) {
    return { fechado: false, motivo: 'não tenho o pull request ou a credencial do App' }
  }
  const token = ctx.tokenDoApp
  try {
    const fechado = await ctx.escritor.enviar({
      acao: 'fechar-pr-de-seguranca',
      caminho: `/pulls/${pr.numero}`,
      corpo: { state: 'closed' },
      token,
    })
    if (!fechado.ok) {
      return {
        fechado: false,
        motivo: `o GitHub não deixou fechar o pull request (${fechado.status})`,
      }
    }
    await ctx.escritor.enviar({
      acao: 'comentar-pr-de-seguranca',
      caminho: `/issues/${pr.numero}/comments`,
      corpo: {
        body: 'Fechado pelo GitOrch a pedido do dono do projeto: a melhoria de segurança não foi aprovada.',
      },
      token,
    })
    await ctx.escritor.enviar({
      acao: 'apagar-ramo-de-seguranca',
      caminho: `/git/refs/heads/${pr.ramo}`,
      token,
    })
    return { fechado: true, motivo: `pull request #${pr.numero} fechado a pedido do dono` }
  } catch (erro) {
    return {
      fechado: false,
      motivo: cortarPorPontoDeCodigo(mascararCredenciais(mensagemDoErro(erro), [token]), 300),
    }
  }
}

// ------------------------------------------------------------------ textos

export function lerTentativaDeMescla(
  registro: Pick<RegistroDaMelhoria, 'mescla'>
): TentativaDeMescla | null {
  const t: unknown = registro.mescla
  const sha = campoDe(t, 'sha')
  const recusas = campoDe(t, 'recusas')
  const motivo = campoDe(t, 'motivo')
  if (typeof recusas !== 'number' || typeof motivo !== 'string') return null
  return { sha: typeof sha === 'string' ? sha : null, motivo, recusas }
}

export function textoDoAvisoDeMesclada(args: {
  repositorio: string
  numero: number
  nome: string
  url: string | null
}): string {
  return (
    `GitOrch: mesclei o pull request #${args.numero} em ${args.repositorio} (${args.nome}). ` +
    'A verificação automática passou e o projeto está em "Cuidar". ' +
    `Para desfazer, reverta o pull request #${args.numero}${args.url ? ` (${args.url})` : ''}.`
  )
}

export function textoDoAlertaDeSegredo(args: {
  repositorio: string
  numero: number
  checks: readonly string[]
  url: string | null
}): string {
  return (
    `Atenção em ${args.repositorio}: a verificação de segredos (${args.checks.join(', ')}) falhou no pull request #${args.numero} ` +
    'e achou um segredo exposto no repositório. Troque esse segredo o quanto antes (crie um novo e revogue o antigo). ' +
    `Não mesclei nada.${args.url ? ` Veja a execução: ${args.url}` : ''}`
  )
}

interface DescricaoDaMudanca {
  oQueMuda: string
  porQueEMaisSeguro: string
  risco: string
}

const DESCRICOES: Record<string, DescricaoDaMudanca> = {
  'permissoes-minimas-dos-workflows': {
    oQueMuda: 'reduz a permissão do token de uma automação do repositório para só leitura',
    porQueEMaisSeguro:
      'se alguém conseguir explorar a automação, ela não consegue escrever no repositório',
    risco:
      'se algum passo da automação precisar escrever (publicar, comentar), ele pode falhar; a verificação passou, o que indica que não',
  },
  'alternativa-de-varredura-de-senhas': {
    oQueMuda: 'liga uma verificação gratuita que procura senhas e chaves em cada mudança',
    porQueEMaisSeguro: 'avisa na hora se alguém commitar uma senha ou chave',
    risco:
      'pode apontar achados antigos e deixar pull requests de outras pessoas vermelhos até serem tratados',
  },
}

const DESCRICAO_PADRAO: DescricaoDaMudanca = {
  oQueMuda: 'aplica uma melhoria de segurança no repositório',
  porQueEMaisSeguro: 'reduz a chance de um problema de segurança',
  risco: 'pode mudar o comportamento de alguma automação; a verificação passou',
}

export function textoDaPerguntaDeMescla(args: {
  repositorio: string
  numero: number
  idBase: string
  nome: string
}): string {
  const d = DESCRICOES[args.idBase] ?? DESCRICAO_PADRAO
  return (
    `Posso mesclar o pull request #${args.numero} de ${args.repositorio} (${args.nome})?\n\n` +
    `O que muda: ${d.oQueMuda}.\n` +
    `Por que é mais seguro: ${d.porQueEMaisSeguro}.\n` +
    `Risco: ${d.risco}.\n` +
    `Como desfazer: reverta o pull request #${args.numero} depois de mesclado, ou feche-o antes.\n\n` +
    'A verificação automática passou. Eu só mesclo se você disser sim.'
  )
}
