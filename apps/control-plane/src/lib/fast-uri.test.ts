import { describe, expect, test } from 'vitest'
import pkg from 'fast-uri'
const { parse } = pkg

describe('fast-uri security check (CVE-2026-13676 / GHSA-4c8g-83qw-93j6)', () => {
  test('deve canonicalizar hostnames Unicode/IDN corretamente sem erro ou confusão de host', () => {
    // A vulnerabilidade original falhava em canonicalizar hostnames Unicode para URLs da família HTTP,
    // deixando o host em sua forma Unicode (ex: "127。0。0。1") em vez de canonicalizar para ASCII ("127.0.0.1").
    // Nas versões seguras (como a 4.1.1/3.1.4), a conversão de IDN funciona corretamente.
    const result = parse('http://127。0。0。1/')

    expect(result.error).toBeUndefined()
    expect(result.host).toBe('127.0.0.1')
  })

  test('deve converter domínios IDN Unicode para ASCII Punycode corretamente', () => {
    const result = parse('http://exämple.com/')

    expect(result.error).toBeUndefined()
    expect(result.host).toBe('xn--exmple-cua.com')
  })
})
