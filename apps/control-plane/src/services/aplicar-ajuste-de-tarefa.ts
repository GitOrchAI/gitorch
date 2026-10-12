// Fase 4.2: o APLICADOR da reescrita de uma tarefa fora do padrão.
//
// O motor de IA só preenche o formulário (os 8 campos do padrão); quem decide
// se pode escrever e quem escreve é este arquivo, por código. A decisão do dono
// é que, fora do padrão, o GitOrch reescreve sozinho E GUARDA O ORIGINAL — por
// isso cada trava abaixo existe para o original nunca se perder e para a
// reescrita nunca pisar em quem está trabalhando na tarefa:
//
//  - só issue ABERTA (nunca pull request), só em projeto com autonomia
//    "cuidar", e só com o interruptor da peça ligado;
//  - não escreve se gente editou a issue nas últimas 24 h, se o texto mudou
//    desde a conferência, se o dev assíncrono tem sessão viva nela (ou a
//    etiqueta de entrega a ele), ou se há entrega em julgamento do QA (PR
//    aberto ou parecer travado): reescrever o critério de verificação no meio
//    do trabalho confunde quem constrói e quem julga;
//  - a validação do que o motor devolveu é do SISTEMA: os 8 campos, todas as
//    referências #N e links do original, o limite do título; em dúvida, não
//    escreve e registra o motivo no painel;
//  - o original é guardado ANTES de escrever (ficha) e vai inteiro no próprio
//    corpo novo, num bloco recolhido; `desfazerAjusteDeTarefa` o restaura;
//  - a cadeia de reescritas não perde o começo: `original` guarda sempre o
//    PRIMEIRO texto (só é gravado quando ausente) e `historico` acrescenta o
//    texto que havia antes de cada reescrita. Desfazer volta ao original; o
//    texto imediatamente anterior é pedido por `alvo: 'anterior'`;
//  - escrita que chegou ao GitHub mas voltou com erro não vira "falhou" às
//    cegas: relê a tarefa e compara o texto (aplicado, falhou de verdade, ou
//    "incerto" quando nem a releitura funcionou).

import { DOD_FIELD_MAP, type DoDFields, type InfraIssueForm, validateDoD } from '@gitorch/cadence'
import { renderIssueBody, pesoDoCorpoDaIssue } from './backlog-executor.js'
import { conferirTarefaSemPedido, hashDoCorpoDaTarefa } from './conferir-tarefa-sem-pedido.js'
import { lerSecaoDaIssue } from './secao-da-issue.js'
import { cortarPorPontoDeCodigo, limparSurrogates, resumirErro } from './texto-seguro.js'

/** Nome da variável que liga e desliga a peça. */
export const INTERRUPTOR_DO_AJUSTE_DE_TAREFA = 'GITORCH_AJUSTE_DE_TAREFA'

const VALORES_QUE_DESLIGAM: ReadonlySet<string> = new Set([
  '0',
  'false',
  'off',
  'nao',
  'não',
  'desligado',
])

/**
 * A peça vem LIGADA por padrão (decisão do dono); a variável existe para
 * desligá-la sem deploy. Só um valor explícito de "desligado" a desliga: texto
 * vazio ou desconhecido não desliga nada por engano.
 */
export function ajusteDeTarefaLigado(
  env: Record<string, string | undefined> = process.env
): boolean {
  const bruto = env[INTERRUPTOR_DO_AJUSTE_DE_TAREFA]?.trim().toLowerCase()
  return bruto === undefined || !VALORES_QUE_DESLIGAM.has(bruto)
}

/** Gente editou a issue há menos que isto: não se escreve por cima. */
export const JANELA_DE_EDICAO_HUMANA_MS = 24 * 60 * 60_000

export const TITULO_MAXIMO = 200

/** O GitHub recusa corpo acima de 65.536 caracteres; sobra folga para o que ele conta diferente. */
export const CORPO_MAXIMO = 60_000

/** Etiquetas de que a tarefa já foi entregue ao dev assíncrono. */
const ETIQUETAS_DE_ENTREGA_AO_DEV: ReadonlySet<string> = new Set(['jules', 'gitorch:agent:jules'])

const MARCADOR_DO_AJUSTE = 'gitorch:ajuste-de-padrao'

// ---------------------------------------------------------------------------
// Referências e links
// ---------------------------------------------------------------------------

