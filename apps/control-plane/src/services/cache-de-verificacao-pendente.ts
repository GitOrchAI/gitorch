/**
 * Cache curto, em memória e por processo, do resultado PENDENTE/DESCONHECIDO
 * da leitura de check-runs de um PR, por (repositório, PR, sha do head).
 *
 * Existe para o QA não gastar a cota de leituras do GitHub relendo, a cada
 * acordada, os mesmos PRs que continuam com CI pendente e deixar PR verde
 * atrás deles na fome (Jardim, 30/09/2026). Só pendente e desconhecido entram:
 * verde, vermelho e sem-checks são veredito e SEMPRE são relidos.
 */
import type { EstadoDaVerificacao } from './vigia-da-verificacao.js'

/** Quanto tempo um pendente vale sem reler os check-runs. */
export const TTL_DA_VERIFICACAO_PENDENTE_MS = 3 * 60 * 1000

/** Limite de entradas: passou disso, as mais antigas são descartadas. */
export const MAX_ENTRADAS_DO_CACHE_DE_PENDENTES = 200

/** Os únicos estados que o cache aceita — nunca um veredito. */
export type EstadoPendenteEmCache = Extract<EstadoDaVerificacao, 'pending' | 'unknown'>

export interface CacheDeVerificacaoPendente {
  ler(chave: string): EstadoPendenteEmCache | undefined
  gravar(chave: string, estado: EstadoPendenteEmCache): void
  esquecer(chave: string): void
  tamanho(): number
  limpar(): void
}

export function chaveDaVerificacao(repositorio: string, numeroDoPr: number, sha: string): string {
  return `${repositorio}#${numeroDoPr}@${sha}`
}

export function criarCacheDeVerificacaoPendente(
  opcoes: { ttlMs?: number; maxEntradas?: number; agora?: () => number } = {}
): CacheDeVerificacaoPendente {
  const ttlMs = opcoes.ttlMs ?? TTL_DA_VERIFICACAO_PENDENTE_MS
  const maxEntradas = opcoes.maxEntradas ?? MAX_ENTRADAS_DO_CACHE_DE_PENDENTES
  const agora = opcoes.agora ?? Date.now
  // A ordem de inserção do Map é a ordem de gravação: a primeira chave é
  // sempre a mais antiga (e a primeira a vencer, já que o TTL é igual).
  const entradas = new Map<string, { estado: EstadoPendenteEmCache; gravadoEm: number }>()

  const vencida = (gravadoEm: number): boolean => agora() - gravadoEm >= ttlMs

  return {
    ler(chave) {
      const entrada = entradas.get(chave)
      if (!entrada) return undefined
      if (vencida(entrada.gravadoEm)) {
        entradas.delete(chave)
        return undefined
      }
      return entrada.estado
    },
    gravar(chave, estado) {
      // Varre o que já venceu, do mais antigo para o mais novo.
      for (const [k, v] of entradas) {
        if (!vencida(v.gravadoEm)) break
        entradas.delete(k)
      }
      // Regravar a mesma chave a faz virar a mais nova.
      entradas.delete(chave)
      entradas.set(chave, { estado, gravadoEm: agora() })
      while (entradas.size > maxEntradas) {
        const maisAntiga = entradas.keys().next()
        if (maisAntiga.done) break
        entradas.delete(maisAntiga.value)
      }
    },
    esquecer(chave) {
      entradas.delete(chave)
    },
    tamanho() {
      return entradas.size
    },
    limpar() {
      entradas.clear()
    },
  }
}

/** Instância única do processo — usada quando a missão não recebe outra. */
export const cacheDoProcesso: CacheDeVerificacaoPendente = criarCacheDeVerificacaoPendente()
