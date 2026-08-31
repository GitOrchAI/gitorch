// O VIGIA DO PULL REQUEST — a peça que o desenho da esteira nunca teve.
//
// O desenho ia do desejo até o painel e parava. Enquanto a sessão do dev
// assíncrono está VIVA, `session-watch.ts` cuida do trabalho dela, e
// `varrerCicloTerminalDaSessao` cuida da linha que chegou ao fim. Mas quando a
// sessão MORRE com o pull request ainda aberto, o pull request sai do radar:
// nenhuma das duas varreduras olha para ele de novo, e o SM também não —
// `escolherParaDelegar` trata "linha fechada com PR" como prova de que a tarefa
// já foi entregue, então a issue nunca volta para a fila. O PR fica aberto para
// sempre.
//
// Medido no banco em 31/08/2026, no repositório do produto: 119 linhas de
// sessão, UMA viva. Dos 18 pull requests abertos, 17 têm sessão FECHADA
// (`pr-rejeitado-sem-retomada`, `abandoned`) e um único (#408) tem sessão viva.
// Ou seja: a vigia de sessões cuidava de 1 e ninguém cuidava dos outros 17.
//
// ESTE MÓDULO É PURO NA DECISÃO E INJETADO NA AÇÃO, pelo mesmo motivo de
// `session-watch.ts`: a decisão precisa ser testável com o corpo REAL dos pull
// requests do dono, sem rede, e a ação precisa passar pelos portões que já
// existem (guarda de autonomia, teto de vagas da conta do dev).
//
// O PORTÃO MAIS PERIGOSO DE PULAR VEM PRIMEIRO: pull request de gente nunca é
// tocado. Mesma lei de `fechar-tarefa.ts` e `mesclarPr` — o produto julga toda
// entrega, mas só ADMINISTRA (retoma, fecha) o que ele mesmo encomendou. Aqui
// isso é mais delicado que nos vizinhos, porque o pull request do dev sai com o
// AUTOR do dono (conta da instalação) e sem label: o login não separa nada.

import { pedidoDeRebase } from './conflito-de-merge.js'

/**
 * Rodapé emitido pelo dev assíncrono ao abrir o pull request — a ÚNICA
 * evidência positiva de autoria que existe quando o autor é a conta do dono.
 *
 * Cópia deliberada da regra de `.github/scripts/lib/pr-eligibility.ts`, e não
 * um import: aquele arquivo vive fora do workspace pnpm (`.github/scripts`
 * instala com `--ignore-workspace`) e fora do `rootDir` deste pacote, então o
 * `tsc` do control-plane não o alcança. Para a cópia não virar divergência
 * silenciosa — que é exatamente como este produto já foi mordido antes — o
 * teste `a expressão vive igual nos dois lados` lê OS DOIS ARQUIVOS do disco e
 * compara a expressão caractere a caractere. Mexer num lado sem o outro fica
 * vermelho e diz onde.
 */
const RODAPE_DO_DEV =
  /^[ \t*_]*PR created automatically by Jules for task\s+(?:\[\d+\]\(https:\/\/jules\.google\.com\/task\/\d+\)|\d+)[^\n]*started by @[\w-]+/m

/** Contas de bot que são, por si só, prova de que o pull request é da automação. */
const AUTORES_DA_AUTOMACAO = ['dependabot[bot]', 'dependabot-preview[bot]']

/**
 * Automação que o vigia reconhece mas NÃO tem como consertar (ACHADO 6 do QA).
 *
 * Não é uma correção da autoria — `ehPRDaAutomacao` continua respondendo a
 * verdade sobre estes pull requests. É um limite do vigia: a única ferramenta
 * de conserto que ele tem é abrir uma sessão do dev assíncrono, e essa sessão
 * precisa de uma TAREFA DE ORIGEM. Pull request do Dependabot não nasce de
 * tarefa nenhuma; não há sessão morta atrás dele para retomar.
 *
 * Sem esta lista, o que sobrava para eles era o portão 5 ("não tenho tarefa de
 * origem registrada"), ou seja: ESCALAR ao dono. Medido no repositório do
 * produto em 31/08/2026, os dois pull requests do Dependabot abertos (#403 e
 * #404) não têm linha de sessão — cada um viraria duas escaladas assim que
 * passasse dos três dias, sobre algo que o próprio Dependabot resolve: o #360
 * foi fechado por ele mesmo, com "Looks like these dependencies are updatable
 * in another way, so this is no longer needed".
 *
 * Chamar o dono para dizer "achei um pull request e não sei o que é" quatro
 * vezes por semana é o barulho que apaga o aviso que importa.
 */
export const AUTORES_QUE_O_VIGIA_NAO_CONSERTA: readonly string[] = [
  'dependabot[bot]',
  'dependabot-preview[bot]',
]

/** É automação de dependência, que o vigia enxerga mas não sabe destravar? */
export function ehAutomacaoQueOVigiaNaoConserta(pr: SinaisDePR): boolean {
  return AUTORES_QUE_O_VIGIA_NAO_CONSERTA.includes(pr.autor ?? '')
}

/** Labels que a automação põe no PRÓPRIO pull request (nunca na issue). */
const LABELS_DA_AUTOMACAO = ['jules', 'dependabot']