const URL_NO_TEXTO = /https?:\/\/[^\s)\]>"'<]+/g
const ALVO_DE_LINK_MARKDOWN = /\]\(([^)\s]+)\)/g
const REFERENCIA_ENTRE_REPOSITORIOS = /(?<![\w./-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g
const REFERENCIA_DE_ISSUE = /(?<![\w&/#])#(\d+)\b/g

/**
 * Tudo que aponta para fora do texto: links soltos, alvos de link markdown,
 * `dono/repo#N` e `#N`. Cada um é comparado por igualdade exata — `#12` não é
 * `#123`, e o `#` de âncora de um link pertence ao link, não é uma referência.
 */
export function extrairReferencias(texto: string): string[] {
  const achadas = new Set<string>()
  let resto = texto

  for (const m of resto.matchAll(URL_NO_TEXTO)) {
    achadas.add(m[0].replace(/[.,;:!?]+$/, ''))
  }
  resto = resto.replace(URL_NO_TEXTO, ' ')

  for (const m of resto.matchAll(ALVO_DE_LINK_MARKDOWN)) {
    if (m[1]) achadas.add(m[1])
  }
  resto = resto.replace(ALVO_DE_LINK_MARKDOWN, '] ')

  for (const m of resto.matchAll(REFERENCIA_ENTRE_REPOSITORIOS)) {
    achadas.add(`${m[1]}#${m[2]}`)
  }
  resto = resto.replace(REFERENCIA_ENTRE_REPOSITORIOS, ' ')

  for (const m of resto.matchAll(REFERENCIA_DE_ISSUE)) {
    achadas.add(`#${m[1]}`)
  }
  return [...achadas]
}

/**
 * Menções que notificam: `@usuario` e `@org/time`. Não conta o `@` colado a
 * uma palavra (e-mail), nem o de um código entre crases (decorador).
 */
const MENCAO_NO_TEXTO =
  /(?<![\w@./`-])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_.-]+)?)/g

export function extrairMencoes(texto: string): string[] {
  const achadas = new Set<string>()
  for (const m of texto.matchAll(MENCAO_NO_TEXTO)) achadas.add(`@${(m[1] as string).toLowerCase()}`)
  return [...achadas]
}

// ---------------------------------------------------------------------------
// Validação e montagem do corpo novo
// ---------------------------------------------------------------------------

export type ResultadoDaValidacao =
  { ok: true; titulo: string; corpo: string } | { ok: false; motivo: string }

const TAG_DE_BLOCO = /<(\/?)details\b[^>]*>/gi
const QUALQUER_TAG_DE_BLOCO = /<\/?details\b/i

/**
 * Os `<details>`/`</details>` do texto abrem e fecham em ordem, sem fechar o
 * que não abriu? Contar não basta: `</details> ... <details>` tem uma de cada
 * e quebra o bloco recolhido.
 */
export function detalhesBalanceadosEmOrdem(texto: string): boolean {
  let profundidade = 0
  for (const m of texto.matchAll(TAG_DE_BLOCO)) {
    profundidade += m[1] === '/' ? -1 : 1
    if (profundidade < 0) return false
  }
  return profundidade === 0
}

/**
 * Sobra uma cerca de código aberta no fim do texto? Segue a regra do
 * markdown: a cerca fecha com o MESMO caractere (``` ou ~~~), com ao menos o
 * mesmo tamanho e nada além de espaço na linha. Cercas de caracteres
 * diferentes não se fecham entre si.
 */
export function cercaDeCodigoAberta(texto: string): boolean {
  let aberta: { caractere: string; tamanho: number } | null = null
  for (const linha of texto.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(linha)
    if (!m) continue
    const marca = m[1] as string
    const resto = m[2] as string
    if (aberta === null) {
      // uma cerca de crase não leva crase na linha de informação (``` em linha não abre cerca)
      if (marca.startsWith('`') && resto.includes('`')) continue
      aberta = { caractere: marca.charAt(0), tamanho: marca.length }
    } else if (
      marca.charAt(0) === aberta.caractere &&
      marca.length >= aberta.tamanho &&
      resto.trim() === ''
    ) {
      aberta = null
    }
  }
  return aberta !== null
}

/** O original cabe num bloco recolhido sem quebrar a página? Em dúvida, não. */
function motivoDeOriginalQueNaoCabeNoBloco(
  tituloOriginal: string,
  corpoOriginal: string
): string | null {
  if (QUALQUER_TAG_DE_BLOCO.test(tituloOriginal)) {
    return 'o título original tem tag de bloco recolhido e não cabe no bloco recolhido'
  }
  if (!detalhesBalanceadosEmOrdem(corpoOriginal)) {
    return 'o texto original tem blocos <details> desbalanceados ou fora de ordem e não cabe no bloco recolhido'
  }
  if (cercaDeCodigoAberta(corpoOriginal)) {
    return 'o texto original tem uma cerca de código aberta e não cabe no bloco recolhido'
  }
  return null
}

/** Os marcadores `<!-- gitorch:... -->` do original: identificam a tarefa e ficam na raiz do corpo. */
function marcadoresDoOriginal(corpoOriginal: string): string[] {
  return [...new Set(corpoOriginal.match(/<!--\s*gitorch:[^>]*?-->/g) ?? [])]
}

/** O peso do original é preservado como seção própria, com o porquê que ele trazia. */
function pesoDoOriginal(
  corpoOriginal: string
): { weight: NonNullable<ReturnType<typeof pesoDoCorpoDaIssue>>; rationale: string } | null {
  const weight = pesoDoCorpoDaIssue(corpoOriginal)
  if (weight === null) return null
  const secao = lerSecaoDaIssue(corpoOriginal, 'Peso')
  const porque = secao.split('\n').slice(1).join('\n').trim()
  return { weight, rationale: porque === '' ? 'Peso mantido do texto original.' : porque }
}

function blocoDoOriginal(tituloOriginal: string, corpoOriginal: string): string {
  return [
    '## Texto original',
    '',
    '<details><summary>Texto original</summary>',
    '',
    `**Título original:** ${tituloOriginal}`,
    '',
    corpoOriginal,
    '',
    '</details>',
  ].join('\n')
}

export function validarAjusteDeTarefa(args: {
  tituloOriginal: string
  corpoOriginal: string
  form: InfraIssueForm
}): ResultadoDaValidacao {
  const recusa = (motivo: string): ResultadoDaValidacao => ({ ok: false, motivo })
  const campos: DoDFields = args.form.fields

  // A ficha e o bloco recolhido guardam o original já limpo: um substituto solto
  // viraria U+FFFD e o desfazer devolveria um texto diferente do que a pessoa
  // escreveu. Em vez de alterar o original, não se reescreve.
  if (
    limparSurrogates(args.tituloOriginal) !== args.tituloOriginal ||
    limparSurrogates(args.corpoOriginal) !== args.corpoOriginal
  ) {
    return recusa(
      'o texto original tem um caractere partido (surrogate solto) que não se guarda sem alterar; não reescrevo para o desfazer devolver o texto exato'
    )
  }

  const naoCabe = motivoDeOriginalQueNaoCabeNoBloco(args.tituloOriginal, args.corpoOriginal)
  if (naoCabe) return recusa(naoCabe)

  const dod = validateDoD(campos)
  if (!dod.ok)
    return recusa(`o formulário não tem os 8 campos preenchidos: ${dod.errors.join('; ')}`)

  const titulo = limparSurrogates(campos.titulo.trim())
  if (titulo.length > TITULO_MAXIMO) {
    return recusa(`o título novo passa de ${TITULO_MAXIMO} caracteres`)
  }
  if (/[\r\n]/.test(titulo)) return recusa('o título novo tem quebra de linha')
  if (QUALQUER_TAG_DE_BLOCO.test(titulo)) {
    return recusa('o título novo mexe no bloco recolhido do texto original')
  }

  for (const { key, header } of DOD_FIELD_MAP) {
    const valor = campos[key]
    if (/(^|\n)##\s/.test(valor)) {
      return recusa(`o campo ${header} traz um cabeçalho de seção e quebraria a leitura do padrão`)
    }
    if (QUALQUER_TAG_DE_BLOCO.test(valor)) {
      return recusa(`o campo ${header} mexe no bloco recolhido do texto original`)
    }
    if (cercaDeCodigoAberta(valor)) {
      return recusa(
        `o campo ${header} deixa uma cerca de código aberta e engoliria o texto seguinte`
      )
    }
  }

  const corpoDosCampos = [
    ...marcadoresDoOriginal(args.corpoOriginal),
    renderIssueBody({ ...campos, titulo }, MARCADOR_DO_AJUSTE, pesoDoOriginal(args.corpoOriginal)),
  ].join('\n\n')

  // O texto vai ao GitHub do cliente: uma menção ou um link que o original não
  // tinha notificaria gente ou levaria a um endereço que ninguém escreveu ali.
  const textoNovo = `${titulo}\n\n${corpoDosCampos}`
  const textoOriginal = `${args.tituloOriginal}\n\n${args.corpoOriginal}`
  const mencoesDoOriginal = new Set(extrairMencoes(textoOriginal))
  const mencoesNovas = extrairMencoes(textoNovo).filter((m) => !mencoesDoOriginal.has(m))
  if (mencoesNovas.length > 0) {
    return recusa(
      `a reescrita menciona quem o original não mencionava (notificaria): ${mencoesNovas.join(', ')}`
    )
  }
  const linksDoOriginal = new Set(extrairReferencias(textoOriginal))
  const linksNovos = extrairReferencias(textoNovo).filter(
    (r) => /^https?:\/\//i.test(r) && !linksDoOriginal.has(r)
  )
  if (linksNovos.length > 0) {
    return recusa(`a reescrita traz link que o original não tinha: ${linksNovos.join(', ')}`)
  }

  // Só o que o texto NOVO diz conta: o original inteiro vai no bloco recolhido
  // e, se contasse, qualquer reescrita "preservaria" tudo por definição.
  const presentes = new Set(extrairReferencias(`${titulo}\n\n${corpoDosCampos}`))
  const faltando = extrairReferencias(`${args.tituloOriginal}\n\n${args.corpoOriginal}`).filter(
    (r) => !presentes.has(r)
  )
  if (faltando.length > 0) {
    return recusa(`a reescrita perdeu referências do original: ${faltando.join(', ')}`)
  }

  // O peso e o porquê vêm do original: o trecho antes do bloco tem de fechar o que abre.
  if (!detalhesBalanceadosEmOrdem(corpoDosCampos) || cercaDeCodigoAberta(corpoDosCampos)) {
    return recusa('o texto novo deixaria um bloco ou uma cerca de código aberta antes do original')
  }

  const corpo = limparSurrogates(
    `${corpoDosCampos}\n\n${blocoDoOriginal(args.tituloOriginal, args.corpoOriginal)}`
  )
  if (!detalhesBalanceadosEmOrdem(corpo) || cercaDeCodigoAberta(corpo)) {
    return recusa('o corpo montado não fecha o bloco recolhido do original')
  }
  if (corpo.length > CORPO_MAXIMO) {
    return recusa(`o corpo novo passaria de ${CORPO_MAXIMO} caracteres`)
  }

  // A MESMA conferência da varredura tem que concordar com o que vai ser escrito.
  const volta = conferirTarefaSemPedido({
    titulo,
    corpo,
    estaNoQuadro: null,
    estaNaSprintAtual: null,
  })
  if (!volta.padraoOk) {
    return recusa(`o corpo montado não passa na conferência do padrão: ${volta.erros.join('; ')}`)
  }
  return { ok: true, titulo, corpo }
}

// ---------------------------------------------------------------------------
// As travas e a escrita
// ---------------------------------------------------------------------------

/** O que o aplicador lê da issue no GitHub. */
export interface IssueNoGitHub {
  titulo: string
  corpo: string
  etiquetas: string[]
  estado: string
  ehPullRequest: boolean
  /** `updated_at`; `null` quando ilegível. */
  atualizadaEm: Date | null
}

/** Tudo de fora de que o aplicador precisa, por função: o aplicador não conhece Prisma nem fetch. */
export interface DepsDoAplicador {
  /** `dono/repo`. */
  repo: string
  /** Autonomia do projeto, lida na hora (o dono pode mudar pelo painel). */
  autonomia: () => string | null | undefined
  interruptorLigado: () => boolean
  /** Lança o erro do GitHub quando a leitura falha. */
  lerIssue: (numero: number) => Promise<IssueNoGitHub>
  /** `PATCH` do título e do corpo, pela porta com a guarda de autonomia. */
  escreverIssue: (numero: number, dados: { titulo: string; corpo: string }) => Promise<void>
  /** Há sessão do dev assíncrono aberta para a tarefa? */
  temSessaoDoDevViva: (numero: number) => Promise<boolean>
  /** Há PR aberto da tarefa, ou parecer do QA travado num PR dela? */
  temEntregaEmJulgamento: (numero: number) => Promise<boolean>
  /** Mescla chaves na conferência da ficha (nunca troca o JSON inteiro). */
  gravarConferencia: (numero: number, parcial: Record<string, unknown>) => Promise<void>
  /** A conferência da ficha como está agora (`null` quando não há). */
  lerConferencia: (numero: number) => Promise<Record<string, unknown> | null>
  registrarNoPainel: (evento: { chave: string; texto: string }) => Promise<void>
  agora?: () => Date
}

export type VeredictoDaTrava =
  { pode: true; issue: IssueNoGitHub } | { pode: false; motivo: string }

/**
 * Todas as travas, na ordem do mais barato ao mais caro: as que só olham o
 * banco vêm antes da leitura do GitHub. Roda ANTES de gastar motor e de novo
 * (com leitura nova) imediatamente antes de escrever.
 */
export async function avaliarSePodeReescrever(
  deps: DepsDoAplicador,
  pedido: { numero: number; hashDoCorpoConferido: string }
): Promise<VeredictoDaTrava> {
  const nao = (motivo: string): VeredictoDaTrava => ({ pode: false, motivo })

  if (!deps.interruptorLigado()) return nao('o interruptor da peça está desligado')
  if (deps.autonomia() !== 'cuidar') return nao('a autonomia do projeto não é "cuidar"')

  if (await deps.temSessaoDoDevViva(pedido.numero)) {
    return nao('o dev assíncrono tem sessão viva nesta tarefa')
  }
  if (await deps.temEntregaEmJulgamento(pedido.numero)) {
    return nao('há entrega desta tarefa em julgamento (PR aberto ou parecer travado)')
  }

  const issue = await deps.lerIssue(pedido.numero)
  if (issue.ehPullRequest) return nao('é um pull request, não uma tarefa')
  if (issue.estado !== 'open') return nao('a tarefa não está aberta')
  if (issue.etiquetas.some((e) => ETIQUETAS_DE_ENTREGA_AO_DEV.has(e))) {
    return nao('a tarefa já foi entregue ao dev assíncrono (etiqueta de delegação)')
  }

  const agora = (deps.agora ?? (() => new Date()))()
  if (issue.atualizadaEm === null) return nao('não consegui ler quando a tarefa foi editada')
  if (agora.getTime() - issue.atualizadaEm.getTime() < JANELA_DE_EDICAO_HUMANA_MS) {
    return nao('a tarefa foi editada há menos de 24 h; não escrevo por cima')
  }

  if (hashDoCorpoDaTarefa(issue.titulo, issue.corpo) !== pedido.hashDoCorpoConferido) {
    return nao('o texto da tarefa mudou depois da conferência')
  }
  return { pode: true, issue }
}

// ---------------------------------------------------------------------------
// Histórico dos textos anteriores
// ---------------------------------------------------------------------------

/** O texto que a tarefa tinha ANTES de uma reescrita. */
export interface EntradaDoHistorico {
  em: string
  titulo: string
  corpo: string
  hash: string
}

/** Quantos textos anteriores a ficha guarda (o primeiro e o mais novo nunca saem). */
export const HISTORICO_MAXIMO_DE_ITENS = 10

/** Teto de caracteres de título e corpo somados no histórico. */
export const HISTORICO_MAXIMO_DE_CARACTERES = 400_000

function objetoOuNulo(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null
}

function entradaDoHistorico(bruto: unknown): EntradaDoHistorico | null {
  const o = objetoOuNulo(bruto)
  if (!o) return null
  const { em, titulo, corpo, hash } = o
  if (
    typeof em !== 'string' ||
    typeof titulo !== 'string' ||
    typeof corpo !== 'string' ||
    typeof hash !== 'string'
  ) {
    return null
  }
  return { em, titulo, corpo, hash }
}

/** As entradas legíveis do histórico gravado na ficha, na ordem em que foram gravadas. */
export function lerHistorico(bruto: unknown): EntradaDoHistorico[] {
  if (!Array.isArray(bruto)) return []
  return bruto.flatMap((e) => {
    const entrada = entradaDoHistorico(e)
    return entrada ? [entrada] : []
  })
}

function tamanhoDoHistorico(historico: readonly EntradaDoHistorico[]): number {
  return historico.reduce((soma, e) => soma + e.titulo.length + e.corpo.length, 0)
}

/**
 * Acrescenta o texto de antes de uma reescrita. Só cresce no fim; o mesmo texto
 * duas vezes seguidas (nova tentativa depois de uma falha) não se repete. Passou
 * do teto, descarta os intermediários mais ANTIGOS depois do primeiro — o
 * primeiro é o original verdadeiro e o último é o que o "anterior" restaura,
 * então nenhum dos dois sai. `descartados` diz quantos saíram.
 */
export function acrescentarAoHistorico(
  atual: unknown,
  entrada: EntradaDoHistorico
): { historico: EntradaDoHistorico[]; descartados: number } {
  const historico = lerHistorico(atual)
  if (historico.at(-1)?.hash !== entrada.hash) historico.push(entrada)
  let descartados = 0
  while (
    historico.length > 2 &&
    (historico.length > HISTORICO_MAXIMO_DE_ITENS ||
      tamanhoDoHistorico(historico) > HISTORICO_MAXIMO_DE_CARACTERES)
  ) {
    historico.splice(1, 1)
    descartados += 1
  }
  return { historico, descartados }
}

// ---------------------------------------------------------------------------
// A reescrita
// ---------------------------------------------------------------------------

export type ResultadoDoAjuste =
  | { tipo: 'aplicado'; titulo: string; hashDoCorpoNovo: string }
  | { tipo: 'bloqueado'; motivo: string }
  | { tipo: 'invalido'; motivo: string }
  | { tipo: 'falhou'; motivo: string }
  /** A escrita deu erro e nem a releitura confirmou se o texto novo entrou. */
  | { tipo: 'incerto'; motivo: string }

function linkDaIssue(repo: string, numero: number): string {
  return `https://github.com/${repo}/issues/${numero}`
}

/** O que o painel diz sobre como desfazer: o original verdadeiro e o texto anterior. */
const COMO_DESFAZER =
  'Como desfazer: o texto ORIGINAL verdadeiro, o primeiro de antes do GitOrch, está na ficha da ' +
  'tarefa (conferencia.original). O bloco "Texto original" do corpo guarda só o texto de antes da ' +
  'ÚLTIMA reescrita, que depois de uma segunda reescrita já não é o original. O GitOrch restaura pela ficha ' +
  "(desfazerAjusteDeTarefa), por padrão para o ORIGINAL, ou, com alvo 'anterior', só para o texto " +
  'imediatamente anterior a esta reescrita.'

/**
 * Depois de um erro no PATCH, o que a tarefa tem no GitHub? A escrita pode ter
 * chegado e só a resposta ter se perdido (timeout, erro na volta): sem reler,
 * a ficha diria "falhou" sobre um texto que já está publicado.
 */
type Releitura =
  | { tipo: 'texto-novo' }
  | { tipo: 'texto-original' }
  | { tipo: 'outro-texto' }
  | { tipo: 'ilegivel' }

async function reler(
  deps: DepsDoAplicador,
  numero: number,
  hashes: { novo: string; original: string }
): Promise<Releitura> {
  let issue: IssueNoGitHub
  try {
    issue = await deps.lerIssue(numero)
  } catch {
    return { tipo: 'ilegivel' }
  }
  const hash = hashDoCorpoDaTarefa(issue.titulo, issue.corpo)
  if (hash === hashes.novo) return { tipo: 'texto-novo' }
  if (hash === hashes.original) return { tipo: 'texto-original' }
  return { tipo: 'outro-texto' }
}

/**
 * Valida o formulário do motor e, só se tudo estiver certo, reescreve a tarefa.
 * Nunca lança por causa do conteúdo: o resultado diz o que aconteceu.
 */
export async function reescreverTarefa(
  deps: DepsDoAplicador,
  pedido: {
    numero: number
    hashDoCorpoConferido: string
    form: InfraIssueForm
    /** Por que a tarefa estava fora do padrão (vai para o painel). */
    motivo: string
    /** Falhas de escrita já registradas para este mesmo texto. */
    falhasAnteriores?: number
  }
): Promise<ResultadoDoAjuste> {
  const agora = (deps.agora ?? (() => new Date()))()
  const hashOriginal = pedido.hashDoCorpoConferido

  const trava = await avaliarSePodeReescrever(deps, pedido)
  if (!trava.pode) return { tipo: 'bloqueado', motivo: trava.motivo }
  const { issue } = trava

  const validacao = validarAjusteDeTarefa({
    tituloOriginal: issue.titulo,
    corpoOriginal: issue.corpo,
    form: pedido.form,
  })
  if (!validacao.ok) {
    await deps.gravarConferencia(pedido.numero, {
      ajuste: {
        estado: 'invalido',
        hashDoCorpoOriginal: hashOriginal,
        motivo: validacao.motivo,
        tentadoEm: agora.toISOString(),
      },
    })
    await deps.registrarNoPainel({
      chave: `ajuste:${deps.repo}:${pedido.numero}:${hashOriginal}:invalido`,
      texto:
        `GitOrch: não reescrevi a tarefa #${pedido.numero} de ${deps.repo} — ` +
        `${validacao.motivo}. Nada foi alterado no GitHub. ${linkDaIssue(deps.repo, pedido.numero)}`,
    })
    return { tipo: 'invalido', motivo: validacao.motivo }
  }

  const hashDoCorpoNovo = hashDoCorpoDaTarefa(validacao.titulo, validacao.corpo)

  // O texto de antes vai para a ficha ANTES da escrita: se a escrita der certo e
  // o registro seguinte falhar, ainda dá para desfazer. `original` é o PRIMEIRO
  // texto da tarefa e só é gravado quando ainda não existe — numa segunda
  // reescrita o texto atual pode ser o de uma pessoa, e sobrescrever perderia o
  // de antes do GitOrch. Cada texto anterior fica no histórico.
  const fichaAtual = await deps.lerConferencia(pedido.numero)
  const originalGravado = objetoOuNulo(fichaAtual?.['original'])
  const temOriginal =
    typeof originalGravado?.['titulo'] === 'string' &&
    typeof originalGravado?.['corpo'] === 'string'
  const { historico, descartados } = acrescentarAoHistorico(fichaAtual?.['historico'], {
    em: agora.toISOString(),
    titulo: issue.titulo,
    corpo: issue.corpo,
    hash: hashOriginal,
  })
  const jaDescartados =
    typeof fichaAtual?.['historicoDescartados'] === 'number'
      ? fichaAtual['historicoDescartados']
      : 0
  await deps.gravarConferencia(pedido.numero, {
    ...(temOriginal
      ? {}
      : {
          original: { titulo: issue.titulo, corpo: issue.corpo, guardadoEm: agora.toISOString() },
        }),
    historico,
    ...(descartados > 0 ? { historicoDescartados: jaDescartados + descartados } : {}),
    ajuste: {
      estado: 'iniciado',
      hashDoCorpoOriginal: hashOriginal,
      hashDoCorpoNovo,
      motivo: pedido.motivo,
      iniciadoEm: agora.toISOString(),
    },
  })

  let confirmadoPorReleitura = false
  try {
    await deps.escreverIssue(pedido.numero, { titulo: validacao.titulo, corpo: validacao.corpo })
  } catch (err) {
    const motivo = resumirErro(err, 200)
    const releitura = await reler(deps, pedido.numero, {
      novo: hashDoCorpoNovo,
      original: hashOriginal,
    })

    if (releitura.tipo === 'ilegivel') {
      const motivoIncerto = cortarPorPontoDeCodigo(
        `${motivo} (e não consegui reler a tarefa para saber se o texto novo entrou)`,
        300
      )
      await deps.gravarConferencia(pedido.numero, {
        ajuste: {
          estado: 'incerto',
          hashDoCorpoOriginal: hashOriginal,
          hashDoCorpoNovo,
          motivo: motivoIncerto,
          tentadoEm: agora.toISOString(),
        },
      })
      await deps.registrarNoPainel({
        chave: `ajuste:${deps.repo}:${pedido.numero}:${hashOriginal}:incerto`,
        texto:
          `GitOrch: a escrita na tarefa #${pedido.numero} de ${deps.repo} deu erro e não consegui ` +
          `reler a tarefa para saber se o texto novo entrou. Confira a tarefa no GitHub: ` +
          `${linkDaIssue(deps.repo, pedido.numero)} O texto de antes está guardado na ficha; ` +
          `se o texto novo estiver lá, o desfazer (desfazerAjusteDeTarefa) relê a tarefa e restaura.`,
      })
      return { tipo: 'incerto', motivo: motivoIncerto }
    }

    if (releitura.tipo !== 'texto-novo') {
      const motivoDaFalha =
        releitura.tipo === 'outro-texto'
          ? cortarPorPontoDeCodigo(
              `${motivo} (a tarefa está com outro texto, de quem a editou; não toquei nela)`,
              300
            )
          : motivo
      await deps.gravarConferencia(pedido.numero, {
        ajuste: {
          estado: 'falhou',
          falhas: (pedido.falhasAnteriores ?? 0) + 1,
          hashDoCorpoOriginal: hashOriginal,
          motivo: motivoDaFalha,
          tentadoEm: agora.toISOString(),
        },
      })
      return { tipo: 'falhou', motivo: motivoDaFalha }
    }
    // O texto novo está no GitHub: só a resposta se perdeu. Segue como sucesso.
    confirmadoPorReleitura = true
  }

  await deps.gravarConferencia(pedido.numero, {
    ajuste: {
      estado: 'aplicado',
      hashDoCorpoOriginal: hashOriginal,
      hashDoCorpoNovo,
      motivo: pedido.motivo,
      escritoEm: agora.toISOString(),
      ...(confirmadoPorReleitura ? { confirmadoPorReleitura: true } : {}),
    },
  })
  await deps.registrarNoPainel({
    chave: `ajuste:${deps.repo}:${pedido.numero}:${hashOriginal}`,
    texto:
      `GitOrch reescreveu a tarefa #${pedido.numero} de ${deps.repo} para o padrão de 8 campos ` +
      `(${pedido.motivo}). Título: "${issue.titulo}" -> "${validacao.titulo}". ` +
      `${linkDaIssue(deps.repo, pedido.numero)} ` +
      (confirmadoPorReleitura
        ? 'A resposta da escrita se perdeu, mas reli a tarefa e o texto novo está lá. '
        : '') +
      `O texto de antes ficou guardado no bloco "Texto original" do próprio corpo e na ficha da tarefa. ` +
      COMO_DESFAZER,
  })
  return { tipo: 'aplicado', titulo: validacao.titulo, hashDoCorpoNovo }
}

// ---------------------------------------------------------------------------
// Desfazer
// ---------------------------------------------------------------------------

export interface DepsDoDesfazer {
  repo: string
  lerIssue: (numero: number) => Promise<IssueNoGitHub>
  escreverIssue: (numero: number, dados: { titulo: string; corpo: string }) => Promise<void>
  lerConferencia: (numero: number) => Promise<Record<string, unknown> | null>
  gravarConferencia: (numero: number, parcial: Record<string, unknown>) => Promise<void>
  registrarNoPainel: (evento: { chave: string; texto: string }) => Promise<void>
  agora?: () => Date
}

/** Para onde o desfazer devolve a tarefa. */
export type AlvoDoDesfazer = 'original' | 'anterior'

function texto(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null
}

/** Estados em que a tarefa PODE estar com o texto novo no GitHub. */
const ESTADOS_QUE_PODEM_SER_DESFEITOS: ReadonlySet<string> = new Set([
  'aplicado',
  'iniciado',
  'incerto',
])

/**
 * Devolve título e corpo a um texto de antes da reescrita, a partir da ficha.
 * Por padrão volta ao ORIGINAL (o primeiro texto, de antes do GitOrch);
 * `alvo: 'anterior'` volta só ao texto imediatamente anterior à última
 * reescrita (por exemplo, o de uma pessoa). Recusa quando alguém editou a
 * tarefa depois do ajuste (restaurar apagaria a edição), a menos que `forcar`.
 * Relê a tarefa antes de decidir, o que também resolve o estado "incerto".
 */
export async function desfazerAjusteDeTarefa(
  deps: DepsDoDesfazer,
  pedido: { numero: number; forcar?: boolean; alvo?: AlvoDoDesfazer }
): Promise<{ desfeito: true } | { desfeito: false; motivo: string }> {
  const nao = (motivo: string) => ({ desfeito: false as const, motivo })
  const agora = (deps.agora ?? (() => new Date()))()
  const alvo: AlvoDoDesfazer = pedido.alvo ?? 'original'

  const conferencia = await deps.lerConferencia(pedido.numero)
  let titulo: string | null
  let corpo: string | null
  if (alvo === 'anterior') {
    const ultimo = lerHistorico(conferencia?.['historico']).at(-1)
    titulo = ultimo?.titulo ?? null
    corpo = ultimo?.corpo ?? null
    if (titulo === null || corpo === null) {
      return nao('não há texto anterior guardado para esta tarefa')
    }
  } else {
    const original = objetoOuNulo(conferencia?.['original'])
    titulo = texto(original?.['titulo'])
    corpo = texto(original?.['corpo'])
    if (titulo === null || corpo === null) {
      return nao('não há texto original guardado para esta tarefa')
    }
  }

  const ajuste = objetoOuNulo(conferencia?.['ajuste']) ?? {}
  const estado = texto(ajuste['estado'])
  // Desfeito só para o texto anterior ainda deixa voltar ao original; desfeito
  // para o original é o fim da cadeia.
  const desfeitoParaOAnterior = estado === 'desfeito' && ajuste['desfeitoPara'] === 'anterior'
  if (
    estado === null ||
    !(ESTADOS_QUE_PODEM_SER_DESFEITOS.has(estado) || (desfeitoParaOAnterior && alvo === 'original'))
  ) {
    return nao(`o ajuste desta tarefa não está aplicado (estado: ${estado ?? 'nenhum'})`)
  }

  let atual: IssueNoGitHub
  try {
    atual = await deps.lerIssue(pedido.numero)
  } catch (err) {
    return nao(`não consegui reler a tarefa para desfazer: ${resumirErro(err, 200)}`)
  }
  const hashAtual = hashDoCorpoDaTarefa(atual.titulo, atual.corpo)
  const hashDoAlvo = hashDoCorpoDaTarefa(titulo, corpo)
  if (hashAtual === hashDoAlvo) {
    return nao(
      alvo === 'anterior'
        ? 'a tarefa já está com o texto anterior'
        : 'a tarefa já está com o texto original'
    )
  }
  // O que o último passo deixou no GitHub: o texto novo da reescrita, ou, depois
  // de um desfazer para o anterior, o texto que o próprio desfazer escreveu.
  const hashEsperado = desfeitoParaOAnterior
    ? ajuste['hashDoTextoRestaurado']
    : ajuste['hashDoCorpoNovo']
  if (!pedido.forcar && hashAtual !== hashEsperado) {
    return nao('a tarefa foi editada depois do ajuste; restaurar apagaria essa edição')
  }

  await deps.escreverIssue(pedido.numero, { titulo, corpo })
  // `hashDoCorpoOriginal` passa a ser o do texto restaurado: é com ele que a
  // missão reconhece "esta tarefa, com este texto, já teve a sua vez" e não a
  // reescreve de novo logo depois de um desfazer.
  await deps.gravarConferencia(pedido.numero, {
    ajuste: {
      ...ajuste,
      estado: 'desfeito',
      desfeitoEm: agora.toISOString(),
      desfeitoPara: alvo,
      hashDoTextoRestaurado: hashDoAlvo,
      hashDoCorpoOriginal: hashDoAlvo,
    },
  })
  await deps.registrarNoPainel({
    chave: `ajuste-desfeito:${deps.repo}:${pedido.numero}:${String(ajuste['hashDoCorpoNovo'] ?? ajuste['hashDoCorpoOriginal'])}:${alvo}`,
    texto:
      `GitOrch desfez a reescrita da tarefa #${pedido.numero} de ${deps.repo}: ` +
      (alvo === 'anterior'
        ? 'título e corpo voltaram ao texto imediatamente anterior à reescrita. '
        : 'título e corpo voltaram ao texto original, o primeiro de antes do GitOrch. ') +
      linkDaIssue(deps.repo, pedido.numero),
  })
  return { desfeito: true }
}
