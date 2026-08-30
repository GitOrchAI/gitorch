'use client'
// Pedidos: escrever em português o que precisa acontecer, e acompanhar o que
// já foi pedido. Os DOIS lados são ao vivo agora: o composer manda
// (POST /api/v1/desejos, com as 7 frases de erro do produto) e a lista lê de
// volta (GET /api/v1/painel/pedidos), com a árvore que o Produto pendurou.
//
// A tabela mostra SÓ o que existe de verdade. O desenho original tinha colunas
// de urgência, responsável e previsão; nenhuma delas tem fonte hoje, e coluna
// inventada é pior que coluna faltando. Elas voltam quando houver de onde ler.
// Portado de TelaPedidos.jsx.
import { useState, useSyncExternalStore } from 'react'
import { ROTAS, enviarPedido, pedir } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { assinarProjeto, projetoAtual, projetoNoServidor, filtroDeProjeto } from './painel-projeto'
import { Ad } from './PainelIcons'
import { Card, Estado, Chips, Cabeca } from './PainelUI'
import { Estados } from './PainelEstados'

/** Um pedido como a rota devolve (espelha PedidoDoPainel do control-plane). */
interface PedidoView {
  numero: number
  titulo: string
  situacao: 'andando' | 'entregue'
  projeto: string
  quando: string
  endereco: string
  partes: { total: number; concluidas: number }
}

/** "há 3 dias" a partir do ISO — o dono lê tempo, não data. */
function quandoLegivel(iso: string): string {
  if (!iso) return ''
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (dias < 1) return 'hoje'
  if (dias === 1) return 'ontem'
  if (dias < 30) return `há ${dias} dias`
  const meses = Math.floor(dias / 30)
  return meses === 1 ? 'há 1 mês' : `há ${meses} meses`
}

/**
 * O andamento em palavras. Um desejo com 0 partes NÃO está em 0% — ele ainda
 * não foi quebrado em fases, e dizer "0%" faria o dono achar que o trabalho
 * está parado quando na verdade nem começou a ser planejado.
 */
function andamentoLegivel(p: PedidoView): string {
  if (p.situacao === 'entregue') return 'entregue'
  if (p.partes.total === 0) return 'ainda sendo planejado'
  return `${p.partes.concluidas} de ${p.partes.total} partes prontas`
}

interface Projeto {
  id: string
  nome: string
  repo: string
}

type Prioridade = 'P0' | 'P1' | 'P2'
type Filtro = 'todos' | 'andando' | 'entregue'

