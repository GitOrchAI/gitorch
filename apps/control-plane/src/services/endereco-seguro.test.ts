import { afterEach, describe, expect, it, vi } from 'vitest'
import { buscarComGuarda, enderecoPermitido } from './endereco-seguro.js'

describe('enderecoPermitido', () => {
  it('permite endereço público comum', () => {
    expect(enderecoPermitido('https://jardimdaspatinhas.com.br/products').permitido).toBe(true)
  })

  it.each([
    'http://127.0.0.1:3011',
    'http://localhost:4011/',
    'https://[::1]/',
    'http://10.0.0.5/api',
    'http://192.168.1.10/',
    'http://172.16.4.4/',
    'http://169.254.169.254/latest/meta-data/',
    'http://algo.internal/',
  ])('bloqueia rede interna: %s', (u) => {
    expect(enderecoPermitido(u).permitido).toBe(false)
  })

  it.each(['file:///etc/passwd', 'ftp://x/y', 'gopher://x'])(
    'bloqueia esquema não-web: %s',
    (u) => {
      expect(enderecoPermitido(u).permitido).toBe(false)
    }
  )

  it('bloqueia domínio que apenas COMEÇA com um permitido', () => {
    expect(enderecoPermitido('http://localhost.atacante.com/').permitido).toBe(false)
  })

  it('bloqueia texto que não é endereço', () => {
    expect(enderecoPermitido('não é url').permitido).toBe(false)
  })

  // --- Casos além do brief: fechando desvios reais de SSRF ---

  it('bloqueia nome interno mesmo com maiúsculas (comparação normaliza caixa)', () => {
    expect(enderecoPermitido('http://LOCALHOST/').permitido).toBe(false)
  })

  it('bloqueia domínio ".local" (mDNS/rede interna), mesmo formato de ".internal"', () => {
    expect(enderecoPermitido('http://impressora.local/').permitido).toBe(false)
  })

  it('não bloqueia por falso positivo: nome que só CONTÉM "localhost" como substring', () => {
    // "notlocalhost.com" não tem "localhost" como rótulo exato — é um domínio
    // público normal. Bloquear por substring seria bloqueio cego demais.
    expect(enderecoPermitido('http://notlocalhost.com/').permitido).toBe(true)
  })

  it.each(['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/'])(
    'bloqueia loopback disfarçado por codificação alternativa de IPv4: %s',
    (u) => {
      expect(enderecoPermitido(u).permitido).toBe(false)
    }
  )

  it('bloqueia endereço "esta rede" 0.0.0.0', () => {
    expect(enderecoPermitido('http://0.0.0.0/').permitido).toBe(false)
  })

  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.5]/',
    'http://[::ffff:169.254.169.254]/',
  ])('bloqueia IPv4 interno mapeado em IPv6: %s', (u) => {
    expect(enderecoPermitido(u).permitido).toBe(false)
  })

  it('bloqueia link-local IPv6 fora do prefixo literal "fe80:" (fe80::/10 é uma faixa, não uma string)', () => {
    // fe81::/16 ainda está dentro de fe80::/10, mas não começa com a string
    // exata "fe80:" — uma checagem por prefixo de texto deixaria isso passar.
    expect(enderecoPermitido('http://[fe81::1]/').permitido).toBe(false)
  })

  it('bloqueia rede local única IPv6 (fc00::/7)', () => {
    expect(enderecoPermitido('http://[fd12:3456::1]/').permitido).toBe(false)
  })

  it('bloqueia multicast IPv6 (ff00::/8)', () => {
    expect(enderecoPermitido('http://[ff02::1]/').permitido).toBe(false)
  })

  it('bloqueia endereço IPv6 não especificado (::)', () => {
    expect(enderecoPermitido('http://[::]/').permitido).toBe(false)
  })

  it('devolve o motivo junto do veredito (não só o booleano)', () => {
    const r = enderecoPermitido('http://127.0.0.1/')
    expect(r.permitido).toBe(false)
    expect(r.motivo.length).toBeGreaterThan(0)
  })
})

