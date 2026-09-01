import { isFailoverError } from '../lib/runtime-resolver.js'

/**
 * O motivo de verdade não mora sempre no mesmo lugar do stderr — por isso o
 * resumo guarda as DUAS PONTAS.
 *
 * O QUE ACONTECEU (medido em 31/08/2026): a falha do motor era registrada como
 * `step.stderr.slice(0, 300)`. Os dois motores da esteira colocam a causa em
 * pontas OPOSTAS do texto, e o corte de cabeça só funcionava para um deles:
 *
 *  - CODEX: imprime primeiro um banner informativo de 298 bytes que começa com
 *    "Reading additional input from stdin..."; o erro real, `401 Unauthorized:
 *    Missing bearer or basic authentication`, só aparece por volta do byte 674.
 *    O corte caía exatamente no fim do banner e decapitava a causa.
 *  - ANTIGRAVITY: faz o contrário. Capturado ao vivo nesta VM em 01/09/2026,
 *    `agy --model "Gemini 3.5 Flash (Medium)"` devolve 484 bytes que COMEÇAM
 *    com `Error: invalid model selection`, seguidos da lista de modelos vivos.
 *    Aqui a causa está na CABEÇA — guardar só a cauda perderia o motivo e
 *    deixaria no banco uma lista de modelos sem dizer o que houve.
 *
 * Guardar cabeça E cauda é o que atende os dois sem escolher um favorito.
 *
 * O estrago não era só cosmético, e é por isso que este é o primeiro conserto:
 *
 *  1) O DIAGNÓSTICO NASCIA ERRADO. Os registros `failed` da tabela `missions`
 *     terminavam no meio da linha de comando do `podman run`, sem nenhum
 *     motivo. A leitura óbvia do log era "o motor trava esperando stdin" — que
 *     é falsa: reproduzido ao vivo no mesmo container, o processo lê stdin,
 *     recebe EOF, imprime o banner e SÓ ENTÃO morre de 401. Uma sessão inteira
 *     foi gasta perseguindo uma trava de teclado que nunca existiu.
 *  2) O CLASSIFICADOR FICAVA CEGO. `isFailoverError` casa 'unauthor' e '401' —
 *     as duas coisas ficavam fora dos 300 bytes guardados, então nem a decisão
 *     de trocar de motor era tomada pelo motivo certo. Ver
 *     `classificarFalhaDoMotor` abaixo: o veredito passou a sair do texto
 *     COMPLETO, antes de qualquer corte.
 *  3) O MESMO CORTE MENTIA SOBRE O CATÁLOGO. A lista de modelos do agy tem 11
 *     itens; medido ao vivo, o corte de 300 bytes deixava só 4 no log. Quem
 *     lesse o log concluiria que o provedor só oferece 4 modelos e escolheria o
 *     substituto errado. O CLI nunca truncou nada — o truncamento era NOSSO.
 *
 * NUNCA MASCARAR: quando corta, o resumo DIZ quantos bytes ficaram de fora.
 * Silenciar o corte seria trocar uma mentira por outra.
 */

/** O mesmo teto de sempre (300); explícito para os chamadores não divergirem. */
export const TETO_PADRAO_DO_RESUMO = 300

/**
 * Quanto do espaço vai para a CAUDA. Mais para a cauda porque o erro do Codex
 * (401) é longo e vem no fim, enquanto o do Antigravity se identifica logo na
 * primeira linha — a cabeça precisa de menos espaço para dizer a mesma coisa.
 */
const FATIA_DA_CAUDA = 0.6

const marcaDeCorte = (cortados: number): string => `…(${cortados} bytes cortados)…`

/**
 * Resume um stderr grande guardando o COMEÇO e o FIM, com a marca do que foi
 * cortado no meio. Texto que cabe no teto passa intacto, sem enfeite nenhum.
 */
