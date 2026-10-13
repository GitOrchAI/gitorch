// Os executores das melhorias de segurança: cada um faz UMA melhoria, do começo
// ao fim, com a mesma disciplina:
//  1. relê o estado ANTES de escrever (a sondagem tem até um dia; o "estado
//     anterior" guardado para o desfazer tem de ser o de agora, não o de ontem);
//  2. escreve com a chamada exata, pela porta de escrita (lista branca + ritmo);
//  3. relê DEPOIS para confirmar. 2xx sem confirmação é "incerto", nunca "aplicado".
//
// Mudança em ARQUIVO do repositório é sempre por pull request: ramo próprio, um
// arquivo, um PR. A branch padrão nunca recebe commit direto (a porta de escrita
// nem aceita esse ramo).
//
// Nada aqui decide se PODE: as travas (autonomia, interruptores, lista de
// projetos) ficam em `aplicar-melhoria-de-seguranca.ts`.

import { Buffer } from 'node:buffer'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import { cortarPorPontoDeCodigo, mascararCredenciais } from './texto-seguro.js'
import {
  CAMINHO_DO_WORKFLOW_DE_SENHAS,
  GITLEAKS_VERSION,
  workflowDeAlternativaGratuita,
} from './alternativa-gratuita-de-seguranca.js'
import { type AcaoDeSeguranca, type EscritorDeSeguranca } from './escritor-de-seguranca.js'
import { MARCA_DO_PR_DE_SEGURANCA, PREFIXO_DOS_RAMOS_DE_SEGURANCA } from './pr-de-seguranca.js'
import { campoDe, erroDeRedeSeguro, type RespostaDoGitHub } from './leitor-de-seguranca.js'
import {
  respostaDizIndisponivel,
  type SondagemDoRepositorio,
  type WorkflowSondado,
} from './sondagem-de-seguranca.js'
import {
  adicionarPermissoesMinimas,
  analisarWorkflow,
  caminhoDeWorkflowValido,
  removerPermissoesMinimas,
} from './workflows-de-seguranca.js'

export type EstadoDaMelhoria =
  | 'aplicado'
  | 'aguardando-revisao'
  | 'aguardando-dono'
  | 'recusado'
  | 'indisponivel'
  | 'incerto'
  | 'falhou'
  | 'desfeito'
  | 'dispensado'

export interface RegistroDoPr {
  numero: number
  ramo: string
  caminho: string
  acao: 'criar' | 'editar' | 'apagar'
  url: string | null
}

const RAMO_DO_GITORCH = /^gitorch\/seguranca\/[A-Za-z0-9._-]+$/

/** O que vem do banco não é confiado: o pull request guardado precisa ter a forma que o GitOrch grava. */
export function ehRegistroDoPr(v: unknown): v is RegistroDoPr {
  const numero = campoDe(v, 'numero')
  const ramo = campoDe(v, 'ramo')
  const caminho = campoDe(v, 'caminho')
  const acao = campoDe(v, 'acao')
  const url = campoDe(v, 'url')
  return (
    typeof numero === 'number' &&
    Number.isInteger(numero) &&
    numero > 0 &&
    typeof ramo === 'string' &&
    RAMO_DO_GITORCH.test(ramo) &&
    !ramo.includes('..') &&
    typeof caminho === 'string' &&
    caminhoDeWorkflowValido(caminho) &&
    (acao === 'criar' || acao === 'editar' || acao === 'apagar') &&
    (url === null || (typeof url === 'string' && url.startsWith('https://') && url.length <= 300))
  )
}

/** O que a ficha guarda de cada melhoria. */
export interface RegistroDaMelhoria {
  estado: EstadoDaMelhoria
  atualizadoEm: string
  proximaTentativaEm: string | null
  tentativas: number
  motivo: string
  /** O valor de ANTES da mudança, para o desfazer. */
  anterior?: unknown
  pr?: RegistroDoPr
  /** O texto do "como desfazer" mostrado no painel. */
  desfazer: string
  /** A última vez que o produto olhou este pull request para mesclar e não mesclou. */
  mescla?: TentativaDeMescla
}

/** O que a mescla automática lembra entre uma passada e outra depois de o GitHub recusar o merge (sem isso viraria laço). */
export interface TentativaDeMescla {
  /** Commit do pull request na última tentativa que não terminou em merge. */
  sha: string | null
  /** O que impediu, em português simples. */
  motivo: string
  /** Quantas vezes o GitHub recusou o merge ao todo; passou do teto, o produto desiste. */
  recusas: number
}

export interface ResultadoDaAplicacao {
  estado:
    | 'aplicado'
    | 'aguardando-revisao'
    | 'recusado'
    | 'indisponivel'
    | 'incerto'
    | 'falhou'
    | 'dispensado'
  motivo: string
  anterior?: unknown
  pr?: RegistroDoPr
  /** O GitHub limitou a taxa: tentar de novo em pouco tempo. */
  limitada?: boolean
}

export interface ContextoDeExecucao {
  repositorio: string
  /**
   * A credencial da CONFIGURAÇÃO (a que a sondagem provou ter administração) e
   * das leituras. Nunca assina um pull request.
   */
  token: string
  /**
   * A credencial do App (instalação). Assina TODA escrita de pull request (ramo,
   * arquivo, abertura, fechamento): o autor é o App, nunca a conta do dono nem
   * a do cliente. `null` = sem App neste repositório, e então não há pull request.
   */
  tokenDoApp: string | null
  escritor: EscritorDeSeguranca
  /** Leitura com a mesma credencial da escrita. */
  ler: (caminho: string) => Promise<RespostaDoGitHub>
  sondagem: SondagemDoRepositorio
  agora: Date
}

// ------------------------------------------------------------------ respostas

export type ClasseDaResposta = 'ok' | 'indisponivel' | 'recusado' | 'cota' | 'falhou'

/** O que uma resposta de ESCRITA quer dizer. */
export function classificarRespostaDeEscrita(
  r: Pick<RespostaDoGitHub, 'ok' | 'status' | 'mensagem' | 'limitada'>
): ClasseDaResposta {
  if (r.ok) return 'ok'
  if (r.limitada) return 'cota'
  if (r.status >= 500) return 'falhou'
  if (respostaDizIndisponivel(r)) return 'indisponivel'
  return 'recusado'
}

