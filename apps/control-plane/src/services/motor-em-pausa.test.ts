import { describe, it, expect } from 'vitest'
import {
  assinaturaDeFalha,
  criarRegistroDeMotorMorto,
  DESCANSO_DO_MOTOR_MORTO_MS,
  FALHAS_IGUAIS_ATE_PAUSAR,
} from './motor-em-pausa.js'

const T0 = new Date('2026-08-26T10:00:00Z')
const depois = (ms: number) => new Date(T0.getTime() + ms)

describe('criarRegistroDeMotorMorto — o motor morto sai do rodízio', () => {
  it('motor que morreu pedindo login entra em pausa', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    expect(r.estaEmPausa('codex', T0)).toBe(true)
  })

  it('os outros motores seguem normalmente', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    expect(r.estaEmPausa('antigravity', T0)).toBe(false)
  })

  it('a cadeia perde só o motor morto', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual([{ runtime: 'antigravity' }])
  })

  it('sucesso apaga a marca NA HORA — motor religado volta sem ninguém pedir', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    r.marcarVivo('codex')
    expect(r.estaEmPausa('codex', T0)).toBe(false)
  })

  it('o tempo tambem devolve o motor — para quem religou na mão, sem missão nenhuma', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    expect(r.estaEmPausa('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS - 1))).toBe(true)
    expect(r.estaEmPausa('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS))).toBe(false)
  })

  it('falha em rajada NÃO estica o descanso para sempre', () => {
    // Remarcar a cada falha faria o motor nunca mais voltar.
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    r.marcarMorto('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS - 1))
    expect(r.estaEmPausa('codex', depois(DESCANSO_DO_MOTOR_MORTO_MS))).toBe(false)
  })

  it('cadeia INTEIRA em pausa devolve a original — proteção não pode parar a esteira', () => {
    // Ficar sem motor nenhum seria trocar um desperdício por uma paralisação.
    const r = criarRegistroDeMotorMorto()
    r.marcarMorto('codex', T0)
    r.marcarMorto('antigravity', T0)
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual(cadeia)
  })

  it('cadeia sem motor morto passa inteira', () => {
    const r = criarRegistroDeMotorMorto()
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual(cadeia)
  })
})

// ---------------------------------------------------------------------------
// PARAR DE INSISTIR NUM MOTOR QUE FALHA SEMPRE PELO MESMO MOTIVO
//
// Medido no journal de 31/08 (janela de 9h48): 'erro recuperável em antigravity'
// 24 vezes, 100% delas 'invalid model selection'; 'erro recuperável em codex'
// 30 vezes, todas 401. 54 tentativas queimadas, cada uma pagando um `podman run`
// inteiro. O motor quebrado era tentado a cada poucos minutos, para sempre.
// ---------------------------------------------------------------------------

const ERRO_DO_MODELO_MORTO = (missao: string) =>
  `rails step 1 failed: Command failed: podman run --rm --name gitorch-mission-${missao} ` +
  'localhost/gitorch-agent:latest agy --model "Gemini 3.5 Flash (Medium)"\n' +
  'Error: invalid model selection (--model "Gemini 3.5 Flash (Medium)" --effort ""): ' +
  'model Gemini 3.5 Flash (Medium) is not recognized as a known model or custom model in settings'

const ERRO_401_DO_CODEX = (missao: string) =>
  `rails step 1 failed: Command failed: podman run --rm --name gitorch-mission-${missao} ` +
  'localhost/gitorch-agent:latest codex exec\n' +
  'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, ' +
  'url: https://api.openai.com/v1/responses'

describe('assinaturaDeFalha — o MESMO erro tem que ser reconhecido como o mesmo', () => {
  it('missões diferentes com o mesmo defeito dão a MESMA assinatura', () => {
    // O nome do container muda a cada missão. Sem normalizar, cada falha
    // pareceria inédita e o contador nunca chegaria ao teto.
    expect(assinaturaDeFalha(ERRO_DO_MODELO_MORTO('cmab123xyz'))).toBe(
      assinaturaDeFalha(ERRO_DO_MODELO_MORTO('cmqq987abc'))
    )
  })

  it('defeitos diferentes dão assinaturas DIFERENTES', () => {
    expect(assinaturaDeFalha(ERRO_DO_MODELO_MORTO('a'))).not.toBe(
      assinaturaDeFalha(ERRO_401_DO_CODEX('a'))
    )
  })
})

describe('marcarFalha — desliga o que falha SEMPRE, não o que falha uma vez', () => {
  it('N falhas iguais seguidas tiram o motor do rodízio, e ele DIZ o porquê', () => {
    const r = criarRegistroDeMotorMorto()
    for (let i = 1; i < FALHAS_IGUAIS_ATE_PAUSAR; i++) {
      expect(r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO(`m${i}`), T0).pausou).toBe(false)
    }
    const ultima = r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO('mN'), T0)
    expect(ultima.pausou).toBe(true)
    expect(r.estaEmPausa('antigravity', T0)).toBe(true)
    // "DIZER que parou e por quê": o motivo carrega o motor, a contagem e o erro.
    expect(ultima.motivo).toContain('antigravity')
    expect(ultima.motivo).toContain(String(FALHAS_IGUAIS_ATE_PAUSAR))
    expect(ultima.motivo).toContain('invalid model selection')
  })

  it('O OUTRO LADO: uma falha só NÃO desliga o motor', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarFalha('claude', ERRO_401_DO_CODEX('m1'), T0)
    expect(r.estaEmPausa('claude', T0)).toBe(false)
  })

  it('O OUTRO LADO: falhas por motivos DIFERENTES nunca desligam o motor', () => {
    // Motor que erra por causas variadas está vivo e reagindo ao mundo — é
    // exatamente o motor bom que a guarda não pode derrubar.
    const r = criarRegistroDeMotorMorto()
    for (let i = 0; i < FALHAS_IGUAIS_ATE_PAUSAR * 3; i++) {
      const erro = i % 2 === 0 ? ERRO_DO_MODELO_MORTO(`m${i}`) : ERRO_401_DO_CODEX(`m${i}`)
      expect(r.marcarFalha('antigravity', erro, T0).pausou).toBe(false)
    }
    expect(r.estaEmPausa('antigravity', T0)).toBe(false)
  })

  it('O OUTRO LADO: um sucesso no meio zera a contagem', () => {
    const r = criarRegistroDeMotorMorto()
    r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO('m1'), T0)
    r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO('m2'), T0)
    r.marcarVivo('antigravity')
    for (let i = 3; i < FALHAS_IGUAIS_ATE_PAUSAR + 2; i++) {
      expect(r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO(`m${i}`), T0).pausou).toBe(false)
    }
    expect(r.estaEmPausa('antigravity', T0)).toBe(false)
  })

  it('avisa UMA vez: falha número N+1 não repete o recado', () => {
    const r = criarRegistroDeMotorMorto()
    for (let i = 0; i < FALHAS_IGUAIS_ATE_PAUSAR; i++) {
      r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO(`m${i}`), T0)
    }
    expect(r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO('depois'), T0).pausou).toBe(false)
  })

  it('um motor pausado não arrasta o outro junto', () => {
    const r = criarRegistroDeMotorMorto()
    for (let i = 0; i < FALHAS_IGUAIS_ATE_PAUSAR; i++) {
      r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO(`m${i}`), T0)
    }
    expect(r.estaEmPausa('antigravity', T0)).toBe(true)
    expect(r.estaEmPausa('claude', T0)).toBe(false)
  })

  it('a pausa por falha repetida também se desfaz sozinha com o tempo', () => {
    const r = criarRegistroDeMotorMorto()
    for (let i = 0; i < FALHAS_IGUAIS_ATE_PAUSAR; i++) {
      r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO(`m${i}`), T0)
    }
    expect(r.estaEmPausa('antigravity', depois(DESCANSO_DO_MOTOR_MORTO_MS))).toBe(false)
  })

  it('NÃO derruba a esteira: com os dois motores pausados a cadeia passa inteira', () => {
    // A regra que já existia continua valendo para a pausa nova.
    const r = criarRegistroDeMotorMorto()
    for (let i = 0; i < FALHAS_IGUAIS_ATE_PAUSAR; i++) {
      r.marcarFalha('codex', ERRO_401_DO_CODEX(`m${i}`), T0)
      r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO(`m${i}`), T0)
    }
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual(cadeia)
  })

  it('a cadeia real de hoje mantém o Claude e descarta os dois quebrados', () => {
    // chain=codex>antigravity>claude, medida no journal de 31/08. Com a guarda,
    // a missão vai direto ao único motor que pode entregar.
    const r = criarRegistroDeMotorMorto()
    for (let i = 0; i < FALHAS_IGUAIS_ATE_PAUSAR; i++) {
      r.marcarFalha('codex', ERRO_401_DO_CODEX(`m${i}`), T0)
      r.marcarFalha('antigravity', ERRO_DO_MODELO_MORTO(`m${i}`), T0)
    }
    const cadeia = [{ runtime: 'codex' }, { runtime: 'antigravity' }, { runtime: 'claude' }]
    expect(r.filtrarCadeia(cadeia, T0)).toEqual([{ runtime: 'claude' }])
  })
})
