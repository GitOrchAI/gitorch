import { describe, it, expect } from 'vitest'
import { podeEscrever } from '@gitorch/cadence'
import { createGithubBacklog } from './github-backlog.js'
import { classificarRequisicao } from './guarda-de-autonomia.js'
import { GithubExecutionError } from './github-errors.js'

// L3-T8 — o peso no QUADRO do cliente.
//
// O dono: "as issues são rasas, isso não garante qualidade no peso da entrega.
// Quando é P2, quando é P0? não vejo visualmente no GitHub". Corpo de issue é
// texto que ele abre; o que ele vê de relance é o card. `weight` era exigido
// do modelo desde sempre e nunca saía do balanceamento de sprint.
//
// O fake abaixo não é um "sim, senhor": ele MODELA o quadro (campos + valor
// por item) e recusa o que a API real recusa — nome de campo duplicado
// ("Name has already been taken", provado ao vivo em 31/08/2026) e valor
// gravado em campo inexistente. As asserções olham o ESTADO final do quadro.

interface CampoDoQuadro {
  id: string
  name: string
  dataType: string
  typename: string
}

function quadroDeMentira(
  camposIniciais: CampoDoQuadro[] = [],
  opcoes: {
    /**
     * Faz a CRIAÇÃO do campo falhar com esta mensagem, com o quadro ainda sem
     * o campo. É a corrida real: outro tique criou "Peso" entre a leitura e a
     * criação, ou o GraphQL respondeu 502 no meio do plano.
     */
    falhaAoCriar?: string
  } = {}
) {
  const campos = [...camposIniciais]
  /** itemId → (fieldId → número). É o que o cliente enxerga no card. */
  const valores = new Map<string, Map<string, number>>()
  /** Quantas vezes o quadro do cliente foi LIDO. O cache se mede aqui. */
  let leiturasDeCampos = 0
  let proximoCampo = 0

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url)
    if (!endereco.includes('/graphql')) {
      return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
    }
    const { query, variables } = JSON.parse(String(init?.body ?? '{}')) as {
      query: string
      variables: { name?: string; fieldId?: string; itemId?: string; number?: number }
    }

    if (query.includes('createProjectV2Field')) {
      if (opcoes.falhaAoCriar) {
        return new Response(JSON.stringify({ errors: [{ message: opcoes.falhaAoCriar }] }), {
          status: 200,
        })
      }
      const nome = String(variables.name)
      if (campos.some((c) => c.name === nome)) {
        // Exatamente o que a API real responde — e o que produziu o laço
        // eterno do campo Sprint quando o produto tratava homônimo como
        // ausência.
        return new Response(
          JSON.stringify({ errors: [{ message: 'Name has already been taken' }] }),
          {
            status: 200,
          }
        )
      }
      proximoCampo += 1
      const campo: CampoDoQuadro = {
        id: `F_${proximoCampo}`,
        name: nome,
        dataType: query.includes('dataType: NUMBER') ? 'NUMBER' : 'TEXT',
        typename: 'ProjectV2Field',
      }
      campos.push(campo)
      return new Response(
        JSON.stringify({
          data: { createProjectV2Field: { projectV2Field: { id: campo.id, name: campo.name } } },
        }),
        { status: 200 }
      )
    }

    if (query.includes('updateProjectV2ItemFieldValue')) {
      const fieldId = String(variables.fieldId)
      const campo = campos.find((c) => c.id === fieldId)
      if (!campo || campo.dataType !== 'NUMBER') {
        return new Response(
          JSON.stringify({ errors: [{ message: `campo ${fieldId} não é NUMBER` }] }),
          { status: 200 }
        )
      }
      const itemId = String(variables.itemId)
      const doItem = valores.get(itemId) ?? new Map<string, number>()
      doItem.set(fieldId, Number(variables.number))
      valores.set(itemId, doItem)
      return new Response(
        JSON.stringify({
          data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } },
        }),
        { status: 200 }
      )
    }

    // Leitura dos campos do quadro.
    leiturasDeCampos += 1
    return new Response(
      JSON.stringify({
        data: {
          node: {
            fields: {
              nodes: campos.map((c) => ({
                __typename: c.typename,
                id: c.id,
                name: c.name,
                dataType: c.dataType,
              })),
            },
          },
        },
      }),
      { status: 200 }
    )
  }

  /** O que o dono veria no card: o número gravado no campo "Peso". */
  const pesoNoCard = (itemId: string): number | undefined => {
    const campo = campos.find((c) => c.name === 'Peso' && c.dataType === 'NUMBER')
    if (!campo) return undefined
    return valores.get(itemId)?.get(campo.id)
  }

  return {
    campos,
    valores,
    pesoNoCard,
    leituras: () => leiturasDeCampos,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  }
}

