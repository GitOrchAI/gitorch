import { describe, it, expect, vi } from 'vitest'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import {
  guardaDeAutonomia,
  guardaPorRepositorio,
  repositorioDaUrl,
  classificarRequisicao,
  vaiParaOGithub,
  type DonoDoRepositorio,
} from './guarda-de-autonomia.js'

const GRAPHQL = 'https://api.github.com/graphql'
const REPO = 'https://api.github.com/repos/dono/repo'

function fetchFalso() {
  return vi.fn(async () => new Response('{}', { status: 200 }))
}

describe('classificarRequisicao — o que cada chamada representa', () => {
  it('GET é leitura, não importa a rota', () => {
    expect(classificarRequisicao({ url: `${REPO}/issues`, metodo: 'GET' })).toBe('ler')
    expect(classificarRequisicao({ url: `${REPO}/pulls/7/merge`, metodo: 'GET' })).toBe('ler')
  })

  it('consulta ao quadro chega por POST e ainda assim é leitura', () => {
    // O defeito óbvio seria classificar pelo método: no GraphQL toda leitura
    // também é POST, e a tela do painel pararia de carregar no nível "só olhar".
    const corpo = JSON.stringify({
      query: 'query GetIterationField($id: ID!) { node(id: $id) { id } }',
    })
    expect(classificarRequisicao({ url: GRAPHQL, metodo: 'POST', corpo })).toBe('ler')
  })

  it('mutation do quadro é "organizar"', () => {
    for (const op of [
      'createProjectV2Field',
      'updateProjectV2Field',
      'addProjectV2ItemById',
      'updateProjectV2ItemFieldValue',
      'archiveProjectV2Item',
      'createProjectV2',
      'linkProjectV2ToRepository',
    ]) {
      const corpo = JSON.stringify({ query: `mutation X { ${op}(input: {}) { id } }` })
      expect(classificarRequisicao({ url: GRAPHQL, metodo: 'POST', corpo })).toBe('organizar')
    }
  })

  it('abrir pedido, comentar e mexer no pedido é "propor"', () => {
    expect(classificarRequisicao({ url: `${REPO}/issues`, metodo: 'POST' })).toBe('propor')
    expect(classificarRequisicao({ url: `${REPO}/issues/12/comments`, metodo: 'POST' })).toBe(
      'propor'
    )
    expect(classificarRequisicao({ url: `${REPO}/issues/12`, metodo: 'PATCH' })).toBe('propor')
  })

  it('rótulo e marco são "organizar" — arrumam o que existe, não propõem', () => {
    expect(classificarRequisicao({ url: `${REPO}/labels`, metodo: 'POST' })).toBe('organizar')
    expect(classificarRequisicao({ url: `${REPO}/milestones`, metodo: 'POST' })).toBe('organizar')
    expect(classificarRequisicao({ url: `${REPO}/issues/12/labels`, metodo: 'POST' })).toBe(
      'organizar'
    )
  })

  it('o merge é "mesclar" — e vem ANTES da regra geral de pull request', () => {
    expect(classificarRequisicao({ url: `${REPO}/pulls/7/merge`, metodo: 'PUT' })).toBe('mesclar')
    expect(classificarRequisicao({ url: `${REPO}/pulls`, metodo: 'POST' })).toBe('propor')
  })

  it('emitir token NÃO é escrita no repositório — senão o produto inteiro para', () => {
    // Armadilha real: `POST /app/installations/N/access_tokens` é o caminho
    // por onde TUDO passa, inclusive a leitura. Classificá-lo como escrita
    // desconhecida deixaria o produto sem credencial em qualquer nível abaixo
    // de "cuidar" — e nem a tela do painel carregaria.
    expect(
      classificarRequisicao({
        url: 'https://api.github.com/app/installations/123/access_tokens',
        metodo: 'POST',
      })
    ).toBe('ler')
    expect(classificarRequisicao({ url: 'https://api.github.com/user/repos', metodo: 'GET' })).toBe(
      'ler'
    )
    expect(classificarRequisicao({ url: 'https://api.github.com/orgs/acme', metodo: 'GET' })).toBe(
      'ler'
    )
  })

  it('corpo ILEGÍVEL no GraphQL cai no desconhecido, não em leitura', () => {
    // A auditoria pegou isto: a versão anterior devolvia 'ler' quando o corpo
    // não era string. Bastava um Request com corpo em fluxo para uma mutation
    // atravessar a porta classificada como leitura.
    expect(classificarRequisicao({ url: GRAPHQL, metodo: 'POST', corpo: null })).toBe('mesclar')
    expect(classificarRequisicao({ url: GRAPHQL, metodo: 'POST' })).toBe('mesclar')
  })

  it('a forma /repositories/{id}/ também é o repositório do cliente', () => {
    // A API do GitHub aceita as duas formas. Cobrir só /repos/ deixava esta
    // cair em 'ler' — escrita passando como leitura.
    expect(
      classificarRequisicao({
        url: 'https://api.github.com/repositories/1319993284/issues',
        metodo: 'POST',
      })
    ).toBe('propor')
    expect(
      classificarRequisicao({
        url: 'https://api.github.com/repositories/1319993284/pulls/7/merge',
        metodo: 'PUT',
      })
    ).toBe('mesclar')
  })

  it('escrita DESCONHECIDA cai no degrau mais alto, nunca no mais baixo', () => {
    // Uma rota nova que ninguém classificou não pode vazar num nível baixo.
    expect(classificarRequisicao({ url: `${REPO}/rota-inventada`, metodo: 'DELETE' })).toBe(
      'mesclar'
    )
    expect(classificarRequisicao({ url: `${REPO}/git/refs`, metodo: 'POST' })).toBe('mesclar')
    const corpo = JSON.stringify({ query: 'mutation Nova { operacaoQueNaoExisteAinda { id } }' })
    expect(classificarRequisicao({ url: GRAPHQL, metodo: 'POST', corpo })).toBe('mesclar')
  })
})

