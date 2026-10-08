import { describe, expect, it } from 'vitest'
import {
  chaveDoEventoDaMelhoria,
  planejarMelhorias,
  proximaTentativaApos,
  textoDoEventoDaMelhoria,
} from './melhorias-de-seguranca.js'
import type { RegistroDaMelhoria } from './executores-de-seguranca.js'
import type { SondagemDoRepositorio, WorkflowSondado } from './sondagem-de-seguranca.js'

const AGORA = new Date('2026-03-10T12:00:00.000Z')

function workflow(caminho: string, parcial: Partial<WorkflowSondado> = {}): WorkflowSondado {
  return {
    caminho,
    declaraPermissoes: false,
    ehDeploy: false,
    seguroParaPermissaoMinima: true,
    motivoDeNaoSeguro: null,
    temGitleaks: false,
    temCodeql: false,
    ...parcial,
  }
}

function sondagem(parcial: Partial<SondagemDoRepositorio> = {}): SondagemDoRepositorio {
  return {
    versao: 1,
    repositorio: 'acme/api',
    sondadoEm: AGORA.toISOString(),
    credencial: 'cliente ou dono',
    comAdmin: true,
    privado: false,
    branchPadrao: 'main',
    segredos: 'desligado',
    bloqueioDePush: 'desligado',
    alertasDeDependencias: 'desligado',
    atualizacoesDeSeguranca: 'desligado',
    varreduraDeCodigo: 'desligado',
    linguagensSuportadas: ['javascript-typescript'],
    permissaoDoWorkflow: 'write',
    podeAprovarPrs: false,
    workflows: {
      estado: 'lidos',
      truncado: false,
      itens: [workflow('.github/workflows/ci.yml', { declaraPermissoes: true })],
    },
    ...parcial,
  }
}

function registro(
  estado: RegistroDaMelhoria['estado'],
  extra: Partial<RegistroDaMelhoria> = {}
): RegistroDaMelhoria {
  return {
    estado,
    atualizadoEm: AGORA.toISOString(),
    proximaTentativaEm: null,
    tentativas: 1,
    motivo: 'x',
    desfazer: 'Como desfazer: ...',
    ...extra,
  }
}

const ids = (
  s: SondagemDoRepositorio,
  registros: Record<string, RegistroDaMelhoria> = {},
  liberados: string[] = []
) =>
  planejarMelhorias({
    sondagem: s,
    registros,
    liberadosPeloDono: new Set(liberados),
    agora: AGORA,
  }).candidatas.map((c) => c.id)

describe('planejarMelhorias: o que aplicar e em que ordem', () => {
  it('repositório público com tudo desligado: a ordem fixa, uma de cada, e a permissão padrão por último', () => {
    expect(ids(sondagem())).toEqual([
      'alertas-de-dependencias',
      'varredura-de-senhas',
      'varredura-de-codigo',
      'permissao-padrao-do-workflow',
    ])
  })

  it('atualizações de segurança só entram depois dos alertas estarem ligados', () => {
    expect(ids(sondagem({ alertasDeDependencias: 'ligado' }))).toContain(
      'atualizacoes-de-seguranca'
    )
    expect(ids(sondagem({ alertasDeDependencias: 'desligado' }))).not.toContain(
      'atualizacoes-de-seguranca'
    )
    expect(
      ids(sondagem({ alertasDeDependencias: 'ligado', atualizacoesDeSeguranca: 'ligado' }))
    ).not.toContain('atualizacoes-de-seguranca')
  })

  it('só planeja o que a sondagem viu "desligado": "indisponível" e "desconhecido" nunca viram escrita', () => {
    const s = sondagem({
      alertasDeDependencias: 'desconhecido',
      segredos: 'indisponivel',
      bloqueioDePush: 'indisponivel',
      varreduraDeCodigo: 'indisponivel',
      permissaoDoWorkflow: null,
    })
    expect(ids(s)).toEqual([])
  })

  it('senhas vazadas: basta um dos dois (varredura ou bloqueio de push) estar desligado', () => {
    expect(ids(sondagem({ segredos: 'ligado', bloqueioDePush: 'desligado' }))).toContain(
      'varredura-de-senhas'
    )
    expect(ids(sondagem({ segredos: 'desligado', bloqueioDePush: 'ligado' }))).toContain(
      'varredura-de-senhas'
    )
    expect(ids(sondagem({ segredos: 'ligado', bloqueioDePush: 'ligado' }))).not.toContain(
      'varredura-de-senhas'
    )
  })

  it('credencial sem admin: nenhuma configuração é planejada', () => {
    const s = sondagem({
      comAdmin: false,
      alertasDeDependencias: 'desconhecido',
      segredos: 'desconhecido',
      bloqueioDePush: 'desconhecido',
      varreduraDeCodigo: 'desconhecido',
      permissaoDoWorkflow: null,
    })
    expect(ids(s)).toEqual([])
  })

  it('proteção de branch NUNCA aparece, em nenhuma sondagem', () => {
    for (const s of [sondagem(), sondagem({ privado: true, segredos: 'indisponivel' })]) {
      expect(ids(s).some((i) => /branch|protec/i.test(i))).toBe(false)
    }
  })
})

