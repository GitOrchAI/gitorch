// O MIOLO da conexão de motor — o mesmo em qualquer tela.
//
// POR QUE ESTE ARQUIVO EXISTE (01/09/2026). O único lugar do produto que
// CONECTAVA um motor era o passo 7 do assistente. O painel, onde o dono
// descobre que o motor caiu, só sabia mandá-lo para `/setup`: um <a> com o
// rótulo honesto "Religar no assistente". Honesto e insuficiente — o dono
// clicou, foi parar noutra tela e escreveu: "Serviço mal pensado."
//
// A tentação era copiar o fluxo para o painel. Duas cópias do mesmo login
// divergem na primeira mudança, e a que ninguém olha é a que mente. Então o
// fluxo saiu do componente e virou este módulo: uma loja de estado sem React,
// que o assistente e o painel consomem pelo MESMO caminho.
//
// Fora do React também por um motivo prático: o app web não tem jsdom, e o
// que precisa de teste aqui é justamente a máquina de estados — o que o card
// PASSA A SER depois de cada resposta do servidor.
//
// Regras que este módulo carrega e que não podem se perder numa refatoração:
//
// · `verifying` entra NO CLIQUE, antes de o POST voltar. Se o servidor demora,
//   a tela sem isso continua igual e a pessoa clica de novo (o "2 cliques pra
//   começar a processar" reportado ao vivo em 21/07).
// · Nada vira `connected` sem o servidor confirmar. `parseTokenResponse` e
//   `estadoDoMotorDaLista` (engine-status.ts) são as únicas portas para essa
//   fase.
// · Falha aparece. Rede caindo, 500, stream quebrado: tudo vira estado de erro
//   VISÍVEL, com a causa real do backend quando existe. Engolir a falha deixa
//   a pessoa presa sem saber que o código nunca chegou.
import {
  estadoDoMotorDaLista,
  normalizeLoginState,
  parseTokenResponse,
  type LoginState,
  type MotorDaLista,
} from './engine-status'

/** Um stream vivo de estados de um login assistido. */
export interface StreamDeLogin {
  fechar(): void
}

/**
 * Abre o stream de estados. É uma dependência injetada, e não `EventSource`
 * cru, para o fluxo poder ser testado fora do browser — o teste empurra os
 * eventos na mão e confere o estado que sobra na tela.
 */
export type AberturaDeStream = (
  url: string,
  aoEstado: (raw: unknown) => void,
  aoErro: () => void
) => StreamDeLogin

export interface DepsDeConexao {
  apiBaseUrl: string
  /**
   * A frase de erro genérica, LIDA NA HORA. É função, e não string, porque no
   * assistente ela vem de `t()`: se fosse valor, trocar de idioma recriaria a
   * loja e a pessoa perderia um login pela metade.
   */
  erroPadrao: () => string
  fetchImpl?: typeof fetch
  abrirStream?: AberturaDeStream
}

export interface InstantaneoDeConexao {
  /** O estado de cada card, pela chave que a tela escolheu. */
  estados: Record<string, LoginState>
  /** Envio de token manual em andamento, por card. */
  enviandoToken: Record<string, boolean>
}

export interface CartaoDeMotor {
  /** A chave da tela (o assistente usa `claude-code`; o painel usa o runtime). */
  id: string
  /** O runtime como o servidor o conhece: claude | codex | antigravity. */
  runtime: string
}

export interface ConexaoDeMotores {
  /** Snapshot imutável — a MESMA referência enquanto nada muda. */
  instantaneo(): InstantaneoDeConexao
  inscrever(ouvinte: () => void): () => void
  carregarDoServidor(cartoes: CartaoDeMotor[]): Promise<void>
  conectar(id: string, runtime: string): Promise<void>
  enviarCodigo(id: string, codigo: string): Promise<void>
  enviarToken(id: string, runtime: string, token: string): Promise<void>
  encerrar(): void
}

/** O adaptador real do browser: `EventSource` com o cookie da sessão. */
export const streamPorEventSource: AberturaDeStream = (url, aoEstado, aoErro) => {
  const src = new EventSource(url, { withCredentials: true } as EventSourceInit)
  src.addEventListener('state', (evt) => {
    try {
      aoEstado(JSON.parse((evt as MessageEvent).data))
    } catch {
      // Payload que nem é JSON é falha de verdade: `normalizeLoginState`
      // transforma `undefined` no erro honesto, e a tela oferece o retry.
      aoEstado(undefined)
    }
  })
  src.onerror = aoErro
  return { fechar: () => src.close() }
}

