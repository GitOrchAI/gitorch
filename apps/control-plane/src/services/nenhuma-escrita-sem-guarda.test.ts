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

  /**
   * O OUTRO lado do fail-closed — e o que ele custou.
   *
   * As varreduras acima cuidam de escrita SEM guarda. Este cuida do inverso: o
   * relógio chamando um serviço guardado e esquecendo de entregar o nível do
   * projeto. Aí o `?? fetchSemPermissao()` faz exatamente o que promete, cai no
   * nível mais restrito, e o produto para de trabalhar em silêncio.
   *
   * Não é hipótese. Medido em produção em 30/08/2026: o Scrum Master saiu de 82
   * missões concluídas e zero falhas (29/08) para 5 falhas e nenhuma entrega,
   * todas com "EscritaNaoAutorizadaError: Não posso organizar o quadro" — com os
   * dois projetos em `cuidar`. `runSmDelegation` e `runSmWatchdog` eram chamados
   * sem `fetchImpl`, enquanto o PO, poucas linhas acima, já usava
   * `fetchDoQuadro(project)`.
   *
   * Um fail-closed que ninguém vê falhar é um interruptor de desligar o produto.
   */
  it('quem chama serviço guardado no relógio entrega o nível do projeto', () => {
    const servicos = readdirSync(join(RAIZ, 'services'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) =>
        readFileSync(join(RAIZ, 'services', f), 'utf8').includes('?? fetchSemPermissao()')
      )

    // Só as funções que ACEITAM `fetchImpl`, e não toda função exportada do
    // módulo. A diferença importa: `runDuvidaTecnicaViaRa` recebe `repository`
    // e não escreve nada no GitHub — ali o repositório é contexto para o
    // prompt do agente. Cobrar dela um fetch com permissão seria um alarme
    // falso permanente, e alarme falso permanente é como se aprende a ignorar
    // o vermelho.
    const guardados = new Set<string>()
    for (const f of servicos) {
      const src = readFileSync(join(RAIZ, 'services', f), 'utf8')
      // Os tipos de opções que têm `fetchImpl` — é o que marca quem escreve.
      const tiposComFetch = new Set<string>()
      for (const m of src.matchAll(/(?:interface|type)\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
        if (m[1] && m[2] && /\bfetchImpl\??:/.test(m[2])) tiposComFetch.add(m[1])
      }
      for (const m of src.matchAll(
        /export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*:/g
      )) {
        const nome = m[1]
        const params = m[2] ?? ''
        if (!nome) continue
        const aceitaFetch =
          /\bfetchImpl\??:/.test(params) || [...tiposComFetch].some((t) => params.includes(t))
        if (aceitaFetch) guardados.add(nome)
      }
    }

    const scheduler = readFileSync(join(RAIZ, 'plugins', 'scheduler.ts'), 'utf8')
    const semNivel: string[] = []

    for (const nome of guardados) {
      // Cada chamada `nome({ ... })` do relógio; o corpo vai até o fecha-chaves
      // no mesmo recuo da abertura, que é como este arquivo é formatado.
      const re = new RegExp(`\\b${nome}\\(\\{\\n([\\s\\S]*?)\\n(\\s*)\\}\\)`, 'g')
      for (const m of scheduler.matchAll(re)) {
        const corpo = m[1] ?? ''
        // Só cobra de quem escreve em repositório de CLIENTE: uma chamada que
        // não nomeia repositório nenhum não tem nível para entregar.
        if (!/repository:/.test(corpo)) continue
        if (!/fetchImpl:/.test(corpo)) {
          semNivel.push(`${nome}() — chamada com \`repository:\` e sem \`fetchImpl:\``)
        }
      }
    }

    expect(
      semNivel,
      [
        'Serviço guardado chamado sem o nível de autonomia do projeto.',
        '',
        'O default é `?? fetchSemPermissao()`: quem não recebe o nível cai no',
        'mais restrito e RECUSA toda escrita — o produto para de trabalhar sem',
        'ninguém perceber. Foi assim que a esteira parou em 30/08/2026.',
        '',
        'Passe `fetchImpl: fetchDoQuadro(project)`, como o PO já faz.',
        '',
        'Encontrados:',
        ...semNivel.map((x) => `  ${x}`),
      ].join('\n')
    ).toEqual([])
  })
})
