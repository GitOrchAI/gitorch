/**
 * As dúvidas que um agente PODE abrir com o dono do projeto — e as que ele não
 * pode.
 *
 * Ordem do dono, 25/08/2026, nas palavras dele: "se os agentes do gitorch tem
 * duvidas sobre o projeto, deve-se usar sempre o askquestions SEMPRE, nao podem
 * achar nada. E claro todas duvidas estarao salvas nas memorias deles ! para
 * que nunca mais questione o usuario !"
 *
 * O mecanismo de perguntar já existia inteiro (`agent-question.ts`, do épico
 * W3): pergunta com botões no Telegram, resposta gravada na memória do projeto,
 * e uma chave que impede repetir. Só o PO usava. RA, SM e QA adivinhavam.
 *
 * Este arquivo é o CATÁLOGO: o que merece pergunta, com a chave e o texto de
 * cada uma. Existe separado porque as duas metades do pedido do dono vivem
 * aqui — perguntar em vez de achar, e nunca repetir a mesma pergunta.
 */

/**
 * O que merece interromper o dono.
 *
 * Perguntar demais é tão ruim quanto adivinhar: um dono que recebe pergunta a
 * cada ciclo para de responder, e aí o produto volta a decidir sozinho — só que
 * agora com a fama de chato. A régua: só vira pergunta o que MUDA O RESULTADO
 * e o que o produto não consegue descobrir sozinho olhando o repositório.
 */
export type AssuntoDaDuvida =
  /** Como este projeto chega ao ar. Sem isso o produto não sabe quando a tarefa acabou. */
  | 'como-publica'
  /** O repositório não tem verificação automática nenhuma. */
  | 'sem-verificacao'

export interface Duvida {
  /** A chave que impede a mesma pergunta de voltar. */
  dedupKey: string
  text: string
  context: string
  options: Array<{ label: string; value: string }>
}

/**
 * A chave de deduplicação.
 *
 * Leva o assunto E o repositório: o mesmo dono pode ter dois projetos que
 * publicam de jeitos diferentes, e uma chave só por assunto faria a resposta de
 * um valer para o outro — que é o mesmo defeito de misturar clientes, só que
 * dentro da mesma conta.
 */
export function chaveDaDuvida(assunto: AssuntoDaDuvida, repositorio: string): string {
  return `${assunto}:${repositorio}`
}

/**
 * L4-T18 fix-up (itens 5/6, revisão de portão) — sentinel do botão
 * abrangente "nem workflow, nem servidor meu": de propósito NÃO é um dos 4
 * valores que `como-o-projeto-publica.ts` entende (`RESPOSTAS_DE_COMO_PUBLICA`)
 * — `configuracaoAPartirDaResposta` ignora esta resposta (não grava
 * `publicacao.como` ainda), e `duvidaDeSeguimentoComoPublica`, abaixo,
 * dispara a PERGUNTA DE DETALHE que distingue os dois casos restantes SEM
 * PERDER informação, na MESMA dedupKey (2 perguntas curtas para a MESMA
 * decisão, em vez de uma parede de 4 botões).
 */
export const VALOR_PUBLICA_OUTRO = 'publica-outro'

/**
 * "Como este projeto vai ao ar?"
 *
 * A pergunta que faltava. O produto só sabia acompanhar publicação por
 * deployment do GitHub ou por workflow do Actions, e adivinhava qual era.
 * Medido em 25/08 no `loureng/patinhas-3d-crafts`: nenhum ambiente daquele
 * repositório se declara produção — todos os deploys registrados são de preview
 * (um por pull request) e o único ambiente estável é de outra ferramenta,
 * ilegível para o nosso aplicativo. A publicação real acontece nas VMs do dono.
 * Adivinhando, o produto ficou 992 vezes em 24 horas batendo num 403, com seis
 * entregas mescladas presas esperando uma confirmação que nunca viria.
 *
 * L4-T18 fix-up (itens 5/6, revisão de portão) — eram 4 opções fixas; o
 * envio (`sendTelegramQuestion`, telegram-bot.ts) passou a RECUSAR (lança)
 * qualquer pergunta com mais de 3, e esta era a ÚNICA da base que estourava
 * o teto — um crash real em produção, não hipotético. Reduzida para 3: as
 * duas mais comuns (workflow / VM própria) direto, e a terceira abrangente
 * o bastante para as duas menos comuns (serviço externo / manual) juntas —
 * `duvidaDetalheDeComoPublica` faz a segunda pergunta, curta, só para quem
 * escolheu a abrangente, e os 4 valores que `como-o-projeto-publica.ts` já
 * entende continuam TODOS alcançáveis, sem perder informação nenhuma.
 */
