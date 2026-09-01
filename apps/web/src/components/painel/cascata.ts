// A CASCATA POR AGENTE — a lógica da tela, fora do React (o app web testa
// lógica em .ts; o .tsx só desenha).
//
// O QUE ESTA TELA É: para cada papel (PO/RA/SM/QA), a fila de motores que o
// produto tenta, em ordem, até um responder. Cada degrau carrega motor, modelo
// e esforço, e é do PROJETO do cliente (Project.runtimeConfig.agents).
//
// AS TRÊS ARMADILHAS QUE ESTE ARQUIVO EXISTE PARA FECHAR — todas medidas, não
// imaginadas:
//
// 1. MODELO É POR MOTOR. Até 01/09/2026 o resolvedor carimbava um modelo do
//    Antigravity em qualquer degrau: `claude --model "Gemini 3.7 Flash
//    (Medium)"` responde "There's an issue with the selected model", e os
//    degraus de reserva nasciam mortos. Um seletor que MANTÉM o modelo quando
//    o dono troca o motor remonta esse degrau morto na tela, com ele achando
//    que escolheu. Por isso `trocarMotor` zera o modelo, sempre.
//
// 2. ESFORÇO NÃO É UMA COISA SÓ. `max` existe no claude e não no codex;
//    no antigravity a flag `--effort` é RECUSADA junto com `--model` (erro
//    duro do CLI) e o esforço vive dentro do nome do modelo. Uma escada única
//    para os três mandaria um nível que o motor não aplica — e o CLI do claude
//    apenas AVISA e roda no padrão, então o dono pagaria por um esforço que
//    nunca aconteceu.
//
// 3. MODELO QUE SAIU DO AR PRECISA APARECER DIZENDO QUE SAIU. `<select>` cujo
//    `value` não casa nenhuma `<option>` desenha a primeira: o dono abriria a
//    cascata que ele mesmo montou e leria um modelo que nunca escolheu.
import type { MotorCota } from './painel-tipos'
import { ENGINE_DISPLAY_NAMES } from '../setup/engine-status'

export const PAPEIS = ['po', 'ra', 'sm', 'qa'] as const
export type Papel = (typeof PAPEIS)[number]

/**
 * Como cada papel aparece para o dono.
 *
 * O produto chama `ra` e `sm` de "Planejamento" nos dois (descrever-evento.ts),
 * e lá tanto faz — é uma frase de evento. Aqui são DUAS LINHAS que ele
 * configura separado, e dois rótulos iguais fazem mexer na errada. A sigla vai
 * junto porque é ela que o resto do produto (log, missão, quadro) usa.
 */
export const PAPEL_NA_TELA: Record<Papel, { sigla: string; titulo: string; oQueFaz: string }> = {
  po: {
    sigla: 'PO',
    titulo: 'Produto',
    oQueFaz: 'quebra o seu pedido em tarefas e escreve o que cada uma precisa entregar',
  },
  ra: {
    sigla: 'RA',
    titulo: 'Arquitetura',
    oQueFaz: 'lê o repositório antes de mexer e decide onde a mudança encosta',
  },
  sm: {
    sigla: 'SM',
    titulo: 'Andamento',
    oQueFaz: 'mantém a esteira andando: move os cards do quadro e cobra o que travou',
  },
  qa: {
    sigla: 'QA',
    titulo: 'Qualidade',
    oQueFaz: 'julga o pull request: aprova, reprova e diz por quê',
  },
}

// --- o que a rota fala ------------------------------------------------------

export interface ModeloOpcao {
  /** o que vai gravado e vira `--model` (o claude só aceita o identificador). */
  valor: string
  /** o nome de vitrine, que é o que o dono reconhece. */
  rotulo: string
}

export interface ModeloQueSaiu extends ModeloOpcao {
  /** ISO do dia em que a coleta viu o modelo sumir. `null` = não carimbado. */
  sumiuEm: string | null
}

export interface MotorOpcoes {
  runtime: string
  /** a escada REAL daquele motor — elas não coincidem entre os três. */
  esforcos: string[]
  /** true quando escolher esforço é escolher outro modelo (Antigravity). */
  esforcoNoNomeDoModelo: boolean
  modelos: ModeloOpcao[]
  indisponiveis: ModeloQueSaiu[]
}

export interface OpcoesPayload {
  motores: MotorOpcoes[]
}

export interface DegrauSalvo {
  runtime: string
  model?: string
  effort?: string
}

export interface PapelSalvo extends DegrauSalvo {
  fallbacks?: DegrauSalvo[]
}

