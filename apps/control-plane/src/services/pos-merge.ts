// A sessão não encerra mais no merge — encerra quando há VEREDITO sobre a
// publicação (ver `varrerPublicacoes`, scheduler.ts). Esta função pura decide
// só uma coisa: QUAIS sessões a vigília pós-merge precisa olhar neste ciclo.
//
// Três regras, nesta ordem:
// 1. Só quem mesclou (`mergeCommitSha` preenchido) — sem commit mesclado não
//    há o que acompanhar.
// 2. Nunca quem já tem veredito FINAL (`no-ar`/`sem-publicacao` — os dois
//    estados que `scheduler.ts` usa para encerrar a linha). `falhou` e
//    `commit-errado` ficam DE FORA desta lista de exclusão de propósito: o
//    CD pode ser retentado pelo cliente, e uma execução presa na fila
//    (commit-errado) pode ser sucedida pela execução certa — continuam sendo
//    reexaminados, com a mesma cadência de quem ainda não tem veredito
//    nenhum.
// 3. Respeita a cadência (`CADENCIA_DE_PUBLICACAO_MS`, publicacao.ts): quem
//    já foi checado recentemente espera a próxima janela — é isso que evita
//    gastar a quota do GitHub do cliente a cada tique do relógio.

import { CADENCIA_DE_PUBLICACAO_MS } from './publicacao.js'

/**
 * Só os quatro campos que a decisão precisa — não a `LinhaDeSessao` inteira,
 * para não acoplar este módulo ao shape completo do Prisma. Uma linha real
 * (dev-session-store.ts) satisfaz esta forma por estrutura.
 */
export interface SessaoParaVarredura {
  id: string
  mergeCommitSha: string | null
  deployState: string | null
  deployCheckedAt: Date | null
}

/**
 * Estados finais da publicação: quem chegou aqui já foi encerrado por
 * `scheduler.ts` e não entra mais nesta lista (em produção a sessão sai da
 * consulta por `closedAt`; aqui a checagem existe também para quem chama
 * esta função com um recorte que ainda inclui sessões fechadas).
 */
const ESTADOS_FINAIS = new Set(['no-ar', 'sem-publicacao'])

/**
 * Genérica sobre `T` (em vez de fixa em `SessaoParaVarredura`) para que quem
 * chama com uma `LinhaDeSessao[]` real (scheduler.ts) receba de volta linhas
 * completas — com `sessionName`/`projectId`, que a varredura precisa para
 * agir — não apenas os quatro campos que ESTA decisão examina.
 */
export function sessoesParaAcompanharPublicacao<T extends SessaoParaVarredura>(
  sessoes: T[],
  agora: Date
): T[] {
  return sessoes.filter((sessao) => {
    if (!sessao.mergeCommitSha) return false
    if (sessao.deployState !== null && ESTADOS_FINAIS.has(sessao.deployState)) return false
    if (!sessao.deployCheckedAt) return true
    return agora.getTime() - sessao.deployCheckedAt.getTime() >= CADENCIA_DE_PUBLICACAO_MS
  })
}