describe('campo Peso no quadro', () => {
  it('quadro sem o campo: cria "Peso" como NUMBER e grava o valor no card', async () => {
    const quadro = quadroDeMentira()
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: quadro.fetchImpl,
    })

    await backlog.setWeight?.('PVTI_1', 3)

    const criado = quadro.campos.find((c) => c.name === 'Peso')
    expect(criado?.dataType).toBe('NUMBER')
    expect(quadro.pesoNoCard('PVTI_1')).toBe(3)
  })

  it('campo já existe: REUSA, não tenta criar de novo (o laço eterno do Sprint)', async () => {
    const quadro = quadroDeMentira([
      { id: 'F_ja', name: 'Peso', dataType: 'NUMBER', typename: 'ProjectV2Field' },
    ])
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: quadro.fetchImpl,
    })

    await backlog.setWeight?.('PVTI_1', 5)

    // Se tivesse tentado criar, o fake teria devolvido "Name has already been
    // taken" e a chamada teria estourado; o valor no card prova o reuso.
    expect(quadro.campos.filter((c) => c.name === 'Peso')).toHaveLength(1)
    expect(quadro.pesoNoCard('PVTI_1')).toBe(5)
  })

  it('dois cards, dois pesos — o valor não vaza de um item para o outro', async () => {
    const quadro = quadroDeMentira()
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: quadro.fetchImpl,
    })

    await backlog.setWeight?.('PVTI_1', 3)
    await backlog.setWeight?.('PVTI_2', 13)

    expect(quadro.pesoNoCard('PVTI_1')).toBe(3)
    expect(quadro.pesoNoCard('PVTI_2')).toBe(13)
    // Um campo só: dois cards não podem produzir dois campos "Peso" no quadro
    // do cliente. (O CACHE da resolução é outra afirmação, e tem teste
    // próprio logo abaixo — este aqui passaria sem cache nenhum, porque a
    // segunda leitura já acharia o campo criado na primeira.)
    expect(quadro.campos.filter((c) => c.name === 'Peso')).toHaveLength(1)
  })

  it('sem quadro, o peso vira silêncio útil — a issue e o corpo continuam valendo', async () => {
    const quadro = quadroDeMentira()
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      fetchImpl: quadro.fetchImpl,
    })

    await expect(backlog.setWeight?.('', 3)).resolves.toBeUndefined()
    expect(quadro.campos).toEqual([])
    expect(quadro.valores.size).toBe(0)
  })

  it('homônimo de outro tipo NÃO é mascarado: o dono precisa resolver, e o plano segue', async () => {
    // Um campo de TEXTO chamado "Peso" (alguém criou na mão). Criar de novo é
    // recusado para sempre; gravar número nele é impossível. O peso do card se
    // perde — mas o plano inteiro não pode cair por causa da vitrine.
    const quadro = quadroDeMentira([
      { id: 'F_texto', name: 'Peso', dataType: 'TEXT', typename: 'ProjectV2Field' },
    ])
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: quadro.fetchImpl,
    })

    await expect(backlog.setWeight?.('PVTI_1', 3)).resolves.toBeUndefined()
    expect(quadro.pesoNoCard('PVTI_1')).toBeUndefined()
    // E não ficou um segundo campo "Peso" pendurado no quadro do cliente.
    expect(quadro.campos).toHaveLength(1)
  })

  it('a resolução é CACHEADA: N cards, UMA leitura do quadro do cliente', async () => {
    // O comentário do código promete "resolvido UMA vez por execução do
    // plano", e até aqui nada cobrava isso — apagar o cache não derrubava
    // teste nenhum, porque a segunda leitura simplesmente reencontrava o
    // campo criado na primeira. O efeito observável do cache é o número de
    // idas ao quadro do cliente: um plano de 30 tasks faria 30 leituras do
    // quadro em vez de 1, e é a cota da API do cliente que paga.
    const quadro = quadroDeMentira()
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: quadro.fetchImpl,
    })

    await backlog.setWeight?.('PVTI_1', 3)
    await backlog.setWeight?.('PVTI_2', 5)
    await backlog.setWeight?.('PVTI_3', 8)

    expect(quadro.leituras()).toBe(1)
    // E o resultado continua certo — cache que "economiza" errando não serve.
    expect(quadro.pesoNoCard('PVTI_3')).toBe(8)
  })

  it('falha ao CRIAR o campo sobe como GithubExecutionError, não crua', async () => {
    // `applyBacklog` já criou as issues quando chega aqui. Um erro solto
    // atravessando o plano no meio deixa o trabalho pela metade e chega ao
    // dono como um `Error` anônimo do cliente de GraphQL. O irmão
    // `resolveSprint`, no mesmo arquivo, embrulha em `GithubExecutionError`
    // exatamente por isso — e é o tipo que o resto do produto reconhece.
    const quadro = quadroDeMentira([], { falhaAoCriar: 'Name has already been taken' })
    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: quadro.fetchImpl,
    })

    await expect(backlog.setWeight?.('PVTI_1', 3)).rejects.toBeInstanceOf(GithubExecutionError)
    // A mensagem original não pode sumir no embrulho: sem ela ninguém
    // descobre POR QUE o quadro recusou.
    await expect(backlog.setWeight?.('PVTI_1', 3)).rejects.toThrow(/Name has already been taken/)
  })
})