export function resumoDeErroDoMotor(
  texto: string | undefined | null,
  teto: number = TETO_PADRAO_DO_RESUMO
): string {
  const bruto = texto ?? ''
  if (bruto.length <= teto) return bruto

  // O tamanho da marca depende do número que ela anuncia, e o número depende do
  // espaço que sobra para as duas pontas. Duas ou três passadas fecham a conta
  // exata — sem isto, ou o resumo estoura o teto, ou o número anunciado mente.
  let cortados = bruto.length - teto
  let sobra = teto - marcaDeCorte(cortados).length
  for (let i = 0; i < 4; i++) {
    const proximaSobra = teto - marcaDeCorte(bruto.length - sobra).length
    if (proximaSobra === sobra) break
    sobra = proximaSobra
  }
  cortados = bruto.length - sobra

  // Teto apertado demais para caber marca + duas pontas: cai na cauda pura, que
  // é onde mora o erro mais caro (o 401 do Codex). Melhor uma ponta honesta que
  // um resumo só de enfeite.
  if (sobra <= 0 || cortados <= 0) return bruto.slice(bruto.length - teto)

  const cauda = Math.floor(sobra * FATIA_DA_CAUDA)
  const cabeca = sobra - cauda
  return bruto.slice(0, cabeca) + marcaDeCorte(cortados) + bruto.slice(bruto.length - cauda)
}

export interface FalhaDoMotorClassificada {
  /** O texto que vai para o log e para a coluna `missions.error`. */
  mensagem: string
  /**
   * Se este erro justifica cair para o próximo motor da cadeia. Vem do stderr
   * COMPLETO, nunca do resumo.
   */
  ehFailover: boolean
}

/**
 * Classifica ANTES de cortar, resume DEPOIS — nesta ordem, e a ordem é o
 * conserto inteiro.
 *
 * Enquanto o produto classificava o texto já truncado, ele decidia pelo que
 * tinha sobrado do erro, não pelo erro. O 401 do Codex mora no byte 674; num
 * resumo de 300 bytes ele podia não caber de jeito nenhum — e aí o produto
 * concluía "não é caso de trocar de motor" sobre uma falha de autenticação, que
 * é o caso de trocar de motor mais claro que existe.
 *
 * Agora o veredito é tirado do texto inteiro e viaja junto com a mensagem. O
 * resumo pode caber ou não caber; a decisão não depende mais disso.
 */
export function classificarFalhaDoMotor(args: {
  bruto: string | undefined | null
  teto?: number
}): FalhaDoMotorClassificada {
  const bruto = args.bruto ?? ''
  return {
    // Texto vazio não tem veredito nenhum: sem sinal, sem palpite.
    ehFailover: bruto.length > 0 && isFailoverError(bruto),
    mensagem: resumoDeErroDoMotor(bruto, args.teto),
  }
}

/**
 * A marca que carrega o veredito do TEXTO COMPLETO grudada no próprio erro.
 *
 * Sem ela o veredito se perderia no caminho: quem lança o erro tem o stderr
 * inteiro na mão, mas quem DECIDE o failover está num `catch` lá longe, e tudo
 * que chega até lá é a mensagem — já resumida. Recalcular a classificação ali
 * seria decidir de novo pelo texto cortado, que é exatamente o defeito.
 *
 * `Symbol.for` e não um campo comum: o veredito não pode aparecer em
 * `JSON.stringify`, nem em log de erro, nem colidir com propriedade de
 * ninguém — é metadado interno da decisão, não conteúdo do erro.
 */
const MARCA_DE_FAILOVER = Symbol.for('gitorch.failoverPeloTextoCompleto')

/** Gruda o veredito no erro. Veredito falso não deixa marca nenhuma. */
export function marcarFailoverDoTextoCompleto<E extends object>(err: E, ehFailover: boolean): E {
  if (ehFailover) {
    Object.defineProperty(err, MARCA_DE_FAILOVER, {
      value: true,
      enumerable: false,
      configurable: true,
    })
  }
  return err
}

/** Lê o veredito gravado na origem, onde o stderr inteiro ainda existia. */
export function temMarcaDeFailover(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[MARCA_DE_FAILOVER] === true
  )
}
