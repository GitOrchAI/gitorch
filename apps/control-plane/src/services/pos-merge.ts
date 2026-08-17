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
 * Só os cinco campos que a decisão precisa — não a `LinhaDeSessao` inteira,
 * para não acoplar este módulo ao shape completo do Prisma. Uma linha real
 * (dev-session-store.ts) satisfaz esta forma por estrutura.
 *
 * `closedAt` (Crítico 2, leva C): antes deste campo, esta decisão confiava
 * cegamente que "veredito final" e "linha fechada" eram a mesma coisa — não
 * são. Ver a checagem abaixo.
 */
export interface SessaoParaVarredura {
  id: string
  mergeCommitSha: string | null
  deployState: string | null
  deployCheckedAt: Date | null
  closedAt: Date | null
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
 * agir — não apenas os cinco campos que ESTA decisão examina.
 */
export function sessoesParaAcompanharPublicacao<T extends SessaoParaVarredura>(
  sessoes: T[],
  agora: Date
): T[] {
  return sessoes.filter((sessao) => {
    if (!sessao.mergeCommitSha) return false
    // Crítico 2 (leva C): uma sessão órfã — `scheduler.ts` grava o veredito
    // FINAL (`registrarEstadoDaPublicacao`) e o processo morre (restart do
    // control-plane) antes de conseguir fechar a linha (`fecharSessao`,
    // depois de `testarAmbiente`, uma chamada HTTP real de ~10s). Sem esta
    // ressalva, um veredito final bastava para excluir a sessão desta lista
    // PARA SEMPRE — mesmo com `closedAt` ainda nulo — e o índice único de
    // sessão aberta por issue bloqueava qualquer nova delegação para a
    // mesma issue, sem ninguém nunca mais tentar fechar a linha de verdade.
    // Só trata "veredito final" como "pode pular" quando a linha está DE
    // FATO fechada (`closedAt` não-nulo) — nunca só pelo veredito. Uma linha
    // órfã (final + `closedAt` nulo) cai para a checagem de cadência abaixo,
    // como qualquer sessão ainda em aberto, e volta a ser examinada na
    // próxima janela — dessa vez terminando de verdade.
    if (
      sessao.deployState !== null &&
      ESTADOS_FINAIS.has(sessao.deployState) &&
      sessao.closedAt !== null
    )
      return false
    if (!sessao.deployCheckedAt) return true
    return agora.getTime() - sessao.deployCheckedAt.getTime() >= CADENCIA_DE_PUBLICACAO_MS
  })
}
