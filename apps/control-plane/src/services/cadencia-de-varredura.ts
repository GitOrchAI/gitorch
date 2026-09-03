/**
 * A3 (fix-up L4-T3): a guarda "lê a cadência (ms) da env, com padrão e
 * defesa contra valor inválido" se repete no scheduler (cadência da
 * reconciliação de dúvidas escaladas, da varredura de quadro, dos itens da
 * sprint, do custo da ordem...). Cada cópia é um lugar a mais onde a guarda
 * pode divergir — a cicatriz documentada nos próprios comentários do
 * scheduler.ts: `Number(x) ?? padrão` NÃO protege nada, porque string vazia,
 * texto ou negativo viram `NaN`/número inteiro e passam direto — a varredura
 * passaria a rodar a CADA TIQUE por um erro de digitação na env. Extraído
 * aqui para essa guarda existir num lugar só.
 */

/**
 * Lê uma cadência em milissegundos da variável de ambiente `nomeEnv`.
 * Ausente → devolve `padraoMs` em silêncio (configuração normal, não é
 * erro). Presente mas inválida (não numérica, `NaN`, `<= 0`) → devolve
 * `padraoMs` e avisa via `onWarn` (opcional; produção passa `app.log.warn`)
 * — nunca deixa passar um valor que faria a varredura rodar sem parar.
 */
export function lerCadenciaMs(
  nomeEnv: string,
  padraoMs: number,
  onWarn?: (mensagem: string) => void
): number {
  const bruto = process.env[nomeEnv]
  if (bruto === undefined) return padraoMs
  const lido = Number(bruto)
  if (!Number.isFinite(lido) || lido <= 0) {
    onWarn?.(`[Scheduler] ${nomeEnv} inválido ('${bruto}'); usando o padrão de ${padraoMs}ms`)
    return padraoMs
  }
  return lido
}
