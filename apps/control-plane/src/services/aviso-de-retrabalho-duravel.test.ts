import { describe, expect, it, vi } from 'vitest'
import { vigiarSessoes, MAX_TENTATIVAS_DE_AVISO } from './session-watch.js'
import type { LinhaDeSessao } from './dev-session-store.js'

// POR QUE ESTE ARQUIVO EXISTE — medido na prova ponta a ponta de 21/08/2026.
//
// O QA reprovou o pull request #157 com motivo tecnicamente correto e tentou
// entregar a reprovação na conversa viva do dev. A entrega falhou com HTTP 429
// — limite de taxa, erro PASSAGEIRO. O produto gritou no log a frase certa
// ("o dev não vai retrabalhar sozinho") e NÃO REPETIU.
//
// O encalhe virou PERMANENTE por composição, e é isso que torna o caso grave:
// o parecer JÁ tinha sido postado no pull request, então na passagem seguinte o
// laço de descoberta trata a entrega como "já julgada neste head" e pula. Para
// sempre. Medido: 47 minutos depois, o pull request seguia com um commit e o
// dev sem responder — enquanto no dia anterior o mesmo laço fechou em 9 minutos
// com o aviso entregue.
//
// Reenviado À MÃO minutos depois, o MESMO texto foi aceito na hora (HTTP 200,
// verificado contra a API real). Uma repetição teria resolvido; o que faltava
// era o produto LEMBRAR do recado.

const BASE = {
  id: 'linha-1',
  projectId: 'proj-1',
  issueNumber: 151,
  sessionName: 'sessions/abc',
  state: 'IN_PROGRESS',
  answeredHash: null,
  pullRequestNumber: 157,
  attempts: 1,
  nudges: 0,
  lastProgressAt: null,
  stateCheckedAt: null,
  reworkNoticePending: null,
  reworkNoticeAttempts: 0,
  pendingSince: null,
  closedAt: null,
} as unknown as LinhaDeSessao

type Deps = Parameters<typeof vigiarSessoes>[0]

function deps(over: Record<string, unknown> = {}): Deps {
  return {
    sessoes: [BASE],
    agora: new Date('2026-08-21T22:00:00Z'),
    consultarSessao: vi.fn(async () => ({ estado: 'IN_PROGRESS', ultimaAtualizacao: null })),
    ultimaMensagem: vi.fn(async () => ''),
    aprovarPlano: vi.fn(async () => true),
    responder: vi.fn(async () => true),
    pedirParaContinuar: vi.fn(async () => true),
    dispararMissao: vi.fn(async () => undefined),
    registrarEstado: vi.fn(async () => undefined),
    registrarResposta: vi.fn(async () => undefined),
    registrarPr: vi.fn(async () => undefined),
    registrarInvestigacao: vi.fn(async () => undefined),
    fecharSessao: vi.fn(async () => undefined),
    ...over,
  } as unknown as Deps
}

