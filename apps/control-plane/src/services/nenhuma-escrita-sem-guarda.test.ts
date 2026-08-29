import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A guarda de autonomia só vale se NENHUM caminho escapar dela. E o jeito de um
// caminho escapar não é malícia: é alguém escrever `fetch('https://api.github.com/...')`
// num arquivo novo, sem saber que existe uma porta.
//
// Foi exatamente o que a auditoria do bloco 4 achou: a guarda existia e ONZE
// chamadas cruas dentro do relógio passavam por fora dela, abrindo, comentando
// e fechando issue no repositório do cliente. Este teste é o que faz esse furo
// não voltar em silêncio — se voltar, ele fica vermelho e diz onde.
//
// Não é análise estática de verdade; é uma varredura de texto. Ela erra para o
// lado de reclamar demais, e isso é de propósito: um falso alarme custa um
// comentário, um furo custa escrita no repositório de um cliente.

const RAIZ = join(__dirname, '..')

/**
 * O que conta como chamada crua PERIGOSA.
 *
 * Não é "qualquer api.github.com": ler a conta do dono (`/user`, `/user/emails`,
 * `/installation/repositories`) não toca repositório de cliente nenhum, e
 * marcar isso encheria a lista de exceções até ela não querer dizer mais nada.
 *
 * Perigoso é: um caminho de REPOSITÓRIO (`/repos/`, `/repositories/`), o
 * GraphQL (por onde saem as mutations do quadro), ou uma URL MONTADA — porque
 * numa URL montada o caminho não dá para saber lendo, e o que não dá para saber
 * conta como perigoso.
 */
const CHAMADA_CRUA =
  /(?<![\w.])fetch\s*\(\s*[`'"]https:\/\/api\.github\.com(\/repos\/|\/repositories\/|\/graphql|\$\{)/

/**
 * Arquivos que PODEM conter a chamada crua, com o motivo.
 *
 * Esta lista é curta de propósito. Crescer aqui é um sinal, não uma solução:
 * quem acrescentar uma linha precisa dizer por que aquele caminho não escreve
 * no repositório de um cliente.
 */
const PERMITIDOS: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'services/guarda-de-autonomia.ts',
    'é a PRÓPRIA porta: o `?? fetch` dela é onde o fetch do runtime entra para ser embrulhado — é o começo da corrente, não um furo nela',
  ],
  // Fora essa, VAZIA, e isso é a notícia: depois do conserto do bloco 4 não sobrou UM
  // caminho de produção que fale com o repositório do cliente por fora da
  // porta. Quem precisar acrescentar algo aqui tem que escrever POR QUE aquele
  // caminho não escreve no repositório de um cliente — e a resposta "é mais
  // fácil assim" não serve.
])

function arquivosTs(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) {
      arquivosTs(caminho, acc)
    } else if (nome.endsWith('.ts') && !nome.endsWith('.test.ts')) {
      acc.push(caminho)
    }
  }
  return acc
}

describe('nenhuma escrita no GitHub sai por fora da guarda', () => {
  it('nenhum arquivo de produção chama api.github.com com fetch cru', () => {
    const infratores: string[] = []

    for (const caminho of arquivosTs(RAIZ)) {
      const relativo = caminho.slice(RAIZ.length + 1)
      if (PERMITIDOS.has(relativo)) continue

      const linhas = readFileSync(caminho, 'utf8').split('\n')
      linhas.forEach((linha, i) => {
        if (CHAMADA_CRUA.test(linha)) {
          infratores.push(`${relativo}:${i + 1} — ${linha.trim().slice(0, 90)}`)
        }
      })
    }

    // A mensagem importa tanto quanto a falha: quem quebrar este teste daqui a
    // seis meses precisa entender o que fazer sem ler esta conversa.
    expect(
      infratores,
      [
        'Chamada ao GitHub sem passar pela guarda de autonomia.',
        '',
        'Use uma destas, em vez de `fetch` direto:',
        '  fetchDoRepositorio({ nivel })  — quando você TEM o projeto em mãos',
        '  guardaPorRepositorio(...)      — quando o repositório está na URL',
        '  fetchSemPermissao()            — só leitura, ou padrão que falha fechado',
        '',
        'Se este caminho realmente não escreve no repositório de um cliente,',
        'acrescente-o a PERMITIDOS neste arquivo COM O MOTIVO.',
        '',
        'Encontrados:',
        ...infratores.map((x) => `  ${x}`),
      ].join('\n')
    ).toEqual([])
  })

  // A SEGUNDA classe de furo, e a mais silenciosa: o arquivo não chama
  // api.github.com nenhuma vez — ele só ENTREGA o `fetch` cru para outro módulo
  // (um ProjectV2Client, um mover de card) que escreve por ele. A varredura de
  // cima não vê isso. Foi assim que board-status.ts ficou de fora do primeiro
  // conserto: o furo estava no `?? fetch` do default, não numa chamada.
  it('nenhum default cai no `?? fetch` cru — o padrão tem que falhar fechado', () => {
    const infratores: string[] = []
    const DEFAULT_CRU = /\?\?\s*fetch\s*[),\n]/

    for (const caminho of arquivosTs(RAIZ)) {
      const relativo = caminho.slice(RAIZ.length + 1)
      if (PERMITIDOS.has(relativo)) continue
      const texto = readFileSync(caminho, 'utf8')
      // Só interessa quem fala com o GitHub. Um `?? fetch` num cliente de
      // Telegram ou do dev assíncrono não escreve no repositório de ninguém.
      if (!/api\.github\.com|ProjectV2Client|createCardMover/.test(texto)) continue

      texto.split('\n').forEach((linha, i) => {
        if (DEFAULT_CRU.test(linha)) {
          infratores.push(`${relativo}:${i + 1} — ${linha.trim().slice(0, 90)}`)
        }
      })
    }

    expect(
      infratores,
      [
        'Um default `?? fetch` num módulo que fala com o GitHub.',
        '',
        'Quem esquece de passar um fetch com permissão tem que FALHAR FECHADO.',
        'Troque por `?? fetchSemPermissao()` — leitura continua passando, e',
        'qualquer escrita é recusada com o motivo em vez de sair sem guarda.',
        '',
        'Encontrados:',
        ...infratores.map((x) => `  ${x}`),
      ].join('\n')
    ).toEqual([])
  })

  it('a lista de permitidos tem só a própria porta', () => {
    // Hoje é UM, e é a própria porta. Se um dia crescer, que seja por uma
    // decisão escrita, e não por alguém empurrar um arquivo para dentro da
    // lista para o vermelho sumir. Este número é o freio.
    expect(PERMITIDOS.size).toBeLessThanOrEqual(2)
  })

  it('todo permitido tem um motivo escrito', () => {
    for (const [arquivo, motivo] of PERMITIDOS) {
      expect(motivo.length, `${arquivo} está na lista sem motivo`).toBeGreaterThan(20)
    }
  })
})
