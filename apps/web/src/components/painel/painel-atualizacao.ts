// A faixa "atualização em andamento" do painel. A rota só diz se a trava de
// entrega está ligada e desde quando; o texto afirma só isso e, sem resposta,
// não mostra nada (nunca inventa uma atualização).

import { pedir, ROTAS, type PedirDeps } from './painel-api'

export interface AtualizacaoEmAndamento {
  ligada: boolean
  desde: string | null
}

export async function buscarAtualizacao(
  deps: PedirDeps = {}
): Promise<AtualizacaoEmAndamento | null> {
  try {
    const corpo = await pedir<Partial<AtualizacaoEmAndamento>>(ROTAS.atualizacao, {}, deps)
    if (typeof corpo?.ligada !== 'boolean') return null
    return { ligada: corpo.ligada, desde: typeof corpo.desde === 'string' ? corpo.desde : null }
  } catch {
    return null
  }
}

const COMPLEMENTO = 'Trabalho novo começa assim que terminar.'

export function textoDaAtualizacao(
  estado: AtualizacaoEmAndamento | null,
  opcoes: { fusoHorario?: string } = {}
): string | null {
  if (!estado || !estado.ligada) return null
  const quando = estado.desde ? new Date(estado.desde) : null
  if (!quando || Number.isNaN(quando.getTime())) {
    return `Atualização em andamento. ${COMPLEMENTO}`
  }
  const hora = quando.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(opcoes.fusoHorario ? { timeZone: opcoes.fusoHorario } : {}),
  })
  return `Atualização em andamento desde ${hora}. ${COMPLEMENTO}`
}