describe('pedido de retrabalho que não chegou ao dev é reentregue', () => {
  it('reentrega o TEXTO guardado e apaga a pendência quando chega', async () => {
    const reentregar = vi.fn(async () => true)
    const limpar = vi.fn(async () => undefined)

    const resumo = await vigiarSessoes(
      deps({
        sessoes: [{ ...BASE, reworkNoticePending: 'Refaça: falta ligar o log ao fluxo.' }],
        reentregarAviso: reentregar,
        limparAvisoPendente: limpar,
      })
    )

    // O TEXTO tem que viajar. Um booleano de "havia um recado" mandaria ao dev
    // um aviso vazio, e ninguém retrabalha com isso.
    expect(reentregar).toHaveBeenCalledWith({
      sessionName: 'sessions/abc',
      texto: 'Refaça: falta ligar o log ao fluxo.',
    })
    expect(limpar).toHaveBeenCalledWith({ sessionName: 'sessions/abc' })
    expect(resumo).toContain('reentregue')
  })

  it('falhou de novo: conta a tentativa e NÃO apaga a pendência', async () => {
    const contar = vi.fn(async () => undefined)
    const limpar = vi.fn(async () => undefined)

    await vigiarSessoes(
      deps({
        sessoes: [{ ...BASE, reworkNoticePending: 'Refaça.' }],
        reentregarAviso: async () => false,
        limparAvisoPendente: limpar,
        contarTentativaDeAviso: contar,
      })
    )

    expect(contar).toHaveBeenCalledWith({ sessionName: 'sessions/abc' })
    expect(limpar).not.toHaveBeenCalled()
  })

  it('reentregador que LANÇA conta a tentativa em vez de derrubar a vigília', async () => {
    const contar = vi.fn(async () => undefined)
    await vigiarSessoes(
      deps({
        sessoes: [{ ...BASE, reworkNoticePending: 'Refaça.' }],
        reentregarAviso: async () => {
          throw new Error('rede fora do ar')
        },
        contarTentativaDeAviso: contar,
      })
    )
    expect(contar).toHaveBeenCalledOnce()
  })

  it('no teto de tentativas, desiste AVISANDO o dono — nunca em silêncio', async () => {
    const avisarDono = vi.fn(async (_mensagem: string) => true)
    const reentregar = vi.fn(async () => true)
    const limpar = vi.fn(async () => undefined)

    await vigiarSessoes(
      deps({
        sessoes: [
          {
            ...BASE,
            reworkNoticePending: 'Refaça.',
            reworkNoticeAttempts: MAX_TENTATIVAS_DE_AVISO,
          },
        ],
        reentregarAviso: reentregar,
        limparAvisoPendente: limpar,
        avisarDono,
      })
    )

    // Desistir calado seria voltar ao defeito original, só que mais devagar.
    expect(avisarDono).toHaveBeenCalledOnce()
    const texto = String(avisarDono.mock.calls.at(0)?.at(0) ?? '')
    // Escrito para GENTE: nomeia o trabalho pelo número do quadro, aponta onde
    // está escrito o que mudar, e diz a AÇÃO. O identificador de sessão fica no
    // log, nunca no recado de quem decide.
    expect(texto).toContain('#151')
    expect(texto).toContain('#157')
    expect(texto).toContain('avisá-lo à mão')
    expect(texto).not.toContain('sessions/abc')
    // E para de tentar: o recado sai da fila.
    expect(reentregar).not.toHaveBeenCalled()
    expect(limpar).toHaveBeenCalledOnce()
  })

  it('carimba a cadência mesmo quando a reentrega falha — o teto é de TEMPO, não de passagens', async () => {
    // ACHADO 1 DA LENTE: `stateCheckedAt` só avança quando o exame da sessão dá
    // certo, e num erro de rede ele NÃO dá. Sem carimbar aqui, a reentrega roda
    // a cada tique (1 min) e cinco tentativas queimam em CINCO MINUTOS — o
    // apagão de oito minutos que motivou esta feature esgotaria o teto e
    // apagaria o recado antes de o serviço voltar.
    const registrarEstado = vi.fn(async () => undefined)
    await vigiarSessoes(
      deps({
        sessoes: [{ ...BASE, reworkNoticePending: 'Refaça.' }],
        reentregarAviso: async () => false,
        contarTentativaDeAviso: vi.fn(async () => undefined),
        registrarEstado,
      })
    )
    expect(registrarEstado).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/abc' })
    )
  })

  it('no teto SEM conseguir avisar o dono, o recado NÃO é apagado', async () => {
    // ACHADO 2: apagar sem avisar destrói a evidência que esta peça veio
    // preservar — o defeito original de volta, e pior, porque agora o pedido
    // some do banco e ninguém fica sabendo que existiu.
    const limpar = vi.fn(async () => undefined)
    await vigiarSessoes(
      deps({
        sessoes: [
          {
            ...BASE,
            reworkNoticePending: 'Refaça.',
            reworkNoticeAttempts: MAX_TENTATIVAS_DE_AVISO,
          },
        ],
        reentregarAviso: async () => true,
        limparAvisoPendente: limpar,
        // Sem notificador: em produção acontece quando falta o canal do dono.
        avisarDono: undefined,
      })
    )
    expect(limpar).not.toHaveBeenCalled()
  })

  it('entregou mas NÃO conseguiu apagar a marca: conta a tentativa, senão vira laço sem fim', async () => {
    // ACHADO 3: o contador só crescia no ramo de falha. Uma escrita que falha
    // de forma persistente reenviaria o MESMO texto ao dev a cada passagem,
    // para sempre, sem teto nenhum.
    const contar = vi.fn(async () => undefined)
    await vigiarSessoes(
      deps({
        sessoes: [{ ...BASE, reworkNoticePending: 'Refaça.' }],
        reentregarAviso: async () => true,
        limparAvisoPendente: async () => {
          throw new Error('banco recusou')
        },
        contarTentativaDeAviso: contar,
      })
    )
    expect(contar).toHaveBeenCalledWith({ sessionName: 'sessions/abc' })
  })

  it('sessão sem pendência não mexe em nada disso', async () => {
    const reentregar = vi.fn(async () => true)
    await vigiarSessoes(deps({ reentregarAviso: reentregar }))
    expect(reentregar).not.toHaveBeenCalled()
  })
})