export interface CascataPayload {
  /** false = ninguém escolheu ainda; o que veio é o padrão do produto. */
  escolhida: boolean
  agents: Record<string, PapelSalvo>
}

// --- o que a tela segura ----------------------------------------------------

export interface DegrauUI {
  /**
   * Identidade da LINHA na tela, não do conteúdo. Precisa ser única de verdade:
   * chave repetida faz o React desenhar número errado de linhas — já aconteceu
   * aqui (25 linhas com 17 chaves). Dois degraus com o mesmo motor e sem modelo
   * são idênticos em conteúdo, então o conteúdo não serve de chave.
   */
  chave: string
  runtime: string
  /** '' = nenhum escolhido; o degrau roda no modelo padrão do próprio motor. */
  model: string
  /** '' = nenhum escolhido; o degrau roda no esforço padrão do próprio motor. */
  effort: string
}

/** Por papel, a fila: `[0]` é o principal, o resto são as reservas, na ordem. */
export type CascataUI = Record<Papel, DegrauUI[]>

/**
 * Contador de chaves. Monotônico de propósito: um esquema "maior índice + 1"
 * reaproveitaria a chave de um degrau recém-removido, e o React casaria a
 * linha nova com o estado da linha morta.
 */
let sequenciaDeChave = 0

function novaChave(papel: string): string {
  sequenciaDeChave += 1
  return `${papel}#${sequenciaDeChave}`
}

/**
 * O nome do motor como o dono JÁ o vê no assistente — mesma fonte, nunca uma
 * segunda lista. Dois nomes para o mesmo motor em telas diferentes confundem
 * quem está decidindo. Motor fora da lista cai no nome cru em vez de sumir:
 * melhor mostrar algo do que esconder um motor que existe de verdade.
 */
export function nomeDoMotor(runtime: string): string {
  return ENGINE_DISPLAY_NAMES[runtime] ?? runtime
}

export function acharMotor(
  motores: readonly MotorOpcoes[],
  runtime: string
): MotorOpcoes | undefined {
  return motores.find((m) => m.runtime === runtime)
}

/**
 * O esforço só entra na tela se AQUELE motor puder aplicá-lo.
 *
 * Largar em silêncio seria ruim; por isso `avisosDoCarregamento` conta ao dono
 * exatamente o que foi largado e por quê. O que não dá para fazer é mostrar
 * `max` selecionado num codex: a rota recusa a gravação (400) e o CLI, no caso
 * do claude, só avisa e roda no padrão — o dono pagaria por um nível que nunca
 * foi aplicado.
 */
function esforcoUtilizavel(motor: MotorOpcoes | undefined, effort: unknown): string {
  if (typeof effort !== 'string' || effort === '' || !motor) return ''
  if (motor.esforcoNoNomeDoModelo) return ''
  return motor.esforcos.includes(effort) ? effort : ''
}

function degrauDaTela(papel: Papel, d: DegrauSalvo, motores: readonly MotorOpcoes[]): DegrauUI {
  const runtime = typeof d.runtime === 'string' ? d.runtime : ''
  return {
    chave: novaChave(papel),
    runtime,
    // O modelo gravado é preservado mesmo fora do catálogo: sumir com ele
    // esconderia justamente o que o dono precisa ver (ver `opcoesDeModelo`).
    model: typeof d.model === 'string' ? d.model : '',
    effort: esforcoUtilizavel(acharMotor(motores, runtime), d.effort),
  }
}

/**
 * A resposta da rota vira o estado da tela.
 *
 * Papel que a resposta não trouxe (payload torto, escrito à mão no banco) ainda
 * nasce com UMA linha, no primeiro motor que o dono realmente tem — nunca um
 * literal de motor escrito aqui, que é a classe de defeito que esta leva inteira
 * veio matar, e nunca uma linha vazia que o dono não consegue nem editar.
 */
export function paraTela(
  agents: Record<string, PapelSalvo | undefined> | null | undefined,
  motores: readonly MotorOpcoes[]
): CascataUI {
  const saida = {} as CascataUI
  for (const papel of PAPEIS) {
    const salvo = agents?.[papel]
    const brutos: DegrauSalvo[] = salvo
      ? [salvo, ...(Array.isArray(salvo.fallbacks) ? salvo.fallbacks : [])]
      : [{ runtime: motores[0]?.runtime ?? '' }]
    saida[papel] = brutos.map((d) => degrauDaTela(papel, d ?? { runtime: '' }, motores))
  }
  return saida
}

/** `2026-08-31T23:00:00Z` → `31/08/2026`. Sem locale: o resultado não pode
 *  depender do fuso de quem abre a tela. */
