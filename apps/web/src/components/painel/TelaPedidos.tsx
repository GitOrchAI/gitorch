'use client'
// Pedidos: escrever em português o que precisa acontecer. O composer é AO VIVO
// (POST /api/v1/desejos, com as 7 frases de erro do produto); a lista de
// pedidos fica de exemplo nesta leva (não há rota para listar os desejos).
// Portado de TelaPedidos.jsx.
import { useState } from 'react'
import { DEMO } from './painel-demo'
import { ROTAS, enviarPedido } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Ad } from './PainelIcons'
import { Card, Estado, Chips, Tecnico, Cabeca } from './PainelUI'
import { Estados, SeloDemo } from './PainelEstados'

interface Projeto {
  id: string
  nome: string
  repo: string
}

type Prioridade = 'P0' | 'P1' | 'P2'
type Filtro = 'todos' | 'Em desenvolvimento' | 'Esperando você' | 'Travado' | 'Em produção'

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

  const enviar = async () => {
    if (!texto.trim()) {
      setAviso({ erro: 'Escreva o que precisa acontecer antes de pedir.' })
      return
    }
    setEnviando(true)
    setAviso(null)
    const alvo = repo || (projetos.estado === 'ok' && projetos.dados?.[0]?.id) || ''
    const r = await enviarPedido({ projectId: alvo, texto })
    setEnviando(false)
    if (r.ok) {
      setTexto('')
      setAviso({ numero: r.numero, endereco: r.endereco })
    } else {
      setAviso({ erro: r.erro })
    }
  }

  const filtros: [Filtro, string][] = [
    ['todos', 'Todos'],
    ['Em desenvolvimento', 'Em desenvolvimento'],
    ['Esperando você', 'Esperando você'],
    ['Travado', 'Travado'],
    ['Em produção', 'Em produção'],
  ]
  const vis = filtro === 'todos' ? DEMO.pedidos : DEMO.pedidos.filter((p) => p.sit === filtro)

  return (
    <>
      <Cabeca titulo="Pedidos">
        Escreva em português o que precisa acontecer no seu produto. O pedido é registrado
        oficialmente e a equipe de agentes parte dele.
      </Cabeca>

      <Card titulo="Novo pedido">
        <textarea
          className="ad-field"
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
            <span className="ad-label">Onde</span>
            <Estados
              r={projetos}
              o_que="a lista de projetos"
              vazio="Conclua o setup para ter um projeto que aceite pedidos."
            >
              {(lista) =>
                lista.length === 1 ? (
                  <div className="ad-field" style={{ color: 'var(--gl-muted)' }}>
                    {lista[0].nome}
                  </div>
                ) : (
                  <select
                    className="ad-field"
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
            <span className="ad-label">Urgência</span>
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
          <button className="ad-btn a" onClick={() => void enviar()} disabled={enviando}>
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
        sub={
          <>
            {vis.length} de {DEMO.pedidos.length}
            <SeloDemo mostrar />
          </>
        }
      >
        {vis.length === 0 ? (
          <div className="ad-empty">Nenhum pedido com essa situação.</div>
        ) : (
          <div className="ad-tw">
            <table>
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Urgência</th>
                  <th>Situação</th>
                  <th>Responsável</th>
                  <th>Previsão</th>
                </tr>
              </thead>
              <tbody>
                {vis.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.t}</b>
                      <div className="m">
                        #{p.id} · {p.repo} · pedido {p.quando}
                      </div>
                      <Tecnico>{p.tec}</Tecnico>
                    </td>
                    <td>
                      <span className={'ad-tag ' + p.pri.toLowerCase()}>{p.pri}</span>
                    </td>
                    <td className="ad-nowrap">
                      <Estado d={p.d}>{p.sit}</Estado>
                    </td>
                    <td className="ad-nowrap">{p.resp}</td>
                    <td className="ad-nowrap" style={{ color: 'var(--gl-muted)' }}>
                      {p.prev}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
