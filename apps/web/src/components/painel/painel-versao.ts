// A versão que está no ar, para o rodapé do painel. A rota é pública; o texto
// só afirma o que o servidor informou e, sem informação, diz que não sabe.

import { pedir, ROTAS, type PedirDeps } from './painel-api'

export interface VersaoNoAr {
  commit: string
  noArDesde: string
}

const NAO_INFORMADA = 'Versão no ar: não informada'

export async function buscarVersaoNoAr(deps: PedirDeps = {}): Promise<VersaoNoAr | null> {
  try {
    const corpo = await pedir<Partial<VersaoNoAr>>(ROTAS.versao, {}, deps)
    if (typeof corpo?.commit !== 'string' || typeof corpo.noArDesde !== 'string') return null
    return { commit: corpo.commit, noArDesde: corpo.noArDesde }
  } catch {
    return null
  }
}

export function textoDaVersaoNoAr(versao: VersaoNoAr | null): string {
  if (!versao || versao.commit === 'desconhecido' || versao.commit === '') return NAO_INFORMADA
  const curto = versao.commit.slice(0, 7)
  const quando = new Date(versao.noArDesde)
  if (Number.isNaN(quando.getTime())) return `Versão no ar: ${curto}`
  const data = quando.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `Versão no ar: ${curto} · desde ${data}`
}
