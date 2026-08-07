/**
 * Portão de merge: a palavra final é do QA, não do CI.
 *
 * O merge automático nasceu olhando só os testes. Isso basta para bump de
 * dependência, mas não para código escrito pelo dev assíncrono: ali existe um
 * revisor de verdade — o QA do produto — e o veredito dele precisa valer. Sem
 * este portão, um pull request reprovado entra na linha principal desde que os
 * testes estejam verdes, e o julgamento vira enfeite.
 *
 * Quatro decisões que parecem detalhe e não são:
 *
 * 1. Veredito é sempre sobre uma VERSÃO. Aprovação de um commit anterior não
 *    autoriza o commit de agora — senão bastaria enviar qualquer alteração
 *    depois do "aprovado" para passar sem ninguém reler.
 * 2. Só conta o veredito do revisor de qualidade. A automação aprova em nome do
 *    sistema antes de mesclar; se essa aprovação contasse, o portão abriria
 *    sozinho.
 * 3. O login do revisor é comparado INTEIRO, com o sufixo de robô. O QA é um
 *    App e revisa como `nome[bot]`; o login `nome`, sem o sufixo, é uma conta
 *    de pessoa que qualquer um pode registrar. Tratar os dois como a mesma
 *    identidade tornaria o veredito assinável por um estranho — num repositório
 *    público, qualquer pessoa pode aprovar um pull request. Colchete não é
 *    caractere válido em nome de usuário, então o sufixo é justamente o que não
 *    dá para falsificar.
 * 4. Quem dispensa o julgamento é a natureza do CÓDIGO, não a identidade de
 *    quem abriu o pull request.
 */

export type EstadoDaRevisao = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'

export interface RevisaoDoPr {
  /** Login de quem revisou, como a plataforma devolve — sufixo de robô incluso. */
  autor: string
  /** `Bot` ou `User`, como a plataforma classifica a conta. */
  tipoDeConta?: string | undefined
  estado: EstadoDaRevisao
  /** Commit que a revisão julgou; nulo em revisões antigas. */
  commitId?: string | null
  /** Momento da revisão, em ISO 8601. */
  em: string
}

/** Autoria de um commit do pull request, como a plataforma devolve. */
export interface CommitDoPr {
  /** Quem escreveu. */
  autor: string
  /** Quem enviou; costuma ser igual ao autor, e divergir importa. */
  enviadoPor?: string | undefined
}

export interface DecisaoDeMerge {
  pode: boolean
  /** Sempre acionável: diz o que destrava. */
  motivo: string
}

/**
 * Estados que carregam julgamento. `COMMENTED` nunca carregou. `DISMISSED`
 * entra na lista de propósito: descartar uma revisão é o gesto de dizer que
 * aquele julgamento não vale mais, e ele precisa ser VISTO para poder anular o
 * anterior. Se fosse filtrado fora, uma aprovação antiga voltaria a valer
 * sozinha depois de revogada.
 */
const ESTADOS_COM_VEREDITO: ReadonlyArray<EstadoDaRevisao> = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
]

/**
 * Identidades que a própria automação usa para aprovar antes de mesclar. Nunca
 * julgam, mesmo que alguém configure o revisor de qualidade como uma delas: o
 * sistema não é testemunha de si mesmo, e um erro de configuração não pode
 * abrir o portão em silêncio.
 */
const IDENTIDADES_DO_SISTEMA: ReadonlySet<string> = new Set([
  'github-actions',
  'github-actions[bot]',
  'app/github-actions',
])

/** O robô que abre os bumps de dependência. */
const ROBO_DE_DEPENDENCIA = 'dependabot[bot]'

/**
 * Quem pode constar como enviador de um commit de rotina.
 *
 * `web-flow` é a identidade com que o GitHub assina os commits criados pela
 * própria API — é assim que os bumps de dependência nascem, e conferido contra
 * pull requests reais é o que aparece ali. Exigir que o enviador fosse o robô
 * travaria toda atualização de dependência do repositório.
 *
 * Aceitá-la não afrouxa nada: commit enviado por `git push` carrega como
 * enviador quem o criou na máquina de origem, nunca `web-flow`. Continua sendo
 * o autor de cada commit que decide se isto é rotina.
 */
const ENVIADORES_DE_ROTINA: ReadonlySet<string> = new Set([ROBO_DE_DEPENDENCIA, 'web-flow'])

/**
 * Nome de usuário no GitHub não diferencia maiúscula de minúscula, então
 * comparar em caixa baixa é seguro. O que NÃO se pode fazer é remover o sufixo
 * `[bot]`: ele é a única parte do login que uma pessoa não consegue registrar.
 */
function identidade(login: string): string {
  return login.toLowerCase()
}

function ehIdentidadeDoSistema(login: string): boolean {
  return IDENTIDADES_DO_SISTEMA.has(identidade(login))
}

/** Um revisor declarado com o sufixo de robô só pode ser atendido por um robô. */
function contaCompativel(revisao: RevisaoDoPr, revisorDeQualidade: string): boolean {
  if (!identidade(revisorDeQualidade).endsWith('[bot]')) return true
  return revisao.tipoDeConta === undefined || revisao.tipoDeConta === 'Bot'
}

/**
 * Decide se o pull request é rotina de dependência — o único caso que dispensa
 * o julgamento do QA.
 *
 * A pergunta é sobre o CÓDIGO que está no topo agora, não sobre quem abriu o
 * pull request. Quem abriu continua sendo o robô mesmo depois que outra pessoa
 * empurra um commit no mesmo ramo, e nesse ponto o que entraria na linha
 * principal já não é rotina nenhuma.
 *
 * Sem commits conhecidos, responde que não: na dúvida, exige julgamento.
 */
export function ehRotinaDeDependencia(commits: readonly CommitDoPr[]): boolean {
  if (commits.length === 0) return false
  return commits.every(
    (c) =>
      identidade(c.autor) === ROBO_DE_DEPENDENCIA &&
      (c.enviadoPor === undefined || ENVIADORES_DE_ROTINA.has(identidade(c.enviadoPor)))
  )
}

/**
 * Último julgamento do revisor de qualidade, ou `undefined` se ele ainda não
 * julgou — ou se o julgamento mais recente dele foi descartado. Revisões se
 * acumulam no pull request; vale a mais recente.
 */
export function ultimoVeredito(
  revisoes: readonly RevisaoDoPr[],
  revisorDeQualidade: string
): RevisaoDoPr | undefined {
  if (ehIdentidadeDoSistema(revisorDeQualidade)) return undefined

  const alvo = identidade(revisorDeQualidade)
  const maisRecente = revisoes
    .filter(
      (r) =>
        identidade(r.autor) === alvo &&
        !ehIdentidadeDoSistema(r.autor) &&
        contaCompativel(r, revisorDeQualidade) &&
        ESTADOS_COM_VEREDITO.includes(r.estado)
    )
    .sort((a, b) => Date.parse(a.em) - Date.parse(b.em))
    .at(-1)

  // Julgamento descartado não é julgamento: some, e não deixa o anterior no lugar.
  return maisRecente?.estado === 'DISMISSED' ? undefined : maisRecente
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
