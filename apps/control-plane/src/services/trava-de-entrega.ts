// Trava de entrega: a parte do produto numa troca de versão que nunca corta
// agente trabalhando.
//
// O entregador (fora deste repositório) pede que o produto pare de INICIAR
// trabalho novo, pergunta "ainda há trabalho em andamento?" até a resposta ser
// não, troca a versão e solta a trava. O que já está rodando termina
// normalmente e nada é cancelado: a trava só fecha a porta de entrada.
//
// `podeIniciarTrabalho` é a guarda ÚNICA. Todo ponto que começa trabalho
// (criar ou tomar missão, abrir sessão do dev, diagnóstico, login assistido,
// etapas de segundo plano que escrevem no GitHub) passa por ela; o teste de
// arquitetura `inicio-de-trabalho-com-trava.test.ts` impede um ponto novo de
// nascer sem ela.
//
// O estado vive no banco (linha única) para sobreviver ao reinício do serviço:
// uma trava só em memória sumiria no restart que a própria troca provoca.

const ID_DA_LINHA = 'entrega'

/** Quanto a leitura da trava fica em cache: não consulta o banco a cada ponto. */
export const CACHE_DA_TRAVA_MS = 1500

/** Depois de quantas horas ligada a trava vira "esquecida" e o dono é avisado. */
export const HORAS_ATE_TRAVA_ESQUECIDA = 2

/** Texto mostrado na tela quando um pedido é recusado por causa da trava. */
export const MENSAGEM_EM_ENTREGA =
  'O GitOrch está sendo atualizado. Tente de novo em alguns minutos.'

/** Sugestão de espera (segundos) enviada no cabeçalho Retry-After. */
export const SEGUNDOS_ATE_TENTAR_DE_NOVO = 60

/** Intervalo mínimo entre dois avisos de "não consegui ler a trava". */
const INTERVALO_DO_AVISO_DE_LEITURA_MS = 60_000

export interface EstadoDaTrava {
  ligada: boolean
  desde: Date | null
  motivo: string | null
  ligadaPor: string | null
}

interface LinhaDaTrava {
  id: string
  ligada: boolean
  desde: Date | null
  motivo: string | null
  ligadaPor: string | null
}

/**
 * Só o que a trava usa do Prisma. Assinatura de método (bivariante), como nos
 * vizinhos, para o PrismaClient real caber sem cast.
 */
export interface PrismaDaTrava {
  travaDeEntrega: {
    findUnique(args: { where: { id: string } }): Promise<LinhaDaTrava | null>
    upsert(args: {
      where: { id: string }
      create: Omit<LinhaDaTrava, 'id'> & { id: string }
      update: Partial<Omit<LinhaDaTrava, 'id'>>
    }): Promise<LinhaDaTrava>
  }
}

export interface OpcoesDaTrava {
  agora?: () => number
  cacheMs?: number
  onWarn?: (mensagem: string) => void
}

const DESLIGADA: EstadoDaTrava = Object.freeze({
  ligada: false,
  desde: null,
  motivo: null,
  ligadaPor: null,
})

function paraEstado(linha: LinhaDaTrava | null): EstadoDaTrava {
  if (!linha || !linha.ligada) return { ...DESLIGADA }
  return {
    ligada: true,
    desde: linha.desde,
    motivo: linha.motivo,
    ligadaPor: linha.ligadaPor,
  }
}

export interface TravaDeEntrega {
  /** Lê do banco, sem cache. Rejeita se o banco falhar. */
  estadoDaTrava(): Promise<EstadoDaTrava>
  ligarTrava(args: { motivo: string; por: string }): Promise<EstadoDaTrava>
  desligarTrava(args: { por: string }): Promise<EstadoDaTrava>
  /** A guarda única: `false` com a trava ligada OU quando ela não pôde ser lida. */
  podeIniciarTrabalho(): Promise<boolean>
}

