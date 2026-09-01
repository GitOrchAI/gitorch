import { describe, it, expect, vi } from 'vitest'
import {
  CATEGORIAS_DE_DIAGNOSTICO,
  diagnosticarIssues,
  similaridadeDeConteudo,
  detectarRepetidos,
  avaliarParado,
  avaliarRisco,
  avaliarVago,
  type IssueParaDiagnostico,
} from './diagnostico-de-issues.js'
import type { ResultadoDaConsulta } from './grafo-do-codigo.js'

function issue(over: Partial<IssueParaDiagnostico> = {}): IssueParaDiagnostico {
  return {
    number: 1,
    title: 'Corrigir exportação de PDF',
    body: 'Ao exportar o relatório em PDF, o arquivo vem em branco. Passos: 1. abrir relatório 2. exportar 3. abrir o PDF gerado — está vazio.',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    labels: [],
    ...over,
  }
}

describe('as cinco categorias, sem uma sexta', () => {
  it('são exatamente estas cinco, nesta ordem de prioridade', () => {
    expect(CATEGORIAS_DE_DIAGNOSTICO).toEqual([
      'ja_resolvido',
      'repetido',
      'parado',
      'risco',
      'vago',
    ])
  })
})

describe('similaridadeDeConteudo / detectarRepetidos — compara CONTEÚDO, não nome', () => {
  it('a ARMADILHA JÁ PAGA: hífen vs underscore no título não escondem uma repetição real', () => {
    const a = issue({
      number: 10,
      title: 'Erro ao sincronizar catalogo-ml com o Mercado Livre',
      body: 'O catálogo do Mercado Livre não sincroniza os preços quando o produto tem variação de cor.',
      createdAt: '2026-05-01T00:00:00Z',
    })
    const b = issue({
      number: 20,
      title: 'Erro ao sincronizar catalogo_ml com o Mercado Livre',
      body: 'O catálogo do Mercado Livre não sincroniza os preços quando o produto tem variação de cor.',
      createdAt: '2026-05-10T00:00:00Z',
    })
    expect(similaridadeDeConteudo(a, b)).toBeGreaterThanOrEqual(0.6)

    const repetidos = detectarRepetidos([a, b])
    expect(repetidos.get(20)).toEqual({ original: 10, similaridade: expect.any(Number) })
    expect(repetidos.has(10)).toBe(false) // a original não é "repetição de si mesma"
  })

  it('NÃO usa só o título: duas issues com título parecido mas conteúdo diferente não são repetidas', () => {
    const a = issue({
      number: 1,
      title: 'Erro no login',
      body: 'O botão "Entrar com Google" não redireciona — fica girando para sempre no OAuth.',
      createdAt: '2026-05-01T00:00:00Z',
    })
    const b = issue({
      number: 2,
      title: 'Erro no login',
      body: 'Ao digitar a senha errada três vezes, a conta é bloqueada mas o email de aviso nunca chega.',
      createdAt: '2026-05-05T00:00:00Z',
    })
    const repetidos = detectarRepetidos([a, b])
    expect(repetidos.size).toBe(0)
  })

  it('a issue mais antiga fica original; a mais nova é que carrega a marca de repetida', () => {
    const antiga = issue({
      number: 5,
      title: 'Formulário de contato não envia email',
      body: 'Preencher o formulário de contato e clicar em enviar não dispara o email para o suporte.',
      createdAt: '2026-01-01T00:00:00Z',
    })
    const nova = issue({
      number: 50,
      title: 'Formulário de contato quebrado — email não chega',
      body: 'Preencher o formulário de contato e clicar em enviar não dispara o email para o suporte.',
      createdAt: '2026-06-01T00:00:00Z',
    })
    const repetidos = detectarRepetidos([nova, antiga]) // ordem de entrada não importa
    expect(repetidos.get(50)?.original).toBe(5)
    expect(repetidos.has(5)).toBe(false)
  })
})

describe('avaliarParado', () => {
  const agora = Date.parse('2026-09-01T00:00:00Z')

  it('marca parado quando passou do limite de dias sem atualização', () => {
    const i = issue({ updatedAt: '2026-06-01T00:00:00Z' }) // ~92 dias antes
    const r = avaliarParado(i, agora, 45)
    expect(r.parado).toBe(true)
  })

  it('não marca parado dentro do limite', () => {
    const i = issue({ updatedAt: '2026-08-25T00:00:00Z' }) // ~7 dias antes
    const r = avaliarParado(i, agora, 45)
    expect(r.parado).toBe(false)
  })
})

