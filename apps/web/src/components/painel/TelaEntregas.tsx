'use client'
// Entregas: o que ficou PRONTO, e o que ainda não — com o motivo escrito.
//
// AO VIVO desde a leva 2, bloco 5. Antes esta tela mostrava exemplo com selo,
// porque a rota não existia; agora ela lê /api/v1/painel/entregas.
//
// Scrum 2020: o Incremento nasce quando um item atende à Definição de Pronto.
// A régua é do CLIENTE (Configurações), e o que falta vem escrito — uma
// entrega parada sem ninguém dizer por quê é o silêncio que este bloco veio
// acabar.
//
// A LISTA CASA COM O NÚMERO (decisão do dono, 31/08). Até aqui o cabeçalho
// dizia "Prontas: 15" e a lista mostrava as 50 sessões mais recentes, onde há
// ZERO prontas: o dono lia quinze e não via nenhuma. A aba chama-se Entregas,
// então a lista padrão é a das ENTREGAS PRONTAS, da mais recente para a mais
// antiga. O que ainda não fechou não sumiu do produto — está no outro grupo,
// com a contagem no próprio botão, porque filtro que o dono não vê é a mesma
// família de mentira que esta tela veio acabar.
//
// TUDO QUE PODE MENTIR MORA EM entregas-paginacao.ts, QUE TEM TESTE: a chave
// de cada cartão, o denominador, o rótulo do grupo e a navegação. O app web
// testa lógica em `.ts` (vitest com environment 'node'), e era por estarem
// soltos aqui dentro que o "de 50" e a `key` repetida atravessaram revisão.
import { useState, useSyncExternalStore } from 'react'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Estado } from './PainelUI'
import { Estados } from './PainelEstados'
import { assinarProjeto, projetoAtual, projetoNoServidor, filtroDeProjeto } from './painel-projeto'
import {
  chavesDosCartoes,
  navegacao,
  rotuloDoDenominador,
  rotuloDoGrupo,
  PAGINA_INICIAL,
  type GrupoDeEntrega,
} from './entregas-paginacao'

interface EntregaView {
  projeto: string
  pedido: number
  entrega: number | null
  pronto: boolean
  prontoEm: string | null
  atendidos: string[]
  porQueNaoFechou: string[]
}

/**
 * O corpo da rota, do jeito que a tela usa.
 *
 * Contagem AUSENTE vira `null`, nunca 0: `?? 0` colocaria "de 0 pedidos que
 * passaram pela sua régua" embaixo de um número real. É o default vazio que já
 * nos custou caro — desconhecido tem que continuar desconhecido.
 */
interface EntregasView {
  entregas: EntregaView[]
  /** Pedidos prontos em TODOS — contado sobre a população, não sobre a página. */
  prontas: number | null
  /** Pedidos que ainda não fecharam, em TODOS. */
  andando: number | null
  /** Pedidos avaliados, em TODOS. A unidade do cartão, que diz "Pedido #N". */
  total: number | null
  pagina: number
  paginas: number
}

