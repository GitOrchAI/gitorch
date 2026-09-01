'use client'
// A cola de React em volta da loja de conexão (conexao-de-motor.ts).
//
// Fina de propósito: a decisão toda mora na loja, que é testada em node. Aqui
// só existe o que React exige — assinar a loja, entregar o instantâneo e
// fechar os streams quando a tela sai do ar.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  criarConexaoDeMotores,
  type ConexaoDeMotores,
  type InstantaneoDeConexao,
} from './conexao-de-motor'

/** No servidor (SSR) não há loja nem login: instantâneo vazio e estável. */
const VAZIO: InstantaneoDeConexao = { estados: {}, enviandoToken: {} }

export interface ConexaoEmTela extends InstantaneoDeConexao {
  conexao: ConexaoDeMotores
}

export function useConexaoDeMotores(apiBaseUrl: string, erroPadrao: string): ConexaoEmTela {
  // A frase de erro é lida NA HORA por uma ref: se ela entrasse nas dependências
  // da loja, trocar de idioma no meio de um login recriaria tudo e a pessoa
  // perderia a conexão pela metade.
  const frase = useRef(erroPadrao)
  frase.current = erroPadrao

  const conexao = useMemo(
    () => criarConexaoDeMotores({ apiBaseUrl, erroPadrao: () => frase.current }),
    [apiBaseUrl]
  )

  // Sair da tela fecha os streams abertos — sem isto, cada visita ao painel
  // deixaria uma conexão SSE viva atrás de si.
  useEffect(() => () => conexao.encerrar(), [conexao])

  const instantaneo = useSyncExternalStore(conexao.inscrever, conexao.instantaneo, () => VAZIO)
  return { ...instantaneo, conexao }
}
