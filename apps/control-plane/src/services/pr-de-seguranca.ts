// "Este pull request é do aplicador de segurança?"
//
// O aplicador abre pull requests no repositório do cliente (varredura gratuita
// de senhas, permissões mínimas dos workflows). O QA, o vigia e a entrega
// delegada nunca mesclam, fecham nem retomam um pull request destes; só o próprio
// aplicador o mescla, e só quando o projeto está em "cuidar" ou o dono disse sim
// (`mescla-da-melhoria-de-seguranca.ts`). Por isso a identificação é inequívoca e
// mora num módulo sem dependências, que o juiz do QA, o vigia, o reconhecimento
// de entrega delegada e a porta do merge importam sem arrastar o aplicador junto.
//
// Dois sinais, e qualquer um basta: o ramo com o prefixo do GitOrch e a marca no
// corpo. Errar para o lado de enxergar "segurança" demais só deixa de mesclar
// sozinho; errar para o outro lado mesclaria uma mudança no repositório do
// cliente sem ninguém ter olhado.

/** Todo ramo que o aplicador cria começa assim; é o único lugar onde ele grava arquivo. */
export const PREFIXO_DOS_RAMOS_DE_SEGURANCA = 'gitorch/seguranca/'

/** Primeira linha do corpo de todo pull request do aplicador. */
export const MARCA_DO_PR_DE_SEGURANCA = '<!-- gitorch:seguranca -->'

const MARCA_NO_CORPO = /<!--\s*gitorch:seguranca\s*-->/i

export function ehPrDeSeguranca(pr: {
  ramo?: string | null | undefined
  corpo?: string | null | undefined
}): boolean {
  if (
    typeof pr.ramo === 'string' &&
    pr.ramo.toLowerCase().startsWith(PREFIXO_DOS_RAMOS_DE_SEGURANCA)
  ) {
    return true
  }
  return typeof pr.corpo === 'string' && MARCA_NO_CORPO.test(pr.corpo)
}
