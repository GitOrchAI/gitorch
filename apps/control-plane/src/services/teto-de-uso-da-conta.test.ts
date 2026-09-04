import { describe, expect, it } from 'vitest'
import { ehCredencialExpirada } from './credencial-do-motor.js'
import {
  ehTetoDeUsoDaConta,
  quandoACotaVolta,
  recadoDeTetoDeUso,
  recadoDeMotoresEsgotados,
  deveAvisarMotoresEsgotadosDeNovo,
} from './teto-de-uso-da-conta.js'

// A saida LITERAL do provedor, capturada rodando o CLI na mao em 27/08 — E o
// formato de data/hora absoluta que o Codex usa HOJE (L4-T22, medido ao vivo):
// "... or try again at Sep 21st, 2026 6:00 AM". A versão anterior desta
// fixture não trazia a data — e foi exatamente essa lacuna que deixou
// `quandoACotaVolta` devolvendo nulo para a saída real do provedor.
const CODEX_NO_TETO =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at " +
  'Sep 21st, 2026 6:00 AM (https://chatgpt.com/explore/plus)'
// O Codex nem sempre informa a data — quando não informa, continua sem prazo
// nenhum, e `quandoACotaVolta` tem de continuar honesto sobre isso.
const CODEX_NO_TETO_SEM_PRAZO_NENHUM =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)"
const ANTIGRAVITY_NO_TETO =
  'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15h41m4s.'

describe('teto de uso da conta', () => {
  it('reconhece o texto REAL do Codex — que o produto ignorava', () => {
    expect(ehTetoDeUsoDaConta(CODEX_NO_TETO)).toBe(true)
  })

  it('reconhece o texto real do Antigravity', () => {
    expect(ehTetoDeUsoDaConta(ANTIGRAVITY_NO_TETO)).toBe(true)
  })

  it('trabalho comum não vira teto de uso', () => {
    expect(ehTetoDeUsoDaConta('erro: o teste X quebrou na linha 40')).toBe(false)
    expect(ehTetoDeUsoDaConta('PR aberto com sucesso')).toBe(false)
  })

  it('teto de uso NÃO é credencial vencida — a distinção que custou dois logins', () => {
    // O dono religou o Codex duas vezes no mesmo dia por causa desta confusão.
    const saida = { stdout: CODEX_NO_TETO, stderr: '', exitCode: 1 }
    expect(ehTetoDeUsoDaConta(CODEX_NO_TETO)).toBe(true)
    expect(ehCredencialExpirada(saida)).toBe(false)
  })

  it('lê o prazo quando o provedor informa (formato relativo do Antigravity — não pode quebrar)', () => {
    expect(quandoACotaVolta(ANTIGRAVITY_NO_TETO)).toBe('15h41m')
  })

  // L4-T22: era aqui que o defeito vivia — esta asserção afirmava `toBeNull()`
  // para a saída REAL do Codex de hoje, que TEM data e hora ("try again at
  // Sep 21st, 2026 6:00 AM"). Fixava o comportamento antigo (a lacuna) como se
  // fosse correto. A saída real tem prazo; o produto tem de lê-lo.
  it('lê a data e hora absolutas que o Codex usa hoje — o formato que a versão antiga não cobria', () => {
    expect(quandoACotaVolta(CODEX_NO_TETO)).toBe('Sep 21st, 2026 6:00 AM')
  })

  it('sem prazo NENHUM continua devolvendo nulo em vez de inventar um', () => {
    // Prazo errado é pior que nenhum: o dono organiza o dia em cima dele.
    expect(quandoACotaVolta(CODEX_NO_TETO_SEM_PRAZO_NENHUM)).toBeNull()
  })

  it('saída que não é cota também devolve nulo — nunca casa um prazo por acidente', () => {
    expect(quandoACotaVolta('erro: o teste X quebrou na linha 40')).toBeNull()
    expect(quandoACotaVolta('PR aberto com sucesso')).toBeNull()
  })

  it('o recado NÃO pede para religar — foi esse pedido que gastou o tempo dele', () => {
    const texto = recadoDeTetoDeUso({ runtime: 'codex', volta: null })
    expect(texto).toContain('NÃO é login vencido')
    expect(texto).not.toMatch(/reconecte|religue o motor de novo/i)
    expect(texto).toContain('não é preciso')
  })

  it('com prazo, o recado diz quando volta', () => {
    expect(recadoDeTetoDeUso({ runtime: 'antigravity', volta: '15h41m' })).toContain('15h41m')
  })
})