/**
 * Remove tudo que é TEXTO CITADO: blocos de código (``` e ~~~), código inline e
 * linhas de citação (>). Citar o rodapé não é ser o rodapé — e escrever sobre
 * esta automação é justamente o que um pull request do dono faz.
 */
function semTrechosCitados(corpo: string): string {
  return corpo
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')
    .split('\n')
    .filter((linha) => !/^\s{0,3}>/.test(linha))
    .join('\n')
}

/** O corpo traz o rodapé que o dev assíncrono escreve (e não uma citação dele)? */
export function temRodapeDoDev(corpo: string | null | undefined): boolean {
  return RODAPE_DO_DEV.test(semTrechosCitados(corpo ?? ''))
}

/** O que basta para decidir autoria — sem rede. */
export interface SinaisDePR {
  autor?: string | null
  labels?: string[] | null
  corpo?: string | null
}

/**
 * Decide por EVIDÊNCIA POSITIVA de que o pull request nasceu da automação. Três
 * sinais, e só três: o autor é um bot conhecido, o próprio pull request carrega
 * label da automação, ou o corpo traz o rodapé do dev.
 *
 * Ausência de evidência é "de gente" — nunca o contrário. Errar para o lado de
 * não agir custa um pull request parado a mais; errar para o outro é a
 * automação mexendo no trabalho de uma pessoa.
 */
export function ehPRDaAutomacao(pr: SinaisDePR): boolean {
  if (AUTORES_DA_AUTOMACAO.includes(pr.autor ?? '')) return true
  if ((pr.labels ?? []).some((l) => LABELS_DA_AUTOMACAO.includes(l))) return true
  return temRodapeDoDev(pr.corpo)
}

/**
 * Quantas vezes o vigia age sobre o MESMO pull request antes de parar e chamar
 * gente.
 *
 * DOIS, o mesmo número (e o mesmo motivo) de `MAX_PEDIDOS_DE_REBASE` em
 * `conflito-de-merge.ts`: se o dev não resolveu na segunda, ou o conflito é
 * maior do que ele alcança, ou há algo que ele não entende. Cada ação aqui
 * custa uma SESSÃO NOVA na conta do dev — insistir a terceira vez queima cota
 * de verdade e adia o momento em que o dono descobre.
 *
 * E o teto DIZ quando morde: ao alcançá-lo a decisão vira `escalar`, com o
 * número de tentativas escrito no recado. Teto silencioso é o mesmo defeito
 * que ele deveria consertar.
 */
export const MAX_ACOES_DO_VIGIA = 2

/**
 * Quantas ações o vigia executa numa MESMA passada, somando todo o projeto
 * (ACHADO 2 do QA).
 *
 * `MAX_ACOES_DO_VIGIA` limita o que acontece com UM pull request ao longo do
 * tempo. Este limita quantos pull requests são tocados de uma vez — e é ele que
 * faltava. Medido em 31/08/2026, rodando o código real a seco contra o GitHub e
 * o banco do produto: a PRIMEIRA passada fecharia SEIS pull requests de uma vez
 * (#314, #324, #330, #331, #335, #341). Estrear com uma limpeza em massa é a
 * pior forma de o dono descobrir que o vigia existe.
 *
 * DOIS, e o número tem conta:
 *   · a varredura roda de 6 em 6 horas, então o teto ainda drena 8 por dia — a
 *     dívida medida hoje (6) se resolve em menos de um dia, e o regime normal
 *     do repositório é 1 a 2 órfãos por dia, bem abaixo disso;
 *   · com 2 por passada, as duas primeiras ações chegam ao Telegram e à linha
 *     do tempo do painel ~6h antes das seguintes: há janela para desligar;
 *   · é o mesmo número, pelo mesmo motivo, de `TETO_DE_ANALISES_POR_PASSADA`
 *     (analisar-falhas-pendentes.ts): ação que custa caro e é difícil de
 *     desfazer anda devagar.
 *
 * E ele DIZ quando morde: o resumo da passada conta quantos ficaram para a
 * próxima. Teto silencioso é o mesmo defeito que ele existe para consertar.
 */
export const TETO_DE_ACOES_POR_PASSADA = 2

/**
 * Quanto tempo um pull request precisa ficar sem avanço antes de o vigia
 * considerá-lo órfão.
 *
 * Três dias, e não algumas horas: o dev assíncrono trabalha em rajadas, e um
 * pull request que recebeu commit ontem pode muito bem receber outro hoje.
 * Agir cedo demais abriria sessão nova contra trabalho que ainda está andando —
 * o mesmo desperdício que a cadência de `session-watch` evita, numa escala
 * maior.
 */
export const IDADE_MINIMA_DE_ORFANDADE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * De quanto em quanto tempo a varredura roda por projeto.
 *
 * Seis horas — o mesmo período do relógio que já varre conflitos
 * (`jules-pr-conflict.yml`). Bem abaixo da idade mínima de órfão de propósito:
 * assim quem decide se é hora de agir é a IDADE do pull request, não o acaso de
 * quando o relógio bateu.
 */
export const CADENCIA_DA_VARREDURA_MS = 6 * 60 * 60 * 1000

