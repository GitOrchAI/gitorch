import { describe, it, expect } from 'vitest'
import {
  blocoDoAchado,
  runAnaliseCausaDeInfra,
  runIssuePadraoDeInfra,
} from './analise-causa-de-infra.js'
import type { AchadoDeInfra } from './incidente-ci.js'

const achado: AchadoDeInfra = {
  classe: 'ci-do-cliente',
  identidadeEstavel: 'wf:11',
  titulo: 'Workflow "CI" falhou na main',
  travaMerge: true,
  evidencia: '### Fim do log\nnpm ERR! missing script: build',
  paths: ['.github/workflows/ci.yml'],
}

const CAUSA = {
  causaRaiz: 'o step chama `npm run build` mas o package.json não tem esse script',
  arquivosAfetados: 'package.json, .github/workflows/ci.yml',
  criterioDeVerificacao: 'o workflow CI roda verde na main',
  escopo: 'só adicionar o script build; não mexer em deps',
  riscoDeRegressao: 'baixo — script novo, testado localmente',
}

const DOD = {
  titulo: 'Adicionar o script build ausente',
  goal: 'CI volta a passar na main',
  taskDetails: 'o step de build referencia um script inexistente',
  taskDescription: 'adicionar `build` ao package.json',
  implementationGuide: '1. em package.json, adicionar "build": "tsc" em scripts',
  verificationCriteria: 'push na main → workflow CI verde; `npm run build` local sai 0',
  dependencies: 'nenhuma',
  relatedFiles: 'package.json\n.github/workflows/ci.yml',
  notes: 'escopo: só o script. risco: baixo.',
}

/** Executor fake que devolve, em ordem, cada resposta da fila. */
function fakeExecutor(respostas: unknown[]): (p: string) => Promise<string> {
  let i = 0
  return async () => JSON.stringify(respostas[Math.min(i++, respostas.length - 1)])
}

describe('blocoDoAchado', () => {
  it('inclui classe, identidade, arquivos e a evidência', () => {
    const b = blocoDoAchado(achado)
    expect(b).toContain('ci-do-cliente')
    expect(b).toContain('wf:11')
    expect(b).toContain('.github/workflows/ci.yml')
    expect(b).toContain('missing script: build')
  })
})

describe('runAnaliseCausaDeInfra', () => {
  it('devolve os 5 campos da causa', async () => {
    const r = await runAnaliseCausaDeInfra(fakeExecutor([CAUSA]), achado)
    expect(r.causaRaiz).toContain('npm run build')
    expect(r.arquivosAfetados).toContain('package.json')
    expect(r.criterioDeVerificacao).toBeTruthy()
    expect(r.escopo).toBeTruthy()
    expect(r.riscoDeRegressao).toBeTruthy()
  })
})

describe('runIssuePadraoDeInfra', () => {
  it('devolve os 8 campos do DoD (issue padrão Shrimp), validados', async () => {
    const fields = await runIssuePadraoDeInfra(fakeExecutor([{ fields: DOD }]), {
      achado,
      analise: CAUSA,
    })
    expect(fields.titulo).toBeTruthy()
    expect(fields.goal).toBeTruthy()
    expect(fields.implementationGuide).toContain('package.json')
    expect(fields.verificationCriteria.split('\n').some((l) => l.trim().length > 3)).toBe(true)
  })

  it('reprova issue com campo em branco (não publica issue oca)', async () => {
    await expect(
      runIssuePadraoDeInfra(fakeExecutor([{ fields: { ...DOD, goal: '   ' } }]), {
        achado,
        analise: CAUSA,
      })
    ).rejects.toThrow(/DoD/)
  })

  it('scaffolding obsoleto → o prompt pede REMOÇÃO', async () => {
    let promptVisto = ''
    const exec = async (p: string): Promise<string> => {
      promptVisto = p
      return JSON.stringify({ fields: DOD })
    }
    await runIssuePadraoDeInfra(exec, {
      achado: { ...achado, classe: 'scaffolding-do-gitorch' },
      analise: CAUSA,
      scaffoldingObsoleto: true,
    })
    expect(promptVisto).toContain('REMOÇÃO')
  })
})