function resultadoDeErro(
  classe: Exclude<ClasseDaResposta, 'ok'>,
  r: RespostaDoGitHub,
  oQueFazia: string
): ResultadoDaAplicacao {
  const detalhe = r.mensagem ?? 'sem mensagem'
  switch (classe) {
    case 'indisponivel':
      return {
        estado: 'indisponivel',
        motivo: `o GitHub diz que isto não existe aqui (${r.status}): ${detalhe}`,
      }
    case 'recusado':
      return {
        estado: 'recusado',
        motivo: `o GitHub recusou ${oQueFazia} (${r.status}): ${detalhe}`,
      }
    case 'cota':
      return {
        estado: 'falhou',
        limitada: true,
        motivo: `limite de taxa do GitHub ao ${oQueFazia} (${r.status}): ${detalhe}`,
      }
    case 'falhou':
      return {
        estado: 'falhou',
        motivo: `erro do GitHub ao ${oQueFazia} (${r.status}): ${detalhe}`,
      }
  }
}

/** As escritas que montam ou encerram um pull request: assinadas só pelo App. */
const ACOES_DE_PULL_REQUEST: ReadonlySet<AcaoDeSeguranca> = new Set<AcaoDeSeguranca>([
  'criar-ramo-de-seguranca',
  'gravar-arquivo-no-ramo',
  'apagar-arquivo-no-ramo',
  'abrir-pr-de-seguranca',
  'fechar-pr-de-seguranca',
  'comentar-pr-de-seguranca',
  'mesclar-pr-de-seguranca',
  'apagar-ramo-de-seguranca',
])

const MOTIVO_SEM_APP =
  'não há o App do produto neste repositório (ou não consegui a credencial dele): o aplicador só abre ' +
  'pull request como o App, nunca com a conta de uma pessoa'

const semApp = (): ResultadoDaAplicacao => ({ estado: 'recusado', motivo: MOTIVO_SEM_APP })

/** Uma escrita; erro de rede vira `null` (o resultado é desconhecido: pode ter chegado). */
async function escrever(
  ctx: ContextoDeExecucao,
  acao: AcaoDeSeguranca,
  caminho: string,
  corpo?: unknown
): Promise<{ resposta: RespostaDoGitHub } | { erroDeRede: string }> {
  // Pull request: só com o token do App. A configuração usa o da sondagem.
  const token = ACOES_DE_PULL_REQUEST.has(acao) ? ctx.tokenDoApp : ctx.token
  if (token === null) throw new Error(MOTIVO_SEM_APP)
  try {
    const resposta = await ctx.escritor.enviar({
      acao,
      caminho,
      ...(corpo !== undefined ? { corpo } : {}),
      token,
    })
    return { resposta }
  } catch (erro) {
    if (erro instanceof Error && erro.name === 'AcaoForaDaListaBrancaError') throw erro
    // A guarda de autonomia recusou: não é falha de rede e não é "incerto"
    // (nada saiu). Sobe como recusa, com o motivo dela.
    if (erro instanceof EscritaNaoAutorizadaError) throw erro
    return { erroDeRede: erroDeRedeSeguro(erro, token) }
  }
}

async function lerSeguro(
  ctx: ContextoDeExecucao,
  caminho: string
): Promise<RespostaDoGitHub | null> {
  try {
    return await ctx.ler(caminho)
  } catch (erro) {
    if (erro instanceof DOMException && erro.name === 'AbortError') throw erro
    return null
  }
}

const incertoPorRede = (erro: string): ResultadoDaAplicacao => ({
  estado: 'incerto',
  motivo: `a escrita pode ter chegado ao GitHub, mas a conexão caiu (${erro}); confira na próxima passada`,
})

// ------------------------------------------------------------------ configuração

export type MelhoriaDeConfiguracao =
  | 'alertas-de-dependencias'
  | 'atualizacoes-de-seguranca'
  | 'varredura-de-senhas'
  | 'varredura-de-codigo'
  | 'permissao-padrao-do-workflow'

const estadoDaSeguranca = (v: unknown): 'enabled' | 'disabled' | null =>
  v === 'enabled' || v === 'disabled' ? v : null

function leituraIndisponivel(r: RespostaDoGitHub | null): ResultadoDaAplicacao {
  if (r === null) {
    return {
      estado: 'falhou',
      motivo: 'não consegui reler o estado antes de escrever (rede); nada foi escrito',
    }
  }
  if (respostaDizIndisponivel(r)) {
    return {
      estado: 'indisponivel',
      motivo: `o GitHub diz que isto não existe aqui (${r.status}): ${r.mensagem ?? ''}`,
    }
  }
  return {
    estado: 'falhou',
    motivo: `não consegui reler o estado antes de escrever (${r.status}): ${r.mensagem ?? 'sem mensagem'}; nada foi escrito`,
  }
}

interface LeituraDeConfiguracao {
  /** O valor lido, ou `null` se a leitura não serviu. */
  valor: unknown
  r: RespostaDoGitHub | null
}

