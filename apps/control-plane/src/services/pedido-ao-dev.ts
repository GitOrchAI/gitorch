import { lerSecaoDaIssue } from './secao-da-issue.js'

// O pedido que o produto manda ao dev assíncrono.
//
// O QUE FOI MEDIDO, no PR #157: a issue #151 listava QUATRO passos no
// Implementation Guide e o dev entregou TRÊS. Criou a função e o decorador, e
// não fez a integração no fluxo de execução — justamente o passo que fazia a
// entrega servir para alguma coisa. O QA pegou em cinco minutos. Depois disso
// a sessão ficou 44 HORAS parada, sem responder e sem dizer que estava
// travada.
//
// O pedido antigo era o corpo bruto da issue mais duas frases genéricas:
//
//     Work on issue #N of owner/repo.
//     <corpo da issue>
//     Deliver a pull request that closes the issue and satisfies every item
//     under "Verification Criteria". Do not change anything outside the scope
//     described above.
//
// Ele não repetia os passos como coisas a marcar, não pedia conferência antes
// de abrir a entrega, e não dizia o que fazer ao travar. Nos números da
// semana: 68% das sessões precisaram de pelo menos um empurrão e 36% das que
// fecharam foram abandonadas.
//
// As três adições saem do que a prática recomenda para agente de código e
// batem com o que foi observado aqui: lista de conferência explícita,
// autoverificação contra o critério ANTES de abrir a entrega, e instrução
// explícita de comportamento ao travar — em vez de parar em silêncio.

export interface IssueParaODev {
  numero: number
  repositorio: string
  titulo: string
  corpo: string
  /**
   * O aprendizado da 2ª falha (D51): quando esta issue já falhou duas vezes e a
   * análise entendeu o porquê, o `pedidoRevisado` entra AQUI, no TOPO do pedido
   * da 3ª tentativa — antes do corpo da issue, para o agente ler primeiro.
   * Ausente = 1ª ou 2ª tentativa.
   */
  aprendizado?: string
}

/**
 * Extrai os passos do Implementation Guide como linhas soltas.
 *
 * Aceita numerado (`1.`) e lista (`- `) porque o PO usa os dois. Ignorar uma
 * das formas deixaria metade das issues sem conferência nenhuma — e conferência
 * ausente foi exatamente o que deixou o passo 4 do #157 passar.
 */
function passosDoGuia(corpo: string): string[] {
  const secao = lerSecaoDaIssue(corpo, 'Implementation Guide')
  if (!secao) return []
  return secao
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(\d+[.)]|[-*])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, '').trim())
    .filter((l) => l.length > 0)
}

/**
 * Monta o texto do pedido.
 *
 * O corpo da issue continua INTEIRO: o que o PO escreveu é o contrato, e
 * resumir aqui seria decidir por ele o que importa. O que se acrescenta vem
 * depois, e é sempre a mesma coisa — o que conferir, quando conferir, e o que
 * fazer se travar.
 */
export function montarPedidoAoDev(issue: IssueParaODev): string {
  const passos = passosDoGuia(issue.corpo)

  const partes = [
    `Work on issue #${issue.numero} of ${issue.repositorio}.`,
    '',
    ...(issue.aprendizado && issue.aprendizado.trim()
      ? ['## What went wrong the last two times (read this FIRST)', issue.aprendizado.trim(), '']
      : []),
    issue.corpo,
    '',
    'Deliver a pull request that closes the issue and satisfies every item',
    'under "Verification Criteria". Do not change anything outside the scope',
    'described above.',
  ]

  // Lista de conferência SÓ quando há passos. Uma lista vazia é pior que
  // nenhuma: ensina o agente a ignorar a seção.
  if (passos.length > 0) {
    partes.push(
      '',
      'BEFORE OPENING THE PULL REQUEST, go through this checklist of the numbered',
      'steps above and confirm each one is actually done in the diff. The most',
      'common failure here is delivering the first steps and silently skipping',
      'the last one — the integration step that makes the rest useful.',
      '',
      ...passos.map((p, i) => `  ${i + 1}. [ ] ${p}`),
      '',
      'If any box cannot be ticked, do NOT open the pull request yet: finish it,',
      'or say which one you could not do and why.'
    )
  }

  // O que fazer ao travar. É a parte que faltava e que custou 44 horas de
  // silêncio no #157: um agente sem instrução de bloqueio simplesmente para, e
  // ninguém descobre até alguém olhar.
  partes.push(
    '',
    'IF YOU GET STUCK OR BLOCKED at any point, say so in this session right away,',
    'naming what you tried and what is missing. Do not stop silently and do not',
    'wait — a blocked delivery that nobody hears about is worse than a failed one,',
    'because nobody knows to help.'
  )

  return partes.join('\n')
}