describe('a guarda de autonomia cobre o peso', () => {
  it('as DUAS escritas novas no quadro do cliente são classificadas como "organizar"', async () => {
    // A guarda é regex sobre o CORPO que sai na rede, então a única prova que
    // vale é passar por ela o corpo REAL que este código emite — não uma
    // string escrita à mão no teste. Uma mutation que ninguém classificou cai
    // em `mesclar` (o degrau mais alto) e o plano inteiro seria recusado em
    // qualquer nível abaixo de "cuidar", sem ninguém entender por quê.
    const corpos: string[] = []
    const quadro = quadroDeMentira()
    const espiao = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/graphql')) corpos.push(String(init?.body ?? ''))
      return quadro.fetchImpl(url as string, init)
    }) as unknown as typeof fetch

    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_1',
      fetchImpl: espiao,
    })
    await backlog.setWeight?.('PVTI_1', 3)

    const escritas = corpos.filter((c) => c.includes('mutation'))
    expect(escritas).toHaveLength(2) // criar o campo + gravar o valor
    for (const corpo of escritas) {
      expect(
        classificarRequisicao({
          url: 'https://api.github.com/graphql',
          metodo: 'POST',
          corpo,
        })
      ).toBe('organizar')
    }
    // E a leitura dos campos continua sendo LEITURA — classificá-la como
    // escrita faria o produto pedir licença para olhar o quadro.
    const leitura = corpos.find((c) => !c.includes('mutation'))!
    expect(
      classificarRequisicao({
        url: 'https://api.github.com/graphql',
        metodo: 'POST',
        corpo: leitura,
      })
    ).toBe('ler')
  })

  it('"organizar" já passa no nível SUGERIR — o peso NÃO exige "cuidar"', () => {
    // RETRATAÇÃO (31/08/2026). O relato desta entrega afirmou que criar o
    // campo "Peso" exigiria autonomia "cuidar ou acima". É FALSO, e o erro
    // quase chegou ao dono. As duas escritas são `organizar` (teste acima), e
    // a tabela em packages/cadence/src/autonomia.ts libera `organizar` já em
    // `sugerir` — só `mesclar` pede `cuidar`. O número certo passa a morar
    // aqui, colado ao teste que classifica as mutations, para a mesma
    // afirmação não poder ser feita de novo sem alguém ficar vermelho.
    expect(podeEscrever('sugerir', 'organizar').pode).toBe(true)
    expect(podeEscrever('so_olhar', 'organizar').pode).toBe(false)
    // E o degrau que de fato exige "cuidar" é outro — o contraste é o ponto.
    expect(podeEscrever('sugerir', 'mesclar').pode).toBe(false)
  })
})
