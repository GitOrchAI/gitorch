import type { Mecanismo } from './mecanismo-de-publicacao.js'
import { chaveDaDuvida } from './duvidas-do-projeto.js'

/**
 * COMO cada projeto chega ao ar — os cinco caminhos que o dono nomeou (D49).
 *
 * Pergunta dele, 25/08/2026: "como o gitorch deve atuar em diferentes cenarios?
 * quando projeto nao tem CI-CD ou se tem CI mas nao tem CD ou tem CI e CD porem
 * nao tem stagging, ou é render, etc... ou é tudo privado, como meu caso onde
 * tudo esta numa VM minha".
 *
 * O produto conhecia DOIS caminhos, os dois dentro do GitHub: o deployment e o
 * workflow. Nenhum alcança uma VM privada — que é justamente o caso do próprio
 * dono e, provavelmente, o mais comum entre clientes reais. O resultado medido
 * em 24h no `loureng/patinhas-3d-crafts` foi 992 leituras recusadas e SEIS
 * entregas mescladas presas esperando uma confirmação que nunca viria.
 *
 * A pergunta ao dono já existia (`duvidas-do-projeto.ts`) e as respostas dele
 * NUNCA eram lidas por ninguém: o produto perguntava e continuava adivinhando.
 * Este módulo é o que faltava — transformar a resposta em comportamento.
 *
 * A lei não afrouxa: "no ar" continua exigindo prova. O que muda é que, quando
 * prova é impossível, o desfecho honesto passa a ser DIZER ISSO e encerrar, em
 * vez de deixar a entrega presa para sempre fingindo que ainda vai descobrir.
 */

/** As quatro respostas que o dono pode dar — as mesmas de `duvidaSobreComoPublica`. */
export const RESPOSTAS_DE_COMO_PUBLICA = [
  'publica-por-workflow',
  'publica-em-vm-propria',
  'publica-em-servico-externo',
  'publica-manualmente',
] as const

export type RespostaDeComoPublica = (typeof RESPOSTAS_DE_COMO_PUBLICA)[number]

interface ConfiguracaoComPublicacao {
  publicacao?: { como?: unknown }
}

/**
 * A resposta que o dono deu, se deu.
 *
 * `null` significa "ele ainda não disse" — nunca um palpite. Valor fora do
 * catálogo também vira `null`: um texto solto gravado à mão na configuração
 * não pode virar comportamento, porque ninguém saberia qual.
 */
export function comoPublicaDeclarado(runtimeConfig: unknown): RespostaDeComoPublica | null {
  const bruto = (runtimeConfig as ConfiguracaoComPublicacao | null)?.publicacao?.como
  if (typeof bruto !== 'string') return null
  const limpo = bruto.trim() as RespostaDeComoPublica
  return RESPOSTAS_DE_COMO_PUBLICA.includes(limpo) ? limpo : null
}

export type DesfechoDaPublicacao =
  /** Há registro no GitHub para ler: segue o caminho de sempre. */
  | { tipo: 'acompanhar-no-github' }
  /**
   * A publicação acontece fora do alcance do GitHub. O produto NÃO fica
   * lendo o que não existe: espera o aviso de quem publica (a rota de aviso
   * de publicação), com teto — passado o teto, encerra dizendo a verdade.
   */
  | { tipo: 'esperar-aviso'; motivo: string }
  /** Não há publicação automática nenhuma: a entrega termina no merge. */
  | { tipo: 'encerrar-sem-rastreio'; motivo: string }
  /** O produto não sabe, e não pode achar (D47): pergunta ao dono. */
  | { tipo: 'perguntar' }

/**
 * O desfecho honesto de cada cenário.
 *
 * A resposta do DONO manda sobre a descoberta, com uma exceção que é o coração
 * desta tarefa: quem declarou VM própria publica FORA do GitHub, então um
 * ambiente encontrado lá é de outra coisa — foi exatamente o caso do ambiente
 * `copilot`, de outra ferramenta, que o produto tomou por produção e passou 24
 * horas tentando ler sem permissão.
 */