async function lerConfiguracao(
  id: MelhoriaDeConfiguracao,
  ctx: ContextoDeExecucao
): Promise<LeituraDeConfiguracao> {
  switch (id) {
    case 'alertas-de-dependencias': {
      const r = await lerSeguro(ctx, '/vulnerability-alerts')
      if (r === null) return { valor: null, r }
      if (r.status === 204 || r.status === 200) return { valor: 'ligado', r }
      if (r.status === 404 && !respostaDizIndisponivel(r)) return { valor: 'desligado', r }
      return { valor: null, r }
    }
    case 'atualizacoes-de-seguranca': {
      const r = await lerSeguro(ctx, '/automated-security-fixes')
      if (r === null) return { valor: null, r }
      if (r.ok) {
        const ativo = campoDe(r.corpo, 'enabled')
        return { valor: ativo === true ? 'ligado' : ativo === false ? 'desligado' : null, r }
      }
      if (r.status === 404 && !respostaDizIndisponivel(r)) return { valor: 'desligado', r }
      return { valor: null, r }
    }
    case 'varredura-de-senhas': {
      const r = await lerSeguro(ctx, '')
      if (r === null || !r.ok) return { valor: null, r }
      const segredos = estadoDaSeguranca(
        campoDe(r.corpo, 'security_and_analysis', 'secret_scanning', 'status')
      )
      const push = estadoDaSeguranca(
        campoDe(r.corpo, 'security_and_analysis', 'secret_scanning_push_protection', 'status')
      )
      if (segredos === null && push === null) return { valor: null, r }
      return { valor: { segredos, bloqueioDePush: push }, r }
    }
    case 'varredura-de-codigo': {
      const r = await lerSeguro(ctx, '/code-scanning/default-setup')
      if (r === null || !r.ok) return { valor: null, r }
      const estado = campoDe(r.corpo, 'state')
      return { valor: estado === 'configured' || estado === 'not-configured' ? estado : null, r }
    }
    case 'permissao-padrao-do-workflow': {
      const r = await lerSeguro(ctx, '/actions/permissions/workflow')
      if (r === null || !r.ok) return { valor: null, r }
      const padrao = campoDe(r.corpo, 'default_workflow_permissions')
      if (padrao !== 'read' && padrao !== 'write') return { valor: null, r }
      const aprova = campoDe(r.corpo, 'can_approve_pull_request_reviews')
      return {
        valor: { permissao: padrao, podeAprovarPrs: typeof aprova === 'boolean' ? aprova : null },
        r,
      }
    }
  }
}

/** O estado lido já é o que a melhoria quer? */
function jaEstaAplicada(id: MelhoriaDeConfiguracao, valor: unknown): boolean {
  switch (id) {
    case 'alertas-de-dependencias':
    case 'atualizacoes-de-seguranca':
      return valor === 'ligado'
    case 'varredura-de-codigo':
      return valor === 'configured'
    case 'varredura-de-senhas':
      return (
        campoDe(valor, 'segredos') === 'enabled' && campoDe(valor, 'bloqueioDePush') === 'enabled'
      )
    case 'permissao-padrao-do-workflow':
      return campoDe(valor, 'permissao') === 'read'
  }
}

export async function executarMelhoriaDeConfiguracao(
  id: MelhoriaDeConfiguracao,
  ctx: ContextoDeExecucao
): Promise<ResultadoDaAplicacao> {
  const antes = await lerConfiguracao(id, ctx)
  if (antes.valor === null) return leituraIndisponivel(antes.r)
  if (jaEstaAplicada(id, antes.valor)) {
    return { estado: 'dispensado', motivo: 'já estava ligado antes do GitOrch; nada foi escrito' }
  }

  let acao: AcaoDeSeguranca
  let caminho: string
  let corpo: unknown
  let anterior: unknown
  switch (id) {
    case 'alertas-de-dependencias':
      acao = 'ativar-alertas-de-dependencias'
      caminho = '/vulnerability-alerts'
      anterior = { alertas: 'desligado' }
      break
    case 'atualizacoes-de-seguranca':
      acao = 'ativar-atualizacoes-de-seguranca'
      caminho = '/automated-security-fixes'
      anterior = { atualizacoes: 'desligado' }
      break
    case 'varredura-de-senhas': {
      acao = 'configurar-varredura-de-senhas'
      caminho = ''
      const segredos = campoDe(antes.valor, 'segredos')
      const push = campoDe(antes.valor, 'bloqueioDePush')
      const mudar: Record<string, { status: 'enabled' }> = {}
      const guardar: Record<string, 'disabled'> = {}
      if (segredos === 'disabled') {
        mudar['secret_scanning'] = { status: 'enabled' }
        guardar['segredos'] = 'disabled'
      }
      if (push === 'disabled') {
        mudar['secret_scanning_push_protection'] = { status: 'enabled' }
        guardar['bloqueioDePush'] = 'disabled'
      }
      corpo = { security_and_analysis: mudar }
      anterior = guardar
      break
    }
    case 'varredura-de-codigo':
      acao = 'configurar-varredura-de-codigo'
      caminho = '/code-scanning/default-setup'
      corpo = { state: 'configured', query_suite: 'default' }
      anterior = { codigo: 'not-configured' }
      break
    case 'permissao-padrao-do-workflow': {
      acao = 'definir-permissao-padrao-do-workflow'
      caminho = '/actions/permissions/workflow'
      const aprova = campoDe(antes.valor, 'podeAprovarPrs')
      corpo = {
        default_workflow_permissions: 'read',
        ...(typeof aprova === 'boolean' ? { can_approve_pull_request_reviews: aprova } : {}),
      }
      anterior = { permissao: campoDe(antes.valor, 'permissao'), podeAprovarPrs: aprova ?? null }
      break
    }
  }

  const envio = await escrever(ctx, acao, caminho, corpo)
  if ('erroDeRede' in envio) return incertoPorRede(envio.erroDeRede)
  const classe = classificarRespostaDeEscrita(envio.resposta)
  if (classe !== 'ok') return resultadoDeErro(classe, envio.resposta, 'aplicar')

  const depois = await lerConfiguracao(id, ctx)
  if (depois.valor !== null && jaEstaAplicada(id, depois.valor)) {
    return { estado: 'aplicado', motivo: 'escrito e confirmado na releitura', anterior }
  }
  return {
    estado: 'incerto',
    motivo:
      'o GitHub aceitou a escrita, mas a releitura não mostrou o novo valor; confira na próxima passada',
    anterior,
  }
}

/**
 * Depois de um "incerto": só LÊ. Se o valor novo está lá, é "aplicado"; se a
 * leitura mostra que não está, a escrita não valeu (pode tentar de novo);
 * se a leitura falha, continua "incerto".
 */
export async function conferirConfiguracaoAplicada(
  id: MelhoriaDeConfiguracao,
  ctx: ContextoDeExecucao
): Promise<ResultadoDaAplicacao> {
  const lido = await lerConfiguracao(id, ctx)
  if (lido.valor === null) {
    return { estado: 'incerto', motivo: 'ainda não consegui reler o estado para confirmar' }
  }
  if (jaEstaAplicada(id, lido.valor)) {
    return { estado: 'aplicado', motivo: 'confirmado na releitura' }
  }
  return { estado: 'falhou', motivo: 'a releitura mostra que a escrita não valeu; tenta de novo' }
}

// ------------------------------------------------------------------ pull requests

const dono = (repositorio: string): string => repositorio.split('/', 1)[0] ?? ''

