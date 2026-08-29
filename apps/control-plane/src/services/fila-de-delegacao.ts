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
import { ocupaVaga } from './estados-de-sessao.js'

export interface IssueCandidata {
  number: number
  /** Quantos "Blocked by" desta issue ainda estão abertos. */
  bloqueadoresAbertos: number
  /**
   * Os arquivos que a tarefa declarou que vai mexer (seção "Related Files" do
   * corpo da issue, lida por `arquivosDeclarados`).
   *
   * OPCIONAL e, quando ausente ou vazia, significa "NÃO SEI" — nunca "nenhum
   * arquivo". A distinção é a guarda central desta mudança: quem não declarou
   * arquivo jamais pode ser barrado por colisão de arquivo, senão a fila para
   * de andar por falta de informação, que é pior que o defeito original.
   */
  arquivos?: string[]
}

export function escolherParaDelegar(args: {
  /** Na ordem da sprint — a ordem recebida é a prioridade. */
  candidatas: IssueCandidata[]
  /**
   * Arquivos das tarefas que JÁ estão sendo trabalhadas agora.
   *
   * Sem isto, a proteção contra colisão só valeria dentro de UM ciclo, e o
   * defeito voltaria espalhado em dois: a tarefa A é delegada hoje mexendo em
   * `src/x.ts` e fica dias rodando; amanhã a tarefa B, que também declara
   * `src/x.ts`, é delegada numa acordada em que A nem aparece entre as
   * candidatas — porque quem tem sessão viva é filtrado antes de chegar aqui.
   * As duas mexem no mesmo arquivo ao mesmo tempo e o conflito de merge é
   * fabricado de novo, só que mais difícil de enxergar.
   */
  arquivosEmTrabalho?: string[]
  /** Linhas abertas deste projeto (`sessoesVivas`). */
  sessoesVivas: LinhaDeSessao[]
  /** Sessões abertas neste projeto nas últimas 24h. */
  delegadasHoje: number
  tetoConcorrentes: number
  tetoDiario: number
  /**
   * Sessões vivas na CONTA inteira — todos os projetos que dividem a mesma
   * credencial do dev externo. Ausente resolve nas vivas deste projeto, que é
   * o comportamento antigo (e errado quando há mais de um projeto na conta).
   *
   * PREFIRA `ocupamVagaNaConta`: `vivasNaConta` conta TODA linha aberta,
   * inclusive as que o Jules já deu como COMPLETED/FAILED — e essas já
   * devolveram a vaga lá. Foi essa contagem inflada que parou a esteira dos
   * dois projetos em 29/08 (15 linhas COMPLETED abertas = teto batido).
   */
  vivasNaConta?: number | undefined
  /**
   * Sessões da CONTA inteira que OCUPAM uma vaga de concorrência AGORA — só os
   * estados que o Jules ainda está tocando (`ocupaVaga`). É o número certo para
   * o teto de simultâneas; uma sessão terminada no fornecedor não conta.
   */
  ocupamVagaNaConta?: number | undefined
  /**
   * Issues que já falharam 2× e estão ESPERANDO a análise de "por que" antes da
   * 3ª tentativa (D51). Enquanto estão aqui não são redelegadas — a análise
   * (RA) roda, grava o aprendizado e libera a issue com o pedido revisado.
   */
  issuesComAnalisePendente?: number[]
  /** Freio de fluxo por ciclo, independente do plano. */
  capPorCiclo: number
}): number[] {
  const comSessaoViva = new Set(args.sessoesVivas.map((s) => s.issueNumber))
  const analisePendente = new Set(args.issuesComAnalisePendente ?? [])

  // As vagas são da CONTA, não deste projeto: no Pro são 15 simultâneas
  // divididas entre todos os repositórios daquela conta. Usar só as vivas
  // DAQUI faria dois projetos se acharem com 15 cada, contra 15 no total.
  //
  // E só conta quem OCUPA vaga de verdade: uma sessão COMPLETED/FAILED já
  // liberou a vaga no Jules — contá-la aqui zerava a folga e o SM parava de
  // delegar em TODOS os projetos da conta (medido ao vivo 29/08). O fallback
  // filtra por `ocupaVaga` para quem chama sem o número pré-calculado.
  const vivasQueContam =
    args.ocupamVagaNaConta ??
    args.vivasNaConta ??
    args.sessoesVivas.filter((s) => ocupaVaga(s.state)).length
  const folgaConcorrentes = args.tetoConcorrentes - vivasQueContam
  const folgaDiaria = args.tetoDiario - args.delegadasHoje
  const limite = Math.min(folgaConcorrentes, folgaDiaria, args.capPorCiclo)
  if (limite <= 0) return []

  const escolhidas: number[] = []
  // Arquivos já reservados por uma candidata escolhida NESTE ciclo.
  //
  // O produto chegou a delegar duas tarefas que tocavam o mesmo arquivo e
  // fabricou o próprio conflito de merge — depois gastou ciclos tentando
  // resolver um problema que ele mesmo criou. A dependência declarada
  // ("Blocked by #N") não pega isso: as duas tarefas estavam prontas e
  // desbloqueadas, e ninguém escreveu que uma dependia da outra.
  //
  // A reserva vale só para o ciclo. A candidata barrada não é descartada: no
  // ciclo seguinte, com a primeira já tendo sessão viva, ela entra
  // normalmente. Barrar para sempre seria trocar um defeito por outro.
  // Começa já reservando o que está em trabalho — ver `arquivosEmTrabalho`.
  const arquivosReservados = new Set<string>(args.arquivosEmTrabalho ?? [])

  for (const c of args.candidatas) {
    if (escolhidas.length >= limite) break
    if (c.bloqueadoresAbertos > 0) continue
    if (comSessaoViva.has(c.number)) continue
    // Falhou 2× e a análise ainda não rodou: NÃO redelega — o RA vai entender
    // o porquê e liberar a issue com o pedido revisado (D51).
    if (analisePendente.has(c.number)) continue

    const declarados = c.arquivos ?? []
    // Lista vazia = "não sei" = nunca barra. Ver o comentário do campo.
    if (declarados.some((arquivo) => arquivosReservados.has(arquivo))) continue

    escolhidas.push(c.number)
    for (const arquivo of declarados) arquivosReservados.add(arquivo)
  }
  return escolhidas
}