function dataCurta(iso: string): string {
  const dia = iso.slice(0, 10).split('-')
  return dia.length === 3 ? `${dia[2]}/${dia[1]}/${dia[0]}` : iso
}

/** "Qualidade" para o principal, "Qualidade · reserva 1" para os degraus abaixo. */
function ondeNaCascata(papel: Papel, indice: number): string {
  const titulo = PAPEL_NA_TELA[papel].titulo
  return indice === 0 ? titulo : `${titulo} · reserva ${indice}`
}

/**
 * O que estava gravado e NÃO vai valer como está, dito em voz alta.
 *
 * Sem isto, `paraTela` largaria o esforço inválido e trocaria a escolha do
 * cliente em silêncio — o modo de falha mais caro deste produto (uma premissa
 * que expira calada continua parecendo verdade).
 */
export function avisosDoCarregamento(
  agents: Record<string, PapelSalvo | undefined> | null | undefined,
  motores: readonly MotorOpcoes[]
): string[] {
  const avisos: string[] = []
  for (const papel of PAPEIS) {
    const salvo = agents?.[papel]
    if (!salvo) continue
    const degraus = [salvo, ...(Array.isArray(salvo.fallbacks) ? salvo.fallbacks : [])]
    degraus.forEach((d, i) => {
      if (!d || typeof d.runtime !== 'string') return
      const onde = ondeNaCascata(papel, i)
      const motor = acharMotor(motores, d.runtime)
      if (!motor) return

      if (typeof d.effort === 'string' && d.effort && esforcoUtilizavel(motor, d.effort) === '') {
        avisos.push(
          motor.esforcoNoNomeDoModelo
            ? `${onde}: o motor "${motor.runtime}" não tem esforço separado do modelo, então o "${d.effort}" que estava gravado não vale — nele o esforço vem no nome do modelo.`
            : `${onde}: o motor "${motor.runtime}" não tem o esforço "${d.effort}" (aceita: ${motor.esforcos.join(', ')}). Este degrau roda no esforço padrão do motor.`
        )
      }

      // Catálogo vazio é "não sei", nunca "não existe": acusar aqui viraria
      // alarme toda vez que a coleta daquele motor falhasse.
      const modelo = typeof d.model === 'string' ? d.model : ''
      if (!modelo || (motor.modelos.length === 0 && motor.indisponiveis.length === 0)) return
      if (motor.modelos.some((m) => m.valor === modelo || m.rotulo === modelo)) return

      const saiu = motor.indisponiveis.find((m) => m.valor === modelo || m.rotulo === modelo)
      avisos.push(
        saiu
          ? `${onde}: o modelo "${saiu.rotulo}" saiu do catálogo do motor "${motor.runtime}"${saiu.sumiuEm ? ` em ${dataCurta(saiu.sumiuEm)}` : ''}. Enquanto estiver assim, este degrau roda no modelo padrão do motor.`
          : `${onde}: o modelo "${modelo}" não está no catálogo vivo do motor "${motor.runtime}". Este degrau roda no modelo padrão do motor até você escolher um da lista.`
      )
    })
  }
  return avisos
}

// --- mexer na cascata -------------------------------------------------------

/**
 * Troca o motor de um degrau. O modelo do motor ANTIGO não sobrevive — ele é
 * de outro provedor e o CLI novo o recusa. O esforço sobrevive só se existir na
 * escada do motor novo; nunca é "aproximado" para o nível vizinho, porque isso
 * mudaria o comportamento do agente pelas costas de quem escolheu.
 */
export function trocarMotor(
  degrau: DegrauUI,
  runtime: string,
  motores: readonly MotorOpcoes[]
): DegrauUI {
  if (degrau.runtime === runtime) return degrau
  return {
    ...degrau,
    runtime,
    model: '',
    effort: esforcoUtilizavel(acharMotor(motores, runtime), degrau.effort),
  }
}

export function trocarModelo(degrau: DegrauUI, model: string): DegrauUI {
  return { ...degrau, model }
}

export function trocarEsforco(degrau: DegrauUI, effort: string): DegrauUI {
  return { ...degrau, effort }
}

/**
 * Sobe ou desce um degrau. Fora da lista, devolve a MESMA referência: um array
 * novo faria o React redesenhar a fila inteira a cada clique sem efeito.
 */
export function mover(
  degraus: readonly DegrauUI[],
  indice: number,
  direcao: 'cima' | 'baixo'
): DegrauUI[] {
  const destino = direcao === 'cima' ? indice - 1 : indice + 1
  if (indice < 0 || indice >= degraus.length || destino < 0 || destino >= degraus.length) {
    return degraus as DegrauUI[]
  }
  const copia = [...degraus]
  const guardado = copia[indice]
  copia[indice] = copia[destino]
  copia[destino] = guardado
  return copia
}

