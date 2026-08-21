// O juiz abre o endereço que acabou de ir ao ar e confere se as telas
// respondem — sem isso, "publicou" e "funciona" são a mesma afirmação sem
// prova nenhuma por trás.
//
// O endereço nasce fora do produto (Tarefa 13, que por sua vez leu o
// `environment_url` que o GitHub devolveu) — por isso a rede só é alcançada
// por `buscarComGuarda` (Tarefa 11), nunca por um `fetch` direto. A guarda é
// consultada aqui, na porta de entrada desta função, ANTES de qualquer
// chamada: um endereço apontando para dentro de uma rede (loopback, faixa
// privada, metadados de nuvem) nunca chega a ser buscado.
//
// A lição que molda o terceiro veredito veio de um cliente real: o ensaio do
// projeto roda em `127.0.0.1` dentro da própria máquina do cliente — o
// produto, rodando em outra máquina, JAMAIS vai alcançar aquele endereço.
// Isso não é uma reprovação do trabalho do dev, é uma lacuna de
// infraestrutura. Por isso existe `inalcancavel` como veredito próprio,
// distinto de `falhou`: o produto nunca escreve "testado" sobre o que não
// conseguiu testar.

import { buscarComGuarda, enderecoPermitido } from './endereco-seguro.js'

/**
 * Os caminhos que o ensaio visita, por projeto: configuração declarada em
 * `runtimeConfig.ambientes.caminhos` (Tarefa 17), com padrão `['/']` quando
 * ausente, vazia, ou malformada. Fica NESTE arquivo (não em `testarAmbiente`,
 * que continua sem saber nada de `runtimeConfig` — decisão da Tarefa 14) e
 * não em `scheduler.ts`, pelo mesmo motivo de `resolveBoardColumns`/
 * `resolveSprintDays` (board-status.ts): a config vive ao lado do que ela
 * configura, testável sem subir o relógio.
 *
 * Nunca chuta rota de cliente: sem configuração válida, testa só a raiz —
 * o próprio texto do brief da Tarefa 14 proíbe advinhar caminho.
 */
export function resolveCaminhosDeAmbiente(runtimeConfig: unknown): string[] {
  const caminhos = (runtimeConfig as { ambientes?: { caminhos?: unknown } } | null)?.ambientes
    ?.caminhos
  if (!Array.isArray(caminhos)) return ['/']
  const validos = caminhos.filter((c): c is string => typeof c === 'string' && c.length > 0)
  return validos.length > 0 ? validos : ['/']
}

/**
 * O endereço BASE do ambiente — irmão de `resolveCaminhosDeAmbiente`, mas
 * para a metade que faltava (Menor 9 da revisão final da branch).
 *
 * No caminho de DEPLOYMENT, o endereço vem de GRAÇA do GitHub
 * (`environment_url`, publicacao.ts) — a plataforma prova, por construção,
 * que aquele endereço é do commit mesclado. No caminho de WORKFLOW não existe
 * esse presente: nenhuma chamada usada por `acompanharPorWorkflow` devolve
 * URL nenhuma, então `veredito.enderecos` sai SEMPRE vazio ali — e sem este
 * campo, `testarAmbiente` sempre recebia `enderecos: []` e respondia
 * `sem-endereco` para TODO repositório que publica por workflow, inclusive
 * um projeto real do cliente. A Tarefa 14 (o ensaio do ambiente) ficava
 * inerte para metade dos mecanismos reconhecidos — não por bug na lógica do
 * ensaio, mas por nunca receber endereço nenhum para testar.
 *
 * A fonte só pode ser a CONFIGURAÇÃO do projeto — `runtimeConfig.ambientes.endereco`,
 * ao lado de `ambientes.caminhos` (mesmo bloco, Tarefa 17). Nunca inventa: sem
 * este campo (ausente, vazio, ou não é uma string), devolve `null` — o
 * chamador mantém o comportamento honesto de sempre (`sem-endereco`,
 * visível ao dono na mesma nota que já acompanha todo veredito de
 * publicação). A validação de FORMATO do endereço (esquema, rede interna)
 * continua sendo só da guarda (`enderecoPermitido`, endereco-seguro.ts) — este
 * resolvedor não reimplementa nenhuma checagem de segurança, só lê config.
 */
export function resolveEnderecoDeAmbiente(runtimeConfig: unknown): string | null {
  const endereco = (runtimeConfig as { ambientes?: { endereco?: unknown } } | null)?.ambientes
    ?.endereco
  if (typeof endereco !== 'string') return null
  const limpo = endereco.trim()
  return limpo.length > 0 ? limpo : null
}

