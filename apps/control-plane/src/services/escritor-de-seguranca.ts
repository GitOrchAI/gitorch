// A porta de escrita das melhorias de segurança no GitHub do cliente.
//
// Duas travas moram aqui, na saída de rede, para um chamador novo não conseguir
// esquecê-las:
//  - LISTA BRANCA: só existem as ações abaixo, cada uma com método, endereço e
//    corpo conferidos. Não há ação para proteger branch, mesclar, apagar
//    repositório ou mexer em visibilidade: o que não está na lista não tem como
//    ser pedido. As escritas em arquivo só aceitam ramo do próprio GitOrch, nunca
//    a branch padrão;
//  - RITMO: no mínimo 1 s entre duas escritas (regra do GitHub), em série, para
//    todos os projetos do processo.
//
// A guarda de autonomia do projeto fica por fora (`fetchDoRepositorio`), no
// `fetchImpl` que se passa: o escritor não decide política, só a executa.

import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import { repositorioValido } from './nota-de-seguranca.js'
import { PREFIXO_DOS_RAMOS_DE_SEGURANCA } from './pr-de-seguranca.js'
import {
  avisarRespostaRuim,
  erroDeRedeSeguro,
  lerRespostaDoGitHub,
  type AoReceberRespostaRuim,
  type RespostaDoGitHub,
} from './leitor-de-seguranca.js'

export const PAUSA_ENTRE_ESCRITAS_MS = 1000

export { PREFIXO_DOS_RAMOS_DE_SEGURANCA }

const GITHUB_API = 'https://api.github.com'

export const ACOES_DE_SEGURANCA = [
  'ativar-alertas-de-dependencias',
  'desativar-alertas-de-dependencias',
  'ativar-atualizacoes-de-seguranca',
  'desativar-atualizacoes-de-seguranca',
  'configurar-varredura-de-senhas',
  'configurar-varredura-de-codigo',
  'definir-permissao-padrao-do-workflow',
  'criar-ramo-de-seguranca',
  'gravar-arquivo-no-ramo',
  'apagar-arquivo-no-ramo',
  'abrir-pr-de-seguranca',
  'fechar-pr-de-seguranca',
  'apagar-ramo-de-seguranca',
] as const

export type AcaoDeSeguranca = (typeof ACOES_DE_SEGURANCA)[number]

export class AcaoForaDaListaBrancaError extends Error {
  constructor(motivo: string) {
    super(`escrita recusada pela lista branca de segurança: ${motivo}`)
    this.name = 'AcaoForaDaListaBrancaError'
  }
}

export interface PedidoDeEscrita {
  acao: AcaoDeSeguranca
  /** Relativo ao repositório (`/vulnerability-alerts`; vazio = o próprio repositório). */
  caminho: string
  corpo?: unknown
  token: string
}

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const SO_ESSAS = (objeto: Record<string, unknown>, chaves: readonly string[]): boolean =>
  Object.keys(objeto).every((k) => chaves.includes(k))

const RAMO_DO_GITORCH = /^gitorch\/seguranca\/[A-Za-z0-9._-]+$/
const CAMINHO_DE_WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/
const SHA_COMPLETO = /^[0-9a-f]{40}$/

const ramoValido = (ramo: unknown): ramo is string =>
  typeof ramo === 'string' && RAMO_DO_GITORCH.test(ramo) && !ramo.includes('..')

function statusValido(v: unknown): boolean {
  return (
    ehObjeto(v) &&
    SO_ESSAS(v, ['status']) &&
    (v['status'] === 'enabled' || v['status'] === 'disabled')
  )
}

interface Regra {
  metodo: 'PUT' | 'DELETE' | 'PATCH' | 'POST'
  caminho: RegExp
  corpo: (corpo: unknown) => boolean
}

const SEM_CORPO = (corpo: unknown): boolean => corpo === undefined || corpo === null