// L4-T22, item 3: o aviso EXECUTIVO de quando a CADEIA INTEIRA de motores
// ficou sem cota — diferente de `recadoDeTetoDeUso` (que avisa por motor).
describe('recado de motores esgotados (aviso executivo, cadeia inteira sem cota)', () => {
  it('em português, sem jargão técnico, e nunca uma pergunta', () => {
    const texto = recadoDeMotoresEsgotados({
      ateQuando: 'Sep 21st, 2026 6:00 AM',
      duvidasEsperando: 3,
    })
    expect(texto).toContain('sem capacidade')
    expect(texto).toContain('Sep 21st, 2026 6:00 AM')
    // Nunca pergunta técnica — é um informe, não uma pergunta ao dono.
    expect(texto).not.toContain('?')
    expect(texto).not.toMatch(/quota|rate.?limit|\b429\b|token|api key/i)
  })

  it('diz quantas dúvidas do dev estão esperando, no plural', () => {
    const texto = recadoDeMotoresEsgotados({ ateQuando: null, duvidasEsperando: 3 })
    expect(texto).toContain('3')
    expect(texto).toMatch(/dúvidas.*esperando|esperando.*dúvidas/i)
  })

  it('no singular quando é só uma dúvida', () => {
    const texto = recadoDeMotoresEsgotados({ ateQuando: null, duvidasEsperando: 1 })
    expect(texto).not.toMatch(/1 dúvidas/)
  })

  it('sem dúvida nenhuma esperando, não inventa número', () => {
    const texto = recadoDeMotoresEsgotados({ ateQuando: null, duvidasEsperando: 0 })
    expect(texto).not.toMatch(/0 dúvidas/)
  })

  it('sem o provedor ter dito quando volta, é honesto sobre isso — não inventa prazo', () => {
    const texto = recadoDeMotoresEsgotados({ ateQuando: null, duvidasEsperando: 2 })
    expect(texto).not.toContain('null')
  })

  it('nunca pede decisão em texto solto — se algum dia precisar decidir, isso é pergunta formal (3 opções + "Vou escrever"), não este recado', () => {
    const texto = recadoDeMotoresEsgotados({ ateQuando: null, duvidasEsperando: 5 })
    expect(texto).not.toContain('?')
    expect(texto).toMatch(/não é preciso fazer nada/i)
  })

  // L4-T22, fix-up item 3/5: a condição original só olhava o ÚLTIMO erro da
  // cadeia — dois motores caindo por cota e o terceiro (o ÚLTIMO) por outro
  // motivo (credencial, 429 sem texto de cota) fazia o dono não receber
  // NADA, o mesmo silêncio que a tarefa veio matar. Quando o chamador detecta
  // essa mistura, `misto: true` tem que deixar o recado HONESTO sobre isso —
  // nunca simplificar para "foi tudo cota" quando não foi.
  it('quando a queda foi MISTA (nem tudo cota), o recado admite — nunca simplifica para "foi tudo cota"', () => {
    const texto = recadoDeMotoresEsgotados({
      ateQuando: null,
      duvidasEsperando: 1,
      misto: true,
    })
    expect(texto).toMatch(/outro motivo|nem toda queda/i)
  })

  it('sem mistura (todas as quedas foram cota), o recado NÃO menciona "outro motivo"', () => {
    const texto = recadoDeMotoresEsgotados({
      ateQuando: null,
      duvidasEsperando: 1,
      misto: false,
    })
    expect(texto).not.toMatch(/outro motivo/i)
  })

  it('misto omitido continua com o comportamento de sempre (retrocompatível)', () => {
    const texto = recadoDeMotoresEsgotados({ ateQuando: null, duvidasEsperando: 1 })
    expect(texto).not.toMatch(/outro motivo/i)
  })
})

// L4-T22, fix-up item 4: o dedup deste aviso deixou de viver num Map em
// memória do processo (que se perde a cada deploy) e passou a ser uma marca
// persistida em `Project.motoresEsgotadosAvisadoEm`. Esta função pura decide
// SÓ com base na marca lida do banco — o chamador (scheduler.ts) é quem lê e
// grava a coluna.
describe('deveAvisarMotoresEsgotadosDeNovo (dedup persistido em banco, não em Map)', () => {
  it('nunca avisado ainda (marca nula) — pode avisar', () => {
    expect(deveAvisarMotoresEsgotadosDeNovo(null, Date.now())).toBe(true)
  })

  it('avisado há poucos minutos — NÃO avisa de novo (dentro da janela)', () => {
    const agora = Date.now()
    const avisadoEm = new Date(agora - 5 * 60 * 1000)
    expect(deveAvisarMotoresEsgotadosDeNovo(avisadoEm, agora)).toBe(false)
  })

  it('avisado há mais de 24h — pode avisar de novo', () => {
    const agora = Date.now()
    const avisadoEm = new Date(agora - 25 * 60 * 60 * 1000)
    expect(deveAvisarMotoresEsgotadosDeNovo(avisadoEm, agora)).toBe(true)
  })

  it('exatamente 24h — já pode avisar (limite inclusivo, mesma disciplina de deveAvisarDeNovo)', () => {
    const agora = Date.now()
    const avisadoEm = new Date(agora - 24 * 60 * 60 * 1000)
    expect(deveAvisarMotoresEsgotadosDeNovo(avisadoEm, agora)).toBe(true)
  })
})
