/**
 * "Esta pessoa é administradora do repositório?"
 *
 * Em repositório de ORGANIZAÇÃO o dono de fato aparece, nas listas de PR, com
 * a associação MEMBER (nunca OWNER). A única fonte confiável de que ele manda
 * no repositório é a permissão que o GITHUB informa em
 * `GET /repos/{repo}/collaborators/{login}/permission` — campo `permission`.
 *
 * REGRA DE SEGURANÇA (repositório público): o login vem sempre da lista de PRs
 * do GitHub, nunca de texto de PR. Qualquer falha (403, 404, rede, resposta
 * fora do formato) significa "não é admin": o produto aprova e deixa a mescla
 * para o dono (fail-closed).
 */

/** Quanto tempo uma resposta vale sem consultar o GitHub de novo. */
export const TTL_DA_PERMISSAO_DE_ADMIN_MS = 10 * 60 * 1000

/** Limite de entradas: passou disso, as mais antigas são descartadas. */
export const MAX_ENTRADAS_DO_CACHE_DE_PERMISSAO = 200

/** Devolve o corpo bruto do GitHub (ou lança, se o GitHub recusou). */
export type ConsultaDePermissao = (repositorio: string, login: string) => Promise<unknown>

export interface CacheDePermissaoDeAdmin {
  autorTemPermissaoDeAdmin(
    repositorio: string,
    login: string,
    consultar: ConsultaDePermissao
  ): Promise<boolean>
  tamanho(): number
  limpar(): void
}

// Formato de login do GitHub: alfanumérico e hífen, até 39 caracteres, sem
// começar por hífen. Fora disso nem chega a virar caminho de URL.
const LOGIN_DO_GITHUB = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

function ehAdmin(resposta: unknown): boolean {
  if (typeof resposta !== 'object' || resposta === null) return false
  return (resposta as { permission?: unknown }).permission === 'admin'
}

export function criarCacheDePermissaoDeAdmin(
  opcoes: { ttlMs?: number; maxEntradas?: number; agora?: () => number } = {}
): CacheDePermissaoDeAdmin {
  const ttlMs = opcoes.ttlMs ?? TTL_DA_PERMISSAO_DE_ADMIN_MS
  const maxEntradas = opcoes.maxEntradas ?? MAX_ENTRADAS_DO_CACHE_DE_PERMISSAO
  const agora = opcoes.agora ?? Date.now
  // A ordem de inserção do Map é a ordem de gravação: a primeira chave é
  // sempre a mais antiga.
  const entradas = new Map<string, { admin: boolean; gravadoEm: number }>()

  const vencida = (gravadoEm: number): boolean => agora() - gravadoEm >= ttlMs

  return {
    async autorTemPermissaoDeAdmin(repositorio, login, consultar) {
      if (!LOGIN_DO_GITHUB.test(login)) return false
      // O GitHub não diferencia maiúscula de minúscula em login.
      const chave = `${repositorio}\u0000${login.toLowerCase()}`

      const guardada = entradas.get(chave)
      if (guardada) {
        if (!vencida(guardada.gravadoEm)) return guardada.admin
        entradas.delete(chave)
      }

      let admin: boolean
      try {
        admin = ehAdmin(await consultar(repositorio, login))
      } catch {
        // Fail-closed, e sem guardar: um erro passageiro não pode valer 10 min.
        return false
      }

      for (const [k, v] of entradas) {
        if (!vencida(v.gravadoEm)) break
        entradas.delete(k)
      }
      entradas.set(chave, { admin, gravadoEm: agora() })
      while (entradas.size > maxEntradas) {
        const maisAntiga = entradas.keys().next()
        if (maisAntiga.done) break
        entradas.delete(maisAntiga.value)
      }
      return admin
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
export const cacheDePermissaoDoProcesso: CacheDePermissaoDeAdmin = criarCacheDePermissaoDeAdmin()
