const fs = require('fs');

// 1. dev-session-store.ts
let devSessionStore = fs.readFileSync('apps/control-plane/src/services/dev-session-store.ts', 'utf8');
devSessionStore = devSessionStore.replace(
  '    answeredHash: string | null\n  }>\n> {\n  return (await deps.prisma.devSession.findMany({\n    where: { closedAt: null },\n    select: {\n      sessionName: true,\n      issueNumber: true,\n      state: true,\n      lastProgressAt: true,\n      createdAt: true,\n      closedAt: true,\n      answeredHash: true,\n    },\n  })) as unknown as Array<{\n    sessionName: string\n    issueNumber: number\n    state: string\n    lastProgressAt: Date | null\n    createdAt: Date | null\n    closedAt: Date | null\n    answeredHash: string | null\n  }>',
  '    answeredHash: string | null\n    requeueCount: number\n    projectId: string\n  }>\n> {\n  return (await deps.prisma.devSession.findMany({\n    where: { closedAt: null },\n    select: {\n      sessionName: true,\n      issueNumber: true,\n      state: true,\n      lastProgressAt: true,\n      createdAt: true,\n      closedAt: true,\n      answeredHash: true,\n      requeueCount: true,\n      projectId: true,\n    },\n  })) as unknown as Array<{\n    sessionName: string\n    issueNumber: number\n    state: string\n    lastProgressAt: Date | null\n    createdAt: Date | null\n    closedAt: Date | null\n    answeredHash: string | null\n    requeueCount: number\n    projectId: string\n  }>'
);
fs.writeFileSync('apps/control-plane/src/services/dev-session-store.ts', devSessionStore);

// 2. reconciliar-duvidas-escaladas.ts
let reconciliar = fs.readFileSync('apps/control-plane/src/services/reconciliar-duvidas-escaladas.ts', 'utf8');
reconciliar = reconciliar.replace(
  '        answeredHash: string | null\n        updatedAt: Date\n      }>\n    >\n  }\n}',
  '        answeredHash: string | null\n        updatedAt: Date\n        requeueCount: number\n        projectId: string\n      }>\n    >\n  }\n}'
);
reconciliar = reconciliar.replace(
  'select: { sessionName: true, issueNumber: true, answeredHash: true, updatedAt: true },',
  'select: { sessionName: true, issueNumber: true, answeredHash: true, updatedAt: true, requeueCount: true, projectId: true },'
);
reconciliar = reconciliar.replace(
  'fecharSessao: (args: { sessionName: string; agora: Date }) => Promise<void>',
  'fecharSessao: (args: { sessionName: string; issueNumber: number; requeueCount: number; projectId: string; agora: Date }) => Promise<void>'
);
reconciliar = reconciliar.replace(
  'await deps.fecharSessao({ sessionName: sessao.sessionName, agora })',
  'await deps.fecharSessao({ sessionName: sessao.sessionName, issueNumber: sessao.issueNumber, requeueCount: sessao.requeueCount, projectId: sessao.projectId, agora })'
);
fs.writeFileSync('apps/control-plane/src/services/reconciliar-duvidas-escaladas.ts', reconciliar);

// 3. scheduler.ts
let scheduler = fs.readFileSync('apps/control-plane/src/plugins/scheduler.ts', 'utf8');
scheduler = "import { MAX_REQUEUE } from '../services/sessao-terminal.js'\n" + scheduler;

const replacement1 = `        if (linha.requeueCount >= MAX_REQUEUE) {
          await registrarStatusNoPainel(
            linha.projectId,
            \`desistencia:\${linha.projectId}:\${linha.issueNumber}\`,
            \`GitOrch: a entrega da issue #\${linha.issueNumber} falhou \${linha.requeueCount} vezes e bateu o teto de retentativas. A esteira não vai mais tentar sozinha.\`
          )
          app.log.info(
            \`[Scheduler] sessão abandonada devolvida: \${linha.sessionName} (issue #\${linha.issueNumber}) \` +
              'bateu o teto de retentativas — desistiu'
          )
        } else {
          app.log.info(
            \`[Scheduler] sessão abandonada devolvida: \${linha.sessionName} (issue #\${linha.issueNumber}) \` +
              'sem progresso além do teto — a vaga voltou para a fila'
          )
        }`;

