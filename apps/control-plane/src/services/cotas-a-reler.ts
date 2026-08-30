/**
 * Quais motores precisam ter a cota relida agora.
 *
 * Antes de 30/08 a cota só era lida dentro de `refreshModels`, e
 * `refreshModels` só rodava DEPOIS de uma missão completar. Consequência
 * medida: o Claude rodou 2 missões em 3 dias e o painel do dono passou 45 horas
 * exibindo o número da última missão. Um motor parado um dia inteiro
 * simplesmente não tinha número novo.
 *
 * Aqui a decisão é só de RELÓGIO — sem missão, sem catálogo de modelos. Ler a
 * cota custa materializar a credencial num HOME temporário e rodar o binário do
 * motor, então não é de graça: uma vez a cada `INTERVALO_DE_RELEITURA_MIN` por
 * conexão.
 */

/** Uma conexão de motor, do ponto de vista de quem decide reler a cota. */
export type ConexaoParaReleitura = {
  userId: string
  runtime: string
  status: string
  quotaRefreshedAt: Date | string | null
}

/**
 * 30 minutos. As janelas que o painel mostra são de 5 horas e de 1 semana; meia
 * hora é fino o bastante para nenhuma delas virar sem o dono ver, e grosso o
 * bastante para não chamar o binário do motor a cada tique de 1 minuto.
 */
export const INTERVALO_DE_RELEITURA_MIN = 30

/**
 * Só conexão CONECTADA tem cota para ler. Uma conexão `error`/`revoked`/
 * `expired` faria o binário falhar de meia em meia hora sem nunca produzir
 * número — gasto puro, e ainda esconderia o problema real atrás do ruído.
 */
const STATUS_QUE_TEM_COTA = new Set(['connected'])

export function precisaRelerCota(
  conexao: ConexaoParaReleitura,
  agora: Date,
  intervaloMin: number = INTERVALO_DE_RELEITURA_MIN
): boolean {
  if (!STATUS_QUE_TEM_COTA.has(conexao.status)) return false
  // Nunca lida: lê agora. É exatamente o caso do motor que nunca completou
  // missão nenhuma — o que deixava as quatro colunas vazias para sempre.
  if (conexao.quotaRefreshedAt == null) return true
  const lidaEm =
    conexao.quotaRefreshedAt instanceof Date
      ? conexao.quotaRefreshedAt
      : new Date(conexao.quotaRefreshedAt)
  // Carimbo ilegível é "não sei quando li" — e não saber quando leu dá o mesmo
  // risco de mostrar número podre. Lê.
  if (Number.isNaN(lidaEm.getTime())) return true
  return agora.getTime() - lidaEm.getTime() >= intervaloMin * 60 * 1000
}

export function cotasAReler<T extends ConexaoParaReleitura>(
  conexoes: readonly T[],
  agora: Date,
  intervaloMin: number = INTERVALO_DE_RELEITURA_MIN
): T[] {
  return conexoes.filter((c) => precisaRelerCota(c, agora, intervaloMin))
}
