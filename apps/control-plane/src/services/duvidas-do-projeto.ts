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
      { label: 'Serviço externo (Render, Vercel...)', value: 'publica-em-servico-externo' },
      { label: 'Publico na mão, sem automação', value: 'publica-manualmente' },
    ],
  }
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