/** O que a verificação automática do pull request está dizendo agora. */
export type EstadoDaVerificacao = 'verde' | 'vermelha' | 'pendente' | 'ausente'

/** O que basta para saber se dá para pedir conserto no ramo do pull request. */
export interface RamoDoPr {
  /** `head.ref` do GitHub: o ramo onde o trabalho do dev realmente está. */
  branchDoPr: string | null
  /** O ramo vive no repositório do projeto? Pull request de fork, não. */
  branchNoRepoDoProjeto: boolean
}

/**
 * O ramo que o dev consegue retomar, ou `null` quando não há nenhum.
 *
 * `null` NÃO pode virar "então use a principal" (ACHADO 1 do QA): abrir a
 * sessão em `main` faz o dev recomeçar do zero e, com `AUTO_CREATE_PR`, abrir
 * um SEGUNDO pull request — o primeiro continua órfão e agora há dois.
 *
 * Fork cai aqui de propósito: o ramo existe, mas no repositório de outra
 * pessoa. A fonte que o dev assíncrono tem conectada é a do projeto, e ele não
 * empurra para o fork de terceiro.
 */
export function branchParaRetomar(pr: RamoDoPr): string | null {
  if (!pr.branchNoRepoDoProjeto) return null
  const ramo = (pr.branchDoPr ?? '').trim()
  return ramo === '' ? null : ramo
}

/** Um pull request ABERTO, como o GitHub o descreve. */
export interface PrAberto extends RamoDoPr {
  numero: number
  autor?: string | null
  labels?: string[] | null
  corpo?: string | null
  /** `mergeable` do GitHub. `null` = ele ainda está calculando. */
  mergeable: boolean | null
  verificacao: EstadoDaVerificacao
  /** Há quanto tempo o pull request não recebe nada. */
  paradoHaMs: number
}

/** Tudo que a decisão precisa saber — nada disso é buscado aqui dentro. */
export interface PrOrfaoObservado extends RamoDoPr {
  numero: number
  sinais: SinaisDePR
  /** Há linha de sessão VIVA apontando para este pull request? */
  temSessaoViva: boolean
  /** A tarefa de origem, pela linha que guardou este pull request. */
  issueNumber: number | null
  issueAberta: boolean
  mergeable: boolean | null
  verificacao: EstadoDaVerificacao
  paradoHaMs: number
  /** Quantas vezes o vigia JÁ agiu sobre este pull request (lido de `events`). */
  acoesAnteriores: number
  /** Há vaga na conta do dev para abrir mais uma sessão nesta passada? */
  podeAbrirSessao: boolean
}

/** Por que o trabalho parou — o que o vigia vai pedir para o dev consertar. */
export type CausaDaParada = 'conflito' | 'ci-vermelha'

export type AcaoDoVigia =
  /** Não é assunto do vigia (é de gente, é da vigia de sessões, ou é cedo demais). */
  | { acao: 'ignorar'; motivo: string }
  /** Abrir sessão nova para o MESMO trabalho, com o pedido do que consertar. */
  | {
      acao: 'retomar'
      issueNumber: number
      causa: CausaDaParada
      pedido: string
      /** O ramo em que a sessão nova nasce e para onde ela devolve o trabalho. */
      branchDoPr: string
      motivo: string
    }
  /** Fechar o pull request dizendo por quê. */
  | { acao: 'fechar'; motivo: string }
  /** O produto não resolve: o dono precisa saber. */
  | { acao: 'escalar'; motivo: string }

function pedidoDeConsertarVerificacao(numeroDoPr: number): string {
  return [
    `A verificação automática do pull request #${numeroDoPr} está vermelha, e ele ficou`,
    'parado assim. Ninguém vai mesclar uma entrega que não passa.',
    '',
    'Traga a base para o seu ramo, veja o que a verificação está reprovando, conserte a',
    'causa (nunca desligue nem mascare o teste que reprovou) e empurre. Não mude nada',
    'fora do escopo da tarefa enquanto faz isso.',
  ].join('\n')
}

/**
 * O que fazer com UM pull request aberto. Pura: mesma entrada, mesma saída,
 * zero rede.
 *
 * A ordem dos portões é a decisão de projeto mais importante deste arquivo, e é
 * a mesma disciplina de `decidirFechamento`: o portão mais perigoso de pular
 * vem primeiro.
 */
