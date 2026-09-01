'use client'
// OS CONTROLES da conexão de motor — os mesmos no assistente e no painel.
//
// Vieram, fase por fase, do card do passo 7 do assistente (StepConnectEngine).
// Não foram copiados para o painel: foram MOVIDOS para cá e passaram a servir
// aos dois. Uma cópia divergiria na primeira mudança, e a cópia que ninguém
// olha é a que mente para o dono.
//
// Aqui mora só o que a fase manda desenhar. A moldura de cada tela — o card do
// assistente com ícone e selo "Conectado", ou a linha de cota do painel —
// continua com quem chama.
import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import {
  classifyConnectError,
  isManualAccordionVisible,
  looksLikeAuthCode,
  type LoginState,
} from './engine-status'
import type { EstiloDeConexao, TextosDeConexao } from './conexao-textos'
import type { ConexaoDeMotores } from './conexao-de-motor'

export interface ControlesDeConexaoProps {
  /** A loja compartilhada do fluxo (conexao-de-motor.ts). */
  conexao: ConexaoDeMotores
  /** A chave deste card na loja. */
  id: string
  /** O runtime como o servidor o conhece. */
  runtime: string
  estado: LoginState
  enviandoToken: boolean
  textos: TextosDeConexao
  estilo: EstiloDeConexao
}

export function ControlesDeConexao({
  conexao,
  id,
  runtime,
  estado,
  enviandoToken,
  textos,
  estilo,
}: ControlesDeConexaoProps) {
  // O que a pessoa está DIGITANDO é deste card e de mais ninguém — nunca vai
  // para a loja, que guarda só o que veio do servidor.
  const [codigoDigitado, setCodigoDigitado] = useState('')
  const [tokenDigitado, setTokenDigitado] = useState('')
  const [manualPedido, setManualPedido] = useState(false)
  const conectado = estado.phase === 'connected'

  const aoConectar = () => void conexao.conectar(id, runtime)
  const aoEnviarCodigo = () => void conexao.enviarCodigo(id, codigoDigitado)
  const aoEnviarToken = () => void conexao.enviarToken(id, runtime, tokenDigitado)
  const aoDigitarCodigo = setCodigoDigitado
  const aoDigitarToken = setTokenDigitado
  const aoPedirManual = () => setManualPedido(true)

  return (
    <>
      {estado.phase === 'idle' && (
        <button className={estilo.botao} onClick={aoConectar}>
          {textos.conectar}
        </button>
      )}

      {/* O motor ESTAVA conectado e venceu. Print do dono (26/08): o card
          mostrava "Conectado" em verde enquanto toda missão morria por
          credencial — e uma tela verde não oferece nada para clicar. Aqui ele
          vê o que houve e religa no mesmo lugar, pelo MESMO botão do primeiro
          login. Sem dicas de token: não houve tentativa de conectar que tenha
          falhado; uma conexão boa simplesmente venceu. */}
      {estado.phase === 'precisa_religar' && (
        <div className="space-y-2">
          <p className={estilo.erro}>{textos.precisaReligarTitulo}</p>
          <p className={estilo.texto} style={{ fontSize: '0.78rem' }}>
            {textos.precisaReligarDesc}
          </p>
          <button className={estilo.botao} onClick={aoConectar}>
            {textos.religar}
          </button>
        </div>
      )}

      {estado.phase === 'starting' && (
        <span className={`${estilo.texto} inline-flex items-center gap-2`}>
          <Loader2 className="animate-spin" size={16} /> {textos.conectando}
        </span>
      )}

      {estado.phase === 'verifying' && (
        <span className={`${estilo.texto} inline-flex items-center gap-2`}>
          <Loader2 className="animate-spin" size={16} /> {textos.verificando}
        </span>
      )}

      {estado.phase === 'url_ready' && (
        <div className="space-y-3">
          <a
            className={`${estilo.botao} inline-flex items-center gap-2`}
            href={estado.url}
            target="_blank"
            rel="noreferrer"
          >
            {textos.abrirLink} <ExternalLink size={14} />
          </a>
          {estado.code && (
            <div className={estilo.codigo}>
              <code>{estado.code}</code>
            </div>
          )}
          {!estado.code && (
            <div className="flex items-center gap-2">
              <input
                className={estilo.campo}
                type="text"
                placeholder={textos.placeholderCodigo}
                value={codigoDigitado}
                onChange={(e) => aoDigitarCodigo(e.target.value)}
              />
              <button
                className={estilo.botao}
                style={{ flex: 'none' }}
                disabled={!codigoDigitado.trim()}
                onClick={aoEnviarCodigo}
              >
                {textos.enviarCodigo}
              </button>
            </div>
          )}
          <p className={estilo.texto}>{textos.aguardandoAprovacao}</p>
        </div>
      )}

      {estado.phase === 'error' && (
        <div className="space-y-2">
          <p className={estilo.erro}>{estado.message}</p>
          {/* Acionável por tipo: aponta o paste manual (que abre sozinho logo
              abaixo no erro) em vez de só "tente de novo". Exceção: se o que
              está no campo de token TEM CARA do código da página (a
              dupla-colagem real, 18/07), a dica aponta o campo certo em vez de
              repetir "esperado sk-ant-oat". */}
          <p className={estilo.texto} style={{ fontSize: '0.76rem' }}>
            {looksLikeAuthCode(tokenDigitado, runtime)
              ? textos.pareceCodigo
              : textos.dicaDeErro(classifyConnectError(estado.message))}
          </p>
          <button className={estilo.botao} onClick={aoConectar}>
            {textos.conectar}
          </button>
        </div>
      )}

      {/* Rede de segurança: paste manual do token/credencial que o CLI gerou.
          NUNCA visível "de graça" ao lado do campo de código durante url_ready
          (era isso que causava a dupla-colagem, 18/07: o código da página de
          autorização ia parar no campo de token errado). Só existe de verdade
          quando o login assistido falhou (abre sozinho) ou a pessoa pediu pelo
          link discreto abaixo. */}
      {!conectado && isManualAccordionVisible(estado.phase, manualPedido) && (
        <div
          className="mt-3 rounded-xl"
          style={{ background: 'var(--gl-surface-2)', border: '1px solid var(--gl-hair)' }}
        >
          <div className="space-y-2 px-3 py-3">
            <p className={estilo.texto} style={{ fontSize: '0.76rem' }}>
              {runtime === 'claude' ? textos.dicaManualEnv : textos.dicaManualArquivo}
            </p>
            <textarea
              className={estilo.campo}
              rows={3}
              placeholder={textos.placeholderToken}
              value={tokenDigitado}
              onChange={(e) => aoDigitarToken(e.target.value)}
            />
            <button
              className={estilo.botao}
              disabled={!tokenDigitado.trim() || enviandoToken}
              onClick={aoEnviarToken}
            >
              {enviandoToken ? textos.conectando : textos.enviarToken}
            </button>
          </div>
        </div>
      )}

      {/* Link discreto: só aparece quando o accordion está escondido — é a
          única forma de abri-lo fora da fase de erro. */}
      {!conectado && !isManualAccordionVisible(estado.phase, manualPedido) && (
        <button
          type="button"
          className={estilo.linkDiscreto}
          style={{ marginTop: 10 }}
          onClick={aoPedirManual}
        >
          {textos.abrirManual}
        </button>
      )}
    </>
  )
}
