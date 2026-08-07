/**
 * Portão de merge: a palavra final é do QA, não do CI.
 *
 * O merge automático nasceu olhando só os testes. Isso basta para bump de
 * dependência, mas não para código escrito pelo dev assíncrono: ali existe um
 * revisor de verdade — o QA do produto — e o veredito dele precisa valer. Sem
 * este portão, um pull request reprovado entra na linha principal desde que os
 * testes estejam verdes, e o julgamento vira enfeite.
 *
 * Duas decisões que parecem detalhe e não são:
 *
 * 1. Veredito é sempre sobre uma VERSÃO. Aprovação de um commit anterior não
 *    autoriza o commit de agora — senão bastaria enviar qualquer alteração
 *    depois do "aprovado" para passar sem ninguém reler.
 * 2. Só conta o veredito do revisor de qualidade. A automação aprova em nome do
 *    sistema antes de mesclar; se essa aprovação contasse, o portão abriria
 *    sozinho.
 */

export type EstadoDaRevisao = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'

export interface RevisaoDoPr {
  /** Login de quem revisou. */
  autor: string
  estado: EstadoDaRevisao
  /** Commit que a revisão julgou; nulo em revisões antigas. */
  commitId?: string | null
  /** Momento da revisão, em ISO 8601. */
  em: string
}

export interface DecisaoDeMerge {
  pode: boolean
  /** Sempre acionável: diz o que destrava. */
  motivo: string
}

/** Estados que carregam julgamento; comentário e revisão descartada não carregam. */
const ESTADOS_COM_VEREDITO: ReadonlyArray<EstadoDaRevisao> = ['APPROVED', 'CHANGES_REQUESTED']

/**
 * Identidades que a própria automação usa para aprovar antes de mesclar. Nunca
 * julgam, mesmo que alguém configure o revisor de qualidade como uma delas: o
 * sistema não é testemunha de si mesmo, e um erro de configuração não pode
 * abrir o portão em silêncio.
 */
const IDENTIDADES_DO_SISTEMA: ReadonlySet<string> = new Set([
  'github-actions',
  'app/github-actions',
])

/** Tira o sufixo de robô e a diferença de caixa; `Gitorch-AI[bot]` e `gitorch-ai` são a mesma pessoa. */
function identidade(login: string): string {
  return login.replace(/\[bot\]$/, '').toLowerCase()
}

function ehIdentidadeDoSistema(login: string): boolean {
  return IDENTIDADES_DO_SISTEMA.has(identidade(login))
}

/**
 * Último julgamento do revisor de qualidade, ou `undefined` se ele ainda não
 * julgou. Revisões se acumulam no pull request; vale a mais recente.
 */
export function ultimoVeredito(
  revisoes: readonly RevisaoDoPr[],
  revisorDeQualidade: string
): RevisaoDoPr | undefined {
  if (ehIdentidadeDoSistema(revisorDeQualidade)) return undefined

  const alvo = identidade(revisorDeQualidade)
  return revisoes
    .filter(
      (r) =>
        identidade(r.autor) === alvo &&
        !ehIdentidadeDoSistema(r.autor) &&
        ESTADOS_COM_VEREDITO.includes(r.estado)
    )
    .sort((a, b) => Date.parse(a.em) - Date.parse(b.em))
    .at(-1)
}

/**
 * Decide se o pull request pode ser mesclado automaticamente.
 *
 * `exigeAprovacao` separa os dois mundos que passam por aqui: rotina de
 * dependência não é julgada pelo QA e não pode ficar parada esperando um
 * veredito que nunca virá; código escrito pelo dev assíncrono só entra com
 * aprovação explícita sobre a versão atual.
 */
export function decidirMerge(args: {
  revisorDeQualidade: string
  revisoes: readonly RevisaoDoPr[]
  /** Commit no topo do pull request agora. */
  commitAtual: string
  exigeAprovacao: boolean
}): DecisaoDeMerge {
  // Configuração inválida não pode virar "aguardando o QA": ficaria indistinguível
  // de um julgamento que ainda não veio, e o pull request esperaria calado para
  // sempre por alguém que não existe.
  if (ehIdentidadeDoSistema(args.revisorDeQualidade)) {
    return {
      pode: false,
      motivo:
        'o revisor de qualidade está configurado como a identidade da própria automação — ' +
        'aponte-o para o revisor de verdade para que o julgamento volte a existir',
    }
  }

  const veredito = ultimoVeredito(args.revisoes, args.revisorDeQualidade)

  if (!veredito) {
    return args.exigeAprovacao
      ? {
          pode: false,
          motivo:
            'aguardando o veredito do QA sobre este pull request — o merge acontece quando ele aprovar',
        }
      : { pode: true, motivo: 'rotina automatizada, sem reprovação pendente do QA' }
  }

  if (veredito.estado === 'CHANGES_REQUESTED') {
    return {
      pode: false,
      motivo:
        `o QA reprovou este pull request (versão julgada: ${veredito.commitId ?? 'não registrada'}) — ` +
        'atenda ao que ele pediu e envie a correção para reabrir o julgamento',
    }
  }

  if (veredito.commitId === args.commitAtual) {
    return { pode: true, motivo: 'aprovado pelo QA nesta versão' }
  }

  return args.exigeAprovacao
    ? {
        pode: false,
        motivo:
          `o QA aprovou outra versão deste pull request (${veredito.commitId ?? 'não registrada'}, ` +
          `e o topo agora é ${args.commitAtual}) — o novo código precisa de novo julgamento`,
      }
    : { pode: true, motivo: 'rotina automatizada, sem reprovação pendente do QA' }
}