/**
 * Acrescenta uma reserva. Ela nasce num motor que a fila ainda NÃO usa: uma
 * reserva no mesmo motor do degrau de cima não é reserva nenhuma — quando a
 * cota daquele motor acaba, os dois caem juntos.
 */
export function novoDegrau(
  papel: Papel,
  degraus: readonly DegrauUI[],
  motores: readonly MotorOpcoes[]
): DegrauUI[] {
  const jaUsados = new Set(degraus.map((d) => d.runtime))
  const livre = motores.find((m) => !jaUsados.has(m.runtime))
  return [
    ...degraus,
    {
      chave: novaChave(papel),
      runtime: (livre ?? motores[0])?.runtime ?? '',
      model: '',
      effort: '',
    },
  ]
}

/** Remove um degrau — menos o último: um papel sem motor nenhum não roda. */
export function removerDegrau(degraus: readonly DegrauUI[], indice: number): DegrauUI[] {
  if (degraus.length <= 1 || indice < 0 || indice >= degraus.length) return degraus as DegrauUI[]
  return degraus.filter((_, i) => i !== indice)
}

// --- o que a tela mostra em cada seletor ------------------------------------

export interface OpcaoDeModelo extends ModeloOpcao {
  /** vivo = está no catálogo; saiu = a coleta viu sumir; fora = nem uma coisa nem outra. */
  estado: 'vivo' | 'saiu' | 'fora'
  desabilitada: boolean
}

/**
 * As opções do seletor de modelo — catálogo vivo primeiro, o que saiu do ar
 * logo abaixo, DITO.
 *
 * O que saiu fica travado para não ser escolhido de novo, com uma exceção que
 * não é detalhe: se for justamente o modelo gravado, ele precisa continuar
 * selecionável. Um `<select>` cujo `value` não casa nenhuma opção habilitada
 * mostra outra coisa — e o dono leria como sua uma escolha que nunca fez.
 */
export function opcoesDeModelo(motor: MotorOpcoes | undefined, escolhido: string): OpcaoDeModelo[] {
  if (!motor) return []
  const vistos = new Set<string>()
  const saida: OpcaoDeModelo[] = []

  for (const m of motor.modelos) {
    if (vistos.has(m.valor)) continue
    vistos.add(m.valor)
    saida.push({ valor: m.valor, rotulo: m.rotulo, estado: 'vivo', desabilitada: false })
  }

  for (const m of motor.indisponiveis) {
    if (vistos.has(m.valor)) continue
    vistos.add(m.valor)
    saida.push({
      valor: m.valor,
      rotulo: `${m.rotulo} — saiu do ar${m.sumiuEm ? ` em ${dataCurta(m.sumiuEm)}` : ''}`,
      estado: 'saiu',
      desabilitada: m.valor !== escolhido,
    })
  }

  if (escolhido && !vistos.has(escolhido)) {
    saida.unshift({
      valor: escolhido,
      rotulo: `${escolhido} — fora do catálogo deste motor`,
      estado: 'fora',
      desabilitada: false,
    })
  }
  return saida
}

export interface EsforcoNaTela {
  habilitado: boolean
  opcoes: string[]
  /** por que o controle está travado. `null` quando ele funciona. */
  motivo: string | null
}

/**
 * O seletor de esforço daquele motor.
 *
 * No Antigravity ele nasce DESABILITADO com o motivo à vista — não por
 * preguiça de implementar, mas porque `agy --model X --effort high` é erro duro
 * do CLI (medido ao vivo em 01/09/2026) e a rota recusa a gravação. Um seletor
 * clicável ali entregaria ao dono uma escolha que morre na primeira missão.
 */
export function esforcoNaTela(motor: MotorOpcoes | undefined): EsforcoNaTela {
  if (!motor) {
    return {
      habilitado: false,
      opcoes: [],
      motivo: 'não conheço a escada de esforço deste motor.',
    }
  }
  if (motor.esforcoNoNomeDoModelo) {
    return {
      habilitado: false,
      opcoes: [],
      motivo:
        'neste motor o esforço vem dentro do nome do modelo — escolha a variante ' +
        '(High, Medium ou Low) no seletor de modelo.',
    }
  }
  return { habilitado: true, opcoes: [...motor.esforcos], motivo: null }
}

// --- o que vai para a rota --------------------------------------------------

