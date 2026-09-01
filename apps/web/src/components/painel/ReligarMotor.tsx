'use client'
// O botão que RELIGA o motor sem sair do painel.
//
// Antes daqui, o painel mostrava o motor caído e mandava o dono para `/setup`.
// Ele clicou para religar o Codex, foi parar noutra tela e escreveu: "Serviço
// mal pensado." O caminho agora acontece no lugar onde ele clicou.
//
// Nada de fluxo novo: os controles e a máquina de estados são os MESMOS do
// passo 7 do assistente (components/setup/ControlesDeConexao.tsx +
// conexao-de-motor.ts). O que este arquivo acrescenta é só a roupa do painel,
// as frases em PT-BR e o que fazer quando o motor volta.
import { useEffect, useRef } from 'react'
import { API_BASE_URL } from '../../lib/api'
import { ControlesDeConexao } from '../setup/ControlesDeConexao'
import { useConexaoDeMotores } from '../setup/useConexaoDeMotores'
import type { LoginState } from '../setup/engine-status'
import {
  ESTILO_DO_PAINEL,
  motivoDeNaoReligar,
  ofereceReligar,
  textosDoPainel,
} from './religar-motor'
import type { MotorCota } from './painel-tipos'

/** A mesma frase do assistente (locales.ts, `setup.connectError`), em PT-BR:
 *  o painel não é traduzido, e duas frases diferentes para a mesma falha
 *  fariam o dono achar que são dois problemas. */
const ERRO_PADRAO = 'Não deu para conectar. Confira o que você colou e tente de novo.'

export function ReligarMotor({
  motor,
  aoConectar,
}: {
  motor: MotorCota
  /** Chamado UMA vez quando o motor volta: a tela relê a cota do servidor em
   *  vez de deduzir que agora está tudo bem. */
  aoConectar?: () => void
}) {
  const { estados, enviandoToken, conexao } = useConexaoDeMotores(API_BASE_URL, ERRO_PADRAO)
  const estado: LoginState = estados[motor.id] ?? { phase: 'idle' }
  const jaAvisou = useRef(false)

  useEffect(() => {
    if (estado.phase !== 'connected' || jaAvisou.current) return
    jaAvisou.current = true
    aoConectar?.()
  }, [estado.phase, aoConectar])

  if (!ofereceReligar(motor)) {
    const motivo = motivoDeNaoReligar(motor)
    // Controle ausente sem explicação parece defeito nosso, e o dono fica
    // procurando o que ele fez de errado.
    return motivo ? <p className="pn-casc-nota">{motivo}</p> : null
  }

  return (
    <div style={{ marginTop: 10 }}>
      {estado.phase === 'connected' ? (
        <p className="pn-casc-nota" role="status">
          {motor.nome} conectado agora. A cota volta a aparecer na próxima leitura.
        </p>
      ) : (
        <ControlesDeConexao
          conexao={conexao}
          id={motor.id}
          runtime={motor.id}
          estado={estado}
          enviandoToken={!!enviandoToken[motor.id]}
          textos={textosDoPainel(motor)}
          estilo={ESTILO_DO_PAINEL}
        />
      )}
    </div>
  )
}