const LISTA_BRANCA: Readonly<Record<AcaoDeSeguranca, Regra>> = {
  'ativar-alertas-de-dependencias': {
    metodo: 'PUT',
    caminho: /^\/vulnerability-alerts$/,
    corpo: SEM_CORPO,
  },
  'desativar-alertas-de-dependencias': {
    metodo: 'DELETE',
    caminho: /^\/vulnerability-alerts$/,
    corpo: SEM_CORPO,
  },
  'ativar-atualizacoes-de-seguranca': {
    metodo: 'PUT',
    caminho: /^\/automated-security-fixes$/,
    corpo: SEM_CORPO,
  },
  'desativar-atualizacoes-de-seguranca': {
    metodo: 'DELETE',
    caminho: /^\/automated-security-fixes$/,
    corpo: SEM_CORPO,
  },
  // O PATCH do repositório inteiro é o mais perigoso (visibilidade, nome,
  // arquivamento): só passa com `security_and_analysis` e só dois campos.
  'configurar-varredura-de-senhas': {
    metodo: 'PATCH',
    caminho: /^$/,
    corpo: (corpo) => {
      if (!ehObjeto(corpo) || !SO_ESSAS(corpo, ['security_and_analysis'])) return false
      const sa = corpo['security_and_analysis']
      if (!ehObjeto(sa)) return false
      const chaves = Object.keys(sa)
      if (chaves.length === 0) return false
      return (
        SO_ESSAS(sa, ['secret_scanning', 'secret_scanning_push_protection']) &&
        chaves.every((k) => statusValido(sa[k]))
      )
    },
  },
  'configurar-varredura-de-codigo': {
    metodo: 'PATCH',
    caminho: /^\/code-scanning\/default-setup$/,
    corpo: (corpo) =>
      ehObjeto(corpo) &&
      SO_ESSAS(corpo, ['state', 'query_suite']) &&
      (corpo['state'] === 'configured' || corpo['state'] === 'not-configured') &&
      (corpo['query_suite'] === undefined || corpo['query_suite'] === 'default'),
  },
  'definir-permissao-padrao-do-workflow': {
    metodo: 'PUT',
    caminho: /^\/actions\/permissions\/workflow$/,
    corpo: (corpo) =>
      ehObjeto(corpo) &&
      SO_ESSAS(corpo, ['default_workflow_permissions', 'can_approve_pull_request_reviews']) &&
      (corpo['default_workflow_permissions'] === 'read' ||
        corpo['default_workflow_permissions'] === 'write') &&
      (corpo['can_approve_pull_request_reviews'] === undefined ||
        typeof corpo['can_approve_pull_request_reviews'] === 'boolean'),
  },
  'criar-ramo-de-seguranca': {
    metodo: 'POST',
    caminho: /^\/git\/refs$/,
    corpo: (corpo) =>
      ehObjeto(corpo) &&
      SO_ESSAS(corpo, ['ref', 'sha']) &&
      typeof corpo['ref'] === 'string' &&
      corpo['ref'].startsWith('refs/heads/') &&
      ramoValido(corpo['ref'].slice('refs/heads/'.length)) &&
      typeof corpo['sha'] === 'string' &&
      SHA_COMPLETO.test(corpo['sha']),
  },
  'gravar-arquivo-no-ramo': {
    metodo: 'PUT',
    caminho: /^\/contents\/.+$/,
    corpo: (corpo) =>
      ehObjeto(corpo) &&
      SO_ESSAS(corpo, ['message', 'content', 'branch', 'sha']) &&
      typeof corpo['message'] === 'string' &&
      typeof corpo['content'] === 'string' &&
      ramoValido(corpo['branch']) &&
      (corpo['sha'] === undefined ||
        (typeof corpo['sha'] === 'string' && SHA_COMPLETO.test(corpo['sha']))),
  },
  'apagar-arquivo-no-ramo': {
    metodo: 'DELETE',
    caminho: /^\/contents\/.+$/,
    corpo: (corpo) =>
      ehObjeto(corpo) &&
      SO_ESSAS(corpo, ['message', 'sha', 'branch']) &&
      typeof corpo['message'] === 'string' &&
      typeof corpo['sha'] === 'string' &&
      SHA_COMPLETO.test(corpo['sha']) &&
      ramoValido(corpo['branch']),
  },
  'abrir-pr-de-seguranca': {
    metodo: 'POST',
    caminho: /^\/pulls$/,
    corpo: (corpo) =>
      ehObjeto(corpo) &&
      SO_ESSAS(corpo, ['title', 'body', 'head', 'base']) &&
      typeof corpo['title'] === 'string' &&
      typeof corpo['body'] === 'string' &&
      ramoValido(corpo['head']) &&
      typeof corpo['base'] === 'string' &&
      corpo['base'] !== corpo['head'],
  },
  'fechar-pr-de-seguranca': {
    metodo: 'PATCH',
    caminho: /^\/pulls\/\d+$/,
    corpo: (corpo) => ehObjeto(corpo) && SO_ESSAS(corpo, ['state']) && corpo['state'] === 'closed',
  },
  'apagar-ramo-de-seguranca': {
    metodo: 'DELETE',
    caminho: /^\/git\/refs\/heads\/gitorch\/seguranca\/[A-Za-z0-9._-]+$/,
    corpo: SEM_CORPO,
  },
}

