import { describe, it, expect, vi } from 'vitest'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import { guardaDeAutonomia, classificarRequisicao, vaiParaOGithub } from './guarda-de-autonomia.js'

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