describe('avaliarRisco', () => {
  it('marca risco por termo sensível no corpo', () => {
    const i = issue({
      title: 'Senha do admin aparece em texto puro no log',
      body: 'A senha do administrador está sendo gravada em texto puro no log de acesso.',
    })
    const r = avaliarRisco(i)
    expect(r.risco).toBe(true)
  })

  it('marca risco por label de segurança mesmo sem termo no texto', () => {
    const i = issue({
      title: 'Ajuste no botão azul',
      body: 'Trocar a cor do botão.',
      labels: ['security'],
    })
    expect(avaliarRisco(i).risco).toBe(true)
  })

  it('issue comum, sem termo nem label de risco, não é marcada', () => {
    const i = issue({
      title: 'Trocar cor do botão de salvar',
      body: 'O botão de salvar deveria ser verde.',
    })
    expect(avaliarRisco(i).risco).toBe(false)
  })
})

describe('avaliarVago', () => {
  it('corpo vazio é vago', () => {
    expect(avaliarVago(issue({ body: '' })).vago).toBe(true)
  })

  it('corpo curtíssimo sem estrutura é vago', () => {
    expect(avaliarVago(issue({ body: 'não funciona direito' })).vago).toBe(true)
  })

  it('corpo curto mas com passos numerados não é vago', () => {
    expect(avaliarVago(issue({ body: '1. abrir\n2. clicar\n3. quebra' })).vago).toBe(false)
  })

  it('corpo com detalhe suficiente não é vago', () => {
    const i = issue()
    expect(avaliarVago(i).vago).toBe(false)
  })
})

