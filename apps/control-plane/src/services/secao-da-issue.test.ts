import { describe, expect, it } from 'vitest'
import { lerSecaoDaIssue, arquivosDeclarados } from './secao-da-issue.js'

// A leitura de uma seção do corpo da issue no padrão que o PO escreve.
//
// Existia UMA leitura dessas no projeto, e ela vivia solta dentro do
// julgamento (qa-rails-mission.ts) como uma expressão regular no meio da
// função, colada em "Verification Criteria". Precisar da mesma leitura para
// outro cabeçalho ia produzir uma segunda cópia da regra — e duas cópias de
// uma regra de parsing divergem na primeira vez que o formato muda.
//
// Por isso a leitura mora aqui, num lugar só, e os dois a importam.

const CORPO_REAL = `<!-- gitorch:task -->

## Goal

Mapear metadados de erro na pipeline.

## Verification Criteria

1. Forçar uma falha em um pipeline de teste localmente.

## Dependencies

none

## Related Files

apps/control-plane/src/config/pipeline-check.ts, apps/control-plane/src/plugins/telemetry.ts

## Notes

Nada a acrescentar.`

describe('lerSecaoDaIssue', () => {
  it('lê a seção pedida e para no próximo cabeçalho', () => {
    expect(lerSecaoDaIssue(CORPO_REAL, 'Dependencies')).toBe('none')
  })

  it('lê a última seção, que não tem um próximo cabeçalho para parar', () => {
    expect(lerSecaoDaIssue(CORPO_REAL, 'Notes')).toBe('Nada a acrescentar.')
  })

  it('cabeçalho ausente devolve string vazia, nunca o corpo inteiro', () => {
    // Devolver o corpo inteiro por engano faria a leitura de arquivos achar
    // "arquivo" em qualquer texto que tivesse uma barra.
    expect(lerSecaoDaIssue(CORPO_REAL, 'Cabeçalho Que Não Existe')).toBe('')
  })

  it('corpo vazio ou ausente não quebra', () => {
    expect(lerSecaoDaIssue('', 'Goal')).toBe('')
    expect(lerSecaoDaIssue(undefined, 'Goal')).toBe('')
  })

  it('o cabeçalho não é sensível a maiúsculas', () => {
    expect(lerSecaoDaIssue(CORPO_REAL, 'dependencies')).toBe('none')
  })
})

describe('arquivosDeclarados', () => {
  it('lê os caminhos do corpo REAL de uma issue do produto', () => {
    // Formato copiado da issue #151 do repositório: caminhos separados por
    // vírgula, em texto corrido, sob "## Related Files".
    expect(arquivosDeclarados(CORPO_REAL)).toEqual([
      'apps/control-plane/src/config/pipeline-check.ts',
      'apps/control-plane/src/plugins/telemetry.ts',
    ])
  })

  it('aceita também a forma de lista, que o PO às vezes usa', () => {
    const corpo = `## Related Files\n\n- src/a.ts\n- src/b.ts\n`
    expect(arquivosDeclarados(corpo)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('sem a seção, devolve lista vazia — e isso significa "não sei", não "nenhum"', () => {
    // A diferença importa rio abaixo: quem não declara arquivo NUNCA pode ser
    // bloqueado por conflito de arquivo, senão a fila trava sozinha.
    expect(arquivosDeclarados('## Goal\n\nQualquer coisa')).toEqual([])
  })

  it('seção vazia ou com "none" não vira arquivo', () => {
    expect(arquivosDeclarados('## Related Files\n\n')).toEqual([])
    expect(arquivosDeclarados('## Related Files\n\nnone')).toEqual([])
    expect(arquivosDeclarados('## Related Files\n\nN/A')).toEqual([])
  })

  it('descarta o que claramente não é caminho de arquivo', () => {
    // O PO escreve texto livre quando não tem certeza. "todo o backend" não é
    // um arquivo, e tratá-lo como um faria duas tarefas quaisquer colidirem.
    const corpo = '## Related Files\n\ntodo o backend, src/real.ts, e mais alguns'
    expect(arquivosDeclarados(corpo)).toEqual(['src/real.ts'])
  })

  it('normaliza para comparar: barra inicial e espaços não criam arquivos diferentes', () => {
    const corpo = '## Related Files\n\n  /src/a.ts ,  ./src/b.ts'
    expect(arquivosDeclarados(corpo)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('não repete o mesmo caminho duas vezes', () => {
    const corpo = '## Related Files\n\nsrc/a.ts, src/a.ts, ./src/a.ts'
    expect(arquivosDeclarados(corpo)).toEqual(['src/a.ts'])
  })
})

describe('achados da lente sobre o que é caminho', () => {
  it('arquivo de verdade SEM extensão conta — Dockerfile some se a regra exigir ponto', () => {
    const corpo = '## Related Files\n\nDockerfile, Makefile, .env, .gitignore'
    expect(arquivosDeclarados(corpo)).toEqual(['Dockerfile', 'Makefile', '.env', '.gitignore'])
  })

  it('número de versão citado no texto NÃO é arquivo', () => {
    // Antes a extensão podia ser numérica, e `v1.2.3` virava arquivo — duas
    // tarefas que citassem a mesma versão colidiriam sem ter nada em comum.
    expect(arquivosDeclarados('## Related Files\n\nv1.2.3')).toEqual([])
  })

  it('barras repetidas são o mesmo arquivo', () => {
    const corpo = '## Related Files\n\nsrc//a.ts, src/a.ts'
    expect(arquivosDeclarados(corpo)).toEqual(['src/a.ts'])
  })

  it('a CAIXA não é normalizada — aqui A.ts e a.ts são dois arquivos mesmo', () => {
    // Juntar os dois inventaria uma colisão que não existe: o sistema de
    // arquivos desta máquina distingue maiúscula de minúscula.
    const corpo = '## Related Files\n\nsrc/A.ts, src/a.ts'
    expect(arquivosDeclarados(corpo)).toHaveLength(2)
  })

  it('caminho longo de verdade passa inteiro', () => {
    const corpo = '## Related Files\n\napps/web/src/app/painel/page.tsx'
    expect(arquivosDeclarados(corpo)).toEqual(['apps/web/src/app/painel/page.tsx'])
  })
})
