/**
 * Quando vale a pena gastar uma chamada para saber a cota.
 *
 * O PEDIDO DO DONO, 27/08: ele quer que o produto escolha o motor sozinho pela
 * cota. Só que o produto NÃO SABE a cota de nenhum motor — os campos estão
 * vazios desde sempre. Sem número não existe escolha automática, e por isso
 * esta é a dependência dura daquele pedido.
 *
 * A CAUSA, achada no código e não suposta: a cota do Codex só nasce como efeito
 * colateral do aquecimento (`defaultCodexWarmUp`, model-catalog.ts), que roda
 * `codex exec` de verdade e captura o evento de limites. E o aquecimento só é
 * disparado quando `models_cache.json` está AUSENTE:
 *
 *     let raw = await fs.readFile(file)     // models_cache.json
 *     if (!raw) { await warmUp(...) }       // <- único disparo
 *
 * Só que `models_cache.json` está na lista de arquivos que o cofre guarda e
 * devolve a cada missão. Ele NUNCA está ausente. Logo o aquecimento NUNCA
 * roda, o arquivo de cota nunca é escrito, e a leitura devolve nulo para
 * sempre — exatamente o que se via no banco.
 *
 * E a decisão de não reaquecer estava CERTA pelo motivo dela: reaquecer a cada
 * missão gastaria a cota do cliente à toa (há um comentário em
 * engine-connection.ts dizendo isso com todas as letras). As duas coisas
 * verdadeiras se chocavam:
 *
 *   - reaquecer sempre  -> saber a cota, gastando cota a cada missão;
 *   - nunca reaquecer   -> não gastar nada, e nunca saber a cota.
 *
 * A saída não é escolher um dos lados: é separar a PERGUNTA da FREQUÊNCIA.
 * Aquecer de tempos em tempos dá o número por um custo desprezível — quatro
 * chamadas por dia em vez de uma por missão.
 */

/**
 * De quanto em quanto tempo a cota é coletada.
 *
 * Seis horas: o suficiente para o número servir de base a uma decisão ("qual
 * motor tem mais folga") e raro o bastante para o custo desaparecer perto do
 * que as missões já gastam. Mais curto volta a morder a cota do cliente; mais
 * longo devolve um número velho demais para decidir com ele.
 */
export const INTERVALO_DE_COLETA_DE_COTA_MS = 6 * 60 * 60_000

/**
 * Está na hora de coletar?
 *
 * `ultimaColeta` ausente = nunca coletamos, e aí é sempre hora. Data no futuro
 * (relógio torto, restauração de backup) NÃO trava a coleta para sempre: é
 * tratada como "não sei quando foi", que é o lado seguro — o custo de uma
 * coleta a mais é uma chamada; o de nunca mais coletar é o produto voltar a
 * ser cego.
 */
export function estaNaHoraDeColetarCota(
  ultimaColeta: Date | null | undefined,
  agora: Date,
  intervaloMs: number = INTERVALO_DE_COLETA_DE_COTA_MS
): boolean {
  if (!ultimaColeta) return true
  const idade = agora.getTime() - ultimaColeta.getTime()
  if (idade < 0) return true
  return idade >= intervaloMs
}