export function criarConexaoDeMotores(deps: DepsDeConexao): ConexaoDeMotores {
  const doFetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const abrir = deps.abrirStream ?? streamPorEventSource
  const base = deps.apiBaseUrl

  let instantaneo: InstantaneoDeConexao = { estados: {}, enviandoToken: {} }
  const ouvintes = new Set<() => void>()
  const loginIds: Record<string, string> = {}
  const streams: Record<string, StreamDeLogin> = {}
  // Geração por card: um evento que chega de um stream JÁ substituído não pode
  // mexer na tela. Sem isto, um duplo clique em "Conectar" deixava o stream
  // velho falando por cima do novo.
  const geracao: Record<string, number> = {}

  const avisar = () => {
    for (const o of ouvintes) o()
  }

  const definir = (id: string, estado: LoginState) => {
    instantaneo = { ...instantaneo, estados: { ...instantaneo.estados, [id]: estado } }
    avisar()
  }

  const marcarEnvio = (id: string, valor: boolean) => {
    instantaneo = { ...instantaneo, enviandoToken: { ...instantaneo.enviandoToken, [id]: valor } }
    avisar()
  }

  const fecharStream = (id: string) => {
    const anterior = streams[id]
    if (anterior) {
      anterior.fechar()
      delete streams[id]
    }
  }

  const conectar = async (id: string, runtime: string): Promise<void> => {
    fecharStream(id)
    const minha = (geracao[id] = (geracao[id] ?? 0) + 1)
    definir(id, { phase: 'starting' })
    try {
      const res = await doFetch(`${base}/api/v1/engines/${runtime}/login/start`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as { error?: string } | null
        definir(id, { phase: 'error', message: corpo?.error || deps.erroPadrao() })
        return
      }
      const { loginId } = (await res.json()) as { loginId: string }
      loginIds[id] = loginId

      const stream = abrir(
        `${base}/api/v1/engines/login/${loginId}/stream`,
        (raw) => {
          if (geracao[id] !== minha) return
          const estado = normalizeLoginState(raw, deps.erroPadrao())
          definir(id, estado)
          if (estado.phase === 'connected' || estado.phase === 'error') {
            // Acabou: fecha e queima a geração, para um evento atrasado do
            // mesmo stream não desfazer o resultado final.
            geracao[id] = minha + 1
            fecharStream(id)
          }
        },
        () => {
          if (geracao[id] !== minha) return
          geracao[id] = minha + 1
          definir(id, { phase: 'error', message: deps.erroPadrao() })
          fecharStream(id)
        }
      )
      if (geracao[id] !== minha) {
        // Outro "Conectar" ganhou a corrida enquanto o POST voltava.
        stream.fechar()
        return
      }
      streams[id] = stream
    } catch {
      definir(id, { phase: 'error', message: deps.erroPadrao() })
    }
  }

  const enviarCodigo = async (id: string, codigo: string): Promise<void> => {
    const loginId = loginIds[id]
    const code = codigo.trim()
    if (!loginId || !code) return
    // Feedback IMEDIATO: 'verifying' no CLIQUE, ANTES do fetch. O próximo
    // evento do stream (connected/error) sobrescreve esta fase local.
    definir(id, { phase: 'verifying' })
    try {
      const res = await doFetch(`${base}/api/v1/engines/login/${loginId}/code`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      definir(id, { phase: 'error', message: deps.erroPadrao() })
    }
  }

  const enviarToken = async (id: string, runtime: string, token: string): Promise<void> => {
    const valor = token.trim()
    if (!valor || instantaneo.enviandoToken[id]) return
    marcarEnvio(id, true)
    try {
      const res = await doFetch(`${base}/api/v1/engines/${runtime}/token`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: valor }),
      })
      const json = (await res.json().catch(() => null)) as unknown
      definir(id, parseTokenResponse(json, deps.erroPadrao()))
    } catch {
      definir(id, { phase: 'error', message: deps.erroPadrao() })
    } finally {
      marcarEnvio(id, false)
    }
  }

  const carregarDoServidor = async (cartoes: CartaoDeMotor[]): Promise<void> => {
    let dados: { engines?: MotorDaLista[] } | null = null
    try {
      const res = await doFetch(`${base}/api/v1/engines`, { credentials: 'include' })
      dados = res.ok ? ((await res.json()) as { engines?: MotorDaLista[] }) : null
    } catch {
      dados = null
    }
    // Não conseguir ler a lista NÃO é motivo para afirmar nada: os cards ficam
    // como estavam (idle), e a tela que chamou continua mostrando o que ela
    // própria já sabe. Nenhum estado inventado entra aqui.
    if (!dados?.engines) return
    const doServidor: Record<string, LoginState> = {}
    for (const cartao of cartoes) {
      const estado = estadoDoMotorDaLista(dados.engines.find((e) => e.runtime === cartao.runtime))
      if (estado) doServidor[cartao.id] = estado
    }
    // O que a pessoa está fazendo AGORA vence o retrato do servidor: um login
    // em andamento não pode ser atropelado por uma leitura que começou antes.
    instantaneo = { ...instantaneo, estados: { ...doServidor, ...instantaneo.estados } }
    avisar()
  }

  return {
    instantaneo: () => instantaneo,
    inscrever: (ouvinte) => {
      ouvintes.add(ouvinte)
      return () => {
        ouvintes.delete(ouvinte)
      }
    },
    carregarDoServidor,
    conectar,
    enviarCodigo,
    enviarToken,
    encerrar: () => {
      for (const id of Object.keys(streams)) fecharStream(id)
      ouvintes.clear()
    },
  }
}
