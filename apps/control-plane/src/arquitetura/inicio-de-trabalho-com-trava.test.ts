import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Toda porta por onde o produto COMEÇA trabalho tem de passar pela trava de
// entrega (services/trava-de-entrega.ts). Sem isso, uma troca de versão corta
// um agente no meio: o ponto de início novo que esquece a guarda é exatamente o
// que o entregador não consegue ver.
//
// O teste lê os fontes de produção e falha se um arquivo:
//  - cria missão (`mission.create`, `createMany`, `upsert`, INSERT em missions);
//  - toma missão para `running` (`mission.update(Many)` com `status: 'running'`
//    em `data`);
//  - cria diagnóstico (`diagnosisJob.create`);
//  - abre sessão do dev assíncrono (`criarSessaoJules(`);
//  - inicia login assistido (`assistedLogin.start(`, `.start(userId,`)
// SEM importar a guarda, a menos que esteja na lista explícita abaixo.

const raizDoSrc = join(dirname(fileURLToPath(import.meta.url)), '..')

function fontesDeProducao(dir: string): string[] {
  const arquivos: string[] = []
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) {
      if (nome === 'test' || nome === 'arquitetura') continue
      arquivos.push(...fontesDeProducao(caminho))
    } else if (nome.endsWith('.ts') && !nome.endsWith('.test.ts') && !nome.endsWith('.d.ts')) {
      arquivos.push(caminho)
    }
  }
  return arquivos
}

/** Remove comentários de linha e de bloco para não confundir texto com código. */
function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** O texto entre as chaves que abrem em `inicio` (inclusive), com casamento de chaves. */
function blocoDeChaves(texto: string, inicio: number): string {
  let fundo = 0
  for (let i = inicio; i < texto.length; i++) {
    if (texto[i] === '{') fundo += 1
    if (texto[i] === '}') {
      fundo -= 1
      if (fundo === 0) return texto.slice(inicio, i + 1)
    }
  }
  return texto.slice(inicio)
}

