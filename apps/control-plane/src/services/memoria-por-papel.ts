/**
 * O que cada agente precisa lembrar do projeto antes de trabalhar.
 *
 * Ordem do dono, 25/08/2026, nas palavras dele: "Faz o que o mempalace faz !!
 * ele tem que aprender com o projeto, nao só ele, mas todos os agentes !
 * memoria serve pra isso ! ele nao pode nascer sem saber porra nenhuma do
 * projeto !"
 *
 * O estado antes disto: só o PO lia memória DIRIGIDA — o entregável do RA e os
 * pareceres do QA. RA e QA recebiam apenas "as últimas cinco gavetas de
 * qualquer assunto", que é memória genérica: pode trazer cinco coisas sem
 * nenhuma relação com o que aquele agente vai fazer agora. O QA, em especial,
 * não lia os próprios julgamentos — julgava do zero toda vez, sem lembrar o que
 * já tinha apontado naquele repositório.
 *
 * Este arquivo diz, por papel, QUAIS salas da memória importam. Não é a
 * memória: é o mapa de quem lê o quê.
 */

export type PapelDoAgente = 'ra' | 'po' | 'sm' | 'qa'

/**
 * As salas que cada papel lê, em ordem de importância.
 *
 * Lista vazia significa "só a memória geral", e para o SM significa "nenhuma":
 * ele é determinístico, sem motor de IA, e dar memória a ele mudaria a natureza
 * do papel. O dono não pediu isso, e fazer por conta seria trocar o desenho
 * dele por um meu.
 */
const SALAS_POR_PAPEL: Record<PapelDoAgente, readonly string[]> = {
  // O explorador do projeto lê o que ELE mesmo já mapeou, para partir de onde
  // parou em vez de recomeçar o mapa a cada agendamento; e lê os pareceres do
  // QA, porque é ali que aparece o que o repositório tem de frágil.
  ra: ['ra', 'qa'],
  // Já era assim, e está certo: o RA diz o que o desejo precisa, o QA diz o que
  // a entrega revelou sobre o repositório.
  po: ['ra', 'qa'],
  // Determinístico de propósito. Ver o comentário acima.
  sm: [],
  // O juiz lê os PRÓPRIOS pareceres daquele repositório. Sem isso ele repete o
  // mesmo apontamento em entregas diferentes e nunca aprende que naquele
  // projeto o CI sempre quebra no mesmo lugar. E lê o mapa do RA, que é onde
  // está escrito o que cada área do sistema faz.
  qa: ['qa', 'ra'],
}

export function salasQueOPapelLe(papel: string): readonly string[] {
  return SALAS_POR_PAPEL[papel as PapelDoAgente] ?? []
}

/** Este papel aprende com o projeto, ou é determinístico? */
export function papelAprendeComOProjeto(papel: string): boolean {
  return salasQueOPapelLe(papel).length > 0
}

export interface GavetaLida {
  content: string
  createdAt?: string | undefined
}

/**
 * Quantas gavetas por sala entram no contexto.
 *
 * Três, e não mais: cada gaveta é texto que o motor lê e cobra por, então
 * memória demais encarece todo julgamento sem deixá-lo melhor. Três é o
 * suficiente para o padrão aparecer — "isto já aconteceu antes" — sem virar
 * um relatório.
 */
export const GAVETAS_POR_SALA = 3

/**
 * As gavetas que este papel deve ler, já ordenadas e sem repetição.
 *
 * A ordem é a mais recente primeiro, dentro de cada sala, e as salas na ordem
 * de importância do papel. Repetição é tirada porque a mesma gaveta pode
 * aparecer em duas salas, e pagar duas vezes pelo mesmo texto é desperdício
 * puro.
 */
export function memoriaDoPapel(args: {
  papel: string
  /** Lê as gavetas de uma sala do projeto. */
  lerSala: (sala: string) => GavetaLida[]
  porSala?: number
}): GavetaLida[] {
  const porSala = args.porSala ?? GAVETAS_POR_SALA
  const vistas = new Set<string>()
  const saida: GavetaLida[] = []

  for (const sala of salasQueOPapelLe(args.papel)) {
    const daSala = [...args.lerSala(sala)]
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, porSala)
    for (const gaveta of daSala) {
      if (vistas.has(gaveta.content)) continue
      vistas.add(gaveta.content)
      saida.push(gaveta)
    }
  }
  return saida
}