export function decidirAcaoNoPrOrfao(pr: PrOrfaoObservado): AcaoDoVigia {
  // 1) PULL REQUEST DE GENTE. Antes de qualquer outra coisa, e sem exceção.
  if (!ehPRDaAutomacao(pr.sinais)) {
    return {
      acao: 'ignorar',
      motivo: `#${pr.numero} é entrega de gente — o produto julga, mas não administra pull request de humano`,
    }
  }

  // 2) AUTOMAÇÃO QUE O VIGIA NÃO CONSERTA. Ver
  // `AUTORES_QUE_O_VIGIA_NAO_CONSERTA`: é automação de verdade, mas não há
  // sessão de dev atrás dela para retomar nem tarefa de origem para explicar um
  // fechamento. Sem este portão, cada pull request do Dependabot terminava em
  // ESCALADA ao dono — barulho recorrente sobre algo que o próprio Dependabot
  // resolve.
  if (ehAutomacaoQueOVigiaNaoConserta(pr.sinais)) {
    return {
      acao: 'ignorar',
      motivo: `#${pr.numero} é do Dependabot — não há sessão de dev atrás dele para o vigia retomar`,
    }
  }

  // 3) NÃO COMPETIR. Enquanto a sessão está viva, quem examina este pull
  // request é `vigiarSessoes` (session-watch.ts) e quem fecha a linha é
  // `varrerCicloTerminalDaSessao`. Duas varreduras agindo sobre o mesmo pull
  // request abririam sessão em cima de sessão e pediriam rebase duas vezes.
  if (pr.temSessaoViva) {
    return {
      acao: 'ignorar',
      motivo: `#${pr.numero} ainda tem sessão viva — quem cuida dele é a vigia de sessões (session-watch)`,
    }
  }

  // 4) CEDO DEMAIS.
  if (pr.paradoHaMs < IDADE_MINIMA_DE_ORFANDADE_MS) {
    const dias = Math.floor(IDADE_MINIMA_DE_ORFANDADE_MS / (24 * 60 * 60 * 1000))
    return {
      acao: 'ignorar',
      motivo: `#${pr.numero} recebeu novidade há menos de ${dias} dias — ainda pode andar sozinho`,
    }
  }

  // 5) O TETO POR PULL REQUEST, E O TETO DIZ QUANDO MORDE.
  //
  // Estritamente MAIOR que o teto significa que a escalada já saiu (ela mesma
  // conta como ação): daí em diante o vigia se cala, porque repetir o mesmo
  // recado de hora em hora apaga o sinal tanto quanto o silêncio.
  if (pr.acoesAnteriores > MAX_ACOES_DO_VIGIA) {
    return {
      acao: 'ignorar',
      motivo: `#${pr.numero} já foi entregue ao dono depois do teto — agora é com ele`,
    }
  }
  if (pr.acoesAnteriores >= MAX_ACOES_DO_VIGIA) {
    return {
      acao: 'escalar',
      motivo:
        `Tentei ${MAX_ACOES_DO_VIGIA} vezes destravar o pull request #${pr.numero} e ele continua ` +
        'parado. Não vou tentar de novo: alguém precisa olhar, ou a entrega fica onde está.',
    }
  }

  // 6) SEM TAREFA DE ORIGEM não dá para retomar (sessão nova precisa de uma
  // tarefa) nem para fechar (fechar sem saber o que era é destruir trabalho às
  // cegas). Quando o produto não sabe, quem decide é gente.
  if (pr.issueNumber === null) {
    return {
      acao: 'escalar',
      motivo:
        `O pull request #${pr.numero} é do dev assíncrono, está parado e não tenho tarefa de origem ` +
        'registrada para ele. Não dá para retomar nem para dizer por que fechar.',
    }
  }

  // 7) A TAREFA JÁ FOI RESOLVIDA por outro caminho: esta entrega ficou para
  // trás. Fechar dizendo por quê é melhor do que deixá-la aberta para sempre.
  if (!pr.issueAberta) {
    return {
      acao: 'fechar',
      motivo:
        `A tarefa #${pr.issueNumber} que originou este pull request já está fechada — ela foi ` +
        'resolvida por outro caminho. Fechando esta entrega, que ficou para trás.',
    }
  }

  // 8) O GITHUB AINDA NÃO SABE se dá para mesclar. `mergeable: null` é "estou
  // calculando", e tratar isso como conflito abriria sessão à toa.
  if (pr.mergeable === null) {
    return {
      acao: 'ignorar',
      motivo: `#${pr.numero}: o GitHub ainda está calculando se dá para mesclar`,
    }
  }

  // 9) VERIFICAÇÃO RODANDO ainda pode ficar verde.
  if (pr.verificacao === 'pendente') {
    return { acao: 'ignorar', motivo: `#${pr.numero}: a verificação ainda está rodando` }
  }

  const causa: CausaDaParada | null =
    pr.mergeable === false ? 'conflito' : pr.verificacao === 'vermelha' ? 'ci-vermelha' : null

  // 10) NÃO HÁ O QUE CONSERTAR e mesmo assim está parado: mesclável, verificação
  // não reprovada, e ninguém mesclou. Abrir sessão nova aqui não produziria
  // nada — o dev entregaria de novo o que já está entregue. O que falta é
  // julgamento, e isso é notícia para o dono.
  if (causa === null) {
    const dias = Math.floor(pr.paradoHaMs / (24 * 60 * 60 * 1000))
    return {
      acao: 'escalar',
      motivo:
        `O pull request #${pr.numero} (tarefa #${pr.issueNumber}) está mesclável e sem verificação ` +
        `reprovada há ${dias} dias, e ninguém o mesclou. A entrega está pronta e parada.`,
    }
  }

  // 11) SEM RAMO NÃO SE RETOMA NADA (ACHADO 1 do QA).
  //
  // O trabalho do dev está no ramo DELE. Uma sessão aberta na principal não
  // conserta este pull request: ela recomeça do zero e, com `AUTO_CREATE_PR`,
  // abre um SEGUNDO pull request — o órfão continua órfão e agora há dois.
  // Quando o ramo não dá para usar (não veio na leitura, veio vazio, ou vive
  // num fork), a resposta certa é dizer isso ao dono, não agir errado.
  const branch = branchParaRetomar(pr)
  if (branch === null) {
    return {
      acao: 'escalar',
      motivo:
        `O pull request #${pr.numero} (tarefa #${pr.issueNumber}) precisa de conserto ` +
        `(${causa === 'conflito' ? 'está com conflito' : 'está com a verificação vermelha'}), mas ` +
        'não consigo usar o ramo dele: ou não sei qual é, ou ele vive num fork. Não vou abrir ' +
        'trabalho na branch principal, porque isso abriria uma segunda entrega em vez de ' +
        'consertar esta.',
    }
  }

  // 12) HÁ VAGA NA CONTA DO DEV? O teto de sessões simultâneas é da CONTA, não
  // deste caminho. Estourá-lo por fora faria a delegação normal — a que tira
  // tarefa da fila — passar a ser recusada por culpa do vigia.
  if (!pr.podeAbrirSessao) {
    return {
      acao: 'ignorar',
      motivo: `#${pr.numero}: sem vaga na conta do dev agora; fica para a próxima passada`,
    }
  }

  return {
    acao: 'retomar',
    issueNumber: pr.issueNumber,
    causa,
    branchDoPr: branch,
    pedido:
      causa === 'conflito' ? pedidoDeRebase(pr.numero) : pedidoDeConsertarVerificacao(pr.numero),
    motivo:
      causa === 'conflito'
        ? `#${pr.numero} está com conflito e sem sessão atrás dele — abrindo sessão nova para rebasear`
        : `#${pr.numero} está com a verificação vermelha e sem sessão atrás dele — abrindo sessão nova para consertar`,
  }
}

