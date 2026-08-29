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
import { ROTAS, enviarPedido } from './painel-api'
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
  const vis = filtro === 'todos' ? todos : todos.filter((p) => p.situacao === filtro)

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
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Situação</th>
                      <th>Andamento</th>
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
