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

/** `mission.update/updateMany` cujo `data: { ... }` põe `status: 'running'`. */
function tomaMissaoParaRunning(codigo: string): boolean {
  const chamada = /\bmission\s*\.\s*(?:update|updateMany)\s*\(/g
  for (const m of codigo.matchAll(chamada)) {
    const dentro = codigo.slice(m.index, m.index + 3000)
    const data = /\bdata\s*:\s*\{/.exec(dentro)
    if (!data) continue
    const objeto = blocoDeChaves(dentro, data.index + data[0].length - 1)
    if (/\bstatus\s*:\s*['"`]running['"`]/.test(objeto)) return true
  }
  return false
}

type Ponto = { nome: string; acha: (codigo: string) => boolean }

const PONTOS_DE_INICIO: Ponto[] = [
  {
    nome: 'cria missão',
    acha: (c) =>
      /\bmission\s*\.\s*(?:create|createMany|upsert)\s*\(/.test(c) ||
      /INSERT\s+INTO\s+"?missions"?/i.test(c),
  },
  { nome: "toma missão para 'running'", acha: tomaMissaoParaRunning },
  { nome: 'cria diagnóstico', acha: (c) => /\bdiagnosisJob\s*\.\s*create\s*\(/.test(c) },
  {
    nome: 'abre sessão do dev assíncrono',
    acha: (c) => /(?<!function\s)\bcriarSessaoJules\s*\(/.test(c),
  },
  {
    nome: 'inicia login assistido',
    acha: (c) => /\bassistedLogin\s*\.\s*start\s*\(/.test(c),
  },
  {
    nome: 'aciona a criação de sessão do dev por injeção',
    acha: (c) => /\b(?:options|deps)\s*\.\s*criarSessaoDev\s*\(/.test(c),
  },
]

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

const importaAGuarda = (codigo: string): boolean => /trava-de-entrega\.js/.test(codigo)

const fontes = fontesDeProducao(raizDoSrc).map((caminho) => ({
  arquivo: relative(raizDoSrc, caminho).split('\\').join('/'),
  codigo: semComentarios(readFileSync(caminho, 'utf8')),
}))

describe('todo ponto que INICIA trabalho passa pela trava de entrega', () => {
  it('o varredor encontra os pontos de início conhecidos (a varredura não está cega)', () => {
    const acham = (nome: string) =>
      fontes
        .filter((f) => PONTOS_DE_INICIO.find((p) => p.nome === nome)!.acha(f.codigo))
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

  it('nenhum arquivo de produção inicia trabalho sem a guarda ou sem estar justificado', () => {
    const semGuarda: string[] = []
    for (const f of fontes) {
      const pontos = PONTOS_DE_INICIO.filter((p) => p.acha(f.codigo)).map((p) => p.nome)
      if (pontos.length === 0) continue
      if (importaAGuarda(f.codigo)) continue
      if (CHAMADO_SO_POR_QUEM_JA_CHECOU[f.arquivo]) continue
      semGuarda.push(`${f.arquivo}: ${pontos.join(', ')}`)
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