export interface VigiaDoPrDeps {
  /** TODO pull request aberto do projeto — paginado por quem chama, sem teto mudo. */
  listarPrsAbertos: () => Promise<PrAberto[]>
  /**
   * Números de pull request com linha de sessão VIVA. É a fronteira com
   * `session-watch`: o que está aqui dentro é dela, o que está fora é do vigia.
   */
  prsComSessaoViva: Set<number>
  /** A tarefa de origem, pela linha de sessão que guardou este pull request. */
  issueDoPr: (numeroDoPr: number) => number | null
  issueAberta: (issueNumber: number) => Promise<boolean>
  /** Quantas decisões o vigia já gravou para este pull request — é o teto. */
  acoesAnteriores: (numeroDoPr: number) => Promise<number>
  /** Vagas de sessão simultânea que sobram na conta do dev nesta passada. */
  vagasLivres: number
  abrirSessaoDeConserto: (args: {
    numeroDoPr: number
    issueNumber: number
    causa: CausaDaParada
    pedido: string
    /**
     * O ramo do pull request. A sessão nova NASCE nele e DEVOLVE nele — é o
     * que faz o conserto cair na entrega que já existe em vez de abrir outra.
     */
    branchDoPr: string
  }) => Promise<boolean>
  fecharPr: (args: { numero: number; motivo: string }) => Promise<boolean>
  avisarDono: (texto: string) => Promise<boolean>
  /**
   * Grava a decisão em `events`. O tipo é `audit` — é o único que a linha do
   * tempo do dono lê (`painel.ts`, `GET /api/v1/painel/timeline` filtra
   * `type: 'audit'` e renderiza `payload.texto`). `painel_escreveu` não é lido
   * por tela nenhuma.
   */
  registrarDecisao: (args: {
    numeroDoPr: number
    acao: AcaoDoVigia['acao']
    texto: string
  }) => Promise<void>
  /**
   * Teto de ações desta passada. Padrão: `TETO_DE_ACOES_POR_PASSADA`.
   *
   * `| undefined` explícito por causa de `exactOptionalPropertyTypes`: quem
   * repassa `teto: algoQuePodeSerUndefined` precisa compilar.
   */
  teto?: number | undefined
  onWarn?: (m: string) => void
  onInfo?: (m: string) => void
}

