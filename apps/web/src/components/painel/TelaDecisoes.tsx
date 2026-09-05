'use client'
// Decisões: quando um agente precisa de uma escolha sua, ele para e pergunta
// aqui. Responder destrava o trabalho na hora — pelo painel OU pelo Telegram
// (D70, 02/09): quem responde primeiro fecha o outro canal. Portado de
// TelaDecisoes.jsx. Dados AO VIVO (fetchAgentQuestions, reusado); responder AO
// VIVO (POST /painel/decisoes/:id/responder).
//
// QUATRO SEÇÕES (D69/D70, 02/09 — pedido literal do dono): as abertas (com
// botões e o campo de escrever), as já respondidas por você, as que o time
// assumiu por conta própria quando você não respondeu, e — a novidade do D69
// — as respostas que o time deu ao DESENVOLVEDOR em seu nome, com um botão de
// corrigir cada uma.
import { useState } from 'react'
import { Ad } from './PainelIcons'
import { Card, Chips, Cabeca, Decisao, type DecisaoView } from './PainelUI'
import type { RespostaAoDevView } from './respostas-ao-dev'

type FiltroDecisoes = 'pendente' | 'respondida' | 'assumida' | 'respostas-ao-dev'

export function TelaDecisoes({
  decisoes,
  responder,
  aviso,
  foco,
  setFoco,
  respostasAoDev,
  lacunaRespostasAoDev,
  corrigirRespostaAoDev,
}: {
  decisoes: DecisaoView[]
  responder: (id: string, resposta: string) => void
  /** frase de erro do último envio (ex.: 409 já respondida pelo Telegram) */
  aviso: string | null
  foco: string | null
  setFoco: (id: string) => void
  /** D69: o que o time respondeu ao dev em nome do dono. */
  respostasAoDev: RespostaAoDevView[]
  /** D69: a lacuna, escrita pelo SERVIDOR (nunca inventada aqui). */
  lacunaRespostasAoDev: string
  /** D69: corrige uma resposta dada ao dev — vira um comentário novo na tarefa. */
  corrigirRespostaAoDev: (id: string, texto: string) => void
}) {
  const [filtro, setFiltro] = useState<FiltroDecisoes>('pendente')
  const pend = decisoes.filter((d) => d.st === 'pendente')
  const respondidas = decisoes.filter((d) => d.st === 'respondida')
  const assumidas = decisoes.filter((d) => d.st === 'assumida')

  const lista =
    filtro === 'pendente'
      ? pend
      : filtro === 'respondida'
        ? respondidas
        : filtro === 'assumida'
          ? assumidas
          : []
  const sel =
    filtro === 'respostas-ao-dev' ? undefined : (decisoes.find((d) => d.id === foco) ?? lista[0])

  return (
    <>
      <Cabeca titulo="Decisões">
        Quando um agente precisa de uma escolha sua, ele para e pergunta aqui. Responder destrava o
        trabalho na hora, pelo painel ou pelo Telegram — quem você responder primeiro vale, e o
        outro canal fecha.
      </Cabeca>

      {aviso && (
        <div className="pn-pulse cold">
          <Ad n="alert" s={16} />
          <span>{aviso}</span>
        </div>
      )}

      <Chips
        valor={filtro}
        onChange={setFiltro}
        opcoes={[
          ['pendente', 'Esperando você' + (pend.length ? ' · ' + pend.length : '')],
          ['respondida', 'Respondidas' + (respondidas.length ? ' · ' + respondidas.length : '')],
          ['assumida', 'Suposições do time' + (assumidas.length ? ' · ' + assumidas.length : '')],
          [
            'respostas-ao-dev',
            'Respondemos ao dev' + (respostasAoDev.length ? ' · ' + respostasAoDev.length : ''),
          ],
        ]}
      />

      {filtro === 'respostas-ao-dev' ? (
        <TelaRespostasAoDev
          itens={respostasAoDev}
          lacuna={lacunaRespostasAoDev}
          corrigir={corrigirRespostaAoDev}
        />
      ) : (
        <div className="pn-md">
          <Card flush>
            {lista.length === 0 ? (
              <div className="pn-empty">
                {filtro === 'pendente' ? 'Nada esperando por você agora.' : 'Nada por aqui.'}
              </div>
            ) : (
              lista.map((d) => (
                <button
                  key={d.id}
                  className={'pn-row' + (sel && sel.id === d.id ? ' on' : '')}
                  style={{ alignItems: 'flex-start' }}
                  onClick={() => setFoco(d.id)}
                >
                  <span className="pn-grow">
                    <span
                      className="pn-rt"
                      style={{
                        display: 'block',
                        whiteSpace: 'normal',
                        color: d.st === 'pendente' ? 'var(--gl-ink)' : 'var(--gl-muted)',
                      }}
                    >
                      {d.q}
                    </span>
                    <span className="pn-rs">
                      {d.agente} · {d.quando}
                    </span>
                  </span>
                  {d.st === 'pendente' ? (
                    <span className="pn-d wait" style={{ marginTop: 6 }} />
                  ) : (
                    <span style={{ color: 'var(--gl-accent-ink)', flex: 'none', marginTop: 2 }}>
                      <Ad n="check" s={15} />
                    </span>
                  )}
                </button>
              ))
            )}
          </Card>

          <Card flush>
            {!sel ? (
              <div className="pn-empty">Escolha uma decisão.</div>
            ) : (
              <Decisao d={sel} responder={responder} />
            )}
          </Card>
        </div>
      )}
    </>
  )
}