/** O caminho de uma escrita em arquivo precisa ser um workflow de verdade. */
function caminhoDeArquivoValido(caminho: string): boolean {
  const arquivo = /^\/contents\/(.+)$/.exec(caminho)?.[1]
  return arquivo !== undefined && CAMINHO_DE_WORKFLOW.test(arquivo) && !arquivo.includes('..')
}

export interface RitmoDeEscrita {
  /** Espera o que falta até a pausa mínima, em série com qualquer outra escrita. */
  vez: <T>(escrever: () => Promise<T>) => Promise<T>
}

/**
 * O ritmo é UM para o processo inteiro: duas escritas, de projetos diferentes
 * ou não, ficam pelo menos `pausaMs` afastadas. `agora` e `esperar` entram para
 * o teste andar com relógio falso.
 */
export function criarRitmoDeEscrita(deps: {
  esperar: (ms: number) => Promise<void>
  agora: () => number
  pausaMs?: number
}): RitmoDeEscrita {
  const pausa = deps.pausaMs ?? PAUSA_ENTRE_ESCRITAS_MS
  let ultima = Number.NEGATIVE_INFINITY
  let fila: Promise<unknown> = Promise.resolve()
  return {
    vez: <T>(escrever: () => Promise<T>): Promise<T> => {
      const minha = fila.then(async () => {
        const falta = ultima + pausa - deps.agora()
        if (falta > 0) await deps.esperar(falta)
        ultima = deps.agora()
        return escrever()
      })
      fila = minha.catch(() => undefined)
      return minha
    },
  }
}

export interface EscritorDeSeguranca {
  enviar: (pedido: PedidoDeEscrita) => Promise<RespostaDoGitHub>
}

export function criarEscritorDeSeguranca(deps: {
  repositorio: string
  fetchImpl: typeof fetch
  ritmo: RitmoDeEscrita
  aoReceberRespostaRuim?: AoReceberRespostaRuim
}): EscritorDeSeguranca {
  if (!repositorioValido(deps.repositorio)) {
    throw new Error('repositório fora do formato dono/repo')
  }
  return {
    enviar: async (pedido) => {
      const regra = Object.hasOwn(LISTA_BRANCA, pedido.acao) ? LISTA_BRANCA[pedido.acao] : undefined
      if (!regra) throw new AcaoForaDaListaBrancaError(`ação desconhecida "${String(pedido.acao)}"`)
      if (!regra.caminho.test(pedido.caminho) || pedido.caminho.includes('..')) {
        throw new AcaoForaDaListaBrancaError(`endereço fora do da ação "${pedido.acao}"`)
      }
      if (
        (pedido.acao === 'gravar-arquivo-no-ramo' || pedido.acao === 'apagar-arquivo-no-ramo') &&
        !caminhoDeArquivoValido(pedido.caminho)
      ) {
        throw new AcaoForaDaListaBrancaError(
          `arquivo fora de .github/workflows em "${pedido.acao}"`
        )
      }
      if (!regra.corpo(pedido.corpo)) {
        throw new AcaoForaDaListaBrancaError(`corpo fora do permitido na ação "${pedido.acao}"`)
      }

      const url = `${GITHUB_API}/repos/${deps.repositorio}${pedido.caminho}`
      return deps.ritmo.vez(async () => {
        let resposta: Response
        try {
          resposta = await deps.fetchImpl(url, {
            method: regra.metodo,
            headers: {
              Authorization: `Bearer ${pedido.token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'gitorch',
              ...(pedido.corpo === undefined || pedido.corpo === null
                ? {}
                : { 'Content-Type': 'application/json' }),
            },
            ...(pedido.corpo === undefined || pedido.corpo === null
              ? {}
              : { body: JSON.stringify(pedido.corpo) }),
          })
        } catch (erro) {
          // A recusa da guarda de autonomia (nada saiu) não é erro de rede.
          if (erro instanceof EscritaNaoAutorizadaError) throw erro
          throw new Error(erroDeRedeSeguro(erro, pedido.token))
        }
        avisarRespostaRuim(resposta, deps.aoReceberRespostaRuim)
        return lerRespostaDoGitHub(resposta, [pedido.token])
      })
    },
  }
}
