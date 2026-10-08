import { describe, it, expect } from 'vitest'
import {
  CADENCIA_DA_CONFORMIDADE_MS,
  CADENCIA_DA_SEGURANCA_MS,
  CADENCIA_DE_NOVA_TENTATIVA_MS,
  diferencaDeProblemas,
  escolherProjetoDaSeguranca,
  mesclarColetas,
  problemasDaConformidade,
  textoDoEventoDaConformidade,
  textoDoEventoDaNota,
  type FichaMedida,
  type ProjetoDaSeguranca,
} from './varredura-de-seguranca.js'
import type { ColetaDeSeguranca } from './nota-de-seguranca.js'

const HORA = 3_600_000
const AGORA = new Date('2026-10-08T12:00:00Z')

function projeto(id: string): ProjetoDaSeguranca {
  return { id, wingId: `dono/${id}`, runtimeConfig: null }
}

function ficha(
  projectId: string,
  tipo: 'seguranca' | 'conformidade',
  horasAtras: number,
  estado: unknown = { status: 'medido' }
): FichaMedida {
  return { projectId, tipo, atualizadoEm: new Date(AGORA.getTime() - horasAtras * HORA), estado }
}

function escolher(
  projetos: ProjetoDaSeguranca[],
  fichas: FichaMedida[],
  extra: {
    falhas?: Map<string, number>
    bloqueado?: (p: ProjetoDaSeguranca) => boolean
    cadenciaMs?: number
  } = {}
) {
  return escolherProjetoDaSeguranca({
    projetos,
    fichas,
    agora: AGORA,
    cadenciaMs: extra.cadenciaMs ?? CADENCIA_DA_SEGURANCA_MS,
    cadenciaDaConformidadeMs: CADENCIA_DA_CONFORMIDADE_MS,
    novaTentativaMs: CADENCIA_DE_NOVA_TENTATIVA_MS,
    falhasRecentes: extra.falhas ?? new Map(),
    ...(extra.bloqueado ? { bloqueado: extra.bloqueado } : {}),
  })
}

describe('escolherProjetoDaSeguranca (gate persistente pela ficha)', () => {
  it('as cadências padrão são 24 h e 7 dias', () => {
    expect(CADENCIA_DA_SEGURANCA_MS).toBe(24 * HORA)
    expect(CADENCIA_DA_CONFORMIDADE_MS).toBe(7 * 24 * HORA)
  })

  it('ficha de segurança de menos de 24 h e conformidade de menos de 7 dias: nada a fazer', () => {
    const r = escolher(
      [projeto('a')],
      [ficha('a', 'seguranca', 23), ficha('a', 'conformidade', 24 * 6)]
    )
    expect(r.escolhido).toBeNull()
    expect(r.aguardando).toBe(0)
  })

  it('segurança com 24 h ou mais: vencida; a conformidade em dia não vence junto', () => {
    const r = escolher(
      [projeto('a')],
      [ficha('a', 'seguranca', 24), ficha('a', 'conformidade', 24)]
    )
    expect(r.escolhido?.id).toBe('a')
    expect(r.segurancaVencida).toBe(true)
    expect(r.conformidadeVencida).toBe(false)
  })

  it('segurança em dia mas conformidade com 7 dias: só a conformidade vence', () => {
    const r = escolher(
      [projeto('a')],
      [ficha('a', 'seguranca', 2), ficha('a', 'conformidade', 24 * 7)]
    )
    expect(r.escolhido?.id).toBe('a')
    expect(r.segurancaVencida).toBe(false)
    expect(r.conformidadeVencida).toBe(true)
  })

  it('sem nenhuma ficha (projeto novo ou primeiro deploy): as duas vencem', () => {
    const r = escolher([projeto('a')], [])
    expect(r.segurancaVencida).toBe(true)
    expect(r.conformidadeVencida).toBe(true)
  })

  it('o gate vem só das fichas: não depende de memória do processo (sobrevive a deploy)', () => {
    const fichas = [ficha('a', 'seguranca', 1), ficha('a', 'conformidade', 1)]
    // Duas "execuções" independentes, sem estado compartilhado, concordam.
    expect(escolher([projeto('a')], fichas).escolhido).toBeNull()
    expect(escolher([projeto('a')], fichas).escolhido).toBeNull()
  })

  it('vários vencidos: escolhe SÓ UM (o de ficha mais antiga, sem ficha primeiro) e conta os que esperam', () => {
    const r = escolher(
      [projeto('novo'), projeto('velho'), projeto('meio'), projeto('em-dia')],
      [
        ficha('velho', 'seguranca', 100),
        ficha('meio', 'seguranca', 30),
        ficha('em-dia', 'seguranca', 1),
        ficha('em-dia', 'conformidade', 1),
        ficha('velho', 'conformidade', 1),
        ficha('meio', 'conformidade', 1),
      ]
    )
    expect(r.escolhido?.id).toBe('novo')
    expect(r.aguardando).toBe(2)
  })

  it('projeto que falhou há menos de 3 h fica de lado; depois disso volta', () => {
    const falhas = new Map([['a', AGORA.getTime() - 1 * HORA]])
    const antes = escolher([projeto('a'), projeto('b')], [ficha('b', 'seguranca', 50)], { falhas })
    expect(antes.escolhido?.id).toBe('b')
    const depois = escolher([projeto('a')], [], {
      falhas: new Map([['a', AGORA.getTime() - 3 * HORA]]),
    })
    expect(depois.escolhido?.id).toBe('a')
  })

  it('projeto bloqueado (freio de cota do dono) é pulado e o próximo é escolhido', () => {
    const r = escolher([projeto('a'), projeto('b')], [], { bloqueado: (p) => p.id === 'a' })
    expect(r.escolhido?.id).toBe('b')
  })

  it('cadência configurável', () => {
    const r = escolher(
      [projeto('a')],
      [ficha('a', 'seguranca', 2), ficha('a', 'conformidade', 2)],
      {
        cadenciaMs: HORA,
      }
    )
    expect(r.segurancaVencida).toBe(true)
  })
})

