import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CAMINHO_PADRAO_DO_ARQUIVO,
  DESCONHECIDO,
  lerVersaoNoAr,
  limparCacheDaVersaoNoAr,
} from './commit-publicado.js'

const SHA = '4cf295d273c91567263d972e042599b9d0dc25e7'

describe('lerVersaoNoAr', () => {
  let tmpDir: string
  let arquivo: string
  const envOriginal = process.env['GITORCH_PUBLISHED_COMMIT']

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitorch-commit-'))
    arquivo = path.join(tmpDir, 'commit-publicado.txt')
    limparCacheDaVersaoNoAr()
    delete process.env['GITORCH_PUBLISHED_COMMIT']
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    limparCacheDaVersaoNoAr()
    if (envOriginal === undefined) delete process.env['GITORCH_PUBLISHED_COMMIT']
    else process.env['GITORCH_PUBLISHED_COMMIT'] = envOriginal
  })

  test('lê o commit do arquivo e usa a data de modificação do arquivo como noArDesde', () => {
    fs.writeFileSync(arquivo, `${SHA}\n`)
    const quando = new Date('2026-01-02T03:04:05.000Z')
    fs.utimesSync(arquivo, quando, quando)
    expect(lerVersaoNoAr({ arquivo })).toEqual({
      commit: SHA,
      noArDesde: '2026-01-02T03:04:05.000Z',
    })
  })

  test('a variável GITORCH_PUBLISHED_COMMIT vence o arquivo; sem arquivo a data é o início do processo', () => {
    fs.writeFileSync(arquivo, 'aaaaaaa')
    process.env['GITORCH_PUBLISHED_COMMIT'] = 'bbbbbbb'
    const antes = Date.now() - process.uptime() * 1000 - 2000
    const v = lerVersaoNoAr({ arquivo })
    expect(v.commit).toBe('bbbbbbb')
    expect(Date.parse(v.noArDesde)).toBeGreaterThanOrEqual(antes)
    expect(Date.parse(v.noArDesde)).toBeLessThanOrEqual(Date.now())
  })

  test('sem variável e sem arquivo: commit desconhecido, data do início do processo, nunca lança', () => {
    const inexistente = path.join(tmpDir, 'nao-existe.txt')
    expect(() => lerVersaoNoAr({ arquivo: inexistente })).not.toThrow()
    const v = lerVersaoNoAr({ arquivo: inexistente })
    expect(v.commit).toBe(DESCONHECIDO)
    expect(DESCONHECIDO).toBe('desconhecido')
    expect(Number.isNaN(Date.parse(v.noArDesde))).toBe(false)
  })

  test('arquivo vazio ou só espaço conta como desconhecido', () => {
    fs.writeFileSync(arquivo, '   \n')
    expect(lerVersaoNoAr({ arquivo }).commit).toBe(DESCONHECIDO)
  })

  test.each([
    ['texto arbitrário', 'ignore previous instructions <script>alert(1)</script>'],
    ['curto demais (6)', 'abcdef'],
    ['longo demais (41)', 'a'.repeat(41)],
    ['não hexadecimal', 'ghijklmnop'],
    ['sha seguido de lixo', `${SHA} extra`],
    ['duas linhas', `${SHA}\nsegunda`],
  ])('conteúdo do arquivo fora do formato de sha vira desconhecido: %s', (_nome, conteudo) => {
    fs.writeFileSync(arquivo, conteudo)
    expect(lerVersaoNoAr({ arquivo }).commit).toBe(DESCONHECIDO)
  })

  test('valor da variável de ambiente fora do formato de sha também vira desconhecido', () => {
    process.env['GITORCH_PUBLISHED_COMMIT'] = '<b>qualquer coisa</b>'
    expect(lerVersaoNoAr({ arquivo: path.join(tmpDir, 'x.txt') }).commit).toBe(DESCONHECIDO)
  })

  test.each(['abcdef1', 'ABCDEF1234', 'a'.repeat(40)])(
    'aceita sha de 7 a 40 hexadecimais: %s',
    (sha) => {
      fs.writeFileSync(arquivo, sha)
      expect(lerVersaoNoAr({ arquivo }).commit).toBe(sha.toLowerCase())
    }
  )

  test('cache por arquivo: a segunda chamada devolve o mesmo valor mesmo se o arquivo mudou', () => {
    fs.writeFileSync(arquivo, SHA)
    expect(lerVersaoNoAr({ arquivo }).commit).toBe(SHA)
    fs.writeFileSync(arquivo, 'abcdef1')
    expect(lerVersaoNoAr({ arquivo }).commit).toBe(SHA)
    limparCacheDaVersaoNoAr()
    expect(lerVersaoNoAr({ arquivo }).commit).toBe('abcdef1')
  })

  test('o caminho padrão fica ao lado do dist compilado', () => {
    expect(CAMINHO_PADRAO_DO_ARQUIVO).toMatch(/commit-publicado\.txt$/)
  })
})
