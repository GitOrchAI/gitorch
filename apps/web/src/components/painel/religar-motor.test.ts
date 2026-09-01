import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ESTILO_DO_PAINEL,
  motivoDeNaoReligar,
  motorParaReligar,
  ofereceReligar,
  rotuloDeReligar,
  textosDoPainel,
} from './religar-motor'
import type { MotorCota } from './painel-tipos'

// POR QUE ESTE TESTE EXISTE (01/09/2026): o painel mostrava o motor caído e
// oferecia um <a href="/setup"> — "Religar no assistente". O dono clicou,
// caiu noutra tela e escreveu: "Serviço mal pensado." O botão agora RELIGA
// ali mesmo, e o que se testa aqui é o que ele PROMETE e para quem aparece.

function motor(p: Partial<MotorCota> & Pick<MotorCota, 'id' | 'nome'>): MotorCota {
  return {
    estado: 'ligado',
    sessao: null,
    semana: null,
    lidoEm: null,
    precisaReligar: false,
    ...p,
  }
}

describe('religar o motor pelo painel — para quem aparece', () => {
  it('motor com a credencial vencida ganha o botão', () => {
    const m = motor({ id: 'codex', nome: 'Codex', estado: 'precisa_religar', precisaReligar: true })
    expect(ofereceReligar(m)).toBe(true)
    expect(motivoDeNaoReligar(m)).toBeNull()
  })

  it('motor que nunca conectou ganha o botão', () => {
    const m = motor({ id: 'antigravity', nome: 'Antigravity', estado: 'nao_conectado' })
    expect(ofereceReligar(m)).toBe(true)
  })

  it('motor ligado não ganha botão nenhum — não há o que religar', () => {
    const m = motor({ id: 'claude', nome: 'Claude Code', estado: 'ligado', sessao: 27 })
    expect(ofereceReligar(m)).toBe(false)
    expect(motivoDeNaoReligar(m)).toBeNull()
  })

  it('motor caído que o produto NÃO sabe religar diz por quê, em vez de fingir um botão', () => {
    const m = motor({ id: 'motor-novo', nome: 'motor-novo', estado: 'nao_conectado' })
    expect(ofereceReligar(m)).toBe(false)
    const motivo = motivoDeNaoReligar(m)
    expect(motivo).toBeTruthy()
    expect(motivo).toContain('motor-novo')
  })
})

describe('religar o motor pelo painel — o rótulo promete o que entrega', () => {
  it('credencial vencida: "religar", com o nome do motor e o "agora"', () => {
    const r = rotuloDeReligar(
      motor({ id: 'codex', nome: 'Codex', estado: 'precisa_religar', precisaReligar: true })
    )
    expect(r).toBe('Religar o Codex agora')
  })

  it('nunca conectado: "conectar", porque religar seria mentira', () => {
    const r = rotuloDeReligar(
      motor({ id: 'antigravity', nome: 'Antigravity', estado: 'nao_conectado' })
    )
    expect(r).toBe('Conectar o Antigravity agora')
  })

  it('o rótulo NÃO manda para outra tela — era exatamente esse o defeito', () => {
    for (const m of [
      motor({ id: 'codex', nome: 'Codex', estado: 'precisa_religar', precisaReligar: true }),
      motor({ id: 'claude', nome: 'Claude Code', estado: 'nao_conectado' }),
    ]) {
      const r = rotuloDeReligar(m).toLowerCase()
      expect(r).not.toContain('assistente')
      expect(r).not.toContain('setup')
      expect(r).not.toContain('wizard')
    }
  })
})

describe('religar o motor pelo painel — as frases', () => {
  const textos = textosDoPainel(
    motor({ id: 'codex', nome: 'Codex', estado: 'precisa_religar', precisaReligar: true })
  )

  it('nenhuma frase sai vazia nem vaza chave de dicionário', () => {
    for (const [chave, valor] of Object.entries(textos)) {
      if (typeof valor !== 'string') continue
      expect(valor.trim(), `frase vazia em ${chave}`).not.toBe('')
      expect(valor, `chave de locale vazando em ${chave}`).not.toContain('setup.')
    }
  })

  it('a dica de erro é ACIONÁVEL e diferente por tipo de falha', () => {
    const termos = textos.dicaDeErro('terms')
    const captura = textos.dicaDeErro('capture')
    const generico = textos.dicaDeErro('generic')
    expect(new Set([termos, captura, generico]).size).toBe(3)
    for (const d of [termos, captura, generico]) expect(d.trim()).not.toBe('')
  })

  it('o botão do painel fala do motor daquele card, não de "motores" em geral', () => {
    expect(textos.conectar).toBe('Religar o Codex agora')
    expect(textos.religar).toBe('Religar o Codex agora')
  })
})

