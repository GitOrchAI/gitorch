// "Este pull request que acabou de nascer é entrega de qual tarefa nossa?"
//
// Existe porque a resposta chegava TARDE DEMAIS. A ligação PR↔sessão só era
// gravada quando o dev externo REPORTAVA que tinha terminado (session-watch.ts,
// ramo 'julgar'), e o número do PR vem de `outputs` da sessão — um campo que o
// serviço externo preenche quando quer. Medido em produção (20/08/2026):
// PR #132 aberto às 16:58, ligação gravada às 23:28. SEIS HORAS E MEIA.
//
// O custo dessa janela não é atraso: é veredito inválido. Dentro dela o QA
// acorda pelo aviso do GitHub, `ehPrDelegado` não encontra a linha, e a
// entrega é julgada como obra de terceiro — o parecer sai como comentário e
// leva junto a frase "esta entrega não foi encomendada pelo produto", escrita
// no pull request do CLIENTE, sobre um trabalho que o produto encomendou.
//
// O GitHub, porém, já sabe de tudo no segundo zero: o aviso de PR aberto traz
// o branch e o corpo, e os DOIS carregam o identificador da sessão.
//
// Este módulo é puro de propósito — sem rede, sem banco, sem relógio. Ele
// responde a pergunta e nada mais; quem grava é o chamador.

// O dev assíncrono usa DOIS padrões de nome de branch, e descobri isso da pior
// forma: entreguei só o primeiro e, ao conferir os cinco pull requests reais
// deste repositório, QUATRO não casavam. Lidos da API do GitHub em 21/08/2026:
//
//   #132  jules-12112302527133030906-e9d57552          ← identificador no começo
//   #133  fix-dependabot-pnpm-config-2393879608896482841   ← e no fim, sem prefixo
//   #97   fix/jules-pr-ci-failure-fallback-2772598213435248562
//   #79   fix/ci-failure-fallback-token-18033236850476632477
//   #75   fix-jules-apology-handler-token-6237721600950278679
//
// O segundo padrão é o mais comum. Reconhecer só o primeiro seria entregar o
// conserto com a fechadura trocada e o problema intacto.

/** Identificador no começo: `jules-<id>-<hash>`. */
const ID_NO_COMECO_DO_BRANCH = /^jules-(\d{15,})-/i

/**
 * Identificador no fim: `<texto-livre>-<id>`.
 *
 * Os quinze dígitos mínimos não são estética: `fix/issue-123` é nome de branch
 * de gente, e os identificadores do dev têm dezenove ou vinte dígitos. Sem o
 * comprimento, qualquer branch humano com número no fim entraria na busca —
 * e ainda que a comparação final com o nome da sessão barrasse quase tudo, o
 * dia em que uma sessão tivesse nome curto o produto ligaria a entrega errada.
 */
const ID_NO_FIM_DO_BRANCH = /(?:^|[^0-9])(\d{15,})$/

/**
 * Recuo pelo corpo do PR. O marcador é o texto que o próprio dev assina ao
 * abrir a entrega: "PR created automatically by Jules for task [<id>](...)".
 * Serve para o dia em que o padrão de nome de branch mudar — e para a entrega
 * que nasceu antes desta mudança.
 */
const ID_NO_CORPO = /for task \[(\d+)\]/i

/** O mínimo que este módulo precisa saber de uma sessão. */
export interface SessaoParaCasamento {
  sessionName: string
  pullRequestNumber: number | null
}

export interface ArgumentosDoCasamento {
  /** Nome do branch do pull request (`head.ref` no aviso do GitHub). */
  headRefName?: string | undefined
  /** Corpo do pull request. */
  corpo?: string | undefined
  /**
   * O número do PR que chegou agora. Opcional: sem ele o casador só responde
   * "de quem é", sem opinar sobre valer a pena regravar.
   */
  numeroDoPr?: number | undefined
  /** Sessões deste projeto — vivas e fechadas. */
  sessoes: SessaoParaCasamento[]
}

/** Extrai o identificador da sessão do branch ou, faltando ele, do corpo. */
function identificadorDaSessao(args: ArgumentosDoCasamento): string | null {
  const branch = args.headRefName ?? ''
  const doComeco = branch.match(ID_NO_COMECO_DO_BRANCH)?.[1]
  if (doComeco) return doComeco
  const doFim = branch.match(ID_NO_FIM_DO_BRANCH)?.[1]
  if (doFim) return doFim
  return (args.corpo ?? '').match(ID_NO_CORPO)?.[1] ?? null
}

/**
 * Compara o nome guardado com o identificador achado — por SEGMENTO INTEIRO.
 *
 * `endsWith` sozinho é armadilha: `sessions/121123025271330309061` termina com
 * um número que tem `12112302527133030906` como prefixo, e casaria. Ligar um
 * pull request à entrega de OUTRA tarefa é pior que não ligar nada — o QA
 * julgaria a entrega errada contra os critérios errados.
 */
function ehAMesmaSessao(sessionName: string, identificador: string): boolean {
  const ultimoSegmento = sessionName.split('/').pop() ?? ''
  return ultimoSegmento === identificador
}

/**
 * Responde de qual sessão é este pull request, ou `null` quando não dá para
 * saber com certeza.
 *
 * `null` é a resposta correta para o pull request de humano, e é deliberado
 * que "só existe uma sessão aberta" NÃO seja considerado sinal: adivinhar por
 * proximidade foi exatamente o furo que custou o PR #99 (texto no corpo +
 * etiqueta na issue bastavam para o produto tratar entrega humana como sua).
 * Sem identificador exato, não há casamento.
 *
 * Quando `numeroDoPr` é informado e a sessão JÁ aponta para esse mesmo número,
 * a resposta também é `null` — não há nada a gravar. Isso mantém idempotente o
 * caminho do `reopened`, que reenvia o mesmo aviso: regravar mexeria em
 * `stateCheckedAt`, que é a régua de cadência da vigia.
 */
export function casarPrComSessao(args: ArgumentosDoCasamento): { sessionName: string } | null {
  const identificador = identificadorDaSessao(args)
  if (!identificador) return null

  const sessao = args.sessoes.find((s) => ehAMesmaSessao(s.sessionName, identificador))
  if (!sessao) return null

  if (args.numeroDoPr !== undefined && sessao.pullRequestNumber === args.numeroDoPr) return null

  return { sessionName: sessao.sessionName }
}