describe('buscarComGuarda', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('endereço interno é recusado sem sequer chamar a rede', async () => {
    const chamada = vi.fn()
    vi.stubGlobal('fetch', chamada)

    await expect(buscarComGuarda('http://127.0.0.1:3011')).rejects.toThrow(/interna|recus/i)
    expect(chamada).not.toHaveBeenCalled()
  })

  it('devolve status e corpo de uma resposta pública normal', async () => {
    const chamada = vi.fn().mockResolvedValue(new Response('<html>ok</html>', { status: 200 }))
    vi.stubGlobal('fetch', chamada)

    const r = await buscarComGuarda('https://jardimdaspatinhas.com.br/')
    expect(r.status).toBe(200)
    expect(r.corpo).toBe('<html>ok</html>')
  })

  it('nunca envia cabeçalho de autorização à rede', async () => {
    const chamada = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', chamada)

    await buscarComGuarda('https://jardimdaspatinhas.com.br/')

    const opcoesUsadas = chamada.mock.calls[0]?.[1] as RequestInit | undefined
    const cabecalhos = new Headers(opcoesUsadas?.headers ?? {})
    expect(cabecalhos.has('authorization')).toBe(false)
  })

  it('desvio para endereço interno é recusado, sem seguir o redirecionamento', async () => {
    const chamada = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    )
    vi.stubGlobal('fetch', chamada)

    await expect(
      buscarComGuarda('https://jardimdaspatinhas.com.br/vai-redirecionar')
    ).rejects.toThrow(/interna|recus/i)
    expect(chamada).toHaveBeenCalledTimes(1)
  })

  it('segue desvio público normalmente e chega ao destino final', async () => {
    const chamada = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://jardimdaspatinhas.com.br/destino' },
        })
      )
      .mockResolvedValueOnce(new Response('destino final', { status: 200 }))
    vi.stubGlobal('fetch', chamada)

    const r = await buscarComGuarda('https://jardimdaspatinhas.com.br/origem')
    expect(r.status).toBe(200)
    expect(r.corpo).toBe('destino final')
    expect(chamada).toHaveBeenCalledTimes(2)
  })

  it('cadeia de desvios além do limite vira erro claro, nunca segue para sempre', async () => {
    const chamada = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://jardimdaspatinhas.com.br/proximo' },
      })
    )
    vi.stubGlobal('fetch', chamada)

    await expect(buscarComGuarda('https://jardimdaspatinhas.com.br/inicio')).rejects.toThrow(
      /desvio|redirecion/i
    )
    // no máximo 3 desvios seguidos ao inicial: 1 chamada inicial + 3 desvios = 4
    expect(chamada).toHaveBeenCalledTimes(4)
  })

  it('tempo limite vira erro claro em vez de travar para sempre', async () => {
    const chamada = vi.fn().mockImplementation((_url: string, opcoes?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opcoes?.signal?.addEventListener('abort', () => {
          const erro = new Error('The operation was aborted')
          erro.name = 'AbortError'
          reject(erro)
        })
      })
    })
    vi.stubGlobal('fetch', chamada)

    await expect(
      buscarComGuarda('https://jardimdaspatinhas.com.br/lento', { timeoutMs: 20 })
    ).rejects.toThrow(/tempo/i)
  })

  it('corpo gigante é cortado no teto, não devolvido inteiro', async () => {
    const tamanhoEnviado = 300 * 1024 // 300 KB, acima do teto de 256 KB
    const corpoGigante = new Uint8Array(tamanhoEnviado).fill(97) // 'a' repetido
    const chamada = vi.fn().mockResolvedValue(new Response(corpoGigante, { status: 200 }))
    vi.stubGlobal('fetch', chamada)

    const r = await buscarComGuarda('https://jardimdaspatinhas.com.br/arquivo-grande')
    expect(r.corpo.length).toBeLessThanOrEqual(256 * 1024)
    expect(r.corpo.length).toBeLessThan(tamanhoEnviado)
  })
})