export function criarTravaDeEntrega(
  prisma: PrismaDaTrava,
  opcoes: OpcoesDaTrava = {}
): TravaDeEntrega {
  const agora = opcoes.agora ?? Date.now
  const cacheMs = opcoes.cacheMs ?? CACHE_DA_TRAVA_MS
  const onWarn = opcoes.onWarn ?? (() => undefined)

  let cache: { ate: number; pode: boolean } | null = null
  let ultimoAvisoDeLeitura = Number.NEGATIVE_INFINITY

  const ler = async (): Promise<EstadoDaTrava> =>
    paraEstado(await prisma.travaDeEntrega.findUnique({ where: { id: ID_DA_LINHA } }))

  return {
    estadoDaTrava: ler,

    async ligarTrava({ motivo, por }) {
      // Idempotente: já ligada mantém o "desde", o motivo e quem pediu, para a
      // contagem do aviso de trava esquecida não reiniciar a cada chamada.
      const atual = await ler()
      if (atual.ligada) return atual
      const desde = new Date(agora())
      await prisma.travaDeEntrega.upsert({
        where: { id: ID_DA_LINHA },
        create: { id: ID_DA_LINHA, ligada: true, desde, motivo, ligadaPor: por },
        update: { ligada: true, desde, motivo, ligadaPor: por },
      })
      cache = null
      return { ligada: true, desde, motivo, ligadaPor: por }
    },

    async desligarTrava() {
      const atual = await ler()
      if (!atual.ligada) return atual
      await prisma.travaDeEntrega.upsert({
        where: { id: ID_DA_LINHA },
        create: { id: ID_DA_LINHA, ligada: false, desde: null, motivo: null, ligadaPor: null },
        update: { ligada: false, desde: null, motivo: null, ligadaPor: null },
      })
      cache = null
      return { ...DESLIGADA }
    },

    async podeIniciarTrabalho() {
      const t = agora()
      if (cache && t < cache.ate) return cache.pode
      let pode: boolean
      try {
        // Um cliente de banco SEM o modelo da trava não existe em produção (o
        // cliente gerado a partir do schema sempre o tem, e o build barra o
        // código que o referencia sem ele). Só aparece em dublês de teste que
        // não tratam de entrega; nesse caso não há trava para consultar. Isto
        // NÃO é uma falha de leitura: o banco responder erro continua adiando.
        pode = !('travaDeEntrega' in prisma) || !(await ler()).ligada
      } catch (err) {
        // FAIL-SAFE: sem ler a trava não dá para saber se há uma troca de
        // versão em curso. Iniciar trabalho novo no escuro arriscaria um agente
        // cortado no meio pela troca; adiar custa só alguns minutos de espera,
        // e o trabalho adiado volta sozinho quando o banco responder.
        pode = false
        if (t - ultimoAvisoDeLeitura >= INTERVALO_DO_AVISO_DE_LEITURA_MS) {
          ultimoAvisoDeLeitura = t
          onWarn(
            `[Entrega] não consegui ler a trava de entrega; trabalho novo adiado por segurança: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
      cache = { ate: t + cacheMs, pode }
      return pode
    },
  }
}

const porPrisma = new WeakMap<object, TravaDeEntrega>()

/** A trava deste cliente de banco (uma por processo, com o cache dela). */
export function travaDe(
  prisma: PrismaDaTrava,
  onWarn?: (mensagem: string) => void
): TravaDeEntrega {
  let trava = porPrisma.get(prisma)
  if (!trava) {
    trava = criarTravaDeEntrega(prisma, onWarn ? { onWarn } : {})
    porPrisma.set(prisma, trava)
  }
  return trava
}

/** A guarda única de todo ponto que INICIA trabalho. */
export function podeIniciarTrabalho(
  prisma: PrismaDaTrava,
  onWarn?: (mensagem: string) => void
): Promise<boolean> {
  return travaDe(prisma, onWarn).podeIniciarTrabalho()
}

/** O que uma rota que inicia trabalho responde quando a trava está ligada. */
export function recusarPorEntrega(reply: {
  code(status: number): { header(nome: string, valor: string): { send(corpo: unknown): unknown } }
}): unknown {
  return reply
    .code(503)
    .header('Retry-After', String(SEGUNDOS_ATE_TENTAR_DE_NOVO))
    .send({ error: MENSAGEM_EM_ENTREGA, code: 'em-entrega' })
}

export interface DecisaoDeTravaEsquecida {
  deveAvisar: boolean
  novoUltimoAviso: Date | null
  horasLigada: number
}

/**
 * Trava ligada há mais de 2 horas = provavelmente esquecida. Avisa UMA vez por
 * período de 2 horas (não a cada tique) e nunca desliga sozinha: quem decide é
 * o dono ou o entregador.
 */
export function decidirAvisoDeTravaEsquecida(args: {
  desde: Date | null
  ultimoAviso: Date | null
  agora: Date
}): DecisaoDeTravaEsquecida {
  const { desde, ultimoAviso, agora } = args
  if (!desde) return { deveAvisar: false, novoUltimoAviso: null, horasLigada: 0 }
  const horasLigada = Math.floor((agora.getTime() - desde.getTime()) / 3_600_000)
  // O "marco" é o último aviso (ou o início da trava): o próximo só sai quando
  // passar outro período inteiro desde ele.
  const marco = ultimoAviso ?? desde
  if (agora.getTime() - marco.getTime() < HORAS_ATE_TRAVA_ESQUECIDA * 3_600_000) {
    return { deveAvisar: false, novoUltimoAviso: ultimoAviso, horasLigada }
  }
  return { deveAvisar: true, novoUltimoAviso: agora, horasLigada }
}