describe('vaiParaOGithub — host EXATO', () => {
  it('reconhece o GitHub', () => {
    expect(vaiParaOGithub(GRAPHQL)).toBe(true)
  })

  it('NÃO cai num domínio que apenas começa igual', () => {
    // O furo do SSRF era exatamente este: startsWith deixa passar
    // "api.github.com.dominio-alheio.tld".
    expect(vaiParaOGithub('https://api.github.com.dominio-alheio.tld/repos/x/y/issues')).toBe(false)
    expect(vaiParaOGithub('https://evil.com/api.github.com/issues')).toBe(false)
  })

  it('não opina sobre o que não é do GitHub', () => {
    expect(vaiParaOGithub('https://api.telegram.org/bot/sendMessage')).toBe(false)
  })
})

describe('guardaDeAutonomia — a escrita é BARRADA na porta', () => {
  it('no nível "só olhar", abrir um pedido nem chega a sair', async () => {
    const f = fetchFalso()
    const guardado = guardaDeAutonomia(f, () => 'so_olhar')
    await expect(
      guardado(`${REPO}/issues`, { method: 'POST', body: '{"title":"x"}' })
    ).rejects.toBeInstanceOf(EscritaNaoAutorizadaError)
    // A prova de que é barrada na PORTA, e não apenas "não chamada": o fetch
    // de baixo não foi tocado nenhuma vez.
    expect(f).not.toHaveBeenCalled()
  })

  it('no nível "só olhar", a LEITURA passa normalmente', async () => {
    const f = fetchFalso()
    const guardado = guardaDeAutonomia(f, () => 'so_olhar')
    await guardado(`${REPO}/issues`, { method: 'GET' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('no nível "sugerir", propõe mas NÃO mescla', async () => {
    const f = fetchFalso()
    const guardado = guardaDeAutonomia(f, () => 'sugerir')
    await guardado(`${REPO}/issues`, { method: 'POST', body: '{}' })
    expect(f).toHaveBeenCalledTimes(1)
    await expect(guardado(`${REPO}/pulls/7/merge`, { method: 'PUT' })).rejects.toThrow(
      EscritaNaoAutorizadaError
    )
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('no nível "cuidar", mescla', async () => {
    const f = fetchFalso()
    const guardado = guardaDeAutonomia(f, () => 'cuidar')
    await guardado(`${REPO}/pulls/7/merge`, { method: 'PUT' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('projeto legado (nível nulo) é tratado como "só olhar"', async () => {
    const f = fetchFalso()
    const guardado = guardaDeAutonomia(f, () => null)
    await expect(guardado(`${REPO}/issues`, { method: 'POST', body: '{}' })).rejects.toThrow(
      EscritaNaoAutorizadaError
    )
    expect(f).not.toHaveBeenCalled()
  })

  it('o nível é lido NA HORA da chamada, não quando a guarda foi criada', async () => {
    // O dono muda o nível pelo painel no meio de uma varredura longa. Se o
    // valor tivesse sido capturado na criação, a mudança só valeria no
    // próximo ciclo — e uma recusa continuaria valendo depois de autorizada.
    const f = fetchFalso()
    let nivel = 'so_olhar'
    const guardado = guardaDeAutonomia(f, () => nivel)
    await expect(guardado(`${REPO}/issues`, { method: 'POST', body: '{}' })).rejects.toThrow()
    nivel = 'sugerir'
    await guardado(`${REPO}/issues`, { method: 'POST', body: '{}' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('chamada que NÃO vai para o GitHub passa sem opinião', async () => {
    const f = fetchFalso()
    const guardado = guardaDeAutonomia(f, () => 'so_olhar')
    await guardado('https://api.telegram.org/bot/sendMessage', { method: 'POST', body: '{}' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a recusa NÃO fabrica uma resposta HTTP', async () => {
    // Devolver um 403 inventado faria o chamador registrar um erro do GitHub
    // que nunca aconteceu, e o dono procuraria o problema no lugar errado.
    const guardado = guardaDeAutonomia(fetchFalso(), () => 'so_olhar')
    const erro = await guardado(`${REPO}/issues`, { method: 'POST', body: '{}' }).catch((e) => e)
    expect(erro).toBeInstanceOf(EscritaNaoAutorizadaError)
    expect(erro).not.toBeInstanceOf(Response)
  })

  it('funciona com Request e com URL, não só com string', async () => {
    const f = fetchFalso()
    const guardado = guardaDeAutonomia(f, () => 'so_olhar')
    await expect(
      guardado(new URL(`${REPO}/issues`), { method: 'POST', body: '{}' })
    ).rejects.toThrow(EscritaNaoAutorizadaError)
    await expect(
      guardado(new Request(`${REPO}/issues`, { method: 'POST', body: '{}' }))
    ).rejects.toThrow(EscritaNaoAutorizadaError)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('guardaPorRepositorio — a porta descobre o dono pelo endereço', () => {
  function dono(over: Partial<DonoDoRepositorio> = {}): DonoDoRepositorio {
    return {
      nivelDoRepositorio: vi.fn(async (r: string) =>
        r === 'cliente/api' ? 'sugerir' : r === 'cliente/livre' ? 'cuidar' : null
      ),
      nossosRepositorios: new Set(['GitOrchAI/gitorch']),
      ...over,
    }
  }

  it('usa o nível DAQUELE repositório, não um nível global', async () => {
    const f = fetchFalso()
    const g = guardaPorRepositorio(f, dono())
    // 'sugerir' propõe...
    await g('https://api.github.com/repos/cliente/api/issues', { method: 'POST', body: '{}' })
    expect(f).toHaveBeenCalledTimes(1)
    // ...mas não mescla.
    await expect(
      g('https://api.github.com/repos/cliente/api/pulls/1/merge', { method: 'PUT' })
    ).rejects.toThrow(EscritaNaoAutorizadaError)
    // O mesmo produto, no MESMO instante, mescla no repositório que autorizou.
    await g('https://api.github.com/repos/cliente/livre/pulls/1/merge', { method: 'PUT' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('o repositório do PRÓPRIO produto passa — é a nossa casa', async () => {
    const f = fetchFalso()
    const g = guardaPorRepositorio(f, dono())
    await g('https://api.github.com/repos/GitOrchAI/gitorch/issues', {
      method: 'POST',
      body: '{}',
    })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('repositório que não é projeto nem nosso: RECUSA (fail closed)', async () => {
    const f = fetchFalso()
    const g = guardaPorRepositorio(f, dono())
    await expect(
      g('https://api.github.com/repos/estranho/repo/issues', { method: 'POST', body: '{}' })
    ).rejects.toThrow(EscritaNaoAutorizadaError)
    expect(f).not.toHaveBeenCalled()
  })

  it('leitura passa sem sequer consultar quem é o dono', async () => {
    const f = fetchFalso()
    const d = dono()
    const g = guardaPorRepositorio(f, d)
    await g('https://api.github.com/repos/estranho/repo/issues', { method: 'GET' })
    expect(f).toHaveBeenCalledTimes(1)
    expect(d.nivelDoRepositorio).not.toHaveBeenCalled()
  })

  it('escrita no GraphQL é recusada aqui — esta porta não descobre o quadro', async () => {
    // A mutation nomeia o quadro por id, não o repositório. Quem escreve no
    // quadro usa `fetchDoRepositorio`, com o nível em mãos. Inventar um dono
    // aqui seria pior que recusar.
    const f = fetchFalso()
    const g = guardaPorRepositorio(f, dono())
    await expect(
      g('https://api.github.com/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'mutation X { createProjectV2Field(input:{}){id} }' }),
      })
    ).rejects.toThrow(EscritaNaoAutorizadaError)
    expect(f).not.toHaveBeenCalled()
  })

  it('consulta ao GraphQL continua passando', async () => {
    const f = fetchFalso()
    const g = guardaPorRepositorio(f, dono())
    await g('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: 'query Q { repository { id } }' }),
    })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('o cache evita consulta repetida, mas expira', async () => {
    const f = fetchFalso()
    const d = dono()
    const g = guardaPorRepositorio(f, d, { cacheMs: 0 })
    await g('https://api.github.com/repos/cliente/api/issues', { method: 'POST', body: '{}' })
    await g('https://api.github.com/repos/cliente/api/issues', { method: 'POST', body: '{}' })
    // Com validade zero, a segunda escrita consulta de novo — é o que garante
    // que mudar o nível no painel vale rápido.
    expect(d.nivelDoRepositorio).toHaveBeenCalledTimes(2)
  })
})

describe('repositorioDaUrl', () => {
  it('acha dono/nome', () => {
    expect(repositorioDaUrl('https://api.github.com/repos/a/b/issues/1/comments')).toBe('a/b')
  })

  it('a forma por id numérico devolve null — não dá para saber de quem é', () => {
    expect(repositorioDaUrl('https://api.github.com/repositories/123/issues')).toBeNull()
  })

  it('caminho que não é de repositório devolve null', () => {
    expect(repositorioDaUrl('https://api.github.com/graphql')).toBeNull()
    expect(repositorioDaUrl('nao-e-url')).toBeNull()
  })
})
