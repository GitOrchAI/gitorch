# Task 9 — Relatório de implementação

Projeto novo ganha o próprio board Projects v2 no setup, com precedência sobre o env global.

## Step 1 — Graphify

```
$ cd /home/ubuntu/projects/gitorch
$ graphify affected "ProjectV2Client"
Affected nodes for ProjectV2Client
Relations: calls, indirect_call, references, imports, imports_from, re_exports, inherits, extends, implements, uses, mixes_in, embeds
Depth: 2
- index.ts [re_exports] packages/github-sync/src/index.ts:L1
- project-v2-client.test.ts [imports] packages/github-sync/src/project-v2-client.test.ts:L1
- createCardMover() [calls] apps/control-plane/src/services/board-status.ts:L151
- createGithubBacklog() [calls] apps/control-plane/src/services/github-backlog.ts:L29
- runPoMissionViaRails() [calls] apps/control-plane/src/services/po-rails-mission.ts:L136
- scheduler.ts [imports] apps/control-plane/src/plugins/scheduler.ts:L1
- board-status.test.ts [imports] apps/control-plane/src/services/board-status.test.ts:L1
- po-rails-mission.ts [imports] apps/control-plane/src/services/po-rails-mission.ts:L1
- po-rails-mission.test.ts [imports] apps/control-plane/src/services/po-rails-mission.test.ts:L1

$ graphify explain "createGithubBacklog"
Node: createGithubBacklog()
  ID:        apps_control_plane_src_services_github_backlog_creategithubbacklog
  Source:    apps/control-plane/src/services/github-backlog.ts L29
  Type:      code
  Community: 11
  Degree:    5

Connections (5):
  <-- po-rails-mission.ts [imports] [EXTRACTED]
  <-- github-backlog.ts [contains] [EXTRACTED]
  <-- runPoMissionViaRails() [calls] [EXTRACTED]
  --> createBoardStatus() [calls] [EXTRACTED]
  --> .getIterationField() [calls] [EXTRACTED]
```

Confirmou que `ProjectV2Client` é consumido por `scheduler.ts`, `board-status.ts`, `github-backlog.ts` e `po-rails-mission.ts` — nenhum deles precisou mudar de contrato para esta task.

## Desvio do contrato literal do brief (achado ao ler o código real)

O brief pedia `resolveOwnerId: (owner) => Promise<string>` e `findProjectId({ owner, number })`.
Lendo `packages/github-sync/src/project-v2-client.ts:220`, a assinatura real é:

```ts
async findProjectId(input: GetProjectIdInput): Promise<string | null>
// GetProjectIdInput = { login: string; number: number; ownerType: 'user' | 'organization' }
```

`findProjectId` **exige** `ownerType` — que o brief não carregava em `resolveOwnerId`. Ajustei o
contrato de `ensureProjectBoard`: o parâmetro passou a se chamar `resolveOwner` e devolve
`{ id: string; type: 'user' | 'organization' }` em vez de uma string solta. Isso também deu origem
a `resolveGithubOwnerId` (contexto item 5) devolver a mesma forma — assim os dois caminhos (GET
/users, fallback GET /orgs) já entregam o `ownerType` que `findProjectId` cobra.

## Step 2/3 — Teste que falha

Criado `apps/control-plane/src/services/onboarding-board.test.ts` (7 testes: 4 para
`ensureProjectBoard`, 3 para `resolveGithubOwnerId`, este último exigido pelo contexto item 5 —
"com teste para cada caminho").

```
$ pnpm --filter @gitorch/control-plane test -- onboarding-board
 FAIL  src/services/onboarding-board.test.ts [ src/services/onboarding-board.test.ts ]
Error: Cannot find module './onboarding-board.js' imported from .../onboarding-board.test.ts
 Test Files  1 failed | 102 passed (103)
      Tests  893 passed (893)
```

## Step 4 — Implementação