function pluralizar(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`
}

/**
 * Varre TODO pull request aberto do projeto e age no que ficou órfão.
 *
 * Falha num pull request nunca contamina os outros: cada um roda no seu
 * try/catch e o laço segue — mesma disciplina de `vigiarSessoes`.
 *
 * ECONOMIA DE REDE: os três portões baratos (é de gente? tem sessão viva? é
 * cedo demais?) rodam ANTES de qualquer consulta. Só o que sobra custa uma
 * leitura do estado da tarefa e uma contagem de eventos.
 */
export async function vigiarPrsOrfaos(deps: VigiaDoPrDeps): Promise<string> {
  const warn = deps.onWarn ?? (() => undefined)
  const info = deps.onInfo ?? (() => undefined)
  const prs = await deps.listarPrsAbertos()

  const teto = deps.teto ?? TETO_DE_ACOES_POR_PASSADA
  let vagas = deps.vagasLivres
  let acoesFeitas = 0
  let deGente = 0
  let doDependabot = 0
  let comSessaoViva = 0
  let quietos = 0
  let retomados = 0
  let fechados = 0
  let escalados = 0
  let adiadosPeloTeto = 0
  let falhas = 0

  for (const pr of prs) {
    try {
      if (!ehPRDaAutomacao(pr)) {
        deGente += 1
        continue
      }
      if (ehAutomacaoQueOVigiaNaoConserta(pr)) {
        doDependabot += 1
        continue
      }
      if (deps.prsComSessaoViva.has(pr.numero)) {
        comSessaoViva += 1
        continue
      }
      if (pr.paradoHaMs < IDADE_MINIMA_DE_ORFANDADE_MS) {
        quietos += 1
        continue
      }

      const issueNumber = deps.issueDoPr(pr.numero)
      const decisao = decidirAcaoNoPrOrfao({
        numero: pr.numero,
        sinais: pr,
        temSessaoViva: false,
        issueNumber,
        // Quando não há tarefa de origem, a decisão nem chega a olhar para
        // isto (o portão 5 vem antes) — e assim não se gasta a leitura.
        issueAberta: issueNumber === null ? true : await deps.issueAberta(issueNumber),
        branchDoPr: pr.branchDoPr,
        branchNoRepoDoProjeto: pr.branchNoRepoDoProjeto,
        mergeable: pr.mergeable,
        verificacao: pr.verificacao,
        paradoHaMs: pr.paradoHaMs,
        acoesAnteriores: await deps.acoesAnteriores(pr.numero),
        podeAbrirSessao: vagas > 0,
      })

      // O TETO DESTA PASSADA (ACHADO 2 do QA). Fica DEPOIS da decisão e ANTES
      // da execução de propósito: o que ele corta não é "o que olhar", é "o
      // que fazer". Cortar a lista de entrada, como fazem as varreduras que
      // fatiam com `slice`, esconderia pull requests inteiros da vigilância; o
      // que precisa andar devagar é a escrita, não o olhar.
      if (decisao.acao !== 'ignorar' && acoesFeitas >= teto) {
        adiadosPeloTeto += 1
        warn(
          `[vigia-do-pr] o #${pr.numero} ficaria em "${decisao.acao}", mas já fiz ${acoesFeitas} ` +
            `ações nesta passada (teto ${teto}); fica para a próxima`
        )
        continue
      }
      if (decisao.acao !== 'ignorar') acoesFeitas += 1

      switch (decisao.acao) {
        case 'ignorar': {
          // De propósito NÃO vira evento. A linha do tempo do dono mostra os
          // dez últimos: gravar "não fiz nada com o #356" a cada passada
          // enterraria a notícia de verdade embaixo do próprio silêncio.
          quietos += 1
          info(`[vigia-do-pr] ${decisao.motivo}`)
          break
        }

        case 'retomar': {
          const abriu = await deps.abrirSessaoDeConserto({
            numeroDoPr: pr.numero,
            issueNumber: decisao.issueNumber,
            causa: decisao.causa,
            pedido: decisao.pedido,
            branchDoPr: decisao.branchDoPr,
          })
          if (!abriu) {
            // Sem evento: `events` é o registro do que ACONTECEU, e é também o
            // que conta o teto. Gravar uma tentativa que não saiu do lugar
            // gastaria o teto sem nunca ter agido — o pull request seria
            // abandonado ao dono por culpa de uma indisponibilidade nossa.
            warn(`[vigia-do-pr] não consegui abrir sessão para o #${pr.numero}; tenta na próxima`)
            break
          }
          vagas -= 1
          retomados += 1
          await deps.registrarDecisao({
            numeroDoPr: pr.numero,
            acao: 'retomar',
            texto:
              decisao.causa === 'conflito'
                ? `A entrega #${pr.numero} (tarefa #${decisao.issueNumber}) estava com conflito e sem ninguém atrás dela; abri trabalho novo para resolver.`
                : `A entrega #${pr.numero} (tarefa #${decisao.issueNumber}) estava com a verificação vermelha e sem ninguém atrás dela; abri trabalho novo para consertar.`,
          })
          break
        }

        case 'fechar': {
          const fechou = await deps.fecharPr({ numero: pr.numero, motivo: decisao.motivo })
          if (!fechou) {
            warn(`[vigia-do-pr] não consegui fechar o #${pr.numero}; tenta na próxima`)
            break
          }
          fechados += 1
          await deps.registrarDecisao({
            numeroDoPr: pr.numero,
            acao: 'fechar',
            texto: `Fechei a entrega #${pr.numero}: ${decisao.motivo}`,
          })
          break
        }

        case 'escalar': {
          // O evento vem ANTES do recado, e é gravado mesmo se o recado não
          // chegar. É ele que conta o teto: se só contasse quando o Telegram
          // entrega, um bot fora do ar faria a mesma escalada girar de seis em
          // seis horas para sempre. E o painel é o segundo canal — a notícia
          // não se perde só porque a mensagem não saiu.
          escalados += 1
          await deps.registrarDecisao({
            numeroDoPr: pr.numero,
            acao: 'escalar',
            texto: decisao.motivo,
          })
          const avisou = await deps.avisarDono(`GitOrch: ${decisao.motivo}`)
          if (!avisou) {
            warn(
              `[vigia-do-pr] o recado sobre o #${pr.numero} não chegou ao dono; ` +
                'ficou registrado na linha do tempo do painel'
            )
          }
          break
        }
      }
    } catch (err) {
      falhas += 1
      warn(`[vigia-do-pr] falha ao cuidar do #${pr.numero}: ${(err as Error).message}`)
    }
  }

  const partes: string[] = []
  if (retomados > 0) partes.push(pluralizar(retomados, 'retomado', 'retomados'))
  if (fechados > 0) partes.push(pluralizar(fechados, 'fechado', 'fechados'))
  if (escalados > 0) partes.push(pluralizar(escalados, 'escalado', 'escalados'))
  if (adiadosPeloTeto > 0) {
    partes.push(`${adiadosPeloTeto} além do teto desta passada (${teto})`)
  }
  if (deGente > 0) partes.push(`${deGente} de gente`)
  if (doDependabot > 0) partes.push(`${doDependabot} do dependabot`)
  if (comSessaoViva > 0) partes.push(`${comSessaoViva} com sessão viva`)
  if (quietos > 0) partes.push(pluralizar(quietos, 'sem novidade', 'sem novidade'))
  if (falhas > 0) partes.push(pluralizar(falhas, 'falha', 'falhas'))

  return `vigia-do-pr: ${pluralizar(prs.length, 'pull request aberto', 'pull requests abertos')}, ${
    partes.length > 0 ? partes.join(', ') : 'nada a fazer'
  }.`
}