function degrauParaRota(d: DegrauUI, motores: readonly MotorOpcoes[]): DegrauSalvo {
  const motor = acharMotor(motores, d.runtime)
  const mandaEsforco = Boolean(d.effort) && esforcoUtilizavel(motor, d.effort) === d.effort
  return {
    runtime: d.runtime,
    // Campo vazio NÃO vira string vazia: a rota recusa `model: ''` ("modelo
    // precisa ser texto não vazio"), e mandar assim quebraria a gravação
    // inteira por causa de um campo que o dono deliberadamente deixou no padrão.
    ...(d.model ? { model: d.model } : {}),
    ...(mandaEsforco ? { effort: d.effort } : {}),
  }
}

/**
 * O corpo do PUT. Sempre os QUATRO papéis: a rota substitui `agents` inteiro,
 * então mandar meia cascata apagaria os papéis de fora.
 */
export function paraEnvio(
  cascata: CascataUI,
  motores: readonly MotorOpcoes[]
): { agents: Record<Papel, PapelSalvo> } {
  const agents = {} as Record<Papel, PapelSalvo>
  for (const papel of PAPEIS) {
    const fila = cascata[papel] ?? []
    const principal = fila[0]
    agents[papel] = {
      ...(principal ? degrauParaRota(principal, motores) : { runtime: '' }),
      fallbacks: fila.slice(1).map((d) => degrauParaRota(d, motores)),
    }
  }
  return { agents }
}

/**
 * Tem o que salvar? Compara o que SERIA GRAVADO, não o estado da tela: a chave
 * de linha é da tela e nunca deve acender o botão de salvar.
 */
export function mudou(a: CascataUI, b: CascataUI, motores: readonly MotorOpcoes[]): boolean {
  return JSON.stringify(paraEnvio(a, motores)) !== JSON.stringify(paraEnvio(b, motores))
}

// --- a cota, ao lado de cada motor ------------------------------------------

/** Quando a cota foi lida, em linguagem de gente. */
export function quandoFoiLido(iso: string | null, agora: Date = new Date()): string {
  if (!iso) return 'nunca foi lida'
  const min = Math.round((agora.getTime() - new Date(iso).getTime()) / 60000)
  if (min < 2) return 'lida agora'
  if (min < 60) return `lida há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `lida há ${h} h`
  return `lida há ${Math.round(h / 24)} d`
}

export interface ResumoDaCota {
  texto: string
  /** ok = dá para trabalhar; aviso/grave = o dono precisa olhar; mudo = não sei. */
  tom: 'ok' | 'aviso' | 'grave' | 'mudo'
}

/**
 * A cota daquele motor, do jeito que o dono precisa ler para DECIDIR — é este
 * número que separa esta tela de um formulário cego.
 *
 * As regras que este resumo existe para cumprir, as mesmas do card de custos:
 * 1. `null` NUNCA vira 0. "Não sei quanto foi usado" desenhado como 0% faria o
 *    dono achar que tem a cota inteira — o oposto da verdade.
 * 2. "Não consegui ler" e "você não tem esse motor" são fatos diferentes, com
 *    ações opostas. Dar a mesma frase aos dois é como uma falha vira silêncio.
 */
export function resumoDaCota(args: {
  motor: MotorCota | undefined
  cotaLida: boolean
  motivoDaCota: string | null
  agora?: Date
}): ResumoDaCota {
  const agora = args.agora ?? new Date()
  if (!args.cotaLida) {
    return {
      texto: `${args.motivoDaCota ?? 'não consegui ler a cota dos seus motores agora'}.`,
      tom: 'mudo',
    }
  }
  const m = args.motor
  if (!m) {
    return {
      texto: 'este motor não está conectado — um degrau nele não vai rodar.',
      tom: 'grave',
    }
  }
  if (m.precisaReligar) {
    return {
      texto: 'precisa religar: a credencial venceu e a renovação automática não deu conta.',
      tom: 'grave',
    }
  }
  if (m.estado === 'nao_conectado') {
    return {
      texto: 'este motor não está conectado — um degrau nele não vai rodar.',
      tom: 'grave',
    }
  }
  if (m.sessao == null && m.semana == null) {
    return {
      texto: `não consegui ler a cota deste motor — ${quandoFoiLido(m.lidoEm, agora)}.`,
      tom: 'mudo',
    }
  }

  const partes: string[] = []
  if (m.sessao != null) partes.push(`sessão ${m.sessao}%`)
  if (m.semana != null) partes.push(`semana ${m.semana}%`)
  const pico = Math.max(m.sessao ?? 0, m.semana ?? 0)
  return {
    texto: `${partes.join(' · ')} já usados · ${quandoFoiLido(m.lidoEm, agora)}.`,
    tom: pico >= 90 ? 'grave' : pico >= 75 ? 'aviso' : 'ok',
  }
}