describe('planejarMelhorias: a alternativa gratuita (PR) para repositório privado sem o recurso', () => {
  const privadoGratis = (extra: Partial<SondagemDoRepositorio> = {}) =>
    sondagem({
      privado: true,
      segredos: 'indisponivel',
      bloqueioDePush: 'indisponivel',
      varreduraDeCodigo: 'indisponivel',
      ...extra,
    })

  it('é proposta quando o recurso não existe e nenhum workflow roda gitleaks', () => {
    expect(ids(privadoGratis())).toContain('alternativa-de-varredura-de-senhas')
  })

  it('não é proposta se já há gitleaks em algum workflow', () => {
    const s = privadoGratis({
      workflows: {
        estado: 'lidos',
        truncado: false,
        itens: [
          workflow('.github/workflows/ci.yml', { declaraPermissoes: true, temGitleaks: true }),
        ],
      },
    })
    expect(ids(s)).not.toContain('alternativa-de-varredura-de-senhas')
  })

  it('sem a pasta de workflows (ausente) também é proposta; com erro de leitura NÃO', () => {
    expect(
      ids(privadoGratis({ workflows: { estado: 'ausente', truncado: false, itens: [] } }))
    ).toContain('alternativa-de-varredura-de-senhas')
    expect(
      ids(privadoGratis({ workflows: { estado: 'erro', truncado: false, itens: [] } }))
    ).not.toContain('alternativa-de-varredura-de-senhas')
  })

  it('repositório público nunca recebe a alternativa (a configuração por API serve)', () => {
    expect(ids(sondagem({ privado: false }))).not.toContain('alternativa-de-varredura-de-senhas')
  })

  it('privado onde o recurso EXISTE vai pela configuração, não pelo PR', () => {
    const s = sondagem({ privado: true, segredos: 'desligado' })
    expect(ids(s)).toContain('varredura-de-senhas')
    expect(ids(s)).not.toContain('alternativa-de-varredura-de-senhas')
  })
})

