import { describe, it, expect } from 'vitest'
import {
  resumoDeErroDoMotor,
  classificarFalhaDoMotor,
  TETO_PADRAO_DO_RESUMO,
} from './resumo-de-erro-do-motor.js'
import { isFailoverError } from '../lib/runtime-resolver.js'

// O stderr REAL do Codex, reproduzido em 31/08/2026 no mesmo container da
// missão (podman run ... codex exec -s read-only --skip-git-repo-check).
// O banner informativo vem PRIMEIRO (298 bytes); o motivo verdadeiro — 401 —
// só aparece por volta do byte 674. Guardar os 300 PRIMEIROS bytes decapita
// exatamente a causa e deixa o log parecendo uma trava de stdin.
const STDERR_REAL_DO_CODEX =
  'Reading additional input from stdin...\n' +
  '--------\n' +
  'workdir: /workspace\n' +
  'model: gpt-5.5\n' +
  'provider: openai\n' +
  'approval: never\n' +
  'sandbox: read-only\n' +
  'reasoning effort: medium\n' +
  'reasoning summaries: auto\n' +
  '--------\n' +
  '[2026-08-31T23:40:11] User instructions:\n' +
  'user\n' +
  'Reply with only the word ok.\n' +
  '--------\n' +
  'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: ' +
  'HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses\n' +
  'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication ' +
  'in header, url: https://api.openai.com/v1/responses\n'

// O stderr REAL do Antigravity, capturado NESTA VM em 01/09/2026 rodando
// `agy --model "Gemini 3.5 Flash (Medium)" -p "say ok"` — 484 bytes.
//
// Este caso é a PROVA de que guardar só a cauda não bastaria: aqui o motivo
// ("invalid model selection") está na CABEÇA, e o que vem depois é só a lista
// de modelos. No Codex é o contrário. Um motor põe a causa no começo, o outro
// no fim — por isso o resumo guarda as DUAS pontas.
const STDERR_REAL_DO_AGY =
  'Error: invalid model selection (--model "Gemini 3.5 Flash (Medium)" --effort ""): ' +
  'model Gemini 3.5 Flash (Medium) is not recognized as a known model or custom model in settings\n' +
  'Available models:\n' +
  '  Gemini 3.7 Flash (High)\n' +
  '  Gemini 3.7 Flash (Medium)\n' +
  '  Gemini 3.7 Flash (Low)\n' +
  '  Gemini 3.6 Flash (High)\n' +
  '  Gemini 3.6 Flash (Medium)\n' +
  '  Gemini 3.6 Flash (Low)\n' +
  '  Gemini 3.1 Pro (High)\n' +
  '  Gemini 3.1 Pro (Low)\n' +
  '  Claude Sonnet 4.6 (Thinking)\n' +
  '  Claude Opus 4.6 (Thinking)\n' +
  '  GPT-OSS 120B (Medium)\n'