// A lição do `.pn-sw` (painel-css-controles.test.ts): uma classe que ninguém
// escreveu no CSS nasce com 0x0, e o controle mais importante da tela fica
// invisível com todo teste verde. Aqui a asserção é sobre a REGRA existir.
describe('religar o motor pelo painel — os controles têm tamanho na tela', () => {
  const CSS = readFileSync(join(__dirname, '..', '..', 'app', 'globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )

  it('toda classe do estilo do painel tem regra própria no globals.css', () => {
    for (const valor of Object.values(ESTILO_DO_PAINEL)) {
      const partes = valor.split(/\s+/).filter(Boolean)
      const base = partes[0]!
      expect(base, `classe base sem prefixo conhecido: ${base}`).toMatch(/^(pn|wz)-/)
      expect(CSS, `sem regra para .${base}`).toContain(`.${base} {`)
      // Modificadores (`a`, `sm`) só existem colados na base: `.pn-btn.sm`.
      for (const mod of partes.slice(1)) {
        expect(CSS, `sem regra para .${base}.${mod}`).toContain(`.${base}.${mod} {`)
      }
    }
  })
})

// A tela da cascata lista os motores pelo CATÁLOGO (todos os que existem),
// enquanto a cota vem de `engine_connections` (só os que já foram tocados).
// Casar as duas listas é onde nasce a chance de afirmar besteira.
describe('religar o motor pelo painel — casando o catálogo com a cota lida', () => {
  it('cota NÃO lida: nenhum botão, porque "não sei" não é "está caído"', () => {
    expect(
      motorParaReligar({ runtime: 'codex', nome: 'Codex', motor: undefined, cotaLida: false })
    ).toBeNull()
  })

  it('motor no catálogo e sem linha de cota vira um card de "conectar", não some da tela', () => {
    const m = motorParaReligar({
      runtime: 'codex',
      nome: 'Codex',
      motor: undefined,
      cotaLida: true,
    })
    expect(m).not.toBeNull()
    expect(m!.estado).toBe('nao_conectado')
    expect(m!.precisaReligar).toBe(false)
    expect(rotuloDeReligar(m!)).toBe('Conectar o Codex agora')
    // Nada de número inventado para um motor que nunca respondeu.
    expect(m!.sessao).toBeNull()
    expect(m!.semana).toBeNull()
    expect(m!.lidoEm).toBeNull()
  })

  it('motor ligado não vira botão nenhum', () => {
    expect(
      motorParaReligar({
        runtime: 'claude',
        nome: 'Claude Code',
        motor: motor({ id: 'claude', nome: 'Claude Code', estado: 'ligado', sessao: 27 }),
        cotaLida: true,
      })
    ).toBeNull()
  })

  it('motor vencido devolve a linha REAL da cota, não uma inventada', () => {
    const real = motor({
      id: 'codex',
      nome: 'Codex',
      estado: 'precisa_religar',
      precisaReligar: true,
      lidoEm: '2026-09-01T10:00:00.000Z',
    })
    expect(motorParaReligar({ runtime: 'codex', nome: 'Codex', motor: real, cotaLida: true })).toBe(
      real
    )
  })

  it('motor que o produto não sabe religar não vira botão, mesmo caído', () => {
    expect(
      motorParaReligar({ runtime: 'github', nome: 'GitHub', motor: undefined, cotaLida: true })
    ).toBeNull()
  })
})

// A REGRESSÃO EM SI, guardada no lugar onde ela nasceu.
//
// O defeito não era um bug de lógica: era um <a href="/setup"> no card do
// motor caído. Nenhum teste de unidade o pegaria, porque cada função estava
// certa — o produto é que mandava o dono embora da tela. A asserção, então, é
// sobre o ARQUIVO: as telas do painel não navegam para o assistente para
// religar motor.
//
// O que este teste NÃO proíbe, de propósito: `/setup` continua sendo o destino
// CERTO em Header.tsx, na landing e na tela de "Conecte sua conta" do painel
// (app/painel/page.tsx) — ali não há sessão, e é por lá que entra quem chega
// novo. Proibir o caminho inteiro quebraria a porta de entrada do produto.
describe('o painel não empurra o dono para outra tela para religar motor', () => {
  const telas = ['TelaCustos.tsx', 'TelaCascata.tsx']

  for (const tela of telas) {
    it(`${tela} aciona o login assistido em vez de navegar para /setup`, () => {
      const fonte = readFileSync(join(__dirname, tela), 'utf8')
      const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(semComentarios).not.toContain('/setup')
      expect(semComentarios).toContain('ReligarMotor')
    })
  }
})