/** Quantas chamadas `mission.update/updateMany` põem `status: 'running'` em `data`. */
function contaTomadasParaRunning(codigo: string): number {
  let total = 0
  const chamada = /\bmission\s*\.\s*(?:update|updateMany)\s*\(/g
  for (const m of codigo.matchAll(chamada)) {
    const dentro = codigo.slice(m.index, m.index + 3000)
    const data = /\bdata\s*:\s*\{/.exec(dentro)
    if (!data) continue
    const objeto = blocoDeChaves(dentro, data.index + data[0].length - 1)
    if (/\bstatus\s*:\s*['"`]running['"`]/.test(objeto)) total += 1
  }
  return total
}

const ocorrencias = (codigo: string, re: RegExp): number => [...codigo.matchAll(re)].length

type ChaveDePonto =
  | 'criaMissao'
  | 'tomaMissao'
  | 'criaDiagnostico'
  | 'criaSessaoDev'
  | 'loginAssistido'
  | 'sessaoDevPorInjecao'
type Ponto = { chave: ChaveDePonto; nome: string; conta: (codigo: string) => number }

const PONTOS_DE_INICIO: Ponto[] = [
  {
    chave: 'criaMissao',
    nome: 'cria missão',
    conta: (c) =>
      ocorrencias(c, /\bmission\s*\.\s*(?:create|createMany|upsert)\s*\(/g) +
      ocorrencias(c, /INSERT\s+INTO\s+"?missions"?/gi),
  },
  { chave: 'tomaMissao', nome: "toma missão para 'running'", conta: contaTomadasParaRunning },
  {
    chave: 'criaDiagnostico',
    nome: 'cria diagnóstico',
    conta: (c) => ocorrencias(c, /\bdiagnosisJob\s*\.\s*create\s*\(/g),
  },
  {
    chave: 'criaSessaoDev',
    nome: 'abre sessão do dev assíncrono',
    conta: (c) => ocorrencias(c, /(?<!function\s)\bcriarSessaoJules\s*\(/g),
  },
  {
    chave: 'loginAssistido',
    nome: 'inicia login assistido',
    conta: (c) => ocorrencias(c, /\bassistedLogin\s*\.\s*start\s*\(/g),
  },
  {
    chave: 'sessaoDevPorInjecao',
    nome: 'aciona a criação de sessão do dev por injeção',
    conta: (c) => ocorrencias(c, /\b(?:options|deps)\s*\.\s*criarSessaoDev\s*\(/g),
  },
]

/** Os pontos de início que um arquivo tem, por tipo (só os que existem). */
function contarPontos(codigo: string): Partial<Record<ChaveDePonto, number>> {
  const r: Partial<Record<ChaveDePonto, number>> = {}
  for (const p of PONTOS_DE_INICIO) {
    const n = p.conta(codigo)
    if (n > 0) r[p.chave] = n
  }
  return r
}

/**
 * Arquivos que iniciam trabalho SEM importar a guarda, com o motivo e o trecho
 * que prova que a guarda chega até eles por outro caminho. O teste confere que
 * o trecho continua no arquivo: se alguém tirar o gancho, a justificativa
 * deixa de valer e o teste falha.
 */
const CHAMADO_SO_POR_QUEM_JA_CHECOU: Record<string, { motivo: string; prova: string }> = {
  'services/sm-delegation.ts': {
    motivo:
      'delega por injeção: o agendador passa `trabalhoNovoPermitido` (a guarda) e, sem ela liberada, nenhuma tarefa é escolhida para delegar',
    prova: 'trabalhoNovoPermitido',
  },
  'services/retomar-pr-reprovado.ts': {
    motivo:
      'só aciona o dev por `criarSessaoDev` injetado; todos os chamadores montam esse gancho com `criarSessaoJules`, que recebe `podeIniciar`',
    prova: 'criarSessaoDev',
  },
  'services/jules-client.ts': {
    motivo:
      'é a própria implementação de `criarSessaoJules`, que consulta `podeIniciar` antes de qualquer chamada de rede',
    prova: 'podeIniciar',
  },
  'services/trava-de-entrega.ts': {
    motivo: 'é a guarda',
    prova: 'podeIniciarTrabalho',
  },
}

/**
 * Quantos pontos de início de cada tipo existem em cada arquivo e estão
 * protegidos. `guarda` diz por onde a guarda chega até eles. Mudou a contagem
 * (ponto novo ou removido)? Alguém precisa conferir o ponto e atualizar o número.
 */
const PONTOS_REGISTRADOS: Record<
  string,
  { pontos: Partial<Record<ChaveDePonto, number>>; guarda: string }
> = {
  'plugins/scheduler.ts': {
    pontos: { criaMissao: 1, tomaMissao: 2, criaSessaoDev: 4 },
    guarda:
      'missão do relógio: `runTrigger` checa antes de criar; `processSetupMissions` e `retomarMissoesEsperandoCota` checam antes de tomar para running; as 4 sessões do dev recebem `podeIniciar`',
  },
  'plugins/engines.ts': {
    pontos: { loginAssistido: 1 },
    guarda: 'a rota de início do login assistido recusa com 503 antes de `start`',
  },
  'plugins/telegram.ts': {
    pontos: { criaSessaoDev: 1 },
    guarda: 'a sessão do dev recebe `podeIniciar` no pedido',
  },
  'routes/diagnose.ts': {
    pontos: { criaDiagnostico: 1 },
    guarda: 'a rota recusa com 503 antes de criar o diagnóstico',
  },
  'routes/missions.ts': {
    pontos: { criaMissao: 1 },
    guarda: 'a rota de criar missão recusa com 503 antes de criar',
  },
  'routes/setup.ts': {
    pontos: { criaMissao: 2 },
    guarda: 'as duas rotas que criam missão de setup recusam com 503 antes de criar',
  },
  'services/retomar-pr-reprovado.ts': {
    pontos: { sessaoDevPorInjecao: 1 },
    guarda:
      'aciona o dev só por `criarSessaoDev` injetado, montado com `podeIniciar` pelos chamadores',
  },
  'services/sm-delegation.ts': {
    pontos: { sessaoDevPorInjecao: 1 },
    guarda:
      'delega só se o agendador liberar (`trabalhoNovoPermitido`); a sessão sai por injeção com `podeIniciar`',
  },
}

const importaAGuarda = (codigo: string): boolean => /trava-de-entrega\.js/.test(codigo)

const fontes = fontesDeProducao(raizDoSrc).map((caminho) => ({
  arquivo: relative(raizDoSrc, caminho).split('\\').join('/'),
  codigo: semComentarios(readFileSync(caminho, 'utf8')),
}))

describe('todo ponto que INICIA trabalho passa pela trava de entrega', () => {
  it('o varredor encontra os pontos de início conhecidos (a varredura não está cega)', () => {
    const acham = (nome: string) =>
      fontes
        .filter((f) => PONTOS_DE_INICIO.find((p) => p.nome === nome)!.conta(f.codigo) > 0)
        .map((f) => f.arquivo)
    expect(acham('cria missão')).toEqual(
      expect.arrayContaining(['plugins/scheduler.ts', 'routes/missions.ts', 'routes/setup.ts'])
    )
    expect(acham("toma missão para 'running'")).toContain('plugins/scheduler.ts')
    expect(acham('cria diagnóstico')).toContain('routes/diagnose.ts')
    expect(acham('abre sessão do dev assíncrono')).toEqual(
      expect.arrayContaining(['plugins/scheduler.ts', 'plugins/telegram.ts'])
    )
    expect(acham('inicia login assistido')).toContain('plugins/engines.ts')
  })

  it('cada arquivo tem exatamente os pontos de início registrados (ponto novo exige revisão)', () => {
    const divergencias: string[] = []
    const arquivosComPonto = new Set<string>()
    for (const f of fontes) {
      const real = contarPontos(f.codigo)
      if (Object.keys(real).length === 0) continue
      arquivosComPonto.add(f.arquivo)
      const esperado = PONTOS_REGISTRADOS[f.arquivo]?.pontos ?? {}
      if (
        JSON.stringify(real, Object.keys(real).sort()) !==
        JSON.stringify(esperado, Object.keys(esperado).sort())
      ) {
        divergencias.push(
          `${f.arquivo}: real ${JSON.stringify(real)} / registrado ${JSON.stringify(esperado)}`
        )
      }
    }
    for (const arquivo of Object.keys(PONTOS_REGISTRADOS)) {
      if (!arquivosComPonto.has(arquivo)) {
        divergencias.push(`${arquivo}: registrado, mas não tem mais ponto de início (tire do mapa)`)
      }
    }
    expect(
      divergencias,
      'A contagem real de pontos de início difere da registrada. Um ponto novo tem de ' +
        'passar pela guarda (services/trava-de-entrega.js) E ter o número atualizado aqui, conscientemente'
    ).toEqual([])
  })

  it('todo arquivo do mapa importa a guarda ou está justificado como chamado só por quem já checou', () => {
    const semGuarda: string[] = []
    for (const f of fontes) {
      if (!PONTOS_REGISTRADOS[f.arquivo]) continue
      if (importaAGuarda(f.codigo)) continue
      if (CHAMADO_SO_POR_QUEM_JA_CHECOU[f.arquivo]) continue
      semGuarda.push(f.arquivo)
    }
    expect(
      semGuarda,
      'Estes arquivos iniciam trabalho sem passar pela trava de entrega ' +
        '(import de services/trava-de-entrega.js) nem constam da lista justificada'
    ).toEqual([])
  })

  it('a lista de "chamado só por quem já checou" é honesta: o arquivo existe, inicia trabalho e traz a prova', () => {
    for (const [arquivo, { prova }] of Object.entries(CHAMADO_SO_POR_QUEM_JA_CHECOU)) {
      const f = fontes.find((x) => x.arquivo === arquivo)
      expect(f, `${arquivo} não existe mais; tire da lista`).toBeDefined()
      expect(f!.codigo, `${arquivo} perdeu o gancho "${prova}"`).toContain(prova)
    }
  })

  it('cada abertura de sessão do dev recebe a guarda (`podeIniciar`) logo no pedido', () => {
    for (const f of fontes) {
      if (CHAMADO_SO_POR_QUEM_JA_CHECOU[f.arquivo]) continue
      for (const m of f.codigo.matchAll(/(?<!function\s)\bcriarSessaoJules\s*\(\s*\{/g)) {
        const pedido = f.codigo.slice(m.index, m.index + 400)
        expect(pedido, `${f.arquivo}: criarSessaoJules sem podeIniciar`).toContain('podeIniciar')
      }
    }
  })

  it('o agendador aplica a guarda no relógio: tique, tique rápido e criação de missão', () => {
    const agendador = fontes.find((f) => f.arquivo === 'plugins/scheduler.ts')!.codigo
    // criação/tomada de missão
    expect(agendador).toMatch(
      /if \(!\(await podeIniciar\(\)\)\) \{\s*app\.log\.info\([^)]*em entrega/
    )
    expect(agendador).toContain('const emEntrega = await decidirSeEstaEmEntrega()')
    expect(agendador).toContain('const emEntrega = !(await podeIniciar())')
    // delegação do SM
    expect(agendador).toContain('trabalhoNovoPermitido: podeIniciar')
  })
})