/** Data curta, do jeito que o dono lê. */
function quando(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** O número grande, ou travessão quando a rota ainda não disse. */
function numero(v: number | null): string {
  return v === null ? '—' : String(v)
}

export function TelaEntregas() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)

  // A posição guarda A QUE PROJETO E A QUE GRUPO ela pertence. Trocar de
  // projeto (ou de grupo) com a página 4 aberta pediria a página 4 de outra
  // população — normalmente vazia, e o dono leria "nenhuma entrega" onde há
  // entregas. Zerar isto num efeito renderizaria a página errada uma vez antes
  // de corrigir; guardar o contexto junto faz a volta ao início acontecer no
  // MESMO render da troca.
  const [pos, setPos] = useState<{ projeto: string | null; grupo: GrupoDeEntrega; pagina: number }>(
    {
      projeto,
      grupo: 'prontas',
      pagina: PAGINA_INICIAL,
    }
  )
  const mesmoContexto = pos.projeto === projeto
  const grupo: GrupoDeEntrega = mesmoContexto ? pos.grupo : 'prontas'
  const pagina = mesmoContexto ? pos.pagina : PAGINA_INICIAL

  const irPara = (p: number) => setPos({ projeto, grupo, pagina: Math.max(PAGINA_INICIAL, p) })
  const verGrupo = (g: GrupoDeEntrega) => setPos({ projeto, grupo: g, pagina: PAGINA_INICIAL })

  const filtro = filtroDeProjeto(projeto)
  const separador = filtro === '' ? '?' : '&'
  const r = usePainelBusca<EntregasView, Partial<EntregasView>>(
    `${ROTAS.entregas}${filtro}${separador}grupo=${grupo}&pagina=${pagina}`,
    {
      mapear: (b) => ({
        entregas: b.entregas ?? [],
        prontas: b.prontas ?? null,
        andando: b.andando ?? null,
        total: b.total ?? null,
        pagina: b.pagina ?? PAGINA_INICIAL,
        paginas: b.paginas ?? 0,
      }),
      // "Vazio" é o dono não ter pedido nada ainda — não uma página sem linhas.
      // Uma página vazia depois do fim continua sendo a tela normal, com os
      // números certos no cabeçalho.
      vazio: (d) => d.total === 0,
    }
  )

  return (
    <>
      <Cabeca titulo="Entregas">
        O que ficou pronto pela sua régua — e, no que ainda não fechou, o que está faltando.
      </Cabeca>

      <Estados
        r={r}
        o_que="as suas entregas"
        vazio="Nenhuma entrega ainda. A primeira aparece aqui assim que sair."
      >
        {(d) => {
          const quantosNoGrupo = grupo === 'prontas' ? d.prontas : d.andando
          const nota = rotuloDoDenominador(d.total)
          const chaves = chavesDosCartoes(d.entregas)
          const n = navegacao({ pagina: d.pagina, paginas: d.paginas })
          return (
            <>
              <Card>
                <span className="pn-label">Prontas</span>
                <div className="num" style={{ fontSize: 26, fontWeight: 600 }}>
                  {numero(d.prontas)}
                </div>
                {/* Sem `total`, a nota some. Dizer "de 0" ao lado de um número
                    real é o default vazio que esta tela existe para não ter. */}
                {nota && (
                  <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 2 }}>
                    {nota}
                  </div>
                )}
              </Card>

              {/* Os dois grupos, com a contagem no próprio botão: o dono vê de
                  onde vem cada número antes de clicar, e o que a lista mostra
                  fica dito em palavras logo abaixo. */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`pn-btn sm${grupo === 'prontas' ? ' a' : ''}`}
                  onClick={() => verGrupo('prontas')}
                >
                  Prontas ({numero(d.prontas)})
                </button>
                <button
                  type="button"
                  className={`pn-btn sm${grupo === 'andando' ? ' a' : ''}`}
                  onClick={() => verGrupo('andando')}
                >
                  Ainda não fecharam ({numero(d.andando)})
                </button>
              </div>

              <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 10 }}>
                {rotuloDoGrupo(grupo, quantosNoGrupo)}
              </div>

              <div className="pn-3" style={{ marginTop: 16 }}>
                {d.entregas.map((e, i) => (
                  <Card key={chaves[i]}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.025em' }}>
                          Pedido #{e.pedido}
                          {e.entrega !== null && (
                            <span style={{ color: 'var(--gl-faint)', fontWeight: 400 }}>
                              {' '}
                              · entrega #{e.entrega}
                            </span>
                          )}
                        </div>
                        <div className="tt" style={{ color: 'var(--gl-faint)', marginTop: 4 }}>
                          {e.projeto}
                        </div>
                      </div>
                      {e.pronto ? (
                        <Estado d="go">Pronto{e.prontoEm ? ` · ${quando(e.prontoEm)}` : ''}</Estado>
                      ) : (
                        <Estado d="idle">Ainda não</Estado>
                      )}
                    </div>

                    {/* O que falta é a parte que não pode se perder. Uma entrega
                        parada sem motivo escrito é o silêncio que esta tela veio
                        acabar. */}
                    {!e.pronto && e.porQueNaoFechou.length > 0 && (
                      <ul
                        style={{
                          margin: '14px 0 0',
                          paddingLeft: 18,
                          fontSize: 13.5,
                          color: 'var(--gl-muted)',
                        }}
                      >
                        {e.porQueNaoFechou.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    )}

                    {e.pronto && e.atendidos.length > 0 && (
                      <div
                        style={{
                          marginTop: 14,
                          fontSize: 13,
                          color: 'var(--gl-muted)',
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        {e.atendidos.map((a) => (
                          <span key={a}>· {a}</span>
                        ))}
                      </div>
                    )}
                  </Card>
                ))}
              </div>

              {/* A barra de páginas só aparece quando há mais de uma. Os números
                  do cartão acima falam de TODOS os pedidos; esta barra fala só
                  de onde o dono está olhando. */}
              {(n.podeVoltar || n.podeAvancar) && (
                <div
                  style={{
                    marginTop: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 14,
                  }}
                >
                  <button
                    type="button"
                    className="pn-btn g sm"
                    disabled={!n.podeVoltar}
                    onClick={() => irPara(pagina - 1)}
                  >
                    Anteriores
                  </button>
                  <span className="tt" style={{ color: 'var(--gl-faint)' }}>
                    {n.rotulo}
                  </span>
                  <button
                    type="button"
                    className="pn-btn g sm"
                    disabled={!n.podeAvancar}
                    onClick={() => irPara(pagina + 1)}
                  >
                    Seguintes
                  </button>
                </div>
              )}
            </>
          )
        }}
      </Estados>
    </>
  )
}