/**
 * D69 (02/09) — a novidade: o dono corrigiu que faltava ver, no painel, o que
 * o time respondeu ao DEV em nome dele (diferente de "assumida": ali o dono
 * foi perguntado e não respondeu; aqui o time NUNCA chegou a perguntar,
 * resolveu sozinho). LACUNA HONESTA sempre visível: o produto não guarda o
 * texto exato enviado ao dev, só um resumo aprendido — a frase abaixo vem do
 * SERVIDOR (control-plane/routes/painel.ts, LACUNA_RESPOSTAS_AO_DEV), nunca
 * inventada aqui.
 */
function TelaRespostasAoDev({
  itens,
  lacuna,
  corrigir,
}: {
  itens: RespostaAoDevView[]
  lacuna: string
  corrigir: (id: string, texto: string) => void
}) {
  return (
    <div className="pn-md" style={{ display: 'block' }}>
      {lacuna && (
        <div className="pn-pulse cold" style={{ marginBottom: 12 }}>
          <Ad n="alert" s={16} />
          <span>{lacuna}</span>
        </div>
      )}
      <Card flush>
        {itens.length === 0 ? (
          <div className="pn-empty">
            Nenhuma resposta registrada por aqui ainda — ou o produto ainda não gravou nenhuma de
            forma consultável (veja o aviso acima).
          </div>
        ) : (
          itens.map((item) => <ItemRespostaAoDev key={item.id} item={item} corrigir={corrigir} />)
        )}
      </Card>
    </div>
  )
}

function ItemRespostaAoDev({
  item,
  corrigir,
}: {
  item: RespostaAoDevView
  corrigir: (id: string, texto: string) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [texto, setTexto] = useState('')

  return (
    <article className="pn-ask" style={{ borderTop: '1px solid var(--gl-hair)' }}>
      <div className="who">
        {item.projeto ?? 'Projeto removido'}
        {item.issueNumber ? ` · tarefa #${item.issueNumber}` : ''} ·{' '}
        {new Date(item.quando).toLocaleString('pt-BR')}
      </div>
      <p className="q" style={{ fontWeight: 400 }}>
        {item.resumo}
      </p>

      {item.corrigidoEm ? (
        <div className="pn-answered">
          <span className="pn-label" style={{ color: 'var(--gl-accent-ink)' }}>
            Você já corrigiu isto
          </span>
          <span className="pn-rs" style={{ display: 'block', marginTop: 4 }}>
            Corrigido em {new Date(item.corrigidoEm).toLocaleString('pt-BR')} — a correção virou um
            comentário na tarefa.
          </span>
        </div>
      ) : aberto ? (
        <div style={{ marginTop: 12 }}>
          <textarea
            className="pn-field"
            rows={3}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="O que o time respondeu está errado ou incompleto? Escreva a correção — ela vira um comentário novo na tarefa, endereçado ao dev."
          />
          <button
            className="pn-btn a sm"
            style={{ marginTop: 10 }}
            disabled={!texto.trim() || !item.issueNumber}
            onClick={() => {
              corrigir(item.id, texto.trim())
              setTexto('')
              setAberto(false)
            }}
          >
            <Ad n="send" s={14} />
            Corrigir
          </button>
          {!item.issueNumber && (
            <span className="pn-rs" style={{ display: 'block', marginTop: 6 }}>
              Este registro não tem uma tarefa vinculada — não dá para comentar.
            </span>
          )}
        </div>
      ) : (
        <div className="pn-qb" style={{ marginTop: 10 }}>
          <button className="pn-q" onClick={() => setAberto(true)}>
            <Ad n="refresh" s={14} />
            Corrigir
          </button>
        </div>
      )}
    </article>
  )
}