export type RelatorioDeAmbiente = {
  veredito: 'passou' | 'falhou' | 'inalcancavel' | 'sem-endereco'
  /**
   * `true` quando NENHUMA tentativa de rede chegou a acontecer porque a
   * guarda recusou todos os endereços publicados antes do primeiro `fetch`.
   *
   * Separa as DUAS causas que "inalcancavel" juntava numa palavra só, e que
   * pedem tratamentos opostos: um cliente cujo ambiente vive numa rede
   * interna nunca vai ser alcançado a partir daqui — isso é limitação de
   * alcance, não defeito de código, e não pode virar tarefa no quadro dele;
   * já "tentamos e nada respondeu" pode ser o ambiente fora do ar, e aí a
   * repetição da leitura é o que separa defeito de queda momentânea.
   */
  recusadoPelaGuarda: boolean
  testes: Array<{ caminho: string; status: number | null; ok: boolean }>
  motivo: string
}

/** Uma resposta entre 200 e 399 conta como "a tela respondeu" — nada além disso é checado aqui. */
function respostaOk(status: number): boolean {
  return status >= 200 && status < 400
}

/**
 * Testa cada caminho de cada endereço publicado. Só entra na guarda
 * (`buscarComGuarda`) quem passou por `enderecoPermitido`; o resto nunca gera
 * uma chamada de rede.
 *
 * `buscar` recebe a MESMA assinatura de `buscarComGuarda` — é a Tarefa 11
 * quem decide como a rede é alcançada, esta função só a chama.
 */
export async function testarAmbiente(args: {
  enderecos: string[]
  caminhos: string[]
  buscar: typeof buscarComGuarda
}): Promise<RelatorioDeAmbiente> {
  const { enderecos, caminhos, buscar } = args

  if (enderecos.length === 0) {
    return {
      veredito: 'sem-endereco',
      recusadoPelaGuarda: false,
      testes: [],
      motivo: 'nenhum endereço de ambiente foi publicado ainda — nada para testar.',
    }
  }

  // Guarda antes de qualquer chamada: um endereço de rede interna nunca gera
  // tráfego, nem sequer uma tentativa.
  const enderecosAlcancaveis: string[] = []
  const motivosDeRecusa: string[] = []
  for (const endereco of enderecos) {
    const veredito = enderecoPermitido(endereco)
    if (veredito.permitido) {
      enderecosAlcancaveis.push(endereco)
    } else {
      motivosDeRecusa.push(`${endereco} (${veredito.motivo})`)
    }
  }

  if (enderecosAlcancaveis.length === 0) {
    return {
      veredito: 'inalcancavel',
      recusadoPelaGuarda: true,
      testes: [],
      motivo: `endereço fora do alcance da rede a partir daqui, recusado antes de qualquer chamada: ${motivosDeRecusa.join('; ')}.`,
    }
  }

  // Endereços recusados pela guarda não somem do relato final: um veredito
  // "passou" que escondesse um endereço interno descartado silenciosamente
  // seria uma afirmação incompleta sobre o que foi (e o que não foi) testado.
  const notaDeRecusa =
    motivosDeRecusa.length > 0
      ? ` (endereço(s) fora do alcance da rede, não testado(s): ${motivosDeRecusa.join('; ')}.)`
      : ''

  const testes: Array<{ caminho: string; status: number | null; ok: boolean }> = []
  let algumaRespostaChegou = false

  for (const endereco of enderecosAlcancaveis) {
    for (const caminho of caminhos) {
      const url = new URL(caminho, endereco).toString()
      try {
        const resposta = await buscar(url)
        algumaRespostaChegou = true
        testes.push({ caminho, status: resposta.status, ok: respostaOk(resposta.status) })
      } catch {
        // Erro de rede ou tempo esgotado: o padrão de um caminho não testado
        // é NÃO ok — nunca deixe uma falha de rede virar "passou".
        testes.push({ caminho, status: null, ok: false })
      }
    }
  }

  if (!algumaRespostaChegou) {
    return {
      veredito: 'inalcancavel',
      recusadoPelaGuarda: false,
      testes,
      motivo: `nenhuma resposta chegou de nenhum endereço publicado — rede inalcançável a partir daqui (erro de conexão ou tempo esgotado em todas as tentativas).${notaDeRecusa}`,
    }
  }

  const falhas = testes.filter((teste) => !teste.ok)
  if (falhas.length === 0) {
    return {
      veredito: 'passou',
      recusadoPelaGuarda: false,
      testes,
      motivo: `todas as ${testes.length} tela(s) testada(s) responderam normalmente (status entre 200 e 399).${notaDeRecusa}`,
    }
  }

  return {
    veredito: 'falhou',
    recusadoPelaGuarda: false,
    testes,
    motivo: `${falhas.length} de ${testes.length} tela(s) testada(s) não respondeu(ram) bem: ${falhas.map((f) => f.caminho).join(', ')}.${notaDeRecusa}`,
  }
}