export function TelaPedidos() {
  const [texto, setTexto] = useState('')
  const [repo, setRepo] = useState('')
  const [pri, setPri] = useState<Prioridade>('P1')
  const [enviando, setEnviando] = useState(false)
  // A ordem que o dono está montando na tela. `null` enquanto ele não mexeu —
  // e é essa diferença que impede o painel de mandar uma ordem que ninguém
  // pediu só porque a tela desenhou uma.
  const [ordem, setOrdem] = useState<number[] | null>(null)
  const [salvandoOrdem, setSalvandoOrdem] = useState(false)
  const [avisoDaOrdem, setAvisoDaOrdem] = useState<string | null>(null)

  const [aviso, setAviso] = useState<{ numero?: number; endereco?: string; erro?: string } | null>(
    null
  )
  const [filtro, setFiltro] = useState<Filtro>('todos')

  // Mesma regra do envio: GET /api/v1/desejos/projetos — é o que impede a tela
  // de oferecer um projeto que o servidor recusaria.
  const projetos = usePainelBusca<
    Projeto[],
    { projetos?: { id: string; nome: string; repo: string }[] }
  >(ROTAS.projetos, {
    mapear: (b) => (b.projetos ?? []).map((x) => ({ id: x.id, nome: x.nome, repo: x.repo })),
    vazio: (d) => d.length === 0,
  })

  const lista = projetos.estado === 'ok' && projetos.dados ? projetos.dados : []

  const enviar = async () => {
    if (!texto.trim()) {
      setAviso({ erro: 'Escreva o que precisa acontecer antes de pedir.' })
      return
    }
    // Com um projeto só, ele já vem escolhido. Com vários, o dono precisa
    // escolher — nunca cair no primeiro em silêncio (issue no repo errado).
    const alvo = lista.length === 1 ? lista[0].id : repo
    if (!alvo) {
      setAviso({ erro: 'Escolha em qual projeto o pedido deve entrar.' })
      return
    }
    setEnviando(true)
    setAviso(null)
    const r = await enviarPedido({ projectId: alvo, texto })
    setEnviando(false)
    if (r.ok) {
      setTexto('')
      setAviso({ numero: r.numero, endereco: r.endereco })
    } else {
      setAviso({ erro: r.erro })
    }
  }

  // Só os estados que a fonte realmente distingue. Um filtro que nunca casa é
  // pior que filtro nenhum: o dono clica e a lista some sem explicação.
  const filtros: [Filtro, string][] = [
    ['todos', 'Todos'],
    ['andando', 'Andando'],
    ['entregue', 'Entregues'],
  ]
  // O projeto escolhido no topo vale aqui: o dono vê todos os projetos ou um.
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const r = usePainelBusca<PedidoView[], { pedidos?: PedidoView[] }>(
    ROTAS.pedidos + filtroDeProjeto(projeto),
    { mapear: (b) => b.pedidos ?? [], vazio: (d) => d.length === 0 }
  )
  const todos = r.estado === 'ok' && r.dados ? r.dados : []
  const filtrados = filtro === 'todos' ? todos : todos.filter((p) => p.situacao === filtro)

  // Se o dono já mexeu na ordem, a tela mostra a ordem DELE. Enquanto não
  // mexeu, mostra a que veio do servidor.
  const vis =
    ordem === null
      ? filtrados
      : [...filtrados].sort((a, b) => {
          const ia = ordem.indexOf(a.numero)
          const ib = ordem.indexOf(b.numero)
          // Pedido que não está na ordem montada fica no fim, na ordem que veio
          // — nunca some da tela por causa de uma reordenação.
          return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib)
        })

  /** Sobe ou desce um pedido na ordem que o dono está montando. */
  const mover = (numero: number, passo: -1 | 1) => {
    const base = (ordem ?? vis.map((p) => p.numero)).slice()
    const i = base.indexOf(numero)
    const destino = i + passo
    if (i < 0 || destino < 0 || destino >= base.length) return
    ;[base[i], base[destino]] = [base[destino]!, base[i]!]
    setOrdem(base)
    setAvisoDaOrdem(null)
  }

  /** Manda a ordem para o GitHub. Só o projeto escolhido — a ordem é DO quadro. */
  const salvarOrdem = async () => {
    if (!ordem || !projeto) return
    setSalvandoOrdem(true)
    try {
      const r2 = await pedir<{ oQueFiz: string; foraDoQuadro?: number[] }>(ROTAS.ordem, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projeto, pedidos: ordem }),
      })
      // O que ficou de fora vai DITO. "Pronto" com cinco de sete aplicados
      // faria o dono achar que a ordem inteira valeu.
      const sobra = r2.foraDoQuadro?.length
        ? ` ${r2.foraDoQuadro.length} pedido(s) não estão no quadro e ficaram como estavam.`
        : ''
      setAvisoDaOrdem(r2.oQueFiz + sobra)
      setOrdem(null)
      r.recarregar()
    } catch (e) {
      const erro = e as { status?: number; message?: string }
      setAvisoDaOrdem(
        erro.status === 403
          ? (erro.message ?? 'Você não me autorizou a mexer no seu quadro.')
          : 'Não consegui salvar a ordem. Nada mudou no seu quadro.'
      )
    } finally {
      setSalvandoOrdem(false)
    }
  }

  return (
    <>
      <Cabeca titulo="Pedidos">
        Escreva em português o que precisa acontecer no seu produto. O pedido é registrado
        oficialmente e a equipe de agentes parte dele.
      </Cabeca>

      <Card titulo="Novo pedido">
        <textarea
          className="pn-field"
          rows={3}
          value={texto}
          maxLength={60000}
          onChange={(e) => {
            setTexto(e.target.value)
            setAviso(null)
          }}
          placeholder="Quando um pagamento falhar duas vezes, quero avisar o cliente por e-mail."
        />
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 18 }}>
          <div style={{ minWidth: 210, flex: 1 }}>
            <span className="pn-label">Onde</span>
            <Estados
              r={projetos}
              o_que="a lista de projetos"
              vazio="Conclua o setup para ter um projeto que aceite pedidos."
            >
              {(lista) =>
                lista.length === 1 ? (
                  <div className="pn-field" style={{ color: 'var(--gl-muted)' }}>
                    {lista[0].nome}
                  </div>
                ) : (
                  <select
                    className="pn-field"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                  >
                    <option value="">—</option>
                    {lista.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
                )
              }
            </Estados>
          </div>
          <div>
            <span className="pn-label">Urgência</span>
            <Chips
              valor={pri}
              onChange={setPri}
              opcoes={[
                ['P0', 'P0 · para ontem'],
                ['P1', 'P1 · esta semana'],
                ['P2', 'P2 · quando der'],
              ]}
            />
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
            marginTop: 20,
          }}
        >
          <button className="pn-btn a" onClick={() => void enviar()} disabled={enviando}>
            <Ad n="spark" s={16} />
            {enviando ? 'Registrando…' : 'Pedir'}
          </button>
          {aviso?.numero != null && (
            <span style={{ fontSize: 13.5, color: 'var(--gl-accent-ink)' }}>
              Registrado como pedido #{aviso.numero}.
              {aviso.endereco && aviso.endereco !== '#' ? (
                <>
                  {' '}
                  <a
                    href={aviso.endereco}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: 'underline' }}
                  >
                    Ver no GitHub
                  </a>
                </>
              ) : null}
            </span>
          )}
          {aviso?.erro && (
            <span style={{ fontSize: 13.5, color: 'var(--gl-sev)' }}>{aviso.erro}</span>
          )}
        </div>
      </Card>

      <Chips valor={filtro} onChange={setFiltro} opcoes={filtros} />

      <Card
        flush
        titulo="Todos os pedidos"
        sub={r.estado === 'ok' ? `${vis.length} de ${todos.length}` : null}
      >
        <Estados
          r={r}
          o_que="seus pedidos"
          vazio="Você ainda não fez nenhum pedido. Escreva um aí em cima."
        >
          {() =>
            vis.length === 0 ? (
              <div className="pn-empty">Nenhum pedido nessa situação.</div>
            ) : (
              <div className="pn-tw">
                <table>
                  <caption style={{ captionSide: 'top', textAlign: 'left', padding: '0 0 10px' }}>
                    {ordem !== null && (
                      <>
                        <button
                          className="pn-btn a sm"
                          data-testid="salvar-ordem"
                          disabled={salvandoOrdem}
                          onClick={() => void salvarOrdem()}
                        >
                          {salvandoOrdem ? 'Salvando…' : 'Salvar esta ordem no seu quadro'}
                        </button>{' '}
                        <button
                          className="pn-btn g sm"
                          disabled={salvandoOrdem}
                          onClick={() => {
                            setOrdem(null)
                            setAvisoDaOrdem(null)
                          }}
                        >
                          Desfazer
                        </button>
                      </>
                    )}
                    {avisoDaOrdem && (
                      <span style={{ fontSize: 13, color: 'var(--gl-muted)' }}>{avisoDaOrdem}</span>
                    )}
                  </caption>
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Situação</th>
                      <th>Andamento</th>
                      {/* A ordem é DO quadro de um projeto. Com "todos os
                          projetos" não há um quadro para reordenar, e a coluna
                          não aparece em vez de aparecer sem funcionar. */}
                      {projeto && <th>Ordem</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {vis.map((p) => (
                      <tr key={`${p.projeto}#${p.numero}`}>
                        <td>
                          <b>{p.titulo}</b>
                          <div className="m">
                            {p.projeto} · pedido {quandoLegivel(p.quando)}
                          </div>
                        </td>
                        <td className="pn-nowrap">
                          <Estado d={p.situacao === 'entregue' ? 'g' : ''}>
                            {p.situacao === 'entregue' ? 'Entregue' : 'Andando'}
                          </Estado>
                        </td>
                        <td className="pn-nowrap" style={{ color: 'var(--gl-muted)' }}>
                          {andamentoLegivel(p)}
                        </td>
                        {projeto && (
                          <td className="pn-nowrap">
                            <button
                              className="pn-btn g sm"
                              aria-label={`Subir o pedido ${p.numero}`}
                              data-testid={`subir-${p.numero}`}
                              disabled={salvandoOrdem}
                              onClick={() => mover(p.numero, -1)}
                            >
                              ↑
                            </button>{' '}
                            <button
                              className="pn-btn g sm"
                              aria-label={`Descer o pedido ${p.numero}`}
                              data-testid={`descer-${p.numero}`}
                              disabled={salvandoOrdem}
                              onClick={() => mover(p.numero, 1)}
                            >
                              ↓
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Estados>
      </Card>
    </>
  )
}