scheduler = scheduler.replace(
  "        app.log.info(\n          `[Scheduler] sessão abandonada devolvida: ${linha.sessionName} (issue #${linha.issueNumber}) ` +\n            'sem progresso além do teto — a vaga voltou para a fila'\n        )",
  replacement1
);

const replacement2 = `            fecharSessao: async ({ sessionName, issueNumber, requeueCount, projectId, agora }) => {
              // A chave é da conta em que a sessão NASCEU (BYOK, D34), lida
              // linha a linha — MESMO padrão de \`devolverVagasDeSessaoAbandonada\`.
              const apiKey = await chaveDaSessao(sessionName)
              await fecharSessao({
                prisma: app.prisma as unknown as PrismaDevSession,
                sessionName,
                motivo: 'pergunta-sem-resposta',
                agora,
                ...(apiKey
                  ? {
                      arquivarNoFornecedor: (nome: string) =>
                        arquivarSessaoJules({
                          apiKey,
                          sessionName: nome,
                          onWarn: (m) => app.log.warn(m),
                        }),
                    }
                  : {}),
                onWarn: (m) => app.log.warn(m),
              })

              if (requeueCount >= MAX_REQUEUE) {
                await registrarStatusNoPainel(
                  projectId,
                  \`desistencia:\${projectId}:\${issueNumber}\`,
                  \`GitOrch: a entrega da issue #\${issueNumber} falhou \${requeueCount} vezes e bateu o teto de retentativas. A esteira não vai mais tentar sozinha.\`
                )
              }
            },`;

scheduler = scheduler.replace(
  /fecharSessao: async \(\{ sessionName, agora \}\) => \{[\s\S]*?onWarn: \(m\) => app\.log\.warn\(m\),\n *\}\)\n *\},/m,
  replacement2
);
fs.writeFileSync('apps/control-plane/src/plugins/scheduler.ts', scheduler);

// 4. sessao-abandonada.ts
let sessaoAbandonada = fs.readFileSync('apps/control-plane/src/services/sessao-abandonada.ts', 'utf8');
sessaoAbandonada = sessaoAbandonada.replace(
  '  answeredHash?: string | null\n}',
  '  answeredHash?: string | null\n  requeueCount: number\n  projectId: string\n}'
);
fs.writeFileSync('apps/control-plane/src/services/sessao-abandonada.ts', sessaoAbandonada);

// 5. sessao-abandonada.test.ts
let sessaoAbandonadaTest = fs.readFileSync('apps/control-plane/src/services/sessao-abandonada.test.ts', 'utf8');
sessaoAbandonadaTest = sessaoAbandonadaTest.replace(
  '    closedAt: null,\n    ...over,\n  }',
  '    closedAt: null,\n    requeueCount: 0,\n    projectId: \'p1\',\n    ...over,\n  }'
);
fs.writeFileSync('apps/control-plane/src/services/sessao-abandonada.test.ts', sessaoAbandonadaTest);

// 6. reconciliar-duvidas-escaladas.test.ts
let reconciliarTest = fs.readFileSync('apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts', 'utf8');
reconciliarTest = reconciliarTest.replace(
  /updatedAt: new Date\(Date\.now\(\) - 25 \* 60 \* 60 \* 1000\), \/\/ older than HORAS_ATE_TIMEOUT_PERGUNTA_MS \(24h\)/,
  "updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),\n  requeueCount: 0,\n  projectId: 'proj1',"
);
reconciliarTest = reconciliarTest.replace(
  /expect\(deps\.fecharSessao\)\.toHaveBeenCalledWith\(\n *expect\.objectContaining\(\{ sessionName: 'sessions\/legada' \}\)\n *\)/,
  `expect(deps.fecharSessao).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'sessions/legada', issueNumber: 46, requeueCount: 0, projectId: 'proj1' })
    )`
);
fs.writeFileSync('apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts', reconciliarTest);

