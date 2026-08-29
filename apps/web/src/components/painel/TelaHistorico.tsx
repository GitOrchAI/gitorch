'use client'
// Histórico: tudo que aconteceu, com quem fez e a evidência de que terminou.
// Imutável — nada aqui pode ser editado. /painel/historico é leva 2; nesta
// leva a tela mostra o exemplo com selo. Portado de TelaAuditoria.jsx.
import { useState } from 'react'
import { DEMO } from './painel-demo'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'
import { Cabeca, Card, Chips, Tecnico } from './PainelUI'
import { Estados, SeloDemo } from './PainelEstados'

interface EventoView {
  quando: string
  quem: string
  o_que: string
  ev: string
  tec: string
}

export function TelaHistorico() {
  const [quem, setQuem] = useState('todos')
  const r = usePainelBusca<{ eventos: EventoView[] }, { eventos?: Record<string, unknown>[] }>(
    ROTAS.historico,
    {
      demo: { eventos: DEMO.auditoria.map((e) => ({ ...e })) },
      exemploQuandoAusente: true,
      mapear: (b) => ({
        eventos: (b.eventos ?? []).map((x) => ({
          quando: String(x['quando'] ?? ''),
          quem: String(x['quem'] ?? ''),
          o_que: String(x['o_que'] ?? ''),
          ev: String(x['evidencia'] ?? x['ev'] ?? ''),
          tec: String(x['tecnico'] ?? x['tec'] ?? ''),
        })),
      }),
      vazio: (d) => d.eventos.length === 0,
    }
  )

  const todos = r.estado === 'ok' && r.dados ? r.dados.eventos : []
  const nomes = ['todos', ...Array.from(new Set(todos.map((x) => x.quem)))]
  const lista = quem === 'todos' ? todos : todos.filter((x) => x.quem === quem)

  return (
    <>
      <Cabeca titulo="Histórico">
        Tudo que aconteceu, com quem fez e a evidência de que terminou. Serve para você conferir
        depois — nada aqui pode ser editado.
      </Cabeca>

      {nomes.length > 1 && (
        <Chips
          valor={quem}
          onChange={setQuem}
          opcoes={nomes.map((n) => [n, n === 'todos' ? 'Todos' : n] as [string, string])}
        />
      )}

      <Card
        flush
        titulo="Registro"
        sub={
          <>
            {r.estado === 'ok' ? `${lista.length} eventos` : null}
            <SeloDemo mostrar={!!r.demo} />
          </>
        }
      >
        <Estados r={r} o_que="o histórico" vazio="Nada registrado ainda.">
          {() => (
            <div className="pn-tw">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Quem</th>
                    <th>O que fez</th>
                    <th>Evidência</th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((a, i) => (
                    <tr key={i}>
                      <td className="pn-nowrap tt" style={{ color: 'var(--gl-faint)' }}>
                        {a.quando}
                      </td>
                      <td className="pn-nowrap">
                        <b style={{ display: 'inline' }}>{a.quem}</b>
                      </td>
                      <td>
                        {a.o_que}
                        <Tecnico>{a.tec}</Tecnico>
                      </td>
                      <td style={{ color: 'var(--gl-muted)' }}>{a.ev}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Estados>
      </Card>
    </>
  )
}
