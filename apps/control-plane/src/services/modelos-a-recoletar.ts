/**
 * Quais motores precisam ter o CATÁLOGO DE MODELOS recoletado agora.
 *
 * O gêmeo de `cotas-a-reler.ts`, e pelo mesmo motivo — só que um degrau mais
 * fundo, porque aqui não é o painel do dono que fica velho, é a DECISÃO da
 * missão.
 *
 * O QUE FOI MEDIDO (01/09/2026 03:00, banco de produção):
 *
 *   runtime     | status    | modelos | models_refreshed_at
 *   antigravity | connected |      14 | 2026-08-31 16:12:26
 *
 * e, no mesmo instante, `agy models` nesta VM devolve 11 modelos, nenhum deles
 * da geração 3.5. O banco passou ~11 horas afirmando que `Gemini 3.5 Flash
 * (Medium)` existia — e é ESSE catálogo que a guarda de modelo consulta para
 * decidir com o que a missão roda. Um catálogo velho não é um enfeite
 * desatualizado: é uma guarda que aprova um modelo morto.
 *
 * A causa é a mesma da cota antes de 30/08: `refreshModels` só roda depois de
 * uma missão COMPLETAR (ver o comentário no topo de `refreshQuota`). Com os
 * motores caindo, quase nenhuma missão completa — e a coleta só acontece
 * justamente quando ela já não é mais necessária.
 *
 * A cadência da COTA (1 hora, `CADENCIA_DA_RENOVACAO_DE_MOTORES_MS` /
 * `INTERVALO_DE_RELEITURA_MIN`) NÃO muda: é o que o dono pediu e está certo. O
 * catálogo é outra coisa — muda em dias, não em minutos —, e recoletá-lo custa
 * materializar a credencial num HOME temporário e rodar o binário do motor.
 * Um dia é o intervalo que pega a remoção de uma geração antes da rodada
 * seguinte de missões sem pagar por isso a cada hora.
 */

/** Uma conexão de motor, do ponto de vista de quem decide recoletar o catálogo. */
export type ConexaoParaRecoleta = {
  userId: string
  runtime: string
  status: string
  /**
   * Quando a coleta foi TENTADA pela última vez — sucesso ou fracasso.
   *
   * É deliberadamente diferente de `modelsRefreshedAt`, que só é carimbado
   * quando um catálogo novo de verdade SUBSTITUIU o anterior. Se o relógio
   * olhasse o carimbo de sucesso, um motor cuja coleta falha sempre (rede,
   * binário fora do ar) ficaria eternamente "vencido" e seria tentado a CADA
   * tique de um minuto — uma tempestade de containers escondida atrás de uma
   * boa intenção.
   */
  modelsCheckedAt: Date | string | null
}

/**
 * 24 horas. O provedor derruba uma geração em horas (a 3.5 morreu entre 16:12 e
 * 23:00 do dia 31/08), mas quem protege a missão dentro dessa janela é a
 * substituição por família+esforço de `escolherModeloVivo` — este relógio é o
 * que garante que a lista usada por ela não envelhece indefinidamente.
 */
export const INTERVALO_DE_RECOLETA_H = 24

/**
 * Só conexão CONECTADA tem catálogo para ler. Uma conexão caída faria o
 * binário falhar todo dia sem nunca produzir lista — e, pior, a falha
 * repetida sobrescreveria `lastError` da conexão, escondendo o motivo real de
 * ela estar caída atrás do ruído da coleta.
 */
const STATUS_QUE_TEM_CATALOGO = new Set(['connected'])

export function precisaRecoletarModelos(
  conexao: ConexaoParaRecoleta,
  agora: Date,
  intervaloH: number = INTERVALO_DE_RECOLETA_H
): boolean {
  if (!STATUS_QUE_TEM_CATALOGO.has(conexao.status)) return false
  // Nunca coletado: coleta agora. É o motor que nunca completou missão nenhuma
  // — exatamente o que ficava sem catálogo para sempre.
  if (conexao.modelsCheckedAt == null) return true
  const lidoEm =
    conexao.modelsCheckedAt instanceof Date
      ? conexao.modelsCheckedAt
      : new Date(conexao.modelsCheckedAt)
  // Carimbo ilegível é "não sei quando li", e não saber quando leu dá o mesmo
  // risco de decidir a missão por uma lista podre. Coleta.
  if (Number.isNaN(lidoEm.getTime())) return true
  return agora.getTime() - lidoEm.getTime() >= intervaloH * 60 * 60 * 1000
}

export function modelosARecoletar<T extends ConexaoParaRecoleta>(
  conexoes: readonly T[],
  agora: Date,
  intervaloH: number = INTERVALO_DE_RECOLETA_H
): T[] {
  return conexoes.filter((c) => precisaRecoletarModelos(c, agora, intervaloH))
}