/**
 * FECHA o pull request e SÓ ENTÃO comenta por quê (ACHADO 4 do QA).
 *
 * A ordem é a correção, e ela vive aqui — e não solta dentro do relógio — pelo
 * mesmo motivo do resto deste arquivo: ponto que não pode ser importado não
 * pode ser testado, e é exatamente onde os defeitos passam.
 *
 * O DEFEITO QUE ISTO CONSERTA: comentando primeiro, um fechamento que falhasse
 * deixava o comentário publicado. Como só o SUCESSO vira evento — e é o evento
 * que conta o teto —, a passada seguinte encontrava o mesmo pull request no
 * mesmo estado e comentava de novo. De seis em seis horas. Para sempre. Um
 * defeito nosso virava enxurrada no repositório do cliente.
 *
 * Invertida, a falha do fechamento não deixa rastro nenhum e a próxima passada
 * tenta de novo, do zero. E o comentário que falha DEPOIS não desfaz nada: o
 * pull request está fechado, a ação aconteceu, e é isso que o retorno diz — a
 * alternativa (devolver `false`) faria o vigia querer fechar de novo algo que
 * já está fechado, e nunca registrar o que de fato fez.
 */
export async function fecharPrDoVigia(args: {
  repo: string
  numero: number
  motivo: string
  ghSend: (metodo: 'POST' | 'PATCH', caminho: string, corpo: unknown) => Promise<unknown>
  onWarn?: (m: string) => void
}): Promise<boolean> {
  try {
    await args.ghSend('PATCH', `/repos/${args.repo}/pulls/${args.numero}`, { state: 'closed' })
  } catch (err) {
    // NADA foi escrito no repositório do cliente: nem o fechamento, nem o
    // comentário — que é justamente o ponto. `false` (e não uma exceção) porque
    // é o que a dep `fecharPr` promete devolver, e o que faz a varredura dizer
    // "tenta na próxima" sem gastar evento nem teto por uma queda nossa.
    args.onWarn?.(
      `vigia-do-pr: não consegui fechar o #${args.numero} de ${args.repo} ` +
        `(${(err as Error).message}); nada foi comentado e fica para a próxima passada`
    )
    return false
  }
  try {
    await args.ghSend('POST', `/repos/${args.repo}/issues/${args.numero}/comments`, {
      body: `GitOrch: ${args.motivo}`,
    })
  } catch (err) {
    // O fechamento JÁ ACONTECEU. Deixar a exceção subir faria o chamador tratar
    // a ação como não realizada e tentar tudo de novo na próxima passada.
    args.onWarn?.(
      `vigia-do-pr: fechei o #${args.numero} de ${args.repo}, mas não consegui comentar o motivo ` +
        `(${(err as Error).message}); o motivo continua na linha do tempo do painel`
    )
  }
  return true
}

/**
 * Teto de páginas da listagem de pull requests — 2000 pull requests abertos.
 *
 * Existe porque uma paginação sem fim contra um repositório patológico
 * prenderia o tique. Mas ele NÃO é mudo: ao alcançá-lo, a varredura avisa que
 * a passada está incompleta, em vez de devolver uma lista cortada fingindo ser
 * a lista inteira. Teto silencioso é o mesmo defeito que a paginação conserta.
 */
export const MAX_PAGINAS_DE_PR = 20

/** O que a verificação automática daquele commit está dizendo AGORA. */
export async function lerVerificacao(args: {
  repo: string
  sha: string
  ghGet: (caminho: string) => Promise<unknown>
}): Promise<EstadoDaVerificacao> {
  const r = (await args.ghGet(
    `/repos/${args.repo}/commits/${args.sha}/check-runs?per_page=100`
  )) as {
    check_runs?: Array<{ status?: string; conclusion?: string | null }>
  }
  const runs = r.check_runs ?? []
  if (runs.length === 0) return 'ausente'
  if (runs.some((c) => ['failure', 'timed_out', 'action_required'].includes(c.conclusion ?? ''))) {
    return 'vermelha'
  }
  if (runs.some((c) => c.status !== 'completed')) return 'pendente'
  return 'verde'
}