describe('resumoDeErroDoMotor — o log parava de contar o motivo real', () => {
  it('o corte ANTIGO (300 primeiros bytes) perdia o 401: prova do defeito', () => {
    // Isto é a medição, não a correção: confirma que a cabeça do stderr não
    // contém o motivo. Se um dia contiver, este teste avisa que a premissa mudou.
    const cabeca = STDERR_REAL_DO_CODEX.slice(0, 300)
    expect(cabeca).not.toContain('401')
    expect(cabeca).toContain('Reading additional input from stdin')
  })

  it('CAUDA: o resumo carrega o 401 do Codex — a causa verdadeira sobrevive', () => {
    const resumo = resumoDeErroDoMotor(STDERR_REAL_DO_CODEX, 300)
    expect(resumo).toContain('401 Unauthorized')
    expect(resumo).toContain('Missing bearer or basic authentication')
  })

  it('CABEÇA: o resumo carrega o "invalid model selection" do Antigravity', () => {
    // Guardar SÓ a cauda perderia este motivo — a cauda do agy é só lista de
    // modelos. É por isso que o resumo guarda as duas pontas, e não uma.
    const resumo = resumoDeErroDoMotor(STDERR_REAL_DO_AGY, 300)
    expect(resumo).toContain('invalid model selection')
    expect(resumo).toContain('Gemini 3.5 Flash (Medium)')
  })

  it('as DUAS pontas no mesmo resumo, com a marca de corte no meio', () => {
    const resumo = resumoDeErroDoMotor(STDERR_REAL_DO_CODEX, 300)
    // Cabeça: o começo do stderr, intacto.
    expect(resumo.startsWith('Reading additional input from stdin')).toBe(true)
    // Cauda: o fim do stderr, intacto.
    expect(STDERR_REAL_DO_CODEX.endsWith(resumo.slice(resumo.lastIndexOf('…') + 1))).toBe(true)
  })

  it('e o classificador de failover volta a enxergar o erro', () => {
    // A truncagem também cegava isFailoverError: 'unauthor' e '401' ficavam
    // fora dos 300 bytes guardados, então nem o failover era decidido pelo
    // motivo certo. RESULTADO, não chamada.
    expect(isFailoverError(STDERR_REAL_DO_CODEX.slice(0, 300))).toBe(false)
    expect(isFailoverError(resumoDeErroDoMotor(STDERR_REAL_DO_CODEX, 300))).toBe(true)
  })

  it('nunca MASCARA o corte: diz QUANTOS bytes ficaram de fora, e o número confere', () => {
    const resumo = resumoDeErroDoMotor(STDERR_REAL_DO_CODEX, 300)
    const m = /\((\d+) bytes cortados\)/.exec(resumo)
    expect(m).not.toBeNull()
    const anunciados = Number((m as RegExpExecArray)[1])
    // O número anunciado tem que bater com o que sumiu de verdade: total menos
    // o que sobrou das duas pontas.
    const cabeca = resumo.slice(0, resumo.indexOf('…'))
    const cauda = resumo.slice(resumo.lastIndexOf('…') + 1)
    expect(anunciados).toBe(STDERR_REAL_DO_CODEX.length - cabeca.length - cauda.length)
  })

  it('stderr curto passa inteiro, sem enfeite', () => {
    expect(resumoDeErroDoMotor('boom', 300)).toBe('boom')
  })

  it('stderr vazio não vira texto inventado', () => {
    expect(resumoDeErroDoMotor('', 300)).toBe('')
    expect(resumoDeErroDoMotor(undefined, 300)).toBe('')
  })

  it('o resumo respeita o teto de tamanho pedido', () => {
    expect(resumoDeErroDoMotor('x'.repeat(5000), 300).length).toBeLessThanOrEqual(300)
    expect(resumoDeErroDoMotor(STDERR_REAL_DO_CODEX).length).toBeLessThanOrEqual(
      TETO_PADRAO_DO_RESUMO
    )
  })
})

describe('classificarFalhaDoMotor — o veredito sai do texto COMPLETO, antes de cortar', () => {
  it('reconhece o 401 do Codex mesmo que ele nem caiba no resumo', () => {
    // A ordem importa: primeiro classifica sobre o stderr inteiro, DEPOIS
    // resume. Classificar sobre o resumo seria decidir pelo que sobrou.
    const r = classificarFalhaDoMotor({ bruto: STDERR_REAL_DO_CODEX, teto: 60 })
    // Com teto 60 o 401 não cabe no resumo...
    expect(r.mensagem.length).toBeLessThanOrEqual(60)
    // ...e ainda assim o veredito é failover, porque veio do texto completo.
    expect(r.ehFailover).toBe(true)
    expect(isFailoverError(r.mensagem)).toBe(false)
  })

  it('texto sem motivo de failover não vira failover por engano', () => {
    const r = classificarFalhaDoMotor({ bruto: 'erro de sintaxe no arquivo x.ts', teto: 300 })
    expect(r.ehFailover).toBe(false)
    expect(r.mensagem).toBe('erro de sintaxe no arquivo x.ts')
  })

  it('stderr vazio: sem veredito inventado', () => {
    const r = classificarFalhaDoMotor({ bruto: '', teto: 300 })
    expect(r.ehFailover).toBe(false)
    expect(r.mensagem).toBe('')
  })
})