export function duvidaSobreComoPublica(repositorio: string): Duvida {
  return {
    dedupKey: chaveDaDuvida('como-publica', repositorio),
    text:
      `Preciso saber como o ${repositorio} chega ao ar. É com isso que eu decido ` +
      `quando uma tarefa está de fato terminada — hoje eu não consigo confirmar ` +
      `sozinho, e a tarefa fica aberta esperando.`,
    context:
      'Sem esta resposta eu só sei olhar publicação registrada no GitHub, e este ' +
      'repositório não tem nenhuma. As entregas ficam mescladas mas sem fechar.',
    options: [
      { label: 'Workflow do GitHub Actions', value: 'publica-por-workflow' },
      { label: 'Servidor meu (VM própria)', value: 'publica-em-vm-propria' },
      { label: 'Outro (nem workflow, nem servidor meu)', value: VALOR_PUBLICA_OUTRO },
    ],
  }
}

/**
 * O 2º passo de "como publica" — só para quem respondeu `VALOR_PUBLICA_OUTRO`
 * na pergunta de cima. As duas opções que sobraram, curtas (D71: nunca mais
 * de 3 opções fixas por pergunta). MESMA dedupKey da pergunta original —
 * é a MESMA decisão, só entregue em duas perguntas curtas em vez de uma
 * parede de 4 botões: `AgentQuestionService.ask` cria uma pergunta NOVA com
 * esta chave (a original ainda está `open` no momento em que esta nasce —
 * o dedup só age sobre perguntas `answered`), e a resposta a ELA é quem
 * `configuracaoAPartirDaResposta` (como-o-projeto-publica.ts) grava como
 * `publicacao.como` — sem precisar de nenhum ajuste lá, porque a dedupKey é
 * a mesma de sempre.
 */
export function duvidaDetalheDeComoPublica(repositorio: string): Duvida {
  return {
    dedupKey: chaveDaDuvida('como-publica', repositorio),
    text: `E dentro desse "outro" do ${repositorio}: qual dos dois é o seu caso?`,
    context:
      'Você disse que não é nem workflow do GitHub Actions nem servidor seu — só falta saber ' +
      'qual dos dois caminhos restantes é o seu, para eu parar de adivinhar.',
    options: [
      { label: 'Serviço externo (Render, Vercel...)', value: 'publica-em-servico-externo' },
      { label: 'Publico na mão, sem automação', value: 'publica-manualmente' },
    ],
  }
}

const PREFIXO_COMO_PUBLICA = 'como-publica:'

/**
 * A pergunta de SEGUIMENTO, se esta resposta pedir uma — `null` quando não
 * pede nenhuma. Função PURA (nenhum I/O): `plugins/telegram.ts` só faz a
 * chamada a `agentQuestionService.ask` quando isto devolve não-nulo — o
 * MESMO desenho de `configuracaoAPartirDaResposta` (como-o-projeto-publica.ts),
 * que também decide "o quê" sem tocar rede.
 *
 * Só dispara para `VALOR_PUBLICA_OUTRO` numa dedupKey de `como-publica:` —
 * qualquer outra resposta (workflow, vm-própria, texto livre do "Vou
 * escrever") ou qualquer outro assunto de dúvida devolve `null`, sem ação
 * nenhuma.
 */
export function duvidaDeSeguimentoComoPublica(dedupKey: string, resposta: string): Duvida | null {
  if (resposta !== VALOR_PUBLICA_OUTRO) return null
  if (!dedupKey.startsWith(PREFIXO_COMO_PUBLICA)) return null
  const repositorio = dedupKey.slice(PREFIXO_COMO_PUBLICA.length)
  if (!repositorio) return null
  return duvidaDetalheDeComoPublica(repositorio)
}

/**
 * "Este repositório não tem verificação automática — e agora?"
 *
 * Decisão antiga do dono (D10): repositório sem CI é TRABALHO DE BACKLOG, não
 * exceção de merge. Mas o produto precisa saber se aquele projeto vai ganhar
 * verificação ou se vai seguir sem — e isso muda o que ele pode prometer.
 */
export function duvidaSobreFaltaDeVerificacao(repositorio: string): Duvida {
  return {
    dedupKey: chaveDaDuvida('sem-verificacao', repositorio),
    text:
      `O ${repositorio} não tem verificação automática rodando nas entregas. ` +
      `Sem ela eu não consigo provar que uma mudança não quebrou nada antes de mesclar.`,
    context: 'Nenhum workflow de verificação foi encontrado no repositório.',
    options: [
      { label: 'Quero que o GitOrch monte a verificação', value: 'montar-verificacao' },
      { label: 'Vou montar eu mesmo', value: 'dono-monta-verificacao' },
      { label: 'Seguir sem verificação por enquanto', value: 'seguir-sem-verificacao' },
    ],
  }
}

/**
 * A resposta já está na memória do projeto?
 *
 * O `ask()` já deduplica sozinho contra respostas gravadas, mas quem chama
 * precisa desta pergunta ANTES: perguntar é barato, mas montar o contexto da
 * pergunta e acordar o dono não é. E a segunda metade da ordem dele foi
 * explícita — "para que nunca mais questione o usuario".
 */
export function respostaConhecida(
  respostas: ReadonlyMap<string, string> | undefined,
  assunto: AssuntoDaDuvida,
  repositorio: string
): string | null {
  return respostas?.get(chaveDaDuvida(assunto, repositorio)) ?? null
}
