// Quem entra na fila do dev assíncrono neste ciclo.
//
// Decisão pura: sem rede, sem banco. Recebe o que já foi lido e devolve os
// números das issues a delegar.
//
// Antes disto a fila era "issue que ainda NÃO tem a etiqueta de delegação".
// Medido em produção: as issues #46, #47 e #48 foram delegadas, o trabalho
// morreu dentro da sessão, e como as três carregavam a etiqueta elas NUNCA
// voltaram para a fila — morreram em silêncio. A etiqueta é irreversível na
// prática; a linha da sessão não é: sessão fechada sem merge devolve a issue
// para a fila no ciclo seguinte.
//
// Os tetos vêm do plano declarado pelo dono porque a API NÃO oferece consulta
// de cota (verificado: não existe endpoint de quota).

import type { LinhaDeSessao } from './dev-session-store.js'

export interface IssueCandidata {
  number: number
  /** Quantos "Blocked by" desta issue ainda estão abertos. */
  bloqueadoresAbertos: number
}

export function escolherParaDelegar(args: {
  /** Na ordem da sprint — a ordem recebida é a prioridade. */
  candidatas: IssueCandidata[]
  /** Linhas abertas deste projeto (`sessoesVivas`). */
  sessoesVivas: LinhaDeSessao[]
  /** Sessões abertas neste projeto nas últimas 24h. */
  delegadasHoje: number
  tetoConcorrentes: number
  tetoDiario: number
  /** Freio de fluxo por ciclo, independente do plano. */
  capPorCiclo: number
}): number[] {
  const comSessaoViva = new Set(args.sessoesVivas.map((s) => s.issueNumber))

  const folgaConcorrentes = args.tetoConcorrentes - args.sessoesVivas.length
  const folgaDiaria = args.tetoDiario - args.delegadasHoje
  const limite = Math.min(folgaConcorrentes, folgaDiaria, args.capPorCiclo)
  if (limite <= 0) return []

  const escolhidas: number[] = []
  for (const c of args.candidatas) {
    if (escolhidas.length >= limite) break
    if (c.bloqueadoresAbertos > 0) continue
    if (comSessaoViva.has(c.number)) continue
    escolhidas.push(c.number)
  }
  return escolhidas
}
