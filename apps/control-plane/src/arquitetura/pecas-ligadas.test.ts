import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Peça construída e testada que ninguém chama é peça que não existe para o
// produto: o teste da própria peça passa, o build passa, e nada acontece em
// produção. Este teste lê o código-fonte e confere, para cada uma das peças
// abaixo, se existe quem a importe ou chame fora de `*.test.ts` e fora de
// `scripts/` (que fica fora de `src/` e por isso nem é lido).
//
// COMO USAR A LISTA `PENDENTES`: ela é a lista das peças AINDA NÃO LIGADAS.
//  - toda peça fora de `PENDENTES` precisa ter chamador (senão alguém a
//    desligou sem querer);
//  - toda peça em `PENDENTES` NÃO pode ter chamador ainda (se alguém ligou e
//    esqueceu de tirar da lista, o teste falha pedindo para remover).
// Cada fase da ligação remove daqui as peças que ela liga. A lista deve estar
// VAZIA antes do deploy: peça pendente no deploy é peça órfã em produção.

/** As peças do pacote de ligação. */
const AS_PECAS = [
  'acharTarefaDoItem',
  'racharTarefaParecidaPeloCodigo',
  'perguntarSobreVinculoDaTarefa',
  'registrarEntendimentoDoPedido',
  'registrarDirecaoDoProjeto',
  'conferirTarefaSemPedido',
  'ajustarTarefaForaDoPadrao',
  'reavaliarForaDaSprint',
  'calcularNotaDeSeguranca',
  'aplicarMelhoriaDeSeguranca',
  'conferirConformidade',
  'workflowDeAlternativaGratuita',
] as const

/** As ainda não ligadas. Cada fase seguinte remove as suas. */
const PENDENTES: ReadonlySet<string> = new Set<string>([
  'registrarDirecaoDoProjeto',
  'conferirTarefaSemPedido',
  'ajustarTarefaForaDoPadrao',
  'reavaliarForaDaSprint',
  'calcularNotaDeSeguranca',
  'aplicarMelhoriaDeSeguranca',
  'conferirConformidade',
  'workflowDeAlternativaGratuita',
])

const raizDoSrc = join(dirname(fileURLToPath(import.meta.url)), '..')

function arquivosDeProducao(pasta: string): string[] {
  const achados: string[] = []
  for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
    const caminho = join(pasta, entrada.name)
    if (entrada.isDirectory()) {
      // `src/test/` é só apoio de teste (setup, fakes).
      if (entrada.name === 'test') continue
      achados.push(...arquivosDeProducao(caminho))
    } else if (
      entrada.name.endsWith('.ts') &&
      !entrada.name.endsWith('.test.ts') &&
      !entrada.name.endsWith('.d.ts')
    ) {
      achados.push(caminho)
    }
  }
  return achados
}

interface ArquivoLido {
  caminho: string
  texto: string
}

const ARQUIVOS: ArquivoLido[] = arquivosDeProducao(raizDoSrc).map((caminho) => ({
  caminho: relative(raizDoSrc, caminho),
  texto: readFileSync(caminho, 'utf-8'),
}))

/** Os identificadores de verdade do arquivo: comentário e texto de string não entram. */
function identificadoresDe(arquivo: ArquivoLido): Set<string> {
  const fonte = ts.createSourceFile(arquivo.caminho, arquivo.texto, ts.ScriptTarget.ES2022, true)
  const nomes = new Set<string>()
  const visitar = (no: ts.Node): void => {
    if (ts.isIdentifier(no)) nomes.add(no.text)
    ts.forEachChild(no, visitar)
  }
  visitar(fonte)
  return nomes
}

/** Onde a função é declarada (`function nome` ou `const nome =`). */
function arquivosQueDeclaram(nome: string): string[] {
  const declaracao = new RegExp(`\\b(?:function|const|let)\\s+${nome}\\b`)
  return ARQUIVOS.filter((a) => declaracao.test(a.texto)).map((a) => a.caminho)
}

const CACHE_DE_IDENTIFICADORES = new Map<string, Set<string>>()
function usa(arquivo: ArquivoLido, nome: string): boolean {
  if (!arquivo.texto.includes(nome)) return false
  let nomes = CACHE_DE_IDENTIFICADORES.get(arquivo.caminho)
  if (!nomes) {
    nomes = identificadoresDe(arquivo)
    CACHE_DE_IDENTIFICADORES.set(arquivo.caminho, nomes)
  }
  return nomes.has(nome)
}

/**
 * Quem importa ou chama a peça: qualquer arquivo de produção que não seja o
 * que a declara, e que também não seja o arquivo de OUTRA peça pendente (uma
 * peça só chamada por outra peça órfã continua órfã).
 */
function chamadoresDe(nome: string): string[] {
  const declarantes = new Set(arquivosQueDeclaram(nome))
  const arquivosDePecasPendentes = new Set(
    [...PENDENTES].flatMap((pendente) => arquivosQueDeclaram(pendente))
  )
  return ARQUIVOS.filter(
    (a) => !declarantes.has(a.caminho) && !arquivosDePecasPendentes.has(a.caminho) && usa(a, nome)
  ).map((a) => a.caminho)
}

describe('as peças da ligação têm quem as chame', () => {
  it('cada peça é declarada em exatamente um arquivo (o teste não pode ficar vazio por renomeação)', () => {
    for (const peca of AS_PECAS) {
      expect(arquivosQueDeclaram(peca), `declaração de ${peca}`).toHaveLength(1)
    }
  })

  it('PENDENTES só contém nomes que existem na lista das peças', () => {
    for (const pendente of PENDENTES) {
      expect(AS_PECAS as readonly string[], `"${pendente}" não é uma das peças`).toContain(pendente)
    }
  })

  it('o detector enxerga um chamador real (controle: peça já ligada)', () => {
    expect(chamadoresDe('planoPermiteMelhoria')).toContain(join('services', 'decisao-do-vigia.ts'))
  })

  it('o detector não confunde comentário com chamada', () => {
    const lido: ArquivoLido = {
      caminho: 'falso.ts',
      texto: '// conferirConformidade(x)\nconst texto = "conferirConformidade"\n',
    }
    expect(usa(lido, 'conferirConformidade')).toBe(false)
  })

  for (const peca of AS_PECAS) {
    if (PENDENTES.has(peca)) {
      it(`${peca}: pendente e ainda sem chamador`, () => {
        const chamadores = chamadoresDe(peca)
        expect(
          chamadores,
          `${peca} já tem chamador (${chamadores.join(', ')}): tire-a de PENDENTES`
        ).toEqual([])
      })
    } else {
      it(`${peca}: ligada, tem chamador fora de teste e de scripts`, () => {
        expect(
          chamadoresDe(peca),
          `${peca} está fora de PENDENTES mas ninguém a importa nem chama`
        ).not.toEqual([])
      })
    }
  }
})