// 7. scheduler-duvidas-escaladas-antes-do-fechamento-real-seam.test.ts
let seamTest = fs.readFileSync('apps/control-plane/src/plugins/scheduler-duvidas-escaladas-antes-do-fechamento-real-seam.test.ts', 'utf8');
seamTest = seamTest.replace(
  /test\('sessão AWAITING com respondida:0:<hash> parada há 25h: no fim do tique está FECHADA com pergunta-sem-resposta \(nunca abandoned\), e nenhuma agent_question foi criada', async \(\) => \{/,
  `test('sessão AWAITING com respondida:0:<hash> parada há 25h: no fim do tique está FECHADA com pergunta-sem-resposta (nunca abandoned), e nenhuma agent_question foi criada', async () => {`
);

if (!seamTest.includes("test('sessão AWAITING bate o limite MAX_REQUEUE de 3 e registra desistencia no painel', async () => {")) {
  seamTest += `
  test('sessão AWAITING bate o limite MAX_REQUEUE de 3 e registra desistencia no painel', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async () => ({ deduped: false, question: { id: 'q1', answer: null } }))

    // Override prisma to return requeueCount: 3
    prisma['devSession'] = autoModel({
        findMany: vi.fn(async (args: any) => {
            if (args?.where?.answeredHash?.not === null) {
              return prisma['_fechada']() ? [] : [{ ...SESSAO_PRESA, requeueCount: 3 }]
            }
            if (args?.where?.projectId || args?.distinct) {
              return prisma['_fechada']() ? [] : [{ ...SESSAO_PRESA, requeueCount: 3, closedAt: null }]
            }
            return prisma['_fechada']() ? [] : [{ ...SESSAO_PRESA, requeueCount: 3, closedAt: null }]
        }),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async (args: any) => {
          prisma['_updateCalls'].push(args)
          if (args.data['closedAt'] !== undefined) {
             Object.defineProperty(prisma, '_fechada', { value: () => true })
             Object.defineProperty(prisma, '_motivoFechamento', { value: () => args.data['closedReason'] })
          }
          return undefined
        }),
    })

    const appLocal = Fastify({ logger: false })
    appLocal.decorate('prisma', prisma as never)
    appLocal.decorate('agentQuestionService', { ask, marcarAssumida: vi.fn() } as never)

    prisma['_eventCreated'] = false;
    prisma['event'] = autoModel({ create: vi.fn(async () => { prisma['_eventCreated'] = true }) })

    await appLocal.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(prisma['_fechada']()).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    await new Promise((r) => setTimeout(r, 200))

    expect(prisma['_motivoFechamento']()).toBe('pergunta-sem-resposta')
    expect(prisma['_eventCreated']).toBe(true)
  })

  test('sessão abandonada bate o limite MAX_REQUEUE de 3 e registra desistencia no painel', async () => {
    const prisma = buildFakePrisma()
    const ask = vi.fn(async () => ({ deduped: false, question: { id: 'q1', answer: null } }))

    // Override prisma to return requeueCount: 3 and no answeredHash to trigger abandoned
    prisma['devSession'] = autoModel({
        findMany: vi.fn(async (args: any) => {
            if (args?.where?.answeredHash?.not === null) {
              return []
            }
            if (args?.where?.projectId || args?.distinct) {
              return prisma['_fechada']() ? [] : [{ ...SESSAO_PRESA, answeredHash: null, requeueCount: 3, closedAt: null }]
            }
            return prisma['_fechada']() ? [] : [{ ...SESSAO_PRESA, answeredHash: null, requeueCount: 3, closedAt: null }]
        }),
        findUnique: vi.fn(async () => ({ devAccountId: null })),
        update: vi.fn(async (args: any) => {
          prisma['_updateCalls'].push(args)
          if (args.data['closedAt'] !== undefined) {
             Object.defineProperty(prisma, '_fechada', { value: () => true })
             Object.defineProperty(prisma, '_motivoFechamento', { value: () => args.data['closedReason'] })
          }
          return undefined
        }),
    })

    const appLocal = Fastify({ logger: false })
    appLocal.decorate('prisma', prisma as never)
    appLocal.decorate('agentQuestionService', { ask, marcarAssumida: vi.fn() } as never)

    prisma['_eventCreated'] = false;
    prisma['event'] = autoModel({ create: vi.fn(async () => { prisma['_eventCreated'] = true }) })

    await appLocal.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        expect(prisma['_fechada']()).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )

    await new Promise((r) => setTimeout(r, 200))

    expect(prisma['_motivoFechamento']()).toBe('abandoned')
    expect(prisma['_eventCreated']).toBe(true)
  })
`;
}

fs.writeFileSync('apps/control-plane/src/plugins/scheduler-duvidas-escaladas-antes-do-fechamento-real-seam.test.ts', seamTest);

console.log("Applied all patches.");