Criado `apps/control-plane/src/services/onboarding-board.ts` com `ensureProjectBoard` (nunca
lança — degrada com `onWarn` e devolve `null`, cobrindo o risco conhecido do App instalado na
conta pessoal `loureng` em vez da organização `GitOrchAI`) e `resolveGithubOwnerId` (GET
/users/{owner} → fallback GET /orgs/{owner}).

## Step 5 — Teste passa

```
$ pnpm --filter @gitorch/control-plane test -- onboarding-board
 Test Files  103 passed (103)
      Tests  900 passed (900)
(suíte filtrada: 7 passed | 6 skipped)
```

## Step 6 — Ligação no provisionamento e nos trilhos

- `SetupMissionRecord.project` ganhou `runtimeConfig?: unknown`.
- `provisionSetupMission` ganhou um 4º parâmetro `deps: ProvisionSetupMissionDeps = {}` com
  `prisma`, `createProjectV2Client` e `resolveOwner` opcionais — **a presença de `deps.prisma` é
  o interruptor**: sem ele (chamadas antigas/testes de clone) o passo do board é pulado por
  completo, sem tocar rede. O call-site real em `processSetupMissions` passa `{ prisma: app.prisma }`.
- Falha ao criar o board (ex.: "Resource not accessible by integration") nunca derruba o
  `outcome.status: 'completed'` — só `board === null` pula a gravação no Prisma.
- Na resolução dos trilhos (`executeMissionWithFailover`), `railsBoard` passou a preferir
  `project.runtimeConfig.envConfig.GITORCH_PROJECT_BOARD` e só cai para
  `process.env['GITORCH_PROJECT_BOARD']` (o `loureng/9` global) quando o projeto não tem o
  próprio.

Adicionei também 4 testes de integração em `scheduler-setup-mission.test.ts` (não pedidos
literalmente pelo brief, mas cobrindo exatamente o ponto de risco do contexto item 3: criação,
degradação sem derrubar o provisionamento, skip sem prisma, e merge preservando
`runtimeConfig`/`envConfig` pré-existentes).

## Diff (arquivos tocados em scheduler.ts / scheduler-setup-mission.test.ts)

Ver `git diff` no commit abaixo — resumo:
- `apps/control-plane/src/plugins/scheduler.ts`: +80/-3
- `apps/control-plane/src/plugins/scheduler-setup-mission.test.ts`: +125
- `apps/control-plane/src/services/onboarding-board.ts`: novo, 121 linhas
- `apps/control-plane/src/services/onboarding-board.test.ts`: novo, 126 linhas

## Step 7 — Verificação final

```
$ pnpm --filter @gitorch/control-plane test
 Test Files  103 passed (103)
      Tests  904 passed (904)
 (integration suite) Test Files 1 skipped | Tests 6 skipped

$ pnpm --filter @gitorch/control-plane typecheck
> tsc --noEmit -p tsconfig.typecheck.json
(sem saída — limpo)

$ pnpm lint:ci
> eslint . --max-warnings 0
(sem saída — limpo)
```

## Step 8 — Grafo e commit

```
$ cd /home/ubuntu/projects/gitorch && graphify update .
[graphify watch] Rebuilt: 3257 nodes, 5809 edges, 242 communities
```

Nota: `/home/ubuntu/projects/gitorch` é o worktree principal (branch `main`) e não tem os
arquivos novos desta branch (`feat/onboarding-projeto-novo-100`) — o grafo compartilhado só verá
`onboarding-board.ts` depois do merge. Executado exatamente como o brief pedia (Step 1 e Step 8),
mesmo assim.

Commit apenas dos arquivos desta task (sem `git add -A` — a árvore tem outras tasks em
andamento: `progress.md` e outros `onboarding-task-*-brief.md` não tocados):

```
git add apps/control-plane/src/services/onboarding-board.ts \
        apps/control-plane/src/services/onboarding-board.test.ts \
        apps/control-plane/src/plugins/scheduler.ts \
        apps/control-plane/src/plugins/scheduler-setup-mission.test.ts
git commit -m "feat(control-plane): projeto novo ganha o proprio board Projects v2 no setup"
```

Hash do commit: ver saída de `git log -1 --format=%H` após o commit (relatado na resposta final).
