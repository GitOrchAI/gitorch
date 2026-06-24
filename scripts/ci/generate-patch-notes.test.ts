import { expect, test, describe, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyChangesHeuristically,
  calculateNextVersion,
  updateChangelogFile,
} from './generate-patch-notes'

describe('Conversão e Classificação de Mudanças (Heurística)', () => {
  test('deve classificar commits com prefixos convencionais', () => {
    expect(classifyChangesHeuristically('feat: novo módulo de login', [])).toBe('feature')
    expect(classifyChangesHeuristically('feature: suporte a webhook', [])).toBe('feature')

    expect(classifyChangesHeuristically('refactor: limpeza de código morto', [])).toBe(
      'improvement'
    )
    expect(classifyChangesHeuristically('perf: otimização de consultas sql', [])).toBe(
      'improvement'
    )
    expect(classifyChangesHeuristically('style: formatação com prettier', [])).toBe('improvement')

    expect(classifyChangesHeuristically('fix: bug no cálculo de juros', [])).toBe('patch')
    expect(classifyChangesHeuristically('chore: atualiza dependências', [])).toBe('patch')
    expect(classifyChangesHeuristically('docs: atualiza readme do projeto', [])).toBe('patch')
    expect(classifyChangesHeuristically('test: adiciona testes unitários', [])).toBe('patch')
  })

  test('deve classificar baseado em arquivos se não houver prefixo convencional', () => {
    // Nova feature: arquivos adicionados (status 'A') em apps/ ou packages/
    const changedFilesFeature = ['A\tapps/web/src/pages/dashboard.tsx', 'M\tpackage.json']
    expect(classifyChangesHeuristically('cria painel de controle', changedFilesFeature)).toBe(
      'feature'
    )

    // Melhoria: apenas arquivos modificados (status 'M') em apps/ ou packages/
    const changedFilesImprovement = ['M\tpackages/core/src/index.ts', 'M\ttsconfig.json']
    expect(
      classifyChangesHeuristically('ajusta lógica interna do core', changedFilesImprovement)
    ).toBe('improvement')

    // Patch: mudanças apenas em configs, testes ou documentação
    const changedFilesPatch = [
      'M\tREADME.md',
      'M\tscripts/ci/audit-summary.ts',
      'A\tapps/web/src/dashboard.test.tsx',
    ]
    expect(
      classifyChangesHeuristically(
        'atualiza readme e adiciona teste do dashboard',
        changedFilesPatch
      )
    ).toBe('patch')
  })
})

describe('Cálculo do Próximo SemVer Customizado', () => {
  test('deve incrementar a versão corretamente', () => {
    const base = '1.0.0.0'

    // Major bump
    expect(calculateNextVersion(base, 'major')).toBe('2.0.0.0')
    // Feature bump
    expect(calculateNextVersion(base, 'feature')).toBe('1.1.0.0')
    // Improvement bump
    expect(calculateNextVersion(base, 'improvement')).toBe('1.0.1.0')
    // Patch bump
    expect(calculateNextVersion(base, 'patch')).toBe('1.0.0.1')
  })

  test('deve resetar sub-versões ao incrementar níveis maiores', () => {
    const base = '2.3.4.5'

    expect(calculateNextVersion(base, 'major')).toBe('3.0.0.0')
    expect(calculateNextVersion(base, 'feature')).toBe('2.4.0.0')
    expect(calculateNextVersion(base, 'improvement')).toBe('2.3.5.0')
    expect(calculateNextVersion(base, 'patch')).toBe('2.3.4.6')
  })

  test('deve retornar default se a versão atual for inválida', () => {
    expect(calculateNextVersion('invalid-semver', 'patch')).toBe('1.0.0.0')
  })
})

describe('Escrita e Limitação de Histórico de Changelog', () => {
  const tempTestDir = join(process.cwd(), 'wiki_temp_test')
  const testFile = join(tempTestDir, 'Test-Changelog.md')

  const testLang = {
    code: 'pt-br',
    name: 'Português',
    file: 'Test-Changelog.md',
    header: '# 📋 Últimas Atualizações',
    desc: 'Esta página é atualizada automaticamente.',
    typeLabel: {
      feature: 'Funcionalidade',
      improvement: 'Melhoria',
      patch: 'Correção',
    },
    authorLabel: 'Autor',
    typeLabelText: 'Tipo',
    changeLabelText: 'Alteração',
    historyHeader: '### Histórico de Atualizações Recentes',
  }

  beforeAll(() => {
    if (!existsSync(tempTestDir)) {
      mkdirSync(tempTestDir, { recursive: true })
    }
    writeFileSync(testFile, '', 'utf8')
  })

  afterAll(() => {
    try {
      rmSync(tempTestDir, { recursive: true, force: true })
    } catch {}
  })

  test('deve criar o arquivo com cabeçalho se não existir', () => {
    if (existsSync(testFile)) {
      rmSync(testFile)
    }

    updateChangelogFile(
      testFile,
      testLang,
      '1.0.0.1',
      '2026-06-24 12:00:00',
      'Guilherme',
      'a1b2c3d',
      'Correção',
      'Correção de bugs críticos',
      'Ajustes na tela de autenticação.'
    )

    expect(existsSync(testFile)).toBe(true)
    const content = readFileSync(testFile, 'utf8')
    expect(content).toContain('# 📋 Últimas Atualizações')
    expect(content).toContain('## Versão 1.0.0.1 - 2026-06-24 12:00:00')
    expect(content).toContain('**Autor:** Guilherme (Commit: `a1b2c3d`)')
    expect(content).toContain('Ajustes na tela de autenticação.')
  })

  test('deve limitar a no máximo 30 registros de changelog', () => {
    if (existsSync(testFile)) {
      rmSync(testFile)
    }

    // Escrever 35 entradas no changelog
    for (let i = 1; i <= 35; i++) {
      updateChangelogFile(
        testFile,
        testLang,
        `1.0.0.${i}`,
        '2026-06-24 12:00:00',
        'Guilherme',
        `c${i}`,
        'Correção',
        `Ajuste número ${i}`,
        `Descrição detalhada da alteração número ${i}.`
      )
    }

    const content = readFileSync(testFile, 'utf8')

    // Deve conter a última entrada (35)
    expect(content).toContain('## Versão 1.0.0.35')

    // Deve conter no máximo 30 entradas totais. Cada entrada tem "## Versão ".
    // Contamos as ocorrências de "## Versão "
    const occurrences = (content.match(/## Versão /g) || []).length
    expect(occurrences).toBeLessThanOrEqual(30)

    // A primeira entrada inserida (versão 1.0.0.1) deve ter sido podada
    expect(content).not.toContain('## Versão 1.0.0.1 ')
    expect(content).not.toContain('Commit: `c1`')

    // A versão 1.0.0.6 deve ser a mais antiga mantida (35 - 30 + 1 = 6)
    expect(content).toContain('## Versão 1.0.0.6')
  })
})