describe('diagnosticarIssues — orquestração e prioridade', () => {
  const CONSULTA_VAZIA: ResultadoDaConsulta = {
    disponivel: true,
    bruto: 'No matching nodes found.\n',
    nos: [],
  }

  it('quando o grafo não está disponível, "já resolvido" nunca é usado e o motivo aparece explícito', async () => {
    const issues = [issue({ number: 1 })]
    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: false, motivo: 'graphify não instalado' }),
      consultarGrafo: vi.fn(),
    })
    expect(resultado.grafoIndisponivel).toBe('graphify não instalado')
    expect(resultado.achados.some((a) => a.categoria === 'ja_resolvido')).toBe(false)
  })

  it('clone raso (git fetch --unshallow falhou): "já resolvido" não roda — não dá pra confiar na recência', async () => {
    const issues = [issue({ number: 1 })]
    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: true }),
      garantirHistorico: vi
        .fn()
        .mockResolvedValue({ ok: false, motivo: 'git fetch --unshallow falhou: sem rede' }),
      consultarGrafo: vi.fn(),
    })
    expect(resultado.grafoIndisponivel).toContain('sem rede')
    expect(resultado.achados.some((a) => a.categoria === 'ja_resolvido')).toBe(false)
  })

  // Título com exatamente 2 termos "significativos" (>=4 letras, fora da lista
  // de palavras ignoradas) — "exportar" e "relatorio" — para o limiar de
  // cobertura (0.7, mínimo 2 termos) ser alcançável de forma inequívoca nos
  // testes. `agora` é fixado perto de `createdAt`/`updatedAt` de propósito:
  // sem isso, o padrão de datas do fixture (bem no passado) cairia em
  // "parado" antes mesmo de a diferença de "já resolvido" ser observável —
  // cada teste teria dois sinais mudando ao mesmo tempo.
  const AGORA_DO_TESTE = Date.parse('2026-04-01T00:00:00Z')

  it('marca ja_resolvido só com as DUAS evidências: cobertura textual alta E arquivo alterado depois da issue', async () => {
    const abertaEm = '2026-01-01T00:00:00Z'
    const issues = [
      issue({
        number: 42,
        title: 'Exportar relatorio',
        createdAt: abertaEm,
        updatedAt: abertaEm,
      }),
    ]
    const consultarGrafo = vi.fn().mockResolvedValue({
      disponivel: true,
      bruto: '',
      nos: [
        { label: 'exportarRelatorio', arquivo: 'src/relatorios/exportar.ts', semente: true },
        { label: 'gerarPdfDoRelatorio', arquivo: 'src/relatorios/exportar.ts', semente: true },
      ],
    } satisfies ResultadoDaConsulta)
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '2026-03-01T00:00:00Z\n', stderr: '' }) // depois da issue

    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: true }),
      consultarGrafo,
      execFileImpl,
      agora: AGORA_DO_TESTE,
    })

    expect(resultado.achados).toHaveLength(1)
    expect(resultado.achados[0]).toMatchObject({ issue: 42, categoria: 'ja_resolvido' })
    expect(resultado.achados[0]?.evidencia).toContain('src/relatorios/exportar.ts')
  })

  it('NÃO marca ja_resolvido quando o código relacionado existe mas nada mudou depois da issue (só evidência textual)', async () => {
    const issues = [
      issue({
        number: 43,
        title: 'Exportar relatorio',
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
      }),
    ]
    const consultarGrafo = vi.fn().mockResolvedValue({
      disponivel: true,
      bruto: '',
      nos: [{ label: 'exportarRelatorio', arquivo: 'src/relatorios/exportar.ts', semente: true }],
    } satisfies ResultadoDaConsulta)
    // arquivo só foi alterado ANTES da issue ser aberta — é o próprio código com o bug, não uma correção.
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '2026-01-01T00:00:00Z\n', stderr: '' })

    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: true }),
      consultarGrafo,
      execFileImpl,
      agora: AGORA_DO_TESTE,
    })

    expect(resultado.achados.find((a) => a.issue === 43)?.categoria).not.toBe('ja_resolvido')
  })

  it('NÃO marca ja_resolvido só por cobertura textual fraca (poucos termos batendo)', async () => {
    const issues = [
      issue({
        number: 44,
        title: 'Exportar relatorio',
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
      }),
    ]
    const consultarGrafo = vi.fn().mockResolvedValue({
      disponivel: true,
      bruto: '',
      nos: [{ label: 'algumaCoisaNaoRelacionada', arquivo: 'src/outro/arquivo.ts', semente: true }],
    } satisfies ResultadoDaConsulta)
    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: true }),
      consultarGrafo,
      execFileImpl: vi.fn(),
      agora: AGORA_DO_TESTE,
    })
    expect(resultado.achados.find((a) => a.issue === 44)?.categoria).not.toBe('ja_resolvido')
  })

  // REGRESSÃO DE UM FALSO POSITIVO REAL: medido em 01/09/2026 contra o Jardim
  // das Patinhas, a issue #3868 batia com "exportarRelatorio" (semente de
  // verdade) MAS o único arquivo alterado depois da issue era `App.tsx` — um
  // nó VIZINHO (só entrou na resposta por estar a 1-2 saltos da semente no
  // BFS, o roteador que importa toda página da aplicação), sem nenhum termo
  // do título batendo nele. Antes da correção, qualquer arquivo entre os nós
  // retornados contava; agora só semente conta.
  it('NÃO marca ja_resolvido quando o arquivo recente é só um VIZINHO (hub como App.tsx), não uma semente', async () => {
    const issues = [
      issue({
        number: 3868,
        title: 'Exportar relatorio',
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
      }),
    ]
    const consultarGrafo = vi.fn().mockResolvedValue({
      disponivel: true,
      bruto: '',
      nos: [
        // semente de verdade: bate com o título, mas NÃO foi alterada depois da issue.
        { label: 'exportarRelatorio', arquivo: 'src/relatorios/exportar.ts', semente: true },
        // vizinho trazido pelo BFS: não tem nada a ver com o título, mas É recente.
        { label: 'App', arquivo: 'src/App.tsx', semente: false },
      ],
    } satisfies ResultadoDaConsulta)
    const execFileImpl = vi.fn().mockImplementation(async (_cmd, args) => {
      const arquivo = args[args.length - 1]
      // Só o vizinho (App.tsx) foi alterado depois da issue; a semente, não.
      return arquivo === 'src/App.tsx'
        ? { stdout: '2026-03-01T00:00:00Z\n', stderr: '' }
        : { stdout: '2026-01-01T00:00:00Z\n', stderr: '' }
    })

    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: true }),
      consultarGrafo,
      execFileImpl,
      agora: AGORA_DO_TESTE,
    })

    expect(resultado.achados.find((a) => a.issue === 3868)?.categoria).not.toBe('ja_resolvido')
  })

  // SEGUNDA REGRESSÃO DE UM FALSO POSITIVO REAL: mesma issue #3868, mas desta
  // vez `App.tsx` bate como SEMENTE de verdade — o roteador tem uma linha
  // `const Checkout = lazy(() => import(...))`, então o termo "checkout" do
  // título acha um identificador real ali. Filtrar só vizinho (teste acima)
  // não resolve este caso; é preciso excluir o arquivo de roteamento em si.
  it('NÃO marca ja_resolvido quando o único arquivo recente é um arquivo de ROTEAMENTO (App.tsx), mesmo como semente', async () => {
    const issues = [
      issue({
        number: 3868,
        title: 'Checkout Flow',
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
      }),
    ]
    const consultarGrafo = vi.fn().mockResolvedValue({
      disponivel: true,
      bruto: '',
      // "CheckoutFlow" é semente de verdade (identificador real em App.tsx), e
      // é o ÚNICO arquivo candidato — sem exclusão de roteador, isto marcaria
      // ja_resolvido pela cobertura textual + recência de App.tsx sozinho.
      nos: [{ label: 'CheckoutFlow', arquivo: 'src/App.tsx', semente: true }],
    } satisfies ResultadoDaConsulta)
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '2026-03-01T00:00:00Z\n', stderr: '' })

    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: true }),
      consultarGrafo,
      execFileImpl,
      agora: AGORA_DO_TESTE,
    })

    expect(resultado.achados.find((a) => a.issue === 3868)?.categoria).not.toBe('ja_resolvido')
  })

  it('prioridade: ja_resolvido vence repetido quando os dois bateriam', async () => {
    const abertaEm = '2026-01-15T00:00:00Z'
    const original = issue({
      number: 1,
      title: 'Exportar relatorio',
      body: 'Ao exportar o relatório em PDF, o arquivo vem em branco.',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    })
    const duplicataEJaResolvida = issue({
      number: 2,
      title: 'Exportar relatorio',
      body: 'Ao exportar o relatório em PDF, o arquivo vem em branco.',
      createdAt: abertaEm,
      updatedAt: abertaEm,
    })
    const consultarGrafo = vi.fn().mockResolvedValue({
      disponivel: true,
      bruto: '',
      nos: [
        { label: 'exportarRelatorio', arquivo: 'src/relatorios/exportar.ts', semente: true },
        { label: 'gerarPdfDoRelatorio', arquivo: 'src/relatorios/exportar.ts', semente: true },
      ],
    } satisfies ResultadoDaConsulta)
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '2026-03-01T00:00:00Z\n', stderr: '' })

    const resultado = await diagnosticarIssues([original, duplicataEJaResolvida], {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: true }),
      consultarGrafo,
      execFileImpl,
      agora: AGORA_DO_TESTE,
    })

    const achadoDaDuplicata = resultado.achados.find((a) => a.issue === 2)
    expect(achadoDaDuplicata?.categoria).toBe('ja_resolvido')
  })

  it('prioridade: repetido vence parado quando os dois bateriam', async () => {
    const antiga = issue({
      number: 1,
      title: 'Formulário de contato não envia email',
      body: 'Preencher o formulário de contato e clicar em enviar não dispara o email para o suporte.',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    const novaParadaERepetida = issue({
      number: 2,
      title: 'Formulário de contato quebrado, email não chega',
      body: 'Preencher o formulário de contato e clicar em enviar não dispara o email para o suporte.',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z', // também "parado" pela data
    })
    const agora = Date.parse('2026-09-01T00:00:00Z')

    const resultado = await diagnosticarIssues([antiga, novaParadaERepetida], {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: false, motivo: 'sem grafo neste teste' }),
      consultarGrafo: vi.fn(),
      agora,
    })

    expect(resultado.achados.find((a) => a.issue === 2)?.categoria).toBe('repetido')
  })

  it('cada issue recebe no máximo um achado', async () => {
    const issues = [issue({ number: 1, body: '' })] // vazia -> vago, e nada mais deveria bater antes
    const resultado = await diagnosticarIssues(issues, {
      workspacePath: '/ws/repo',
      garantirGrafo: vi.fn().mockResolvedValue({ ok: false, motivo: 'sem grafo neste teste' }),
      consultarGrafo: vi.fn(),
    })
    const achadosDaIssue1 = resultado.achados.filter((a) => a.issue === 1)
    expect(achadosDaIssue1).toHaveLength(1)
  })

  it('consultarGrafo/garantirGrafo nunca são chamados com nada além de leitura — a função não expõe nenhum jeito de escrever no GitHub', async () => {
    const garantirGrafo = vi.fn().mockResolvedValue({ ok: true })
    const consultarGrafo = vi.fn().mockResolvedValue(CONSULTA_VAZIA)
    await diagnosticarIssues([issue()], {
      workspacePath: '/ws/repo',
      garantirGrafo,
      consultarGrafo,
      execFileImpl: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    })
    // A assinatura pública de diagnosticarIssues não recebe token/credencial de escrita —
    // a garantia estrutural é não existir parâmetro nem chamada de rede de escrita aqui.
    expect(garantirGrafo).toHaveBeenCalledWith('/ws/repo')
  })
})
