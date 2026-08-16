import { afterEach, describe, expect, it, vi } from 'vitest'
import { buscarComGuarda, enderecoPermitido } from './endereco-seguro.js'

describe('enderecoPermitido', () => {
  it('permite endereço público comum', () => {
    expect(enderecoPermitido('https://jardimdaspatinhas.com.br/products').permitido).toBe(true)
  })

  it.each([
    ['http://127.0.0.1:3011', 'endereço IPv4 de rede interna'],
    ['http://localhost:4011/', 'aponta para a própria máquina ou nome de rede interna'],
    ['https://[::1]/', 'endereço IPv6 de rede interna'],
    ['http://10.0.0.5/api', 'endereço IPv4 de rede interna'],
    ['http://192.168.1.10/', 'endereço IPv4 de rede interna'],
    ['http://172.16.4.4/', 'endereço IPv4 de rede interna'],
    ['http://169.254.169.254/latest/meta-data/', 'endereço IPv4 de rede interna'],
    ['http://algo.internal/', 'nome de rede interna'],
  ])('bloqueia rede interna: %s (motivo: %s)', (u, motivoEsperado) => {
    const r = enderecoPermitido(u)
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe(motivoEsperado)
  })

  it.each(['file:///etc/passwd', 'ftp://x/y', 'gopher://x'])(
    'bloqueia esquema não-web: %s',
    (u) => {
      const esquema = new URL(u).protocol
      const r = enderecoPermitido(u)
      expect(r.permitido).toBe(false)
      expect(r.motivo).toBe(`esquema não permitido: ${esquema}`)
    }
  )

  it('bloqueia domínio que apenas COMEÇA com um permitido', () => {
    const r = enderecoPermitido('http://localhost.atacante.com/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('aponta para a própria máquina ou nome de rede interna')
  })

  it('bloqueia texto que não é endereço', () => {
    const r = enderecoPermitido('não é url')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('não é um endereço válido')
  })

  // --- Casos além do brief: fechando desvios reais de SSRF ---

  it('bloqueia nome interno mesmo com maiúsculas (comparação normaliza caixa)', () => {
    const r = enderecoPermitido('http://LOCALHOST/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('aponta para a própria máquina ou nome de rede interna')
  })

  it('bloqueia domínio ".local" (mDNS/rede interna), mesmo formato de ".internal"', () => {
    const r = enderecoPermitido('http://impressora.local/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('nome de rede interna')
  })

  it('não bloqueia por falso positivo: nome que só CONTÉM "localhost" como substring', () => {
    // "notlocalhost.com" não tem "localhost" como rótulo exato — é um domínio
    // público normal. Bloquear por substring seria bloqueio cego demais.
    expect(enderecoPermitido('http://notlocalhost.com/').permitido).toBe(true)
  })

  it.each(['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/'])(
    'bloqueia loopback disfarçado por codificação alternativa de IPv4: %s',
    (u) => {
      const r = enderecoPermitido(u)
      expect(r.permitido).toBe(false)
      expect(r.motivo).toBe('endereço IPv4 de rede interna')
    }
  )

  it('bloqueia endereço "esta rede" 0.0.0.0', () => {
    const r = enderecoPermitido('http://0.0.0.0/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv4 de rede interna')
  })

  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.5]/',
    'http://[::ffff:169.254.169.254]/',
  ])('bloqueia IPv4 interno mapeado em IPv6: %s', (u) => {
    const r = enderecoPermitido(u)
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv6 de rede interna')
  })

  it('bloqueia link-local IPv6 fora do prefixo literal "fe80:" (fe80::/10 é uma faixa, não uma string)', () => {
    // fe81::/16 ainda está dentro de fe80::/10, mas não começa com a string
    // exata "fe80:" — uma checagem por prefixo de texto deixaria isso passar.
    const r = enderecoPermitido('http://[fe81::1]/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv6 de rede interna')
  })

  it('bloqueia rede local única IPv6 (fc00::/7)', () => {
    const r = enderecoPermitido('http://[fd12:3456::1]/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv6 de rede interna')
  })

  it('bloqueia multicast IPv6 (ff00::/8)', () => {
    const r = enderecoPermitido('http://[ff02::1]/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv6 de rede interna')
  })

  it('bloqueia endereço IPv6 não especificado (::)', () => {
    const r = enderecoPermitido('http://[::]/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv6 de rede interna')
  })

  it('devolve o motivo exato junto do veredito (não só um texto qualquer não vazio)', () => {
    const r = enderecoPermitido('http://127.0.0.1/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv4 de rede interna')
  })

  // --- Achados da revisão adversarial: faixas reservadas que ainda passavam ---

  it('bloqueia site-local IPv6 depreciado (fec0::/10, RFC 3879) — faixa não coberta pelas outras máscaras de bits', () => {
    const minusculo = enderecoPermitido('http://[fec0::1]/')
    expect(minusculo.permitido).toBe(false)
    expect(minusculo.motivo).toBe('endereço IPv6 de rede interna')

    const maiusculo = enderecoPermitido('http://[FEC0::1]/')
    expect(maiusculo.permitido).toBe(false)
    expect(maiusculo.motivo).toBe('endereço IPv6 de rede interna')
  })

  it.each([
    ['http://100.64.0.1/', 'endereço IPv4 de rede interna'], // 100.64.0.0/10, NAT de operadora (RFC 6598)
    ['http://192.0.0.5/', 'endereço IPv4 de rede interna'], // 192.0.0.0/24, atribuições de protocolo IETF (RFC 6890)
    ['http://192.0.2.10/', 'endereço IPv4 de rede interna'], // 192.0.2.0/24, TEST-NET-1 (RFC 5737)
    ['http://198.18.0.5/', 'endereço IPv4 de rede interna'], // 198.18.0.0/15, benchmarking (RFC 2544)
    ['http://198.51.100.7/', 'endereço IPv4 de rede interna'], // 198.51.100.0/24, TEST-NET-2 (RFC 5737)
    ['http://203.0.113.9/', 'endereço IPv4 de rede interna'], // 203.0.113.0/24, TEST-NET-3 (RFC 5737)
  ])('bloqueia faixa IPv4 reservada/não roteável: %s', (u, motivoEsperado) => {
    const r = enderecoPermitido(u)
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe(motivoEsperado)
  })

  it.each([
    'http://[100::1]/', // 100::/64, bloco "somente descarte" (RFC 6666)
    'http://[2001:db8::1]/', // 2001:db8::/32, documentação (RFC 3849)
    'http://[3fff::1]/', // 3fff::/20, documentação (RFC 9637)
    'http://[2001:2::1]/', // 2001:2::/48, benchmarking (RFC 5180)
  ])('bloqueia faixa IPv6 reservada/não roteável: %s', (u) => {
    const r = enderecoPermitido(u)
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço IPv6 de rede interna')
  })

  it.each(['http://172.15.255.255/', 'http://172.32.0.0/'])(
    'não bloqueia por falso positivo: borda de fora do RFC 1918 172.16.0.0/12: %s',
    (u) => {
      expect(enderecoPermitido(u).permitido).toBe(true)
    }
  )

  it('bloqueia endereço com credencial embutida (usuário/senha) — proteção própria, não emprestada do fetch do runtime', () => {
    const r = enderecoPermitido('http://usuario:senha@jardimdaspatinhas.com.br/')
    expect(r.permitido).toBe(false)
    expect(r.motivo).toBe('endereço com credencial embutida (usuário/senha)')
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