/** Um nome de ramo como caminho de URL: cada trecho codificado, as barras mantidas. */
const caminhoDoRef = (nome: string): string => nome.split('/').map(encodeURIComponent).join('/')

function slugDe(caminho: string): string {
  const arquivo = caminho.split('/').pop() ?? caminho
  return arquivo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function ramoDeAlternativaDeSenhas(): string {
  return `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}alternativa-de-varredura-de-senhas`
}

export function ramoDePermissoesMinimas(caminho: string): string {
  return `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}permissoes-${slugDe(caminho)}`
}

function ramoDoDesfazer(ramoOriginal: string): string {
  return `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}desfazer-${ramoOriginal.slice(PREFIXO_DOS_RAMOS_DE_SEGURANCA.length)}`
}

interface PrDoRamo {
  numero: number
  estado: 'open' | 'merged' | 'closed'
  url: string | null
}

async function procurarPrDoRamo(
  ctx: ContextoDeExecucao,
  ramo: string
): Promise<PrDoRamo | null | 'erro'> {
  const r = await lerSeguro(
    ctx,
    `/pulls?head=${encodeURIComponent(`${dono(ctx.repositorio)}:${ramo}`)}&state=all&per_page=5`
  )
  if (r === null || !r.ok || !Array.isArray(r.corpo)) return 'erro'
  const primeiro: unknown = r.corpo[0]
  if (primeiro === undefined) return null
  const numero = campoDe(primeiro, 'number')
  if (typeof numero !== 'number') return 'erro'
  const url = campoDe(primeiro, 'html_url')
  const fundido =
    campoDe(primeiro, 'merged') === true || typeof campoDe(primeiro, 'merged_at') === 'string'
  const aberto = campoDe(primeiro, 'state') === 'open'
  return {
    numero,
    estado: fundido ? 'merged' : aberto ? 'open' : 'closed',
    url: typeof url === 'string' ? url : null,
  }
}

function resultadoDoPrExistente(
  pr: PrDoRamo,
  registro: Omit<RegistroDoPr, 'numero' | 'url'>
): ResultadoDaAplicacao {
  const ref: RegistroDoPr = { ...registro, numero: pr.numero, url: pr.url }
  if (pr.estado === 'open') {
    return {
      estado: 'aguardando-revisao',
      motivo: `o pull request #${pr.numero} está aberto, esperando revisão`,
      pr: ref,
    }
  }
  if (pr.estado === 'merged') {
    return { estado: 'aplicado', motivo: `o pull request #${pr.numero} foi mesclado`, pr: ref }
  }
  return {
    estado: 'dispensado',
    motivo: `o pull request #${pr.numero} foi fechado sem mesclar; não abro outro`,
    pr: ref,
  }
}

interface ArquivoLido {
  texto: string
  sha: string
}

async function lerArquivoNoRamo(
  ctx: ContextoDeExecucao,
  caminho: string,
  ramo: string
): Promise<ArquivoLido | 'ausente' | 'erro'> {
  const r = await lerSeguro(ctx, `/contents/${caminho}?ref=${encodeURIComponent(ramo)}`)
  if (r === null) return 'erro'
  if (r.status === 404) return 'ausente'
  const conteudo = campoDe(r.corpo, 'content')
  const sha = campoDe(r.corpo, 'sha')
  if (!r.ok || typeof conteudo !== 'string' || typeof sha !== 'string') return 'erro'
  return { texto: Buffer.from(conteudo, 'base64').toString('utf8'), sha }
}

interface PedidoDePr {
  ramo: string
  caminho: string
  acao: RegistroDoPr['acao']
  /** `null` apaga o arquivo. */
  conteudoNovo: string | null
  titulo: string
  corpoDoPr: string
  mensagemDoCommit: string
}

async function abrirPrDeAlteracao(
  ctx: ContextoDeExecucao,
  pedido: PedidoDePr
): Promise<ResultadoDaAplicacao> {
  const base = ctx.sondagem.branchPadrao
  if (base === null)
    return { estado: 'falhou', motivo: 'não sei qual é a branch padrão do repositório' }
  const registroBase = { ramo: pedido.ramo, caminho: pedido.caminho, acao: pedido.acao }

  // 1) o ramo do GitOrch existe? Se não, nasce da ponta da branch padrão.
  const refDaBase = await lerSeguro(ctx, `/git/ref/heads/${caminhoDoRef(base)}`)
  const shaDaBase = campoDe(refDaBase?.corpo, 'object', 'sha')
  if (refDaBase === null || !refDaBase.ok || typeof shaDaBase !== 'string') {
    return { estado: 'falhou', motivo: 'não consegui ler a ponta da branch padrão' }
  }
  const refDoRamo = await lerSeguro(ctx, `/git/ref/heads/${caminhoDoRef(pedido.ramo)}`)
  if (refDoRamo === null || (!refDoRamo.ok && refDoRamo.status !== 404)) {
    return { estado: 'falhou', motivo: 'não consegui conferir se o ramo já existe' }
  }
  if (refDoRamo.status === 404) {
    const criado = await escrever(ctx, 'criar-ramo-de-seguranca', '/git/refs', {
      ref: `refs/heads/${pedido.ramo}`,
      sha: shaDaBase,
    })
    if ('erroDeRede' in criado) return incertoPorRede(criado.erroDeRede)
    const classe = classificarRespostaDeEscrita(criado.resposta)
    if (classe !== 'ok') return resultadoDeErro(classe, criado.resposta, 'criar o ramo')
  }

  // 2) o arquivo no ramo: só grava se ainda não está como deve ficar.
  const noRamo = await lerArquivoNoRamo(ctx, pedido.caminho, pedido.ramo)
  if (noRamo === 'erro') return { estado: 'falhou', motivo: 'não consegui ler o arquivo no ramo' }
  if (pedido.conteudoNovo === null) {
    if (noRamo !== 'ausente') {
      const apagado = await escrever(ctx, 'apagar-arquivo-no-ramo', `/contents/${pedido.caminho}`, {
        message: pedido.mensagemDoCommit,
        sha: noRamo.sha,
        branch: pedido.ramo,
      })
      if ('erroDeRede' in apagado) return incertoPorRede(apagado.erroDeRede)
      const classe = classificarRespostaDeEscrita(apagado.resposta)
      if (classe !== 'ok')
        return resultadoDeErro(classe, apagado.resposta, 'apagar o arquivo no ramo')
    }
  } else if (noRamo === 'ausente' || noRamo.texto !== pedido.conteudoNovo) {
    const gravado = await escrever(ctx, 'gravar-arquivo-no-ramo', `/contents/${pedido.caminho}`, {
      message: pedido.mensagemDoCommit,
      content: Buffer.from(pedido.conteudoNovo, 'utf8').toString('base64'),
      branch: pedido.ramo,
      ...(noRamo === 'ausente' ? {} : { sha: noRamo.sha }),
    })
    if ('erroDeRede' in gravado) return incertoPorRede(gravado.erroDeRede)
    const classe = classificarRespostaDeEscrita(gravado.resposta)
    if (classe !== 'ok')
      return resultadoDeErro(classe, gravado.resposta, 'gravar o arquivo no ramo')
  }

  // 3) o pull request.
  const aberto = await escrever(ctx, 'abrir-pr-de-seguranca', '/pulls', {
    title: pedido.titulo,
    body: pedido.corpoDoPr,
    head: pedido.ramo,
    base,
  })
  if ('erroDeRede' in aberto) return incertoPorRede(aberto.erroDeRede)
  const classe = classificarRespostaDeEscrita(aberto.resposta)
  if (classe !== 'ok') return resultadoDeErro(classe, aberto.resposta, 'abrir o pull request')
  const numero = campoDe(aberto.resposta.corpo, 'number')
  if (typeof numero !== 'number') {
    return {
      estado: 'incerto',
      motivo: 'o GitHub aceitou abrir o pull request, mas não devolveu o número',
    }
  }

  const confere = await lerSeguro(ctx, `/pulls/${numero}`)
  const url = campoDe(aberto.resposta.corpo, 'html_url')
  const pr: RegistroDoPr = { ...registroBase, numero, url: typeof url === 'string' ? url : null }
  if (
    confere !== null &&
    confere.ok &&
    campoDe(confere.corpo, 'state') === 'open' &&
    campoDe(confere.corpo, 'head', 'ref') === pedido.ramo
  ) {
    return {
      estado: 'aguardando-revisao',
      motivo: `pull request #${numero} aberto, esperando revisão`,
      pr,
    }
  }
  return {
    estado: 'incerto',
    motivo: `abri o pull request #${numero}, mas a releitura não o mostrou aberto; confira na próxima passada`,
    pr,
  }
}

function corpoDoPr(secoes: { oQueMuda: string; porQue: string; comoReverter: string }): string {
  return (
    `${MARCA_DO_PR_DE_SEGURANCA}\n\n` +
    `## O que muda\n\n${secoes.oQueMuda}\n\n` +
    `## Por que\n\n${secoes.porQue}\n\n` +
    `## Como reverter\n\n${secoes.comoReverter}\n\n` +
    '_Aberto automaticamente pelo GitOrch. Nada foi gravado na branch principal: a mudança só vale se este pull request for mesclado._\n'
  )
}

export async function executarAlternativaDeSenhas(
  ctx: ContextoDeExecucao
): Promise<ResultadoDaAplicacao> {
  if (ctx.tokenDoApp === null) return semApp()
  const ramo = ramoDeAlternativaDeSenhas()
  const caminho = CAMINHO_DO_WORKFLOW_DE_SENHAS
  const registro = { ramo, caminho, acao: 'criar' as const }

  const existente = await procurarPrDoRamo(ctx, ramo)
  if (existente === 'erro')
    return { estado: 'falhou', motivo: 'não consegui procurar o pull request deste ramo' }
  if (existente !== null) return resultadoDoPrExistente(existente, registro)

  const base = ctx.sondagem.branchPadrao
  if (base === null)
    return { estado: 'falhou', motivo: 'não sei qual é a branch padrão do repositório' }
  const naPadrao = await lerArquivoNoRamo(ctx, caminho, base)
  if (naPadrao === 'erro')
    return { estado: 'falhou', motivo: 'não consegui conferir o arquivo na branch padrão' }
  if (naPadrao !== 'ausente') {
    return {
      estado: 'dispensado',
      motivo: `${caminho} já existe na branch padrão; não abro pull request`,
    }
  }

  return abrirPrDeAlteracao(ctx, {
    ramo,
    caminho,
    acao: 'criar',
    conteudoNovo: workflowDeAlternativaGratuita(),
    titulo: 'Segurança: varredura gratuita de senhas vazadas (gitleaks)',
    mensagemDoCommit: 'Segurança: adiciona a varredura gratuita de senhas vazadas (gitleaks)',
    corpoDoPr: corpoDoPr({
      oQueMuda:
        `Adiciona o workflow \`${caminho}\`, que roda o gitleaks (versão ${GITLEAKS_VERSION}) a cada pull request e a cada push. ` +
        'Todas as Actions do arquivo ficam fixadas por SHA e o token do workflow só tem leitura.',
      porQue:
        'Este repositório é privado e o plano do GitHub não inclui a varredura de senhas vazadas (secret scanning). ' +
        'O gitleaks é gratuito e faz a mesma busca por segredos no código.',
      comoReverter: `Se ainda não foi mesclado, basta fechar este pull request. Se já foi, reverta o merge ou apague \`${caminho}\` por outro pull request.`,
    }),
  })
}

export async function executarPermissoesMinimas(
  ctx: ContextoDeExecucao,
  workflow: WorkflowSondado,
  opcoes: { liberadoPeloDono?: boolean } = {}
): Promise<ResultadoDaAplicacao> {
  const caminho = workflow.caminho
  if (!caminhoDeWorkflowValido(caminho)) {
    return { estado: 'dispensado', motivo: 'caminho de workflow fora do padrão; não mexo' }
  }
  if (workflow.ehDeploy && opcoes.liberadoPeloDono !== true) {
    return {
      estado: 'dispensado',
      motivo: `${caminho} é de deploy/CD: só mexo com o aval do dono`,
    }
  }
  if (ctx.tokenDoApp === null) return semApp()
  const ramo = ramoDePermissoesMinimas(caminho)
  const registro = { ramo, caminho, acao: 'editar' as const }

  const existente = await procurarPrDoRamo(ctx, ramo)
  if (existente === 'erro')
    return { estado: 'falhou', motivo: 'não consegui procurar o pull request deste ramo' }
  if (existente !== null) return resultadoDoPrExistente(existente, registro)

  const base = ctx.sondagem.branchPadrao
  if (base === null)
    return { estado: 'falhou', motivo: 'não sei qual é a branch padrão do repositório' }
  const naPadrao = await lerArquivoNoRamo(ctx, caminho, base)
  if (naPadrao === 'erro')
    return { estado: 'falhou', motivo: 'não consegui ler o workflow na branch padrão' }
  if (naPadrao === 'ausente') return { estado: 'dispensado', motivo: `${caminho} não existe mais` }

  const analise = analisarWorkflow(caminho, naPadrao.texto)
  // A sondagem pode ter até um dia: o arquivo de agora é que decide se é deploy.
  if (analise.ehDeploy && opcoes.liberadoPeloDono !== true) {
    return {
      estado: 'dispensado',
      motivo: `${caminho} é de deploy/CD pelo conteúdo do arquivo: só mexo com o aval do dono`,
    }
  }
  if (analise.declaraPermissoes !== false) {
    return {
      estado: 'dispensado',
      motivo: `${caminho} já declara permissions (ou não dá para analisar); não mexo`,
    }
  }
  if (!analise.seguroParaPermissaoMinima) {
    return {
      estado: 'dispensado',
      motivo: `${caminho}: ${analise.motivoDeNaoSeguro ?? 'pode precisar de escrita'}; não mexo`,
    }
  }
  const novo = adicionarPermissoesMinimas(naPadrao.texto)
  if (novo === null) {
    return {
      estado: 'dispensado',
      motivo: `${caminho} tem uma estrutura em que não edito com segurança`,
    }
  }

  return abrirPrDeAlteracao(ctx, {
    ramo,
    caminho,
    acao: 'editar',
    conteudoNovo: novo,
    titulo: `Segurança: permissões mínimas no workflow ${caminho.split('/').pop() ?? caminho}`,
    mensagemDoCommit: `Segurança: permissões mínimas (contents: read) em ${caminho}`,
    corpoDoPr: corpoDoPr({
      oQueMuda:
        `Acrescenta \`permissions: contents: read\` ao workflow \`${caminho}\`, antes de \`jobs:\`. ` +
        'Nenhuma outra linha do arquivo muda.',
      porQue:
        'Sem `permissions`, o token do workflow vale o que estiver configurado no repositório, que pode incluir escrita. ' +
        'Os passos deste workflow só leem o código, então leitura basta e um passo comprometido não consegue escrever no repositório.',
      comoReverter:
        'Se ainda não foi mesclado, basta fechar este pull request. Se já foi, reverta o merge ou apague as três linhas do bloco (o comentário, `permissions:` e `contents: read`).\n\n' +
        'Confira se esta automação publica alguma coisa (site, pacote, imagem). ' +
        'Se publica, feche este PR sem mesclar: ela precisa da permissão de escrita.',
    }),
  })
}

/**
 * O número do pull request vem da ficha (banco, não confiado): antes de fechá-lo
 * ou de dá-lo por mesclado, a leitura precisa mostrar o PR do aplicador, ou seja,
 * o ramo registrado (com o prefixo do GitOrch) aberto por uma conta de aplicativo.
 * `null` = confere.
 */
export function motivoDoPrNaoSerDoAplicador(corpo: unknown, pr: RegistroDoPr): string | null {
  const ramo = campoDe(corpo, 'head', 'ref')
  if (ramo !== pr.ramo || !pr.ramo.startsWith(PREFIXO_DOS_RAMOS_DE_SEGURANCA)) {
    return `o pull request #${pr.numero} não está no ramo que o aplicador abriu; não mexo nele`
  }
  const tipo = campoDe(corpo, 'user', 'type')
  const login = campoDe(corpo, 'user', 'login')
  if (tipo !== 'Bot' || typeof login !== 'string' || !login.endsWith('[bot]')) {
    return `o pull request #${pr.numero} não foi aberto pelo App (autor ${typeof login === 'string' ? login : 'desconhecido'}); não mexo nele`
  }
  return null
}

export async function acompanharPrDeSeguranca(
  registro: Pick<RegistroDaMelhoria, 'pr'>,
  ctx: ContextoDeExecucao
): Promise<{
  estado: 'aguardando-revisao' | 'aplicado' | 'dispensado' | 'incerto'
  motivo: string
  /** O pull request como o GitHub devolveu; só quando ele segue aberto e é do aplicador. */
  corpo?: unknown
}> {
  const pr = registro.pr
  if (!pr) return { estado: 'incerto', motivo: 'o registro não tem o número do pull request' }
  const r = await lerSeguro(ctx, `/pulls/${pr.numero}`)
  if (r === null || !r.ok)
    return { estado: 'incerto', motivo: `não consegui ler o pull request #${pr.numero}` }
  const naoEh = motivoDoPrNaoSerDoAplicador(r.corpo, pr)
  if (naoEh !== null) return { estado: 'incerto', motivo: naoEh }
  const fundido =
    campoDe(r.corpo, 'merged') === true || typeof campoDe(r.corpo, 'merged_at') === 'string'
  if (fundido) return { estado: 'aplicado', motivo: `o pull request #${pr.numero} foi mesclado` }
  if (campoDe(r.corpo, 'state') === 'closed') {
    return { estado: 'dispensado', motivo: `o pull request #${pr.numero} foi fechado sem mesclar` }
  }
  return {
    estado: 'aguardando-revisao',
    motivo: `o pull request #${pr.numero} segue aberto`,
    corpo: r.corpo,
  }
}

// ------------------------------------------------------------------ como desfazer

const PARAR_DE_APLICAR =
  'Para o GitOrch parar de aplicar melhorias de segurança em todos os projetos, defina GITORCH_APLICAR_SEGURANCA=0 no serviço.'

/**
 * O texto mostrado no painel. É um passo que uma pessoa consegue seguir, com ou
 * sem acesso ao GitOrch: o caminho no GitHub, o interruptor que desliga a
 * aplicação, e só no fim a função que a equipe usa (`desfazerMelhoriaDoProjeto`),
 * citada como informação e não como pedido.
 */
export function comoDesfazerDaMelhoria(id: string, repositorio: string): string {
  const base = id.split(':', 1)[0] ?? id
  const config = `https://github.com/${repositorio}/settings`
  const funcaoDaEquipe =
    'A equipe do GitOrch também desfaz pela função desfazerMelhoriaDoProjeto, que restaura o estado de antes guardado no registro.'
  switch (base) {
    case 'alertas-de-dependencias':
      return `Como desfazer: em Configurações (${config}/security_analysis) de ${repositorio}, desligue "Dependabot alerts". ${PARAR_DE_APLICAR} ${funcaoDaEquipe}`
    case 'atualizacoes-de-seguranca':
      return `Como desfazer: em Configurações (${config}/security_analysis) de ${repositorio}, desligue "Dependabot security updates". ${PARAR_DE_APLICAR} ${funcaoDaEquipe}`
    case 'varredura-de-senhas':
      return `Como desfazer: em Configurações (${config}/security_analysis) de ${repositorio}, desligue "Secret scanning" e "Push protection" (só o que o GitOrch ligou está guardado no registro). ${PARAR_DE_APLICAR} ${funcaoDaEquipe}`
    case 'varredura-de-codigo':
      return `Como desfazer: em Configurações (${config}/security_analysis) de ${repositorio}, em "Code scanning", desative o "default setup". ${PARAR_DE_APLICAR} ${funcaoDaEquipe}`
    case 'permissao-padrao-do-workflow':
      return `Como desfazer: em Configurações (${config}/actions) de ${repositorio}, em "Workflow permissions", volte para o valor anterior (guardado no registro). ${PARAR_DE_APLICAR} ${funcaoDaEquipe}`
    case 'alternativa-de-varredura-de-senhas':
      return `Como desfazer: se o pull request ainda estiver aberto, feche-o e apague o ramo; se já foi mesclado, reverta o merge ou apague ${CAMINHO_DO_WORKFLOW_DE_SENHAS} em ${repositorio} por outro pull request. ${PARAR_DE_APLICAR} ${funcaoDaEquipe}`
    case 'permissoes-minimas-dos-workflows':
      return `Como desfazer: se o pull request ainda estiver aberto, feche-o e apague o ramo; se já foi mesclado, reverta o merge ou apague o bloco "permissions: contents: read" do workflow em ${repositorio}. ${PARAR_DE_APLICAR} ${funcaoDaEquipe}`
    default:
      return `Como desfazer: não há o que desfazer em ${repositorio}.`
  }
}

export interface ResultadoDoDesfazer {
  desfeito: boolean
  motivo: string
  pr?: RegistroDoPr
}

const naoDesfeito = (motivo: string): ResultadoDoDesfazer => ({ desfeito: false, motivo })

async function desfazerConfiguracao(
  id: MelhoriaDeConfiguracao,
  registro: RegistroDaMelhoria,
  ctx: ContextoDeExecucao
): Promise<ResultadoDoDesfazer> {
  const anterior = registro.anterior
  let acao: AcaoDeSeguranca
  let caminho: string
  let corpo: unknown
  let conferir: (valor: unknown) => boolean

  switch (id) {
    case 'alertas-de-dependencias':
      if (campoDe(anterior, 'alertas') !== 'desligado')
        return naoDesfeito('o registro não guarda o estado anterior')
      acao = 'desativar-alertas-de-dependencias'
      caminho = '/vulnerability-alerts'
      conferir = (v) => v === 'desligado'
      break
    case 'atualizacoes-de-seguranca':
      if (campoDe(anterior, 'atualizacoes') !== 'desligado') {
        return naoDesfeito('o registro não guarda o estado anterior')
      }
      acao = 'desativar-atualizacoes-de-seguranca'
      caminho = '/automated-security-fixes'
      conferir = (v) => v === 'desligado'
      break
    case 'varredura-de-senhas': {
      const mudar: Record<string, { status: 'disabled' }> = {}
      if (campoDe(anterior, 'segredos') === 'disabled')
        mudar['secret_scanning'] = { status: 'disabled' }
      if (campoDe(anterior, 'bloqueioDePush') === 'disabled') {
        mudar['secret_scanning_push_protection'] = { status: 'disabled' }
      }
      if (Object.keys(mudar).length === 0)
        return naoDesfeito('o registro não guarda o estado anterior')
      acao = 'configurar-varredura-de-senhas'
      caminho = ''
      corpo = { security_and_analysis: mudar }
      conferir = (v) =>
        (mudar['secret_scanning'] === undefined || campoDe(v, 'segredos') === 'disabled') &&
        (mudar['secret_scanning_push_protection'] === undefined ||
          campoDe(v, 'bloqueioDePush') === 'disabled')
      break
    }
    case 'varredura-de-codigo':
      if (campoDe(anterior, 'codigo') !== 'not-configured') {
        return naoDesfeito('o registro não guarda o estado anterior')
      }
      acao = 'configurar-varredura-de-codigo'
      caminho = '/code-scanning/default-setup'
      corpo = { state: 'not-configured' }
      conferir = (v) => v === 'not-configured'
      break
    case 'permissao-padrao-do-workflow': {
      const permissao = campoDe(anterior, 'permissao')
      if (permissao !== 'read' && permissao !== 'write') {
        return naoDesfeito('o registro não guarda os valores anteriores')
      }
      const aprova = campoDe(anterior, 'podeAprovarPrs')
      acao = 'definir-permissao-padrao-do-workflow'
      caminho = '/actions/permissions/workflow'
      corpo = {
        default_workflow_permissions: permissao,
        ...(typeof aprova === 'boolean' ? { can_approve_pull_request_reviews: aprova } : {}),
      }
      conferir = (v) => campoDe(v, 'permissao') === permissao
      break
    }
  }

  const envio = await escrever(ctx, acao, caminho, corpo)
  if ('erroDeRede' in envio)
    return naoDesfeito(`a conexão caiu (${envio.erroDeRede}); confira o estado no GitHub`)
  const classe = classificarRespostaDeEscrita(envio.resposta)
  if (classe !== 'ok') {
    return naoDesfeito(
      `o GitHub não aceitou desfazer (${envio.resposta.status}): ${envio.resposta.mensagem ?? ''}`
    )
  }
  const depois = await lerConfiguracao(id, ctx)
  if (depois.valor !== null && conferir(depois.valor)) {
    return { desfeito: true, motivo: 'estado anterior restaurado e confirmado na releitura' }
  }
  return naoDesfeito('o GitHub aceitou, mas a releitura não confirmou o estado anterior')
}

async function desfazerPr(
  id: string,
  registro: RegistroDaMelhoria,
  ctx: ContextoDeExecucao
): Promise<ResultadoDoDesfazer> {
  const pr = registro.pr
  if (!pr) return naoDesfeito('o registro não tem o pull request')
  if (ctx.tokenDoApp === null) return naoDesfeito(MOTIVO_SEM_APP)
  const atual = await acompanharPrDeSeguranca(registro, ctx)

  if (atual.estado === 'aguardando-revisao') {
    const fechado = await escrever(ctx, 'fechar-pr-de-seguranca', `/pulls/${pr.numero}`, {
      state: 'closed',
    })
    if ('erroDeRede' in fechado)
      return naoDesfeito(`a conexão caiu (${fechado.erroDeRede}); confira o pull request`)
    if (!fechado.resposta.ok) {
      return naoDesfeito(`o GitHub não deixou fechar o pull request (${fechado.resposta.status})`)
    }
    const apagado = await escrever(ctx, 'apagar-ramo-de-seguranca', `/git/refs/heads/${pr.ramo}`)
    if ('erroDeRede' in apagado || !apagado.resposta.ok) {
      return {
        desfeito: true,
        motivo: `pull request #${pr.numero} fechado; o ramo ficou (apague-o à mão)`,
      }
    }
    return { desfeito: true, motivo: `pull request #${pr.numero} fechado e ramo apagado` }
  }
  if (atual.estado === 'dispensado') {
    return {
      desfeito: true,
      motivo: 'o pull request já tinha sido fechado sem mesclar; nada a reverter',
    }
  }
  if (atual.estado === 'incerto') return naoDesfeito(atual.motivo)

  // Já mesclado: a reversão também é um pull request.
  const ramo = ramoDoDesfazer(pr.ramo)
  const registroBase = {
    ramo,
    caminho: pr.caminho,
    acao: pr.acao === 'criar' ? ('apagar' as const) : ('editar' as const),
  }
  const existente = await procurarPrDoRamo(ctx, ramo)
  if (existente === 'erro') return naoDesfeito('não consegui procurar o pull request de reversão')
  if (existente !== null) {
    const r = resultadoDoPrExistente(existente, registroBase)
    return { desfeito: r.estado !== 'dispensado', motivo: r.motivo, ...(r.pr ? { pr: r.pr } : {}) }
  }

  const base = ctx.sondagem.branchPadrao
  if (base === null) return naoDesfeito('não sei qual é a branch padrão do repositório')
  const naPadrao = await lerArquivoNoRamo(ctx, pr.caminho, base)
  if (naPadrao === 'erro') return naoDesfeito('não consegui ler o arquivo na branch padrão')

  let conteudoNovo: string | null
  if (pr.acao === 'criar') {
    if (naPadrao === 'ausente')
      return { desfeito: true, motivo: `${pr.caminho} já não existe; nada a reverter` }
    conteudoNovo = null
  } else {
    if (naPadrao === 'ausente') return naoDesfeito(`${pr.caminho} não existe mais`)
    conteudoNovo = removerPermissoesMinimas(naPadrao.texto)
    if (conteudoNovo === null) {
      return naoDesfeito(
        'o bloco de permissões foi alterado depois do merge; não adivinho o que remover'
      )
    }
  }
  const aberto = await abrirPrDeAlteracao(ctx, {
    ramo,
    caminho: pr.caminho,
    acao: registroBase.acao,
    conteudoNovo,
    titulo: `Segurança: reverte a mudança em ${pr.caminho.split('/').pop() ?? pr.caminho}`,
    mensagemDoCommit: `Segurança: reverte a mudança em ${pr.caminho} (${id})`,
    corpoDoPr: corpoDoPr({
      oQueMuda: `Desfaz o que o pull request #${pr.numero} do GitOrch fez em \`${pr.caminho}\`.`,
      porQue: 'O desfazer foi pedido para esta melhoria de segurança.',
      comoReverter: 'Feche este pull request sem mesclar para manter a mudança original.',
    }),
  })
  if (aberto.estado === 'aguardando-revisao' || aberto.estado === 'aplicado') {
    return {
      desfeito: true,
      motivo: `pull request de reversão #${aberto.pr?.numero ?? '?'} aberto; a reversão só vale quando for mesclado`,
      ...(aberto.pr ? { pr: aberto.pr } : {}),
    }
  }
  return naoDesfeito(aberto.motivo)
}

/**
 * Desfaz uma melhoria que o GitOrch aplicou, com o valor de antes guardado no
 * registro. Só desfaz o que está "aplicado" (ou com pull request aberto);
 * nunca adivinha um valor que não foi guardado.
 */
export async function desfazerMelhoriaDeSeguranca(
  id: string,
  registro: RegistroDaMelhoria,
  ctx: ContextoDeExecucao
): Promise<ResultadoDoDesfazer> {
  if (registro.estado !== 'aplicado' && registro.estado !== 'aguardando-revisao') {
    return naoDesfeito(`a melhoria está "${registro.estado}"; só desfaço o que está aplicado`)
  }
  const base = id.split(':', 1)[0] ?? id
  switch (base) {
    case 'alertas-de-dependencias':
    case 'atualizacoes-de-seguranca':
    case 'varredura-de-senhas':
    case 'varredura-de-codigo':
    case 'permissao-padrao-do-workflow':
      return desfazerConfiguracao(base, registro, ctx)
    case 'alternativa-de-varredura-de-senhas':
    case 'permissoes-minimas-dos-workflows':
      return desfazerPr(id, registro, ctx)
    default:
      return naoDesfeito('melhoria desconhecida')
  }
}

/** Texto externo (ou de erro) pronto para o painel: sem credencial e cortado por ponto de código. */
export function textoSeguroParaOPainel(texto: string, segredos: readonly string[] = []): string {
  return cortarPorPontoDeCodigo(mascararCredenciais(texto, segredos), 600)
}