describe('mesclarColetas (credencial do cliente primeiro, App completa o que faltou)', () => {
  const vazia: ColetaDeSeguranca = {
    checks: {
      branchProtection: null,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: null,
      codeowners: null,
      securityMd: null,
      dependabotConfigurado: null,
    },
    informativos: { revisaoObrigatoria: null },
    arvore: null,
  }

  it('o que a primeira credencial mediu vale; só os nulos vêm da segunda', () => {
    const primeira: ColetaDeSeguranca = {
      ...vazia,
      checks: { ...vazia.checks, codeowners: false, branchProtection: null },
    }
    const segunda: ColetaDeSeguranca = {
      ...vazia,
      checks: { ...vazia.checks, codeowners: true, branchProtection: true },
      informativos: { revisaoObrigatoria: false },
    }
    const m = mesclarColetas(primeira, segunda)
    expect(m.checks.codeowners).toBe(false)
    expect(m.checks.branchProtection).toBe(true)
    expect(m.informativos.revisaoObrigatoria).toBe(false)
  })
})

describe('texto e diferença dos eventos do painel', () => {
  it('nota nova: diz a nota, a anterior e o que falta', () => {
    const texto = textoDoEventoDaNota({
      repositorio: 'dono/repo',
      nota: 50,
      anterior: 67,
      maximo: 6,
      formula: ['CODEOWNERS presente: FALTA', 'SECURITY.md presente: OK'],
    })
    expect(texto).toContain('dono/repo')
    expect(texto).toContain('50')
    expect(texto).toContain('67')
    expect(texto).toContain('CODEOWNERS presente')
    expect(texto).not.toContain('SECURITY.md presente')
  })

  it('primeira medição não menciona nota anterior', () => {
    const texto = textoDoEventoDaNota({
      repositorio: 'dono/repo',
      nota: 50,
      anterior: undefined,
      maximo: 6,
      formula: [],
    })
    expect(texto).not.toContain('era')
  })

  it('problemas da conformidade: documentos ausentes e licenças em atenção, nada de PII', () => {
    const problemas = problemasDaConformidade({
      licencas: {
        estado: 'verificado',
        total: 2,
        semLicenca: 0,
        emAtencaoTotal: 1,
        emAtencaoOmitidas: 0,
        emAtencao: [{ nome: 'pacote', licenca: 'GPL-3.0-only' }],
        listaUsada: ['GPL'],
      },
      indiciosDePii: {
        estado: 'verificado',
        arquivosLidos: ['schema.prisma'],
        indicios: [{ padrao: 'cpf', ocorrencias: 9, arquivos: 1 }],
      },
      codeownersAusente: true,
      securityMdAusente: false,
      actionsSemSha: null,
    })
    expect(problemas).toEqual(['codeowners-ausente', 'licenca:pacote:GPL-3.0-only'])
  })

  it('só o que é NOVO entra no aviso', () => {
    expect(
      diferencaDeProblemas(['codeowners-ausente', 'a'], ['codeowners-ausente', 'b', 'c'])
    ).toEqual(['b', 'c'])
    expect(diferencaDeProblemas(undefined, ['x'])).toEqual(['x'])
    expect(diferencaDeProblemas(['x'], ['x'])).toEqual([])
  })

  it('texto do aviso de conformidade agrupa licenças e nomeia documentos', () => {
    const texto = textoDoEventoDaConformidade('dono/repo', [
      'codeowners-ausente',
      'licenca:a:GPL-3.0-only',
      'licenca:b:AGPL-3.0-only',
    ])
    expect(texto).toContain('dono/repo')
    expect(texto).toContain('CODEOWNERS')
    expect(texto).toContain('2 pacotes')
  })
})
