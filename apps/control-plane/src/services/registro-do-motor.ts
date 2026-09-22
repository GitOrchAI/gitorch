// A chave de dedup do registro no painel para cada decisão do motor do
// próximo passo (Fase 3.11) — registrarNoPainelUmaVez (registro-no-painel.ts,
// DJ-T15) já dedupa por chave; esta função só monta a chave estável.
//
// Inclui a AÇÃO na chave (não só repositório+PR): a mesma decisão repetida
// em passadas seguintes não vira registro novo, mas uma decisão DIFERENTE
// (o motor mudou de ideia porque o estado mudou) tem que aparecer como um
// evento novo na timeline — nunca escondida atrás da chave da decisão antiga.
export function chaveDoRegistroDoMotor(
  repository: string,
  numeroDoPr: number,
  acao: string
): string {
  return `motor-do-proximo-passo:${repository}:${numeroDoPr}:${acao}`
}