export function desfechoDaPublicacao(args: {
  declarado: RespostaDeComoPublica | null
  mecanismo: Mecanismo
}): DesfechoDaPublicacao {
  const temRegistroNoGithub = args.mecanismo.tipo !== 'nenhum'

  switch (args.declarado) {
    case 'publica-manualmente':
      return {
        tipo: 'encerrar-sem-rastreio',
        motivo:
          'este projeto é publicado na mão, sem automação — a entrega termina no merge, e ' +
          'quem sobe ao ar é você. Não tenho como confirmar publicação daqui.',
      }

    case 'publica-em-vm-propria':
      return {
        tipo: 'esperar-aviso',
        motivo:
          'este projeto publica em servidor seu, fora do GitHub. Eu não consigo enxergar isso ' +
          'daqui: quem confirma é o seu próprio CD, avisando quando a versão sobe.',
      }

    case 'publica-em-servico-externo':
      // Render, Vercel e afins costumam registrar a publicação no GitHub. Quando
      // registram, dá para ler; quando não, só o aviso do serviço resolve.
      return temRegistroNoGithub
        ? { tipo: 'acompanhar-no-github' }
        : {
            tipo: 'esperar-aviso',
            motivo:
              'este projeto publica por um serviço externo que não registra nada no GitHub. ' +
              'Quem confirma é o próprio serviço, avisando quando a versão sobe.',
          }

    case 'publica-por-workflow':
      return temRegistroNoGithub
        ? { tipo: 'acompanhar-no-github' }
        : {
            tipo: 'encerrar-sem-rastreio',
            motivo:
              'você me disse que a publicação é por workflow do GitHub, mas não encontrei ' +
              'nenhum workflow de publicação ativo neste repositório — só verificação. ' +
              'A entrega termina no merge até existir um.',
          }

    case null:
      // Sem resposta do dono: se o repositório mostra por onde publica, segue —
      // não há motivo para incomodar ninguém. Se não mostra nada, PERGUNTA em
      // vez de adivinhar (D47), que foi o que produziu as 992 recusas.
      return temRegistroNoGithub ? { tipo: 'acompanhar-no-github' } : { tipo: 'perguntar' }
  }
}

/**
 * A resposta do dono virando CONFIGURAÇÃO do projeto.
 *
 * Esta era a ponte que faltava, e sem ela o resto não existe: o produto
 * perguntava "como este projeto vai ao ar?", guardava a resposta na tabela de
 * dúvidas e na memória do projeto — e continuava adivinhando, porque nada
 * lia aquilo de volta na hora de decidir. Perguntar sem usar a resposta é
 * pior que não perguntar: gasta a paciência do dono e não muda nada.
 *
 * Devolve o que gravar no `runtimeConfig` do projeto, ou `null` quando a
 * dúvida respondida não é esta (as outras dúvidas têm outros destinos) ou
 * quando a resposta não é uma das do catálogo.
 */
export function configuracaoAPartirDaResposta(args: {
  dedupKey: string
  repositorio: string
  resposta: string
}): { publicacao: { como: RespostaDeComoPublica } } | null {
  if (args.dedupKey !== chaveDaDuvida('como-publica', args.repositorio)) return null
  const valor = args.resposta.trim() as RespostaDeComoPublica
  if (!RESPOSTAS_DE_COMO_PUBLICA.includes(valor)) return null
  return { publicacao: { como: valor } }
}

/**
 * Esta declaração dispensa olhar o repositório?
 *
 * Existe porque descobrir o mecanismo CUSTA leitura no GitHub — e para quem
 * publica na própria VM ou na mão, essa leitura é justamente a que não tem o
 * que achar. Era ela que produzia os 403 em série no caso real: o produto
 * listava os ambientes, encontrava um de outra ferramenta e passava a bater
 * nele a cada tique.
 *
 * As outras duas respostas precisam da descoberta (o serviço externo pode ou
 * não registrar no GitHub; o workflow precisa ser encontrado), então para elas
 * a resposta é não.
 */
export function dispensaOlharORepositorio(declarado: RespostaDeComoPublica | null): boolean {
  return declarado === 'publica-em-vm-propria' || declarado === 'publica-manualmente'
}
