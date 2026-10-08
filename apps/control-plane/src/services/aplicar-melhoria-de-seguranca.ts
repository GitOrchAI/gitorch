// A porta de cada melhoria de segurança que escreve no repositório do cliente.
//
// Travas empilhadas, na ordem em que são conferidas (qualquer uma sozinha barra):
//  1. LISTA BRANCA de melhorias: só as que existem em `MELHORIAS_DE_SEGURANCA`
//     (e, para a de permissões mínimas, só com um workflow de verdade como
//     alvo). Proteção de branch não está na lista e não tem como ser pedida;
//  2. interruptor geral e da peça (variáveis de ambiente, ligados por padrão);
//  3. lista de projetos que podem receber (`todos` por padrão);
//  4. autonomia do projeto = "cuidar";
//  5. autonomia de segurança do projeto = "cuidar" (campo próprio: os dois
//     campos podem divergir por desenho, então cada um é conferido).
// Passadas as cinco, quem executa é o `aplicar` recebido, que escreve pela porta
// de escrita (outra lista branca, a das chamadas HTTP) com o `fetch` guardado
// pela autonomia do projeto.

import { EscritaNaoAutorizadaError, podeEscrever } from '@gitorch/cadence'
import {
  idBaseDaMelhoria,
  melhoriaDeSegurancaLigada,
  projetoNaAllowlistDaSeguranca,
  type Ambiente,
} from './interruptores-de-seguranca.js'
import type { ResultadoDaAplicacao } from './executores-de-seguranca.js'
import { caminhoDeWorkflowValido } from './workflows-de-seguranca.js'
import { resumirErro } from './texto-seguro.js'

export type MotivoDaTrava =
  | 'fora-da-lista-branca'
  | 'interruptor'
  | 'fora-da-allowlist'
  | 'autonomia'
  | 'autonomia-de-seguranca'

/** A melhoria está na lista de ações permitidas? */
export function melhoriaNaListaBranca(id: string): boolean {
  const base = idBaseDaMelhoria(id)
  if (base === null) return false
  if (base === 'permissoes-minimas-dos-workflows') {
    const prefixo = `${base}:`
    return id.startsWith(prefixo) && caminhoDeWorkflowValido(id.slice(prefixo.length))
  }
  return id === base
}

export interface AplicarMelhoriaDeps {
  projeto: { id: string; wingId: string }
  /** `peça` ou `peça:caminho-do-workflow`. */
  melhoria: string
  autonomia: string | null | undefined
  autonomiaDeSeguranca: string | null | undefined
  env: Ambiente
  aplicar: () => Promise<ResultadoDaAplicacao>
}

export type ResultadoDoAplicar =
  | { executado: true; resultado: ResultadoDaAplicacao }
  | { executado: false; bloqueadoPor: MotivoDaTrava; motivo: string }

const barrado = (bloqueadoPor: MotivoDaTrava, motivo: string): ResultadoDoAplicar => ({
  executado: false,
  bloqueadoPor,
  motivo,
})

export async function aplicarMelhoriaDeSeguranca(
  deps: AplicarMelhoriaDeps
): Promise<ResultadoDoAplicar> {
  const base = melhoriaNaListaBranca(deps.melhoria) ? idBaseDaMelhoria(deps.melhoria) : null
  if (base === null) {
    return barrado(
      'fora-da-lista-branca',
      `"${deps.melhoria}" não está na lista de melhorias permitidas`
    )
  }
  if (!melhoriaDeSegurancaLigada(base, deps.env)) {
    return barrado('interruptor', `a peça "${base}" está desligada por variável de ambiente`)
  }
  if (!projetoNaAllowlistDaSeguranca(deps.projeto, deps.env)) {
    return barrado(
      'fora-da-allowlist',
      `${deps.projeto.wingId} não está na lista de projetos que recebem`
    )
  }
  const autonomia = podeEscrever(deps.autonomia, 'mesclar')
  if (!autonomia.pode) return barrado('autonomia', autonomia.motivo)
  const seguranca = podeEscrever(deps.autonomiaDeSeguranca, 'mesclar')
  if (!seguranca.pode) return barrado('autonomia-de-seguranca', seguranca.motivo)

  try {
    return { executado: true, resultado: await deps.aplicar() }
  } catch (erro) {
    // A guarda de autonomia recusou na saída de rede (o nível do projeto mudou
    // depois das travas de cima): nada saiu, então é uma recusa com o motivo
    // dela, e não uma falha de rede nem um "incerto".
    if (erro instanceof EscritaNaoAutorizadaError) {
      return {
        executado: true,
        resultado: {
          estado: 'recusado',
          motivo: `a guarda de autonomia recusou a escrita: ${resumirErro(erro, 300)}`,
        },
      }
    }
    // O que lança não escapa: vira estado explícito, nunca "ok" por engano.
    return {
      executado: true,
      resultado: { estado: 'falhou', motivo: `erro ao aplicar: ${resumirErro(erro, 300)}` },
    }
  }
}