describe('planejarMelhorias: permissões mínimas dos workflows', () => {
  const comWorkflows = (itens: WorkflowSondado[], extra: Partial<SondagemDoRepositorio> = {}) =>
    sondagem({ workflows: { estado: 'lidos', truncado: false, itens }, ...extra })

  it('um candidato por workflow sem permissions, em ordem de caminho', () => {
    const s = comWorkflows([
      workflow('.github/workflows/b.yml'),
      workflow('.github/workflows/a.yml'),
    ])
    const lista = ids(s).filter((i) => i.startsWith('permissoes-minimas-dos-workflows:'))
    expect(lista).toEqual([
      'permissoes-minimas-dos-workflows:.github/workflows/a.yml',
      'permissoes-minimas-dos-workflows:.github/workflows/b.yml',
    ])
  })

  it('workflow que já declara não é candidato', () => {
    const s = comWorkflows([workflow('.github/workflows/a.yml', { declaraPermissoes: true })])
    expect(ids(s).some((i) => i.startsWith('permissoes-minimas'))).toBe(false)
  })

  it('workflow de deploy/CD NUNCA é candidato; vira pergunta ao dono', () => {
    const s = comWorkflows([workflow('.github/workflows/deploy.yml', { ehDeploy: true })])
    const plano = planejarMelhorias({
      sondagem: s,
      registros: {},
      liberadosPeloDono: new Set(),
      agora: AGORA,
    })
    expect(plano.candidatas.some((c) => c.id.startsWith('permissoes-minimas'))).toBe(false)
    expect(plano.perguntas.map((w) => w.caminho)).toEqual(['.github/workflows/deploy.yml'])
  })

  it('a pergunta já feita não se repete', () => {
    const s = comWorkflows([workflow('.github/workflows/deploy.yml', { ehDeploy: true })])
    const plano = planejarMelhorias({
      sondagem: s,
      registros: {
        'permissoes-minimas-dos-workflows:.github/workflows/deploy.yml':
          registro('aguardando-dono'),
      },
      liberadosPeloDono: new Set(),
      agora: AGORA,
    })
    expect(plano.perguntas).toEqual([])
  })

  it('o dono liberou o deploy: vira candidato como qualquer outro', () => {
    const s = comWorkflows([workflow('.github/workflows/deploy.yml', { ehDeploy: true })])
    const lista = ids(
      s,
      {
        'permissoes-minimas-dos-workflows:.github/workflows/deploy.yml':
          registro('aguardando-dono'),
      },
      ['.github/workflows/deploy.yml']
    )
    expect(lista).toContain('permissoes-minimas-dos-workflows:.github/workflows/deploy.yml')
  })

  it('workflow que não é seguro mexer (precisa de escrita) não é candidato e vai para "não mexidos" com o motivo', () => {
    const s = comWorkflows([
      workflow('.github/workflows/a.yml', {
        seguroParaPermissaoMinima: false,
        motivoDeNaoSeguro: 'usa o token do GitHub',
      }),
    ])
    const plano = planejarMelhorias({
      sondagem: s,
      registros: {},
      liberadosPeloDono: new Set(),
      agora: AGORA,
    })
    expect(plano.candidatas.some((c) => c.id.startsWith('permissoes-minimas'))).toBe(false)
    expect(plano.naoMexidos).toEqual([
      {
        id: 'permissoes-minimas-dos-workflows:.github/workflows/a.yml',
        motivo: 'usa o token do GitHub',
      },
    ])
  })

  it('workflow não analisado (declaraPermissoes null) nem é candidato nem é pergunta', () => {
    const s = comWorkflows([workflow('.github/workflows/a.yml', { declaraPermissoes: null })])
    const plano = planejarMelhorias({
      sondagem: s,
      registros: {},
      liberadosPeloDono: new Set(),
      agora: AGORA,
    })
    expect(plano.candidatas.some((c) => c.id.startsWith('permissoes-minimas'))).toBe(false)
    expect(plano.perguntas).toEqual([])
  })

  it('um caminho fora do padrão de workflow é ignorado', () => {
    const s = comWorkflows([workflow('.github/workflows/../../x.yml')])
    expect(ids(s).some((i) => i.startsWith('permissoes-minimas'))).toBe(false)
  })
})

describe('planejarMelhorias: a permissão padrão do token só DEPOIS de todos os workflows declararem', () => {
  const comWorkflows = (itens: WorkflowSondado[], extra: Partial<SondagemDoRepositorio> = {}) =>
    sondagem({ workflows: { estado: 'lidos', truncado: false, itens }, ...extra })

  it('todos declaram: entra', () => {
    expect(
      ids(comWorkflows([workflow('.github/workflows/a.yml', { declaraPermissoes: true })]))
    ).toContain('permissao-padrao-do-workflow')
  })

  it.each([
    ['um ainda não declara', [workflow('.github/workflows/a.yml')]],
    ['um é de deploy sem permissions', [workflow('.github/workflows/cd.yml', { ehDeploy: true })]],
    ['um não foi analisado', [workflow('.github/workflows/a.yml', { declaraPermissoes: null })]],
    [
      'um não é seguro mexer',
      [
        workflow('.github/workflows/a.yml', {
          seguroParaPermissaoMinima: false,
          motivoDeNaoSeguro: 'x',
        }),
      ],
    ],
  ])('%s: NÃO entra', (_nome, itens) => {
    expect(ids(comWorkflows(itens))).not.toContain('permissao-padrao-do-workflow')
  })

  it('pasta de workflows truncada ou com erro de leitura: NÃO entra', () => {
    expect(
      ids(sondagem({ workflows: { estado: 'lidos', truncado: true, itens: [] } }))
    ).not.toContain('permissao-padrao-do-workflow')
    expect(
      ids(sondagem({ workflows: { estado: 'erro', truncado: false, itens: [] } }))
    ).not.toContain('permissao-padrao-do-workflow')
  })

  it('sem workflows nenhum (pasta ausente): entra (nada pode quebrar)', () => {
    expect(
      ids(sondagem({ workflows: { estado: 'ausente', truncado: false, itens: [] } }))
    ).toContain('permissao-padrao-do-workflow')
  })

  it('já está em leitura (ou não se sabe): não entra', () => {
    expect(ids(sondagem({ permissaoDoWorkflow: 'read' }))).not.toContain(
      'permissao-padrao-do-workflow'
    )
    expect(ids(sondagem({ permissaoDoWorkflow: null }))).not.toContain(
      'permissao-padrao-do-workflow'
    )
  })
})

