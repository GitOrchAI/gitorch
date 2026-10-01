// "Esta pessoa é participante do repositório?"
//
// Quem o dono deixou orquestrar o repositório tem o PR e a issue atendidos pelos
// agentes, como o trabalho do dev delegado.
//
// REGRA DE SEGURANÇA (repositório público): a única fonte da resposta é o campo
// `author_association`, que o PRÓPRIO GITHUB preenche no aviso e nas listas de
// PRs e issues. Texto do título, do corpo ou de comentário, e nome de usuário
// (login) NUNCA entram nesta decisão: qualquer pessoa de fora escreve "sou
// colaborador" ou escolhe um login com "jules" — o campo do GitHub ela não
// consegue forjar.
//
// Só OWNER, MEMBER e COLLABORATOR. CONTRIBUTOR, NONE, FIRST_TIME_CONTRIBUTOR,
// FIRST_TIMER, MANNEQUIN, ausente ou qualquer valor desconhecido: não é
// participante, e o comportamento de antes continua (nenhum agente age).
// Conta de aplicativo (`type: "Bot"`) também fica fora: o vigia já trata
// dependabot e afins à parte.

const ASSOCIACOES_DE_PARTICIPANTE: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
])

export function ehParticipanteDoRepo(authorAssociation: unknown, tipoDoAutor?: unknown): boolean {
  if (typeof tipoDoAutor === 'string' && tipoDoAutor.toLowerCase() === 'bot') return false
  if (typeof authorAssociation !== 'string') return false
  return ASSOCIACOES_DE_PARTICIPANTE.has(authorAssociation.toUpperCase())
}
