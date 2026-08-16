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

export type RelatorioDeAmbiente = {
  veredito: 'passou' | 'falhou' | 'inalcancavel' | 'sem-endereco'
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
      testes,
      motivo: `nenhuma resposta chegou de nenhum endereço publicado — rede inalcançável a partir daqui (erro de conexão ou tempo esgotado em todas as tentativas).${notaDeRecusa}`,
    }
  }

  const falhas = testes.filter((teste) => !teste.ok)
  if (falhas.length === 0) {
    return {
      veredito: 'passou',
      testes,
      motivo: `todas as ${testes.length} tela(s) testada(s) responderam normalmente (status entre 200 e 399).${notaDeRecusa}`,
    }
  }

  return {
    veredito: 'falhou',
    testes,
    motivo: `${falhas.length} de ${testes.length} tela(s) testada(s) não respondeu(ram) bem: ${falhas.map((f) => f.caminho).join(', ')}.${notaDeRecusa}`,
  }
}