describe('planejarMelhorias: reentrância e tentativas', () => {
  it.each([
    'aplicado',
    'desfeito',
    'dispensado',
    'aguardando-revisao',
    'aguardando-dono',
    'incerto',
  ] as const)('registro "%s": a melhoria não volta como candidata', (estado) => {
    expect(ids(sondagem(), { 'alertas-de-dependencias': registro(estado) })).not.toContain(
      'alertas-de-dependencias'
    )
  })

  it.each(['recusado', 'indisponivel', 'falhou'] as const)(
    'registro "%s": só volta depois de proximaTentativaEm',
    (estado) => {
      const futuro = new Date(AGORA.getTime() + 60_000).toISOString()
      const passado = new Date(AGORA.getTime() - 60_000).toISOString()
      expect(
        ids(sondagem(), {
          'alertas-de-dependencias': registro(estado, { proximaTentativaEm: futuro }),
        })
      ).not.toContain('alertas-de-dependencias')
      expect(
        ids(sondagem(), {
          'alertas-de-dependencias': registro(estado, { proximaTentativaEm: passado }),
        })
      ).toContain('alertas-de-dependencias')
      expect(
        ids(sondagem(), {
          'alertas-de-dependencias': registro(estado, { proximaTentativaEm: null }),
        })
      ).toContain('alertas-de-dependencias')
    }
  )

  it('PR em andamento vai para "acompanhar" e "incerto" de configuração para "conferir"', () => {
    const plano = planejarMelhorias({
      sondagem: sondagem(),
      registros: {
        'alternativa-de-varredura-de-senhas': registro('aguardando-revisao', {
          pr: {
            numero: 3,
            ramo: 'gitorch/seguranca/x',
            caminho: '.github/workflows/x.yml',
            acao: 'criar',
            url: null,
          },
        }),
        'alertas-de-dependencias': registro('incerto'),
      },
      liberadosPeloDono: new Set(),
      agora: AGORA,
    })
    expect(plano.acompanhar.map((a) => a.id)).toEqual(['alternativa-de-varredura-de-senhas'])
    expect(plano.conferir.map((a) => a.id)).toEqual(['alertas-de-dependencias'])
  })

  it('o backoff por estado: indisponível/recusado esperam dias; falhou espera horas; cota espera menos', () => {
    const em = (estado: 'recusado' | 'indisponivel' | 'falhou', limitada = false) =>
      new Date(proximaTentativaApos(estado, AGORA, limitada)!).getTime() - AGORA.getTime()
    expect(em('indisponivel')).toBe(7 * 24 * 3_600_000)
    expect(em('recusado')).toBe(7 * 24 * 3_600_000)
    expect(em('falhou')).toBe(3 * 3_600_000)
    expect(em('falhou', true)).toBe(3_600_000)
    expect(proximaTentativaApos('aplicado', AGORA, false)).toBeNull()
  })
})

describe('eventos do painel', () => {
  it('a chave segue o formato combinado', () => {
    expect(chaveDoEventoDaMelhoria('acme/api', 'alertas-de-dependencias', 'aplicado')).toBe(
      'melhoria-de-seguranca:acme/api:alertas-de-dependencias:aplicado'
    )
    expect(chaveDoEventoDaMelhoria('acme/api', 'varredura-de-codigo', 'indisponivel')).toBe(
      'melhoria-de-seguranca:acme/api:varredura-de-codigo:indisponivel'
    )
  })

  it('o texto de "aplicado" carrega o COMO DESFAZER', () => {
    const texto = textoDoEventoDaMelhoria({
      repositorio: 'acme/api',
      id: 'alertas-de-dependencias',
      estado: 'aplicado',
      motivo: 'ligado e confirmado',
      desfazer: 'Como desfazer: desligue.',
    })
    expect(texto).toContain('acme/api')
    expect(texto).toContain('ligado e confirmado')
    expect(texto).toContain('Como desfazer: desligue.')
  })

  it('texto externo é cortado por ponto de código e sem credencial', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const texto = textoDoEventoDaMelhoria({
      repositorio: 'acme/api',
      id: 'alertas-de-dependencias',
      estado: 'recusado',
      motivo: `${token} ${'😀'.repeat(5000)}`,
      desfazer: 'Como desfazer: nada a desfazer.',
    })
    expect(texto).not.toContain(token)
    expect(Array.from(texto).length).toBeLessThan(2000)
    expect(texto).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