/**
 * Lê do GitHub o que o vigia precisa saber de cada pull request ABERTO.
 *
 * Vive AQUI, e não dentro do plugin do relógio, pelo mesmo motivo que
 * `decidirAcaoNoPR` foi tirada de `analyze-conflicts.ts`: ponto que não pode
 * ser importado não pode ser testado, e foi assim que o furo do rodapé passou.
 * A rede entra por `ghGet` — o relógio entrega a sua porta de saída, já com
 * teto e guarda de autonomia; um teste entrega uma função de mentira.
 *
 * PAGINADA e sem teto mudo (`MAX_PAGINAS_DE_PR`).
 *
 * O ENRIQUECIMENTO (data do último commit, `mergeable`, verificação) custa três
 * leituras por pull request e por isso só acontece para quem passa nos dois
 * portões baratos: ser da automação e não ter sessão viva. Quem não é
 * enriquecido sai daqui com os valores CONSERVADORES de cada campo —
 * `paradoHaMs: 0`, `mergeable: null`, `verificacao: 'pendente'` — que são, um a
 * um, o valor que faz `decidirAcaoNoPrOrfao` NÃO agir. Assim, mesmo que alguém
 * reordene os portões um dia, o pior caso é inação, nunca uma escrita decidida
 * com dado que ninguém foi buscar.
 */
export async function listarPrsAbertosParaOVigia(args: {
  repo: string
  ghGet: (caminho: string) => Promise<unknown>
  prsComSessaoViva: Set<number>
  agora: Date
  onWarn: (m: string) => void
}): Promise<PrAberto[]> {
  type PrCru = {
    number: number
    user?: { login?: string } | null
    labels?: Array<{ name?: string }> | null
    body?: string | null
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null } | null
  }
  const crus: PrCru[] = []
  for (let pagina = 1; pagina <= MAX_PAGINAS_DE_PR; pagina += 1) {
    const lote = (await args.ghGet(
      `/repos/${args.repo}/pulls?state=open&per_page=100&page=${pagina}`
    )) as PrCru[]
    crus.push(...lote)
    if (lote.length < 100) break
    if (pagina === MAX_PAGINAS_DE_PR) {
      args.onWarn(
        `vigia-do-pr: ${args.repo} tem mais de ${MAX_PAGINAS_DE_PR * 100} pull requests abertos; ` +
          'a varredura desta passada está INCOMPLETA'
      )
    }
  }

  const saida: PrAberto[] = []
  for (const cru of crus) {
    const sinais = {
      autor: cru.user?.login ?? null,
      labels: (cru.labels ?? []).map((l) => l.name ?? ''),
      corpo: cru.body ?? null,
    }
    const base: PrAberto = {
      numero: cru.number,
      ...sinais,
      // O RAMO DO PULL REQUEST (ACHADO 1). `head.repo.full_name` diz se ele
      // vive aqui ou num fork; ausente vira `false`, que é o valor que NÃO faz
      // agir — mesma disciplina conservadora dos três campos abaixo.
      branchDoPr: cru.head?.ref ?? null,
      branchNoRepoDoProjeto: (cru.head?.repo?.full_name ?? null) === args.repo,
      mergeable: null,
      verificacao: 'pendente',
      paradoHaMs: 0,
    }
    if (
      !ehPRDaAutomacao(sinais) ||
      ehAutomacaoQueOVigiaNaoConserta(sinais) ||
      args.prsComSessaoViva.has(cru.number)
    ) {
      saida.push(base)
      continue
    }
    try {
      const detalhe = (await args.ghGet(`/repos/${args.repo}/pulls/${cru.number}`)) as {
        mergeable?: boolean | null
      }
      const sha = cru.head?.sha
      // A DATA DO ÚLTIMO COMMIT, e não `updated_at`: `updated_at` anda a cada
      // comentário, e a automação de conflito comenta nesses mesmos pull
      // requests de 12 em 12 horas (`jules-pr-conflict.yml`). Medido em
      // 31/08/2026: o #356 tem `updated_at` de hoje e o último commit de dias
      // atrás. Medir "parado" por `updated_at` faria o pull request conflitado
      // parecer eternamente recém-tocado — o vigia nunca agiria justamente
      // onde ele mais precisa agir.
      let paradoHaMs = 0
      if (sha) {
        const commit = (await args.ghGet(`/repos/${args.repo}/commits/${sha}`)) as {
          commit?: { committer?: { date?: string } }
        }
        const data = commit.commit?.committer?.date
        if (data) paradoHaMs = args.agora.getTime() - new Date(data).getTime()
      }
      saida.push({
        ...base,
        mergeable: detalhe.mergeable ?? null,
        verificacao: sha
          ? await lerVerificacao({ repo: args.repo, sha, ghGet: args.ghGet })
          : 'ausente',
        paradoHaMs,
      })
    } catch (err) {
      args.onWarn(
        `vigia-do-pr: não consegui ler o #${cru.number} de ${args.repo} ` +
          `(${(err as Error).message}); fica para a próxima passada`
      )
      saida.push(base)
    }
  }
  return saida
}
