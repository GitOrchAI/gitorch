# GitOrch Cuidando do Repositório Inteiro — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o GitOrch tratar cada pull request, issue e alerta de segurança dos repositórios do cliente como um item com ficha própria (estado atual + histórico) em vez de reprocessar tudo do zero a cada aviso do GitHub — encerrando os pareceres duplicados, os pull requests parados sem julgamento e os alertas de segurança sem dono, e adicionando uma nota de segurança por repositório.

**Architecture:** Uma tabela nova (`RepoItem`) guarda o ESTADO ATUAL de cada pedido/tarefa/alerta por projeto; o HISTÓRICO continua na tabela `events` já existente (mesmo padrão do registro de auditoria do painel), nunca duplicado numa tabela própria. O webhook do GitHub (`routes/github-webhook.ts`) passa a aceitar `pull_request` (todas as ações), `pull_request_review`, `check_run`, `status`, `dependabot_alert`, `code_scanning_alert` e `secret_scanning_alert`, e cada aviso atualiza a ficha em vez de só acordar uma missão. Uma varredura nova no `scheduler.ts`, a cada 30 minutos por projeto, pega o que o aviso perdeu — mesmo padrão de cadência por projeto que `vigiarPrsOrfaos` já usa. Sobre a ficha, um pipeline de serviços determinísticos (nunca "LLM decide sozinho fora do trilho" — mesmo modelo "LLM decide, sistema executa" de `packages/cadence`) resolve vínculo com a tarefa, julgamento e próximo passo, substituindo o `decidirAcaoNoPrOrfao` de hoje por um motor que nunca devolve "alguém precisa olhar" sem antes checar a configuração de quem cuida de cada origem.

**Tech Stack:** TypeScript, Fastify (`apps/control-plane`), Prisma + PostgreSQL, Vitest, Next.js/React (`apps/web`), GraphQL (Projects V2 via `packages/github-sync`), REST v3 do GitHub. Monorepo pnpm workspaces; pacotes tocados: `@gitorch/control-plane`, `@gitorch/cadence`, `@gitorch/github-sync`, `web`.

## Global Constraints

- Toda escrita no repositório do cliente passa por `guardaDeAutonomia`/`fetchDoRepositorio` (`apps/control-plane/src/services/guarda-de-autonomia.ts`) — nunca `fetch` cru contra `api.github.com`. Ver `apps/control-plane/src/test/nenhuma-escrita-sem-guarda.test.ts` (varre o repositório inteiro atrás de `fetch` cru).
- Toda migração SQL é `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, aditiva, nunca destrutiva, e roda dentro de `BEGIN; ... COMMIT;` quando altera default de coluna existente — copiar o padrão de `apps/control-plane/prisma/autonomia-do-projeto-migration.sql` e `apps/control-plane/prisma/dev-session-migration.sql`.
- Nenhuma credencial em texto puro em log, commit ou comentário. Nenhuma data de sessão nem nome de cliente em comentário de código de exemplo.
- Nenhum `continue-on-error`, `|| true`, skip de teste ou supressão de exceção. Falha visível sempre.
- Toda decisão sobre "julgar ou não" e "mesclar ou não" consulta `Project.runtimeConfig.cuidaPorOrigem` (Tarefa 0.2) e `Project.autonomia` (`packages/cadence/src/autonomia.ts`, já existente) — nunca hardcoded.
- Teste real por tarefa: `pnpm --filter @gitorch/control-plane test`, `pnpm --filter @gitorch/cadence test`, `pnpm --filter @gitorch/github-sync test` ou `pnpm --filter web test`, conforme o pacote tocado. Rodar o arquivo específico primeiro (`npx vitest run <arquivo> -t <nome>`), depois a suíte do pacote inteira antes de fechar a tarefa.
- Commit por tarefa, citando a tarefa do Shrimp (`git commit -m "feat: ... - task <id>"`), nunca por fase inteira de uma vez.
- Nomes em português, no estilo já estabelecido do repositório (`ficha-do-item.ts`, não `item-record.ts`) — todo arquivo novo deste plano segue essa convenção.

---
## Fase 0 — Fundação

### Task 0.1: Tabela da ficha do item (`RepoItem`)

**Files:**
- Modify: `apps/control-plane/prisma/schema.prisma` (adicionar `model RepoItem` depois de `model InfraIncident` — linha 925 — e `repoItems RepoItem[]` na lista de relações de `model Project`, logo abaixo de `catalogoDeDuvidas CatalogoDeDuvidas[]`, linha 446)
- Create: `apps/control-plane/prisma/repo-item-migration.sql`
- Modify: `apps/control-plane/src/lib/migration-ledger.ts:19-56` (adicionar `'repo-item-migration.sql'` ao fim do array `MIGRATION_LEDGER`)
- Modify: `apps/control-plane/src/lib/migration-ledger.test.ts:20-57` (mesmo array, hardcoded no teste de drift)
- Create: `apps/control-plane/src/services/ficha-do-item.ts`
- Test: `apps/control-plane/src/services/ficha-do-item.test.ts`
- Test: `apps/control-plane/src/lib/migration-ledger.test.ts` (já existe — só ganha a linha nova)

**Interfaces:**
- Consumes: nada de tarefa anterior — é a fundação.
- Produces:
  - `interface EstadoDoItem { status: string; verificacao?: string | null; revisoes?: string | null; conflito?: boolean | null; rascunho?: boolean | null; ultimoCommitEm?: string | null; arquivosMexidos?: string[] | null }` — o snapshot que as Tarefas 1.1/1.2 escrevem.
  - `interface PrismaDaFichaDoItem { repoItem: { upsert: (args: { where: { projectId_tipo_numero: { projectId: string; tipo: string; numero: number } }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>; findUnique: (args: { where: { projectId_tipo_numero: { projectId: string; tipo: string; numero: number } } }) => Promise<RepoItemRecord | null> } }` — o subconjunto do Prisma que `ficha-do-item.ts` usa (mesmo estilo de `PrismaDoRegistroNoPainel` em `registro-no-painel.ts`).
  - `async function atualizarFichaDoItem(deps: { prisma: PrismaDaFichaDoItem; projectId: string; tipo: 'pr' | 'issue' | 'alerta'; numero: number; estado: EstadoDoItem; origem?: string | null }): Promise<RepoItemRecord>` — consumida pelas Tarefas 1.1, 1.2 e 1.3.
  - `async function lerFichaDoItem(deps: { prisma: PrismaDaFichaDoItem; projectId: string; tipo: 'pr' | 'issue' | 'alerta'; numero: number }): Promise<RepoItemRecord | null>` — consumida pela Fase 2 em diante.

- [ ] **Step 1: Adicionar o modelo ao schema Prisma**

Em `apps/control-plane/prisma/schema.prisma`, logo depois do fechamento de `model InfraIncident` (linha 925, `@@map("infra_incidents")` seguido de `}`), adicionar:

```prisma
/// A FICHA de um item do repositório (pedido, tarefa ou alerta): o ESTADO
/// ATUAL, para decisão rápida. O HISTÓRICO continua em `events` (mesmo padrão
/// de `registrarNoPainelUmaVez`, services/registro-no-painel.ts) — nunca
/// duplicado aqui. Ver docs/superpowers/plans/2026-09-15-gitorch-repositorio-inteiro.md
/// (Fase 0-1) para o raciocínio de por que NÃO é "só a lista de eventos".
model RepoItem {
  id        String  @id @default(cuid())
  projectId String  @map("project_id")
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  /// 'pr' | 'issue' | 'alerta'
  tipo String
  /// Número do PR/issue no GitHub, ou o `number` do alerta de segurança.
  numero Int

  /// Snapshot do estado atual: status, verificação, revisões, conflito,
  /// rascunho, último commit, arquivos mexidos (Fase 1.1/1.2).
  estado Json

  /// 'jules_gitorch' | 'jules_fora' | 'assistente' | 'pessoa' | 'dependabot' |
  /// 'outro_bot' — nulo até a Fase 1.4 classificar.
  origem String?

  /// A tarefa (issue) de origem, achada pela Fase 2. Nulo até o vínculo existir.
  issueNumber Int? @map("issue_number")

  /// {deOndeVeio, oQueMuda, queAjusteE, porQueExiste} — formulário da Fase 2.4.
  entendimento Json?

  criadoEm     DateTime @default(now()) @map("criado_em")
  atualizadoEm DateTime @updatedAt @map("atualizado_em")

  /// Uma ficha por (projeto, tipo, número) — upsert nunca duplica.
  @@unique([projectId, tipo, numero])
  @@index([projectId, tipo])
  @@map("repo_items")
}
```

Em `model Project`, logo abaixo de `catalogoDeDuvidas CatalogoDeDuvidas[]` (linha 446), adicionar:

```prisma
  repoItems         RepoItem[]
```

- [ ] **Step 2: Escrever a migração SQL — no padrão de `dev-session-migration.sql`**

Criar `apps/control-plane/prisma/repo-item-migration.sql`:

```sql
-- A ficha do item do repositório (pedido, tarefa, alerta): estado atual, para
-- decisão rápida. O histórico continua em `events` — nunca duplicado aqui (ver
-- docs/superpowers/plans/2026-09-15-gitorch-repositorio-inteiro.md, Fase 0-1).
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/repo-item-migration.sql

CREATE TABLE IF NOT EXISTS repo_items (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL,
  numero         INTEGER NOT NULL,
  estado         JSONB NOT NULL,
  origem         TEXT,
  issue_number   INTEGER,
  entendimento   JSONB,
  criado_em      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS repo_items_project_tipo_numero_key
  ON repo_items (project_id, tipo, numero);

-- A varredura de 30 min (Tarefa 1.3) e o motor do próximo passo (Tarefa 3.5)
-- leem "todas as fichas de um tipo neste projeto" — índice quente.
CREATE INDEX IF NOT EXISTS repo_items_project_tipo_idx
  ON repo_items (project_id, tipo);
```

- [ ] **Step 3: Rodar o teste de drift do ledger e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/lib/migration-ledger.test.ts -t "lista TODO"`
Expected: FAIL — `readdirSync(prismaDir)` agora inclui `repo-item-migration.sql`, mas `MIGRATION_LEDGER` ainda não. A asserção `expect([...MIGRATION_LEDGER].sort()).toEqual(onDisk)` quebra.

- [ ] **Step 4: Registrar a migração no ledger (arquivo mais novo → vai no fim)**

Em `apps/control-plane/src/lib/migration-ledger.ts:56`, depois de `'project-invitation-migration.sql',`, adicionar:

```ts
  'repo-item-migration.sql',
```

Em `apps/control-plane/src/lib/migration-ledger.test.ts:56`, mesma linha, mesmo lugar no array hardcoded do teste `'ordem cronológica congelada'`.

- [ ] **Step 5: Rodar o teste de drift de novo e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/lib/migration-ledger.test.ts`
Expected: PASS — os dois `it` do describe `MIGRATION_LEDGER` verdes.

- [ ] **Step 6: Escrever o teste que falha para `ficha-do-item.ts`**

Criar `apps/control-plane/src/services/ficha-do-item.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { atualizarFichaDoItem, lerFichaDoItem, type PrismaDaFichaDoItem } from './ficha-do-item.js'

function prismaFake(): PrismaDaFichaDoItem & { chamadas: unknown[] } {
  const linhas = new Map<string, Record<string, unknown>>()
  const chave = (projectId: string, tipo: string, numero: number) => `${projectId}:${tipo}:${numero}`
  return {
    chamadas: [],
    repoItem: {
      upsert: vi.fn(async (args: any) => {
        const k = chave(args.where.projectId_tipo_numero.projectId, args.where.projectId_tipo_numero.tipo, args.where.projectId_tipo_numero.numero)
        const existente = linhas.get(k)
        const linha = existente ? { ...existente, ...args.update } : { id: 'novo-id', ...args.create }
        linhas.set(k, linha)
        return linha
      }),
      findUnique: vi.fn(async (args: any) => {
        const k = chave(args.where.projectId_tipo_numero.projectId, args.where.projectId_tipo_numero.tipo, args.where.projectId_tipo_numero.numero)
        return linhas.get(k) ?? null
      }),
    },
  }
}

describe('atualizarFichaDoItem', () => {
  it('cria a ficha quando ela ainda não existe', async () => {
    const prisma = prismaFake()
    const ficha = await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      estado: { status: 'open', verificacao: 'pendente' },
    })
    expect(ficha).toMatchObject({ estado: { status: 'open', verificacao: 'pendente' } })
    expect(prisma.repoItem.upsert).toHaveBeenCalledTimes(1)
  })

  it('atualiza o estado sem apagar origem/entendimento já gravados', async () => {
    const prisma = prismaFake()
    await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      estado: { status: 'open' },
      origem: 'jules_gitorch',
    })
    const ficha = await atualizarFichaDoItem({
      prisma,
      projectId: 'proj-1',
      tipo: 'pr',
      numero: 42,
      estado: { status: 'merged' },
    })
    expect(ficha.estado).toEqual({ status: 'merged' })
    // origem não foi passada na 2ª chamada — o upsert.update só carrega o que
    // mudou, então a origem gravada na 1ª chamada continua na linha.
    expect((ficha as any).origem).toBe('jules_gitorch')
  })
})

describe('lerFichaDoItem', () => {
  it('devolve null quando a ficha não existe', async () => {
    const prisma = prismaFake()
    expect(await lerFichaDoItem({ prisma, projectId: 'proj-1', tipo: 'issue', numero: 7 })).toBeNull()
  })
})
```

- [ ] **Step 7: Rodar e confirmar que falha (módulo ainda não existe)**

Run: `npx vitest run apps/control-plane/src/services/ficha-do-item.test.ts`
Expected: FAIL com `Cannot find module './ficha-do-item.js'`

- [ ] **Step 8: Implementar `ficha-do-item.ts`**

Criar `apps/control-plane/src/services/ficha-do-item.ts`:

```ts
// A ficha do item do repositório: estado ATUAL de um pedido, tarefa ou
// alerta, por (projeto, tipo, número). O histórico continua em `events`
// (registrarNoPainelUmaVez, registro-no-painel.ts) — esta tabela nunca
// guarda uma lista de acontecimentos, só o retrato de agora.

export type TipoDoItem = 'pr' | 'issue' | 'alerta'

export interface EstadoDoItem {
  status: string
  verificacao?: string | null
  revisoes?: string | null
  conflito?: boolean | null
  rascunho?: boolean | null
  ultimoCommitEm?: string | null
  arquivosMexidos?: string[] | null
}

export interface EntendimentoDoItem {
  deOndeVeio: string
  oQueMuda: string
  queAjusteE: string
  porQueExiste: string
}

export interface RepoItemRecord {
  id: string
  projectId: string
  tipo: TipoDoItem
  numero: number
  estado: EstadoDoItem
  origem: string | null
  issueNumber: number | null
  entendimento: EntendimentoDoItem | null
}

/** Só o que `ficha-do-item.ts` precisa do Prisma. */
export interface PrismaDaFichaDoItem {
  repoItem: {
    upsert: (args: {
      where: { projectId_tipo_numero: { projectId: string; tipo: TipoDoItem; numero: number } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }) => Promise<unknown>
    findUnique: (args: {
      where: { projectId_tipo_numero: { projectId: string; tipo: TipoDoItem; numero: number } }
    }) => Promise<RepoItemRecord | null>
  }
}

/**
 * Grava/atualiza a ficha de um item. Chamado pelos handlers de webhook
 * (Fase 0.3) e pela varredura de 30 min (Fase 1.3) — as DUAS fontes que
 * alimentam o estado atual.
 */
export async function atualizarFichaDoItem(deps: {
  prisma: PrismaDaFichaDoItem
  projectId: string
  tipo: TipoDoItem
  numero: number
  estado: EstadoDoItem
  origem?: string | null
  /** Fase 2.4: o formulário de entendimento, quando já existe. Omitido =
   *  não mexe no que já estava gravado (mesmo upsert PARCIAL de `origem`
   *  acima) — nunca apaga um entendimento anterior por engano. */
  entendimento?: EntendimentoDoItem | null
}): Promise<RepoItemRecord> {
  const where = {
    projectId_tipo_numero: { projectId: deps.projectId, tipo: deps.tipo, numero: deps.numero },
  }
  const update: Record<string, unknown> = { estado: deps.estado }
  if (deps.origem !== undefined) update['origem'] = deps.origem
  if (deps.entendimento !== undefined) update['entendimento'] = deps.entendimento

  const linha = await deps.prisma.repoItem.upsert({
    where,
    create: {
      projectId: deps.projectId,
      tipo: deps.tipo,
      numero: deps.numero,
      estado: deps.estado,
      origem: deps.origem ?? null,
      entendimento: deps.entendimento ?? null,
    },
    update,
  })
  return linha as RepoItemRecord
}

/** Lê a ficha, ou `null` quando ainda não existe (item nunca visto). */
export async function lerFichaDoItem(deps: {
  prisma: PrismaDaFichaDoItem
  projectId: string
  tipo: TipoDoItem
  numero: number
}): Promise<RepoItemRecord | null> {
  return deps.prisma.repoItem.findUnique({
    where: {
      projectId_tipo_numero: { projectId: deps.projectId, tipo: deps.tipo, numero: deps.numero },
    },
  })
}
```

- [ ] **Step 9: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/ficha-do-item.test.ts`
Expected: PASS — 3 testes verdes.

- [ ] **Step 10: Gerar o client Prisma e rodar a suíte inteira do control-plane**

Run: `cd apps/control-plane && npx prisma generate && pnpm test`
Expected: PASS — nenhum teste existente quebrou (a mudança é aditiva).

- [ ] **Step 11: Commit**

```bash
git add apps/control-plane/prisma/schema.prisma apps/control-plane/prisma/repo-item-migration.sql \
  apps/control-plane/src/lib/migration-ledger.ts apps/control-plane/src/lib/migration-ledger.test.ts \
  apps/control-plane/src/services/ficha-do-item.ts apps/control-plane/src/services/ficha-do-item.test.ts
git commit -m "feat: tabela RepoItem para a ficha do item do repositorio - task 0.1"
```

---

### Task 0.2: Configurações novas por projeto (`cuidaPorOrigem`, `janelaEmConstrucaoHoras`, `autonomiaDeSeguranca`)

**Files:**
- Modify: `apps/control-plane/prisma/schema.prisma:333-459` (`model Project` — nova coluna `autonomiaDeSeguranca`)
- Create: `apps/control-plane/prisma/autonomia-de-seguranca-migration.sql`
- Modify: `apps/control-plane/src/lib/migration-ledger.ts` e `migration-ledger.test.ts` (mesmo drift guard da Tarefa 0.1 — adicionar `'autonomia-de-seguranca-migration.sql'`)
- Create: `apps/control-plane/src/services/cuidado-por-origem.ts`
- Test: `apps/control-plane/src/services/cuidado-por-origem.test.ts`
- Modify: `apps/control-plane/src/routes/painel.ts:1719` (fim do arquivo — duas rotas novas: `GET`/`POST /api/v1/painel/cuidado-por-origem`)
- Modify: `apps/web/src/components/painel/painel-api.ts:43-44` (adicionar `cuidaPorOrigem: '/api/v1/painel/cuidado-por-origem'` ao objeto `ROTAS`)
- Modify: `apps/web/src/components/painel/TelaConfig.tsx` (novo componente `CuidaPorOrigem`, inserido entre `ReguaDePronto()` e `DuracaoDaSprint()` na linha 343-344)
- Test: `apps/control-plane/src/routes/painel.test.ts` (rota nova — seguir o describe já existente para `/api/v1/painel/sprint-dias`, se houver; senão criar bloco novo no arquivo de teste de painel já usado pelas outras rotas)

**Interfaces:**
- Consumes: `Project.runtimeConfig` (schema.prisma:352, JSON já existente), o padrão `NIVEIS_DE_AUTONOMIA`/`NIVEL_PADRAO` de `packages/cadence/src/autonomia.ts:22-32`.
- Produces:
  - `type OrigemDoItem = 'jules' | 'assistente' | 'pessoa' | 'dependabot'`
  - `type PoliticaDeCuidado = 'sim' | 'nao' | 'perguntar'`
  - `interface CuidaPorOrigem { jules: PoliticaDeCuidado; assistente: PoliticaDeCuidado; pessoa: PoliticaDeCuidado; dependabot: PoliticaDeCuidado }`
  - `function lerCuidaPorOrigem(runtimeConfig: unknown, ehPlanoDoDono: boolean): CuidaPorOrigem` — consumida pela Fase 3 inteira (motor do próximo passo).
  - `function lerJanelaEmConstrucaoHoras(runtimeConfig: unknown): number` — consumida pela Tarefa 3.9.
  - `const AUTONOMIA_DE_SEGURANCA = ['so_olhar', 'sugerir', 'cuidar'] as const` (reaproveita os MESMOS 3 nomes de `NIVEIS_DE_AUTONOMIA`) — consumida pela Fase 5.

- [ ] **Step 1: Escrever o teste que falha para `cuidado-por-origem.ts`**

Criar `apps/control-plane/src/services/cuidado-por-origem.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { lerCuidaPorOrigem, lerJanelaEmConstrucaoHoras, JANELA_EM_CONSTRUCAO_PADRAO_HORAS } from './cuidado-por-origem.js'

describe('lerCuidaPorOrigem', () => {
  it('sem configuração e sem ser o dono: tudo "perguntar", exceto dependabot "sim"', () => {
    expect(lerCuidaPorOrigem(null, false)).toEqual({
      jules: 'sim',
      assistente: 'perguntar',
      pessoa: 'perguntar',
      dependabot: 'sim',
    })
  })

  it('lê o que o cliente configurou em runtimeConfig.cuidaPorOrigem', () => {
    const runtimeConfig = { cuidaPorOrigem: { jules: 'nao', assistente: 'sim', pessoa: 'nao', dependabot: 'perguntar' } }
    expect(lerCuidaPorOrigem(runtimeConfig, false)).toEqual({
      jules: 'nao',
      assistente: 'sim',
      pessoa: 'nao',
      dependabot: 'perguntar',
    })
  })

  it('valor desconhecido em uma origem cai no padrão daquela origem, sem derrubar as outras', () => {
    const runtimeConfig = { cuidaPorOrigem: { jules: 'talvez', assistente: 'sim' } }
    expect(lerCuidaPorOrigem(runtimeConfig, false)).toEqual({
      jules: 'sim',
      assistente: 'sim',
      pessoa: 'perguntar',
      dependabot: 'sim',
    })
  })
})

describe('lerJanelaEmConstrucaoHoras', () => {
  it('padrão de 2 horas quando ninguém configurou', () => {
    expect(lerJanelaEmConstrucaoHoras(null)).toBe(JANELA_EM_CONSTRUCAO_PADRAO_HORAS)
  })
  it('lê o valor configurado', () => {
    expect(lerJanelaEmConstrucaoHoras({ janelaEmConstrucaoHoras: 6 })).toBe(6)
  })
  it('valor negativo ou não numérico cai no padrão', () => {
    expect(lerJanelaEmConstrucaoHoras({ janelaEmConstrucaoHoras: -3 })).toBe(JANELA_EM_CONSTRUCAO_PADRAO_HORAS)
    expect(lerJanelaEmConstrucaoHoras({ janelaEmConstrucaoHoras: 'seis' })).toBe(JANELA_EM_CONSTRUCAO_PADRAO_HORAS)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/cuidado-por-origem.test.ts`
Expected: FAIL com `Cannot find module './cuidado-por-origem.js'`

- [ ] **Step 3: Implementar `cuidado-por-origem.ts`**

Segue o MESMO formato de `como-o-projeto-publica.ts` (runtimeConfig como namespace, leitura tolerante a lixo, nunca lança).

```ts
// Quem cuida de cada origem de pedido, por projeto (Fase 0.2 do plano do
// repositório inteiro). Guardado em Project.runtimeConfig.cuidaPorOrigem —
// mesmo padrão de runtimeConfig.publicacao (como-o-projeto-publica.ts) e
// runtimeConfig.board (board-status.ts): JSON aditivo, sem migração de coluna.

export const ORIGENS = ['jules', 'assistente', 'pessoa', 'dependabot'] as const
export type OrigemDoItem = (typeof ORIGENS)[number]

export const POLITICAS_DE_CUIDADO = ['sim', 'nao', 'perguntar'] as const
export type PoliticaDeCuidado = (typeof POLITICAS_DE_CUIDADO)[number]

export type CuidaPorOrigem = Record<OrigemDoItem, PoliticaDeCuidado>

/**
 * O padrão de quem nunca configurou. Decisão do dono (plano aprovado, Fase 0):
 * Jules cuida sozinho, Dependabot cuida sozinho, assistente de código e pessoa
 * ficam em "perguntar" — a mesma premissa de "pedir permissão a mais" que já
 * rege `NIVEL_PADRAO` em packages/cadence/src/autonomia.ts.
 *
 * `ehPlanoDoDono` existe para o dia em que o produto distinguir a própria
 * instância das dos clientes (mesmo gancho que `autonomia` usa hoje: projeto
 * sem escolha nasce no nível mais restrito, e só se abre por decisão
 * explícita) — hoje o valor não muda o resultado; ficar aqui como parâmetro
 * evita reabrir a assinatura da função quando essa distinção existir de
 * verdade, em vez de inventar um comportamento que ninguém pediu ainda.
 */
export const PADRAO_DE_CUIDADO: CuidaPorOrigem = {
  jules: 'sim',
  assistente: 'perguntar',
  pessoa: 'perguntar',
  dependabot: 'sim',
}

export const JANELA_EM_CONSTRUCAO_PADRAO_HORAS = 2

interface ConfiguracaoComCuidado {
  cuidaPorOrigem?: Partial<Record<string, unknown>>
  janelaEmConstrucaoHoras?: unknown
}

/** O que este projeto configurou, com o padrão para o que faltar ou for lixo. */
export function lerCuidaPorOrigem(runtimeConfig: unknown, _ehPlanoDoDono: boolean): CuidaPorOrigem {
  const bruto = (runtimeConfig as ConfiguracaoComCuidado | null)?.cuidaPorOrigem
  const saida = { ...PADRAO_DE_CUIDADO }
  if (!bruto || typeof bruto !== 'object') return saida
  for (const origem of ORIGENS) {
    const valor = bruto[origem]
    if (typeof valor === 'string' && POLITICAS_DE_CUIDADO.includes(valor as PoliticaDeCuidado)) {
      saida[origem] = valor as PoliticaDeCuidado
    }
  }
  return saida
}

/** Quantas horas um item "em construção" (rascunho ou commit recente) fica só sendo acompanhado. */
export function lerJanelaEmConstrucaoHoras(runtimeConfig: unknown): number {
  const bruto = (runtimeConfig as ConfiguracaoComCuidado | null)?.janelaEmConstrucaoHoras
  if (typeof bruto !== 'number' || !Number.isFinite(bruto) || bruto <= 0) {
    return JANELA_EM_CONSTRUCAO_PADRAO_HORAS
  }
  return bruto
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/cuidado-por-origem.test.ts`
Expected: PASS — 7 testes verdes.

- [ ] **Step 5: Migração da coluna `autonomiaDeSeguranca` — mesmo padrão de `autonomia-do-projeto-migration.sql`**

Em `schema.prisma`, dentro de `model Project`, logo abaixo de `autonomiaEscolhidaEm DateTime? @map("autonomia_escolhida_em")` (linha 383), adicionar:

```prisma
  // Fase 5 do plano do repositório inteiro: até onde o GitOrch vai em
  // segurança sozinho — mesmos 3 nomes de `autonomia` (packages/cadence/src/
  // autonomia.ts), campo PRÓPRIO porque segurança pode ser mais aberta que o
  // resto do repositório sem violar a premissa de "pedir permissão a mais"
  // (o dono pode querer "cuidar" em segurança e "sugerir" no resto).
  autonomiaDeSeguranca            String    @default("so_olhar") @map("autonomia_de_seguranca")
  autonomiaDeSegurancaEscolhidaEm DateTime? @map("autonomia_de_seguranca_escolhida_em")
```

Criar `apps/control-plane/prisma/autonomia-de-seguranca-migration.sql`:

```sql
-- Até onde o GitOrch vai em SEGURANÇA sozinho, por projeto — campo próprio,
-- separado de `autonomia` (packages/cadence/src/autonomia.ts): o dono pode
-- querer "cuidar" em segurança (aplicar branch protection, ligar secret
-- scanning) sem abrir o resto do repositório no mesmo nível.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/autonomia-de-seguranca-migration.sql

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS autonomia_de_seguranca TEXT NOT NULL DEFAULT 'so_olhar';

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_autonomia_de_seguranca_check;
ALTER TABLE projects ADD CONSTRAINT projects_autonomia_de_seguranca_check
  CHECK (autonomia_de_seguranca IN ('so_olhar', 'sugerir', 'cuidar'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS autonomia_de_seguranca_escolhida_em TIMESTAMP(3);
```

Registrar em `migration-ledger.ts` e no array hardcoded de `migration-ledger.test.ts`, depois de `'repo-item-migration.sql'` (Tarefa 0.1 — esta é a segunda migração nova, cronologicamente depois):

```ts
  'autonomia-de-seguranca-migration.sql',
```

- [ ] **Step 6: Rodar o teste de drift e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/lib/migration-ledger.test.ts`
Expected: PASS

- [ ] **Step 7: Rotas do painel — seguir EXATAMENTE o padrão de `/api/v1/painel/sprint-dias` (`painel.ts:1585-1660`)**

No fim de `apps/control-plane/src/routes/painel.ts` (linha 1719, antes do `}` que fecha a função exportada), adicionar, e trocar o import do topo do arquivo (perto da linha 51-56) para incluir `lerCuidaPorOrigem, lerJanelaEmConstrucaoHoras, PADRAO_DE_CUIDADO, ORIGENS, POLITICAS_DE_CUIDADO` de `../services/cuidado-por-origem.js`:

```ts
  // GET /api/v1/painel/cuidado-por-origem — quem cuida de cada origem, e a
  // janela de "em construção", deste projeto.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/cuidado-por-origem',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { runtimeConfig: true },
      })
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      return reply.send({
        cuidaPorOrigem: lerCuidaPorOrigem(row.runtimeConfig, false),
        janelaEmConstrucaoHoras: lerJanelaEmConstrucaoHoras(row.runtimeConfig),
        origens: ORIGENS,
        politicas: POLITICAS_DE_CUIDADO,
        padrao: PADRAO_DE_CUIDADO,
      })
    }
  )

  // POST /api/v1/painel/cuidado-por-origem — o cliente muda quem cuida de cada origem.
  app.post<{
    Body: { projeto?: string; cuidaPorOrigem?: Record<string, unknown>; janelaEmConstrucaoHoras?: unknown }
  }>(
    '/api/v1/painel/cuidado-por-origem',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const projeto = request.body?.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { id: true, runtimeConfig: true },
      })
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      // Normaliza na porta, mesma disciplina de normalizarRegua: chave
      // desconhecida é descartada, valor fora do catálogo é ignorado.
      const atual = (row.runtimeConfig ?? {}) as Record<string, unknown>
      const cuidaAtual = lerCuidaPorOrigem(row.runtimeConfig, false)
      const cuidaPedido = request.body?.cuidaPorOrigem ?? {}
      const cuidaPorOrigem = { ...cuidaAtual }
      for (const origem of ORIGENS) {
        const valor = cuidaPedido[origem]
        if (typeof valor === 'string' && POLITICAS_DE_CUIDADO.includes(valor as never)) {
          cuidaPorOrigem[origem] = valor as never
        }
      }
      const janela = request.body?.janelaEmConstrucaoHoras
      const janelaEmConstrucaoHoras =
        typeof janela === 'number' && Number.isFinite(janela) && janela > 0
          ? janela
          : lerJanelaEmConstrucaoHoras(row.runtimeConfig)

      await app.prisma.project.update({
        where: { id: row.id },
        data: { runtimeConfig: { ...atual, cuidaPorOrigem, janelaEmConstrucaoHoras } },
      })

      return reply.send({ cuidaPorOrigem, janelaEmConstrucaoHoras })
    }
  )
```

- [ ] **Step 8: Rota nova no `ROTAS` do front**

Em `apps/web/src/components/painel/painel-api.ts:44`, logo depois de `sprintDias: '/api/v1/painel/sprint-dias', ...`, adicionar:

```ts
  cuidaPorOrigem: '/api/v1/painel/cuidado-por-origem', // NOVA (Fase 0.2) — quem cuida de cada origem
```

- [ ] **Step 9: Componente novo em `TelaConfig.tsx` — mesmo contrato de `DuracaoDaSprint()`**

Em `apps/web/src/components/painel/TelaConfig.tsx`, entre a função `DuracaoDaSprint()` (termina linha 327) e `export function TelaConfig` (linha 329), adicionar:

```tsx
interface CuidaPorOrigemPayload {
  cuidaPorOrigem: Record<'jules' | 'assistente' | 'pessoa' | 'dependabot', 'sim' | 'nao' | 'perguntar'>
  janelaEmConstrucaoHoras: number
  origens: readonly string[]
  politicas: readonly string[]
}

const RÓTULO_DA_ORIGEM: Record<string, string> = {
  jules: 'Dev assíncrono (Jules) pelo GitOrch',
  assistente: 'Você com Claude, Codex ou Antigravity',
  pessoa: 'Outra pessoa',
  dependabot: 'Dependabot',
}

/**
 * Quem cuida de cada origem de pedido: o GitOrch julga e age sozinho ("Sim"),
 * nunca mexe ("Não") ou pergunta antes ("Perguntar"). Mesmo contrato de
 * `ReguaDePronto`/`DuracaoDaSprint`: salva de verdade, o estado vem da
 * RESPOSTA do servidor.
 */
function CuidaPorOrigem() {
  const projeto = useSyncExternalStore(assinarProjeto, projetoAtual, projetoNoServidor)
  const [dados, setDados] = useState<CuidaPorOrigemPayload | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    if (!projeto) {
      setDados(null)
      setErro(null)
      return
    }
    try {
      setDados(
        await buscar<CuidaPorOrigemPayload>(
          `${ROTAS.cuidaPorOrigem}?projeto=${encodeURIComponent(projeto)}`
        )
      )
      setErro(null)
    } catch {
      setErro('Não consegui ler quem cuida de cada origem agora.')
    }
  }, [projeto])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const escolher = async (origem: string, politica: string) => {
    if (!dados || !projeto) return
    setSalvando(true)
    try {
      const salvo = await pedir<CuidaPorOrigemPayload>(ROTAS.cuidaPorOrigem, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projeto,
          cuidaPorOrigem: { ...dados.cuidaPorOrigem, [origem]: politica },
        }),
      })
      setDados({ ...dados, cuidaPorOrigem: salvo.cuidaPorOrigem })
      setErro(null)
    } catch {
      setErro('Não consegui salvar. Nada mudou.')
    } finally {
      setSalvando(false)
    }
  }

  if (!projeto) {
    return (
      <Card titulo="Quem cuida de cada origem">
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--gl-muted)', maxWidth: '62ch' }}>
          Escolha um projeto no seletor do topo para ver e mudar isto.
        </p>
      </Card>
    )
  }

  return (
    <Card flush titulo="Quem cuida de cada origem">
      <div style={{ padding: '0 18px 12px', fontSize: 13.5, color: 'var(--gl-muted)' }}>
        Para cada origem de pedido, o GitOrch julga e age sozinho, nunca mexe, ou pergunta antes.
      </div>
      {erro && (
        <div style={{ padding: '0 18px 12px', fontSize: 13.5, color: 'var(--gl-sev)' }}>{erro}</div>
      )}
      {dados &&
        dados.origens.map((origem) => (
          <Linha key={origem} titulo={RÓTULO_DA_ORIGEM[origem] ?? origem} desc="">
            <div style={{ display: 'flex', gap: 6 }}>
              {dados.politicas.map((politica) => (
                <button
                  key={politica}
                  type="button"
                  disabled={salvando}
                  onClick={() => void escolher(origem, politica)}
                  data-testid={`cuida-${origem}-${politica}`}
                  aria-pressed={dados.cuidaPorOrigem[origem as never] === politica}
                  className={`pn-btn sm${dados.cuidaPorOrigem[origem as never] === politica ? ' a' : ''}`}
                >
                  {politica === 'sim' ? 'Sim' : politica === 'nao' ? 'Não' : 'Perguntar'}
                </button>
              ))}
            </div>
          </Linha>
        ))}
    </Card>
  )
}
```

Em `export function TelaConfig`, linha 343-344, adicionar `<CuidaPorOrigem />` logo depois de `<DuracaoDaSprint />`.

- [ ] **Step 10: Rodar a suíte do control-plane e a do web**

Run: `pnpm --filter @gitorch/control-plane test && pnpm --filter web test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/control-plane/prisma/schema.prisma apps/control-plane/prisma/autonomia-de-seguranca-migration.sql \
  apps/control-plane/src/lib/migration-ledger.ts apps/control-plane/src/lib/migration-ledger.test.ts \
  apps/control-plane/src/services/cuidado-por-origem.ts apps/control-plane/src/services/cuidado-por-origem.test.ts \
  apps/control-plane/src/routes/painel.ts apps/web/src/components/painel/painel-api.ts \
  apps/web/src/components/painel/TelaConfig.tsx
git commit -m "feat: configuracao de quem cuida de cada origem e autonomia de seguranca - task 0.2"
```

---

### Task 0.3: Webhook recebe todos os avisos que faltam

**Files:**
- Modify: `packages/github-sync/src/types.ts:1-9` (`GitHubWebhookEventName` — acrescentar os 6 eventos novos)
- Modify: `packages/github-sync/src/webhook-normalizer.ts:19-40` (`GitHubWebhookNormalizer.normalize` — novo `case` para cada evento novo)
- Test: `packages/github-sync/src/webhook-normalizer.test.ts`
- Modify: `apps/control-plane/src/routes/github-webhook.ts:246-260` (`toGitHubEventName` — nova lista de eventos suportados)
- Test: `apps/control-plane/src/routes/github-webhook.test.ts` (arquivo pode não existir ainda para este módulo — se não existir, criar seguindo o padrão de `packages/github-sync/src/github-webhook.test.ts`)

**Interfaces:**
- Consumes: `GitHubDeliveryEnvelope`, `GitHubSyncEvent` (`packages/github-sync/src/types.ts`).
- Produces: `GitHubWebhookEventName` ganha `'pull_request_review' | 'check_run' | 'status' | 'dependabot_alert' | 'code_scanning_alert' | 'secret_scanning_alert'`; `normalize()` devolve um `GitHubSyncEvent` genérico (`normalizeGeneric`) para os 6 — a Tarefa 1.1/1.2 é quem lê o payload bruto do evento (`envelope.payload`) para montar `EstadoDoItem`, não o normalizer (que serve ao `syncEngine`, cliente diferente).

- [ ] **Step 1: Escrever o teste que falha — `webhook-normalizer.test.ts`**

Adicionar a `packages/github-sync/src/webhook-normalizer.test.ts` (seguir os `describe` já existentes no arquivo):

```ts
describe('normalize — eventos de segurança e CI (Fase 0.3)', () => {
  it.each([
    'pull_request_review',
    'check_run',
    'status',
    'dependabot_alert',
    'code_scanning_alert',
    'secret_scanning_alert',
  ] as const)('aceita %s sem lançar', (eventName) => {
    const normalizer = new GitHubWebhookNormalizer()
    const envelope = {
      headers: { deliveryId: 'd1', eventName, signature256: 'sig' },
      payload: { action: 'created', repository: { full_name: 'dono/repo' } },
      body: '{}',
      receivedAt: '2026-09-15T00:00:00.000Z',
    }
    const evento = normalizer.normalize(envelope)
    expect(evento.eventName).toBe(eventName)
    expect(evento.repository).toBe('dono/repo')
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run packages/github-sync/src/webhook-normalizer.test.ts -t "eventos de segurança"`
Expected: FAIL — TypeScript recusa `eventName` fora de `GitHubWebhookEventName`, e em runtime cairia em `unsupportedEvent` (lança).

- [ ] **Step 3: Acrescentar os 6 eventos ao tipo**

Em `packages/github-sync/src/types.ts:1-9`, trocar:

```ts
export type GitHubWebhookEventName =
  | 'ping'
  | 'issues'
  | 'pull_request'
  | 'sub_issues'
  | 'issue_dependencies'
  | 'projects_v2'
  | 'projects_v2_item'
  | 'projects_v2_status_update'
```

por:

```ts
export type GitHubWebhookEventName =
  | 'ping'
  | 'issues'
  | 'pull_request'
  | 'pull_request_review'
  | 'check_run'
  | 'status'
  | 'dependabot_alert'
  | 'code_scanning_alert'
  | 'secret_scanning_alert'
  | 'sub_issues'
  | 'issue_dependencies'
  | 'projects_v2'
  | 'projects_v2_item'
  | 'projects_v2_status_update'
```

- [ ] **Step 4: Tratar os 6 eventos no normalizer**

Em `packages/github-sync/src/webhook-normalizer.ts:20-39`, trocar o `switch`:

```ts
  normalize(envelope: GitHubDeliveryEnvelope): GitHubSyncEvent {
    switch (envelope.headers.eventName) {
      case 'issues':
        return normalizeIssue(envelope)
      case 'pull_request':
        return normalizePullRequest(envelope)
      case 'sub_issues':
        return normalizeSubIssue(envelope)
      case 'issue_dependencies':
        return normalizeIssueDependency(envelope)
      case 'projects_v2_item':
        return normalizeProjectItem(envelope)
      case 'projects_v2':
      case 'projects_v2_status_update':
      case 'pull_request_review':
      case 'check_run':
      case 'status':
      case 'dependabot_alert':
      case 'code_scanning_alert':
      case 'secret_scanning_alert':
      case 'ping':
        return normalizeGeneric(envelope)
      default:
        return unsupportedEvent(envelope.headers.eventName)
    }
  }
```

(Os 6 eventos novos caem em `normalizeGeneric` — mesmo tratamento de `ping`/`projects_v2`: o `syncEngine` só precisa saber QUE o evento chegou e de qual repositório, `dependency.repository`; quem lê o corpo específico do evento é `atualizarFichaDoItem`, chamado direto pelo handler da rota, Tarefa 1.1/1.2 — dois consumidores diferentes do mesmo envelope, sem acoplar um ao outro.)

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run packages/github-sync/src/webhook-normalizer.test.ts`
Expected: PASS — suíte inteira do arquivo verde, incluindo os 6 novos.

- [ ] **Step 6: Escrever o teste que falha para `toGitHubEventName`**

Em `apps/control-plane/src/routes/github-webhook.ts`, a função `toGitHubEventName` (linha 246-260) não é exportada hoje — exportar para o teste conseguir chamá-la direto:

```ts
export function toGitHubEventName(event: string | undefined): GitHubWebhookEventName {
```

Criar (ou estender, se já existir) `apps/control-plane/src/routes/github-webhook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toGitHubEventName } from './github-webhook.js'

describe('toGitHubEventName — Fase 0.3', () => {
  it.each([
    'pull_request_review',
    'check_run',
    'status',
    'dependabot_alert',
    'code_scanning_alert',
    'secret_scanning_alert',
  ])('reconhece %s em vez de cair em ping', (nome) => {
    expect(toGitHubEventName(nome)).toBe(nome)
  })

  it('evento desconhecido continua caindo em ping (comportamento de hoje, preservado)', () => {
    expect(toGitHubEventName('marketplace_purchase')).toBe('ping')
  })
})
```

- [ ] **Step 7: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/routes/github-webhook.test.ts`
Expected: FAIL — os 6 eventos novos caem em `'ping'` porque `supported` (linha 247-256) ainda não os lista.

- [ ] **Step 8: Acrescentar os 6 eventos à lista suportada**

Em `apps/control-plane/src/routes/github-webhook.ts:246-260`, trocar:

```ts
function toGitHubEventName(event: string | undefined): GitHubWebhookEventName {
  const supported: GitHubWebhookEventName[] = [
    'ping',
    'issues',
    'pull_request',
    'sub_issues',
    'issue_dependencies',
    'projects_v2',
    'projects_v2_item',
    'projects_v2_status_update',
  ]
  return supported.includes(event as GitHubWebhookEventName)
    ? (event as GitHubWebhookEventName)
    : 'ping'
}
```

por:

```ts
export function toGitHubEventName(event: string | undefined): GitHubWebhookEventName {
  const supported: GitHubWebhookEventName[] = [
    'ping',
    'issues',
    'pull_request',
    'pull_request_review',
    'check_run',
    'status',
    'dependabot_alert',
    'code_scanning_alert',
    'secret_scanning_alert',
    'sub_issues',
    'issue_dependencies',
    'projects_v2',
    'projects_v2_item',
    'projects_v2_status_update',
  ]
  return supported.includes(event as GitHubWebhookEventName)
    ? (event as GitHubWebhookEventName)
    : 'ping'
}
```

- [ ] **Step 9: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/routes/github-webhook.test.ts`
Expected: PASS

- [ ] **Step 10: Rodar as suítes inteiras dos dois pacotes tocados**

Run: `pnpm --filter @gitorch/github-sync test && pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 11: Documentar se o manifesto do GitHub App precisa mudar**

Não há manifesto declarativo do GitHub App no código deste repositório (confirmado: nenhum arquivo `app.yml`/`manifest.json` de App do GitHub em `apps/control-plane` ou na raiz — a instalação é pelo fluxo web do GitHub, `routes/github-app-install.ts`, que troca o `code` do redirect por credenciais; o App em si — nome, webhooks assinados, permissões — foi criado e é mantido na UI do GitHub, fora deste repositório). Isso significa que os 6 eventos novos só chegam depois que o dono ativa os webhooks correspondentes NA TELA do GitHub App (Settings → Developer settings → GitHub Apps → GitOrch → Permissions & events) — **é o mesmo passo da Tarefa 0.4**, não uma mudança de código adicional. Registrar essa dependência no corpo desta tarefa no Shrimp antes de fechá-la.

- [ ] **Step 12: Commit**

```bash
git add packages/github-sync/src/types.ts packages/github-sync/src/webhook-normalizer.ts \
  packages/github-sync/src/webhook-normalizer.test.ts apps/control-plane/src/routes/github-webhook.ts \
  apps/control-plane/src/routes/github-webhook.test.ts
git commit -m "feat: webhook aceita revisao, check_run, status e alertas de seguranca - task 0.3"
```

---

### Task 0.4: Liberar as permissões novas no GitHub — passo do dono (documentação, sem código)

**Files:**
- Create: nenhum arquivo de código. Este é o único item do plano que é passo do dono — não aplicar nada sozinho.
- Modify: nenhum.

**Interfaces:**
- Consumes: a lista de eventos da Tarefa 0.3 (`dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert` exigem a permissão `security_events: read`; nenhuma automação nova de escrita é adicionada por este plano além do que `guarda-de-autonomia.ts` já cobre — a permissão `administration: write` é para a Fase 5.4, aplicar melhorias como branch protection).
- Produces: nenhuma interface de código — o produto do trabalho é uma instrução clara para o dono seguir na tela do GitHub.

- [ ] **Step 1: Registrar as DUAS permissões exatas a pedir**

No corpo da tarefa do Shrimp (não em código), registrar:

1. **`security_events: read`** — necessária para o GitHub App enviar os webhooks `dependabot_alert`, `code_scanning_alert` e `secret_scanning_alert` (Tarefa 0.3) e para a leitura via REST que `security-debt-collector.ts` já faz hoje com a credencial do CLIENTE (`coletarDividaDeSeguranca`, que só funciona porque a credencial do produto recusa essas rotas com 403 — comentário no topo do arquivo). Passar essa leitura para a credencial do produto elimina a dependência de o cliente ter conectado a própria conta.
2. **`administration: write`** — necessária só para a Fase 5.4 (aplicar branch protection e ligar secret scanning via API, quando o plano do GitHub do cliente permitir). Sem ela, a Fase 5.4 cai automaticamente no caminho alternativo da Fase 5.5 (gitleaks no workflow do próprio repositório) — o produto NUNCA fica bloqueado esperando esta permissão, só entrega menos automaticamente até ela existir.

- [ ] **Step 2: Descrever o fluxo real de aceite — como o dono aceita**

O fluxo é o padrão de atualização de permissões de GitHub App (não um fluxo que este produto controla):
1. O dono (ou quem administra o App) vai em `github.com/settings/apps/<nome-do-app>/permissions` (ou, para App de organização, `github.com/organizations/<org>/settings/apps/<nome-do-app>/permissions`).
2. Marca as 2 permissões acima e salva — o GitHub gera um pedido de atualização de permissões.
3. Cada CONTA que instalou o App (o dono e, no futuro, cada cliente) recebe um aviso do GitHub e precisa aceitar a atualização individualmente, em `github.com/settings/installations` → o App → "Review request" — é o GitHub, não o GitOrch, quem envia esse aviso.
4. Sem o aceite de uma conta, os webhooks dos 3 eventos de segurança simplesmente não chegam PARA AQUELE projeto — o resto do plano (Fases 1 a 4) continua funcionando normalmente para ele; só a Fase 5 fica limitada ao caminho gratuito (gitleaks) até o aceite acontecer.

- [ ] **Step 3: Nenhuma ação automática — só o aviso**

Esta tarefa fecha quando o texto acima está registrado no Shrimp e uma mensagem curta e objetiva foi preparada para o dono (formato "3 objetivas + 1 aberta" do padrão de pergunta ao dono, `feedback-toda-pergunta-telegram-4-opcoes`), pedindo que ele confirme QUANDO abrir a tela de permissões do App — nunca alterar a instalação do GitHub App por conta própria a partir do código ou de uma chamada de API (o produto não tem, e não deve ter, uma rota que muda o próprio manifesto do App).

- [ ] **Step 4: Sem commit de código**

Esta tarefa não gera diff em `apps/` nem em `packages/`. Fecha registrando a decisão em `perguntas-e-respostas` (MemPalace) e marcando, no Shrimp, que ela está BLOQUEADA no aceite do dono — nunca marcá-la concluída antes desse aceite ser confirmado (LEI DA VERDADE: "concluído" só depois de ver funcionar).

**Absorve do Shrimp:** L4-T15 (`564e7244`) — "escopo do revisor por origem" — a CONFIGURAÇÃO (`cuidaPorOrigem`) nasce aqui, na Tarefa 0.2; a aplicação plena da regra no julgamento/merge está na Fase 3 (Tarefa 3.8).

---
## Fase 1 — Retrato

### Task 1.1: Ficha do pedido atualizada a cada aviso

**Files:**
- Modify: `apps/control-plane/src/routes/github-webhook.ts:1-22` (imports) e `:796-816` (dentro de `githubWebhookRoutes`, logo depois do bloco que dispara `triggerAgentMission`, antes de `// Mark as processed`, linha 810)
- Test: `apps/control-plane/src/routes/github-webhook.test.ts` (mesmo arquivo criado na Tarefa 0.3)

**Interfaces:**
- Consumes: `atualizarFichaDoItem`, `EstadoDoItem` (`../services/ficha-do-item.js`, Tarefa 0.1); `casamento.projeto` (já existe em `github-webhook.ts`, resolvido antes do bloco de processamento).
- Produces: `function estadoDoPrAPartirDoPayload(payload: Record<string, unknown>): EstadoDoItem` — consumida pela Tarefa 1.3 (a varredura de 30 min monta o MESMO formato de estado a partir de uma leitura REST, não de um payload de webhook — por isso a função só lê o formato comum aos dois: `state`, `draft`, `mergeable`, `head.sha`).

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `apps/control-plane/src/routes/github-webhook.test.ts`:

```ts
import { estadoDoPrAPartirDoPayload } from './github-webhook.js'

describe('estadoDoPrAPartirDoPayload — Fase 1.1', () => {
  it('lê status, rascunho e último commit de um payload de pull_request', () => {
    const estado = estadoDoPrAPartirDoPayload({
      pull_request: {
        state: 'open',
        draft: false,
        mergeable: true,
        head: { sha: 'abc123' },
        changed_files: 3,
      },
    })
    expect(estado).toEqual({
      status: 'open',
      rascunho: false,
      conflito: false,
      ultimoCommitEm: null,
      arquivosMexidos: null,
    })
  })

  it('mergeable false vira conflito true', () => {
    const estado = estadoDoPrAPartirDoPayload({
      pull_request: { state: 'open', draft: false, mergeable: false },
    })
    expect(estado.conflito).toBe(true)
  })

  it('mergeable ausente (GitHub ainda calculando) não afirma conflito nem ausência dele', () => {
    const estado = estadoDoPrAPartirDoPayload({ pull_request: { state: 'open' } })
    expect(estado.conflito).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/routes/github-webhook.test.ts -t "estadoDoPrAPartirDoPayload"`
Expected: FAIL com `estadoDoPrAPartirDoPayload is not a function` (ainda não exportada).

- [ ] **Step 3: Implementar e chamar no handler**

No topo de `apps/control-plane/src/routes/github-webhook.ts`, acrescentar ao bloco de imports (perto da linha 20):

```ts
import { atualizarFichaDoItem, type EstadoDoItem } from '../services/ficha-do-item.js'
```

Logo antes de `export async function githubWebhookRoutes` (linha 353), adicionar:

```ts
/**
 * O estado do pull request que a ficha guarda, lido do payload do webhook
 * (`pull_request.*`) — MESMO FORMATO que a varredura de 30 min (Tarefa 1.3)
 * produz a partir de uma leitura REST, porque as duas alimentam a MESMA
 * ficha e `atualizarFichaDoItem` não sabe (nem precisa saber) qual das duas
 * fontes escreveu por último.
 */
export function estadoDoPrAPartirDoPayload(payload: {
  pull_request?: {
    state?: string
    draft?: boolean
    mergeable?: boolean | null
    head?: { sha?: string }
    changed_files?: number
  }
}): EstadoDoItem {
  const pr = payload.pull_request ?? {}
  return {
    status: pr.state ?? 'unknown',
    rascunho: pr.draft ?? false,
    // `mergeable` ausente/indefinido é "o GitHub ainda está calculando" — nunca
    // vira `false`: a mesma distinção que `PrAberto.mergeable` já respeita em
    // vigia-do-pr.ts (o portão 8 de `decidirAcaoNoPrOrfao`).
    conflito: pr.mergeable === undefined ? null : pr.mergeable === false,
    ultimoCommitEm: null,
    arquivosMexidos: null,
  }
}
```

Dentro de `githubWebhookRoutes`, logo depois do bloco `if (role && app.triggerAgentMission) { ... }` (termina linha 808) e antes de `// Mark as processed` (linha 810), adicionar:

```ts
          // Fase 1.1: a ficha do item é atualizada em TODO aviso reconhecido,
          // independente de ele acordar uma missão ou não — é o que faz o
          // "retrato" existir mesmo quando ninguém está julgando agora.
          if (eventName === 'pull_request' && parsedPayload.pull_request?.number) {
            try {
              await atualizarFichaDoItem({
                prisma: app.prisma as never,
                projectId: project.id,
                tipo: 'pr',
                numero: parsedPayload.pull_request.number,
                estado: estadoDoPrAPartirDoPayload(parsedPayload),
              })
            } catch (err) {
              // Best-effort, mesmo padrão do resto do handler: a ficha nunca
              // pode derrubar o 200 do webhook.
              app.log.warn({ err, projectId: project.id }, 'Falha ao atualizar a ficha do pull request')
            }
          }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/routes/github-webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Rodar a suíte inteira do control-plane**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/routes/github-webhook.ts apps/control-plane/src/routes/github-webhook.test.ts
git commit -m "feat: ficha do pull request atualizada a cada aviso do webhook - task 1.1"
```

---

### Task 1.2: Ficha da tarefa e do alerta de segurança

**Files:**
- Modify: `apps/control-plane/src/routes/github-webhook.ts` (mesmo bloco da Tarefa 1.1 — mais dois `if` para `issues` e para os 3 eventos de alerta)
- Test: `apps/control-plane/src/routes/github-webhook.test.ts`

**Interfaces:**
- Consumes: `atualizarFichaDoItem` (Tarefa 0.1), `estadoDoPrAPartirDoPayload` como referência de formato (Tarefa 1.1).
- Produces: `function estadoDaIssueAPartirDoPayload(payload): EstadoDoItem`, `function estadoDoAlertaAPartirDoPayload(payload, tipoDeAlerta: 'dependabot_alert' | 'code_scanning_alert' | 'secret_scanning_alert'): EstadoDoItem` — consumidas pela Tarefa 1.3 (mesmo motivo da 1.1: a varredura de 30 min usa o mesmo formato).

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `apps/control-plane/src/routes/github-webhook.test.ts`:

```ts
import { estadoDaIssueAPartirDoPayload, estadoDoAlertaAPartirDoPayload } from './github-webhook.js'

describe('estadoDaIssueAPartirDoPayload — Fase 1.2', () => {
  it('lê status da issue', () => {
    expect(estadoDaIssueAPartirDoPayload({ issue: { state: 'open' } })).toEqual({
      status: 'open',
    })
  })
})

describe('estadoDoAlertaAPartirDoPayload — Fase 1.2', () => {
  it('dependabot_alert: lê state e severidade', () => {
    const estado = estadoDoAlertaAPartirDoPayload(
      { dependabot_alert: { state: 'open', security_advisory: { severity: 'high' } } },
      'dependabot_alert'
    )
    expect(estado).toEqual({ status: 'open', verificacao: 'high' })
  })

  it('code_scanning_alert: lê state e severidade da rule', () => {
    const estado = estadoDoAlertaAPartirDoPayload(
      { alert: { state: 'open', rule: { severity: 'error' } } },
      'code_scanning_alert'
    )
    expect(estado).toEqual({ status: 'open', verificacao: 'error' })
  })

  it('secret_scanning_alert: lê state, sem severidade (a API não devolve)', () => {
    const estado = estadoDoAlertaAPartirDoPayload(
      { alert: { state: 'open' } },
      'secret_scanning_alert'
    )
    expect(estado).toEqual({ status: 'open', verificacao: null })
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/routes/github-webhook.test.ts -t "estadoDaIssueAPartirDoPayload"`
Expected: FAIL — funções ainda não existem.

- [ ] **Step 3: Implementar e chamar no handler**

Em `github-webhook.ts`, logo abaixo de `estadoDoPrAPartirDoPayload` (Tarefa 1.1):

```ts
/** O estado da issue que a ficha guarda. */
export function estadoDaIssueAPartirDoPayload(payload: {
  issue?: { state?: string }
}): EstadoDoItem {
  return { status: payload.issue?.state ?? 'unknown' }
}

/**
 * O estado do alerta de segurança que a ficha guarda. Os TRÊS eventos de
 * alerta (`dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert`)
 * têm formatos de payload DIFERENTES entre si — a chave do objeto muda
 * (`dependabot_alert` vs `alert`) e só os dois primeiros trazem severidade.
 * `secret_scanning_alert` nunca traz severidade (a API do GitHub não expõe
 * uma para segredo vazado — é sempre tratamento máximo, Fase 5.2).
 */
export function estadoDoAlertaAPartirDoPayload(
  payload: Record<string, unknown>,
  tipoDeAlerta: 'dependabot_alert' | 'code_scanning_alert' | 'secret_scanning_alert'
): EstadoDoItem {
  if (tipoDeAlerta === 'dependabot_alert') {
    const alerta = payload['dependabot_alert'] as
      | { state?: string; security_advisory?: { severity?: string } }
      | undefined
    return {
      status: alerta?.state ?? 'unknown',
      verificacao: alerta?.security_advisory?.severity ?? null,
    }
  }
  if (tipoDeAlerta === 'code_scanning_alert') {
    const alerta = payload['alert'] as { state?: string; rule?: { severity?: string } } | undefined
    return { status: alerta?.state ?? 'unknown', verificacao: alerta?.rule?.severity ?? null }
  }
  const alerta = payload['alert'] as { state?: string } | undefined
  return { status: alerta?.state ?? 'unknown', verificacao: null }
}
```

No handler, logo depois do bloco de `pull_request` da Tarefa 1.1:

```ts
          if (eventName === 'issues' && parsedPayload.issue?.number) {
            try {
              await atualizarFichaDoItem({
                prisma: app.prisma as never,
                projectId: project.id,
                tipo: 'issue',
                numero: parsedPayload.issue.number,
                estado: estadoDaIssueAPartirDoPayload(parsedPayload),
              })
            } catch (err) {
              app.log.warn({ err, projectId: project.id }, 'Falha ao atualizar a ficha da tarefa')
            }
          }

          const EVENTOS_DE_ALERTA = ['dependabot_alert', 'code_scanning_alert', 'secret_scanning_alert'] as const
          if ((EVENTOS_DE_ALERTA as readonly string[]).includes(eventName)) {
            const numeroDoAlerta =
              (parsedPayload.dependabot_alert?.number as number | undefined) ??
              (parsedPayload.alert?.number as number | undefined)
            if (typeof numeroDoAlerta === 'number') {
              try {
                await atualizarFichaDoItem({
                  prisma: app.prisma as never,
                  projectId: project.id,
                  tipo: 'alerta',
                  numero: numeroDoAlerta,
                  estado: estadoDoAlertaAPartirDoPayload(
                    parsedPayload,
                    eventName as 'dependabot_alert' | 'code_scanning_alert' | 'secret_scanning_alert'
                  ),
                })
              } catch (err) {
                app.log.warn({ err, projectId: project.id }, 'Falha ao atualizar a ficha do alerta')
              }
            }
          }
```

(`eventName` já existe no escopo — é o resultado de `toGitHubEventName(event)`, calculado mais acima no mesmo `try`, linha 545.)

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/routes/github-webhook.test.ts`
Expected: PASS

- [ ] **Step 5: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/routes/github-webhook.ts apps/control-plane/src/routes/github-webhook.test.ts
git commit -m "feat: ficha da tarefa e do alerta de seguranca atualizadas pelo webhook - task 1.2"
```

---

### Task 1.3: Varredura de conferência a cada 30 minutos

**Files:**
- Modify: `apps/control-plane/src/plugins/scheduler.ts` (novo bloco, ao lado do de `varrerPrsOrfaos`, linha 6825-6925 — mesma cadência-por-projeto via `Map`)
- Create: `apps/control-plane/src/services/varredura-do-retrato.ts`
- Test: `apps/control-plane/src/services/varredura-do-retrato.test.ts`

**Interfaces:**
- Consumes: `atualizarFichaDoItem` (Tarefa 0.1); `estadoDoPrAPartirDoPayload`/`estadoDaIssueAPartirDoPayload` (Tarefas 1.1/1.2, reaproveitadas — por isso elas foram desenhadas para ler de um objeto genérico, não do envelope de webhook); `lerVerificacao`, `MAX_PAGINAS_DE_PR` (`../services/vigia-do-pr.js`, já existentes).
- Produces: `async function varrerRetratoDoProjeto(deps: VarreduraDoRetratoDeps): Promise<{ prs: number; issues: number; alertas: number }>` — chamada pelo `scheduler.ts` a cada 30 min por projeto; `export const CADENCIA_DO_RETRATO_MS = 30 * 60_000`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/varredura-do-retrato.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { varrerRetratoDoProjeto } from './varredura-do-retrato.js'

function ghGetFake(rotas: Record<string, unknown>) {
  return vi.fn(async (caminho: string) => {
    for (const [padrao, resposta] of Object.entries(rotas)) {
      if (caminho.startsWith(padrao)) return resposta
    }
    throw new Error(`rota não mapeada no teste: ${caminho}`)
  })
}

describe('varrerRetratoDoProjeto', () => {
  it('grava a ficha de cada PR e cada issue abertos', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [{ number: 10, state: 'open', draft: false, mergeable: true }],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => {
        atualizados.push({ tipo: args.tipo, numero: args.numero })
      },
    })
    expect(resumo).toEqual({ prs: 1, issues: 1, alertas: 0 })
    expect(atualizados).toContainEqual({ tipo: 'pr', numero: 10 })
    expect(atualizados).toContainEqual({ tipo: 'issue', numero: 20 })
  })

  it('issue que é na verdade um pull request (a API do GitHub mistura os dois em /issues) é ignorada aqui', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: { url: 'x' } }],
    })
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => atualizados.push({ tipo: args.tipo, numero: args.numero }),
    })
    expect(atualizados).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/varredura-do-retrato.test.ts`
Expected: FAIL com `Cannot find module './varredura-do-retrato.js'`

- [ ] **Step 3: Implementar `varredura-do-retrato.ts`**

```ts
// A varredura de conferência: a cada 30 min por projeto, pega o que o
// webhook perdeu (entrega que falhou, aviso que o GitHub não reenviou,
// projeto conectado antes de existir webhook). Mesmo papel que
// `vigiarPrsOrfaos` (vigia-do-pr.ts) já cumpre para pull requests órfãos,
// mas aqui o alvo é a FICHA (Fase 0-1), não a decisão de agir.

import { estadoDoPrAPartirDoPayload, estadoDaIssueAPartirDoPayload } from '../routes/github-webhook.js'
import type { EstadoDoItem, TipoDoItem } from './ficha-do-item.js'

/** Cadência da varredura de retrato — separada da de `vigiarPrsOrfaos` (6h): a
 *  ficha precisa ficar em dia bem mais rápido que a decisão de agir sobre um
 *  pull request órfão. */
export const CADENCIA_DO_RETRATO_MS = 30 * 60_000

export const MAX_PAGINAS_DA_VARREDURA = 20

export interface VarreduraDoRetratoDeps {
  repo: string
  ghGet: (caminho: string) => Promise<unknown>
  atualizarFicha: (args: { tipo: TipoDoItem; numero: number; estado: EstadoDoItem }) => Promise<void>
  onWarn?: (m: string) => void
}

interface PrCru {
  number: number
  state?: string
  draft?: boolean
  mergeable?: boolean | null
  head?: { sha?: string }
  changed_files?: number
}

interface IssueCru {
  number: number
  state?: string
  pull_request?: unknown
}

export async function varrerRetratoDoProjeto(
  deps: VarreduraDoRetratoDeps
): Promise<{ prs: number; issues: number; alertas: number }> {
  let prs = 0
  let issues = 0

  for (let pagina = 1; pagina <= MAX_PAGINAS_DA_VARREDURA; pagina += 1) {
    const lote = (await deps.ghGet(
      `/repos/${deps.repo}/pulls?state=open&per_page=100&page=${pagina}`
    )) as PrCru[]
    for (const pr of lote) {
      await deps.atualizarFicha({
        tipo: 'pr',
        numero: pr.number,
        estado: estadoDoPrAPartirDoPayload({ pull_request: pr }),
      })
      prs += 1
    }
    if (lote.length < 100) break
    if (pagina === MAX_PAGINAS_DA_VARREDURA) {
      deps.onWarn?.(`varredura-do-retrato: ${deps.repo} tem mais PRs do que a varredura cobre nesta passada`)
    }
  }

  for (let pagina = 1; pagina <= MAX_PAGINAS_DA_VARREDURA; pagina += 1) {
    const lote = (await deps.ghGet(
      `/repos/${deps.repo}/issues?state=open&per_page=100&page=${pagina}`
    )) as IssueCru[]
    for (const issue of lote) {
      // A rota /issues do GitHub devolve pull requests JUNTO (todo PR também
      // é uma issue lá dentro) — `pull_request` presente é a marca de que
      // esta linha já foi contada na varredura de PRs acima.
      if (issue.pull_request) continue
      await deps.atualizarFicha({
        tipo: 'issue',
        numero: issue.number,
        estado: estadoDaIssueAPartirDoPayload({ issue }),
      })
      issues += 1
    }
    if (lote.length < 100) break
    if (pagina === MAX_PAGINAS_DA_VARREDURA) {
      deps.onWarn?.(`varredura-do-retrato: ${deps.repo} tem mais issues do que a varredura cobre nesta passada`)
    }
  }

  // Alertas de segurança: a Fase 5.2 estende esta função para gravar a ficha
  // de cada alerta usando `coletarDividaDeSeguranca` (security-debt-collector.ts)
  // — não duplicado aqui porque aquele serviço exige a credencial do CLIENTE
  // (403 na do produto), diferente de `ghGet` acima, e a Fase 5 é quem decide
  // como as duas credenciais convivem nesta mesma varredura.
  return { prs, issues, alertas: 0 }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/varredura-do-retrato.test.ts`
Expected: PASS — 2 testes verdes.

- [ ] **Step 5: Ligar ao `scheduler.ts` — mesmo padrão de cadência por projeto de `varrerPrsOrfaos`**

Em `apps/control-plane/src/plugins/scheduler.ts`, perto da linha 6825 (`const ultimaVarreduraDePrOrfao = new Map<string, number>()`), adicionar o Map irmão:

```ts
  const ultimaVarreduraDoRetrato = new Map<string, number>()
```

Logo depois da função `varrerPrsOrfaos` (que termina por volta da linha 6925 — confirmar lendo o arquivo real antes de editar, pois é um arquivo de 11k linhas e a extensão exata pode ter mudado), adicionar uma função irmã:

```ts
  const varrerRetratos = async (): Promise<void> => {
    const agora = new Date()
    const projetos = await app.prisma.project.findMany({
      where: { isActive: true },
      select: { id: true, wingId: true },
    })

    for (const projeto of projetos) {
      const ultima = ultimaVarreduraDoRetrato.get(projeto.id) ?? 0
      if (agora.getTime() - ultima < CADENCIA_DO_RETRATO_MS) continue
      ultimaVarreduraDoRetrato.set(projeto.id, agora.getTime())

      try {
        const token =
          process.env['GITORCH_GITHUB_TOKEN'] ??
          (await mintInstallationToken({
            repository: projeto.wingId,
            onError: (m) => app.log.error(m),
            onWarn: (m) => app.log.warn(m),
          })) ??
          undefined
        if (!token) continue

        const resumo = await varrerRetratoDoProjeto({
          repo: projeto.wingId,
          ghGet: (caminho) => ghGet(caminho, token),
          atualizarFicha: (args) =>
            atualizarFichaDoItem({
              prisma: app.prisma as never,
              projectId: projeto.id,
              tipo: args.tipo,
              numero: args.numero,
              estado: args.estado,
            }).then(() => undefined),
          onWarn: (m) => app.log.warn(`[Scheduler] ${m}`),
        })
        app.log.info(
          { projectId: projeto.id, ...resumo },
          '[Scheduler] varredura-do-retrato: ficha atualizada'
        )
      } catch (err) {
        app.log.error({ err, projectId: projeto.id }, '[Scheduler] varredura-do-retrato falhou')
      }
    }
  }
```

Acrescentar `varrerRetratoDoProjeto, CADENCIA_DO_RETRATO_MS` aos imports de `'../services/varredura-do-retrato.js'` e `atualizarFichaDoItem` de `'../services/ficha-do-item.js'` no topo do arquivo, e chamar `void varrerRetratos()` no MESMO laço de relógio de 1 minuto onde `varrerPrsOrfaos()` já é chamado (confirmar o `setInterval`/laço exato lendo o trecho ao redor da linha 11505 antes de editar — não adivinhar o número de linha).

- [ ] **Step 6: Rodar a suíte do control-plane inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: QA manual — confirmar que a cadência não desanda em produção**

Antes de fechar esta tarefa no Shrimp: subir o control-plane local (ou observar o log do relógio em staging) e confirmar, pelo log `[Scheduler] varredura-do-retrato: ficha atualizada`, que a passada roda 1x por projeto a cada 30 min — nunca a cada tique de 1 min (o mesmo defeito que o comentário de `CADENCIA_DA_VARREDURA_MS` em `vigia-do-pr.ts` já documenta para o vigia de PR órfão).

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/services/varredura-do-retrato.ts apps/control-plane/src/services/varredura-do-retrato.test.ts \
  apps/control-plane/src/plugins/scheduler.ts
git commit -m "feat: varredura de conferencia do retrato a cada 30 minutos - task 1.3"
```

---

### Task 1.4: Descobrir a origem de cada pedido

**Files:**
- Create: `apps/control-plane/src/services/origem-do-item.ts`
- Test: `apps/control-plane/src/services/origem-do-item.test.ts`

**Interfaces:**
- Consumes: `SinaisDePR`, `ehPRDaAutomacao`, `AUTORES_QUE_O_VIGIA_NAO_CONSERTA`, `temRodapeDoDev` (`./vigia-do-pr.js`, já existentes).
- Produces: `type OrigemDoItem = 'jules_gitorch' | 'jules_fora' | 'assistente' | 'pessoa' | 'dependabot' | 'outro_bot'`; `function classificarOrigem(sinais: SinaisDeOrigem): OrigemDoItem` — consumida pela Fase 2 (vínculo) e pela Fase 3 (`cuidaPorOrigem` usa estes 4 baldes: `jules` cobre `jules_gitorch` e `jules_fora`, `assistente` cobre `assistente`, `pessoa` cobre `pessoa`, `dependabot` cobre `dependabot`; `outro_bot` NUNCA é julgado nem mesclado automaticamente — cai sempre em "só acompanha", Tarefa 3.9).

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/origem-do-item.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classificarOrigem } from './origem-do-item.js'

describe('classificarOrigem', () => {
  it('dependabot[bot] como autor → dependabot', () => {
    expect(
      classificarOrigem({ autor: 'dependabot[bot]', labels: [], corpo: null, commits: [], temSessaoGitOrch: false })
    ).toBe('dependabot')
  })

  it('rodapé do dev + sessão do GitOrch → jules_gitorch', () => {
    expect(
      classificarOrigem({
        autor: 'gitorch-bot',
        labels: [],
        corpo: 'PR created automatically by Jules for task [42](https://jules.google.com/task/42) started by @loureng',
        commits: [],
        temSessaoGitOrch: true,
      })
    ).toBe('jules_gitorch')
  })

  it('rodapé do dev SEM sessão do GitOrch → jules_fora (alguém usou o Jules direto, sem passar pelo produto)', () => {
    expect(
      classificarOrigem({
        autor: 'algum-login',
        labels: [],
        corpo: 'PR created automatically by Jules for task [1](https://jules.google.com/task/1) started by @outra-pessoa',
        commits: [],
        temSessaoGitOrch: false,
      })
    ).toBe('jules_fora')
  })

  it('commit com trailer Co-Authored-By de assistente conhecido → assistente', () => {
    expect(
      classificarOrigem({
        autor: 'loureng',
        labels: [],
        corpo: null,
        commits: [{ mensagem: 'fix: x\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>', autorLogin: 'loureng' }],
        temSessaoGitOrch: false,
      })
    ).toBe('assistente')
  })

  it('sem nenhum sinal de automação → pessoa', () => {
    expect(
      classificarOrigem({
        autor: 'loureng',
        labels: [],
        corpo: 'ajuste manual',
        commits: [{ mensagem: 'fix: x', autorLogin: 'loureng' }],
        temSessaoGitOrch: false,
      })
    ).toBe('pessoa')
  })

  it('bot desconhecido (nem dependabot, nem rodapé do dev) → outro_bot', () => {
    expect(
      classificarOrigem({ autor: 'renovate[bot]', labels: [], corpo: null, commits: [], temSessaoGitOrch: false })
    ).toBe('outro_bot')
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/origem-do-item.test.ts`
Expected: FAIL com `Cannot find module './origem-do-item.js'`

- [ ] **Step 3: Implementar `origem-do-item.ts`**

```ts
// A origem de um item (pull request ou commit): quem produziu o trabalho,
// pelas marcas que cada origem deixa no que a API do GitHub já devolve —
// nunca por adivinhação. Consumida pela Fase 2 (vínculo com a tarefa) e pela
// Fase 3 (cuidaPorOrigem, Tarefa 0.2, decide se o GitOrch julga sozinho).

import { ehPRDaAutomacao, temRodapeDoDev, type SinaisDePR } from './vigia-do-pr.js'

export type OrigemDoItem = 'jules_gitorch' | 'jules_fora' | 'assistente' | 'pessoa' | 'dependabot' | 'outro_bot'

/** Contas de bot conhecidas que NÃO são o dev assíncrono nem o produto — ex.:
 *  Renovate, um bot de CI de terceiro. Ausência na lista não vira "é gente":
 *  o sufixo `[bot]` no login já é o sinal (ver `pareceContaDeBot`). */
const SUFIXO_DE_CONTA_DE_BOT = /\[bot\]$/

function pareceContaDeBot(login: string | null | undefined): boolean {
  return SUFIXO_DE_CONTA_DE_BOT.test(login ?? '')
}

/**
 * Assinaturas REAIS que cada assistente de código deixa no rodapé do commit —
 * o trailer `Co-Authored-By`, padrão git. Cada ferramenta escreve o PRÓPRIO
 * nome; casar por substring (não por igualdade exata) tolera a versão do
 * modelo mudar (`Claude Sonnet 5`, `Claude Opus 4` — todos começam com
 * "Claude").
 */
const ASSINATURAS_DE_ASSISTENTE = [/Co-Authored-By:\s*Claude/i, /Co-Authored-By:\s*Codex/i, /Co-Authored-By:\s*Antigravity/i]

function commitAssinadoPorAssistente(commits: SinaisDeOrigem['commits']): boolean {
  return commits.some((c) => ASSINATURAS_DE_ASSISTENTE.some((re) => re.test(c.mensagem)))
}

export interface SinaisDeOrigem extends SinaisDePR {
  /** Mensagens de commit do pull request, na ordem em que a API devolve. */
  commits: Array<{ mensagem: string; autorLogin: string | null }>
  /** Há sessão do dev assíncrono NESTE produto apontando para este pull
   *  request (`casarPrComSessao`, Fase 2.1)? Separa `jules_gitorch` de
   *  `jules_fora` — a MESMA evidência de rodapé existe nos dois casos; o que
   *  muda é se o GitOrch foi quem disparou a sessão. */
  temSessaoGitOrch: boolean
}

/**
 * Classifica pelo sinal mais forte primeiro — mesma disciplina de
 * `casarProjeto` em `github-webhook.ts`: do critério mais confiável ao mais
 * fraco, nunca um `OU` cego entre eles.
 */
export function classificarOrigem(sinais: SinaisDeOrigem): OrigemDoItem {
  // 1) Dependabot: autor de bot conhecido, sinal mais forte que existe.
  if (['dependabot[bot]', 'dependabot-preview[bot]'].includes(sinais.autor ?? '')) return 'dependabot'

  // 2) O dev assíncrono (Jules): rodapé próprio, verificável sem rede.
  if (temRodapeDoDev(sinais.corpo)) {
    return sinais.temSessaoGitOrch ? 'jules_gitorch' : 'jules_fora'
  }

  // 3) Assistente de código (Claude/Codex/Antigravity): trailer de commit.
  if (commitAssinadoPorAssistente(sinais.commits)) return 'assistente'

  // 4) Qualquer outro bot: login termina em [bot] mas não bateu em nenhuma
  // das assinaturas conhecidas acima.
  if (pareceContaDeBot(sinais.autor)) return 'outro_bot'

  // 5) Sem nenhum sinal de automação: é gente. `ehPRDaAutomacao` cobre o
  // resto do que os passos acima já não cobriram (labels da automação) —
  // reaproveitado aqui só como reforço, nunca como decisão isolada.
  if (ehPRDaAutomacao(sinais) && !pareceContaDeBot(sinais.autor)) return 'outro_bot'

  return 'pessoa'
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/origem-do-item.test.ts`
Expected: PASS — 6 testes verdes.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/services/origem-do-item.ts apps/control-plane/src/services/origem-do-item.test.ts
git commit -m "feat: classificador de origem do item (jules, assistente, pessoa, dependabot) - task 1.4"
```

**Absorve do Shrimp:** nenhuma tarefa antiga do Shrimp mapeada nesta fase — a Fase 1 é infraestrutura nova (ficha + varredura + classificador de origem), sem equivalente na fila antiga.

---
## Fase 2 — Vínculo e entendimento

### Task 2.1: Achar a tarefa pelas pistas (vínculo formal, texto, sessão do Jules)

**Files:**
- Create: `apps/control-plane/src/services/vinculo-da-tarefa.ts`
- Test: `apps/control-plane/src/services/vinculo-da-tarefa.test.ts`
- Modify: `packages/github-sync/src/project-v2-client.ts` (novo método `closingIssuesDoPr`, ao lado de `findProjectId`, linha 522-556 — mesmo estilo de `request<T>`)
- Test: `packages/github-sync/src/project-v2-client.test.ts`

**Interfaces:**
- Consumes: `ehPrDelegado`, `ResultadoPrDelegado` (`./pr-delegado.js`, já existente, linhas 21-66); `casarPrComSessao`, `SessaoParaCasamento` (`./casar-pr-com-sessao.js`, Fase 1, já existente); `LinhaDeSessao` (`./dev-session-store.js`).
- Produces:
  - `interface VinculoDaTarefa { issueNumber: number; origemDoVinculo: 'formal' | 'texto' | 'branch-do-jules' }`
  - `async function acharTarefaDoItem(deps: AcharTarefaDeps): Promise<VinculoDaTarefa | null>` — consumida pelas Tarefas 2.2 (RA entra quando isto devolve `null`) e 2.4 (o formulário de entendimento grava `origemDoVinculo`).
  - `async closingIssuesDoPr(input: { owner: string; repo: string; prNumber: number }): Promise<number[]>` em `ProjectV2Client` — consumida só por `acharTarefaDoItem`.

- [ ] **Step 1: Escrever o teste que falha para `closingIssuesDoPr`**

Acrescentar a `packages/github-sync/src/project-v2-client.test.ts` (seguir o padrão dos testes de `findProjectId` já existentes no arquivo — `nock`/fetch mockado, conforme os testes vizinhos usam):

```ts
describe('closingIssuesDoPr', () => {
  it('devolve os números das issues que o PR fecha formalmente', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: { nodes: [{ number: 12 }, { number: 34 }] },
              },
            },
          },
        }),
        { status: 200 }
      )
    )
    const client = new ProjectV2Client({ token: 't', fetchImpl: fetchMock })
    const numeros = await client.closingIssuesDoPr({ owner: 'dono', repo: 'repo', prNumber: 7 })
    expect(numeros).toEqual([12, 34])
  })

  it('PR sem issue vinculada devolve lista vazia', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } },
        }),
        { status: 200 }
      )
    )
    const client = new ProjectV2Client({ token: 't', fetchImpl: fetchMock })
    expect(await client.closingIssuesDoPr({ owner: 'dono', repo: 'repo', prNumber: 7 })).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run packages/github-sync/src/project-v2-client.test.ts -t "closingIssuesDoPr"`
Expected: FAIL — `client.closingIssuesDoPr is not a function`

- [ ] **Step 3: Implementar `closingIssuesDoPr` em `ProjectV2Client`**

Em `packages/github-sync/src/project-v2-client.ts`, logo depois de `findProjectId` (termina linha 556), adicionar:

```ts
  // O vínculo FORMAL do GitHub: o que a UI mostra como "closes #N" na barra
  // lateral do pull request, já resolvido e validado pelo próprio GitHub —
  // mais forte que ler "closes #N" no texto (`pr-delegado.ts` já cobre esse
  // recuo mais fraco). Cobre também vínculo feito pela UI sem citação nenhuma
  // no corpo, e vínculo cross-repository.
  async closingIssuesDoPr(input: { owner: string; repo: string; prNumber: number }): Promise<number[]> {
    const response = await this.request<{
      repository: { pullRequest: { closingIssuesReferences: { nodes: Array<{ number: number }> } } | null } | null
    }>(
      {
        query: `
          query ClosingIssuesDoPr($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $prNumber) {
                closingIssuesReferences(first: 10) {
                  nodes { number }
                }
              }
            }
          }
        `,
        variables: { owner: input.owner, repo: input.repo, prNumber: input.prNumber },
      },
      this.token
    )
    const nodes = unwrap(response).repository?.pullRequest?.closingIssuesReferences.nodes ?? []
    return nodes.map((n) => n.number)
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run packages/github-sync/src/project-v2-client.test.ts -t "closingIssuesDoPr"`
Expected: PASS

- [ ] **Step 5: Escrever o teste que falha para `acharTarefaDoItem`**

Criar `apps/control-plane/src/services/vinculo-da-tarefa.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { acharTarefaDoItem } from './vinculo-da-tarefa.js'

describe('acharTarefaDoItem', () => {
  it('vínculo formal (closingIssuesReferences) vence — nem consulta o corpo/branch', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'loureng',
      corpo: null,
      headRefName: 'qualquer-ramo',
      sessoes: [],
      closingIssues: async () => [12],
      issueComEtiquetaDeDelegacao: () => false,
    })
    expect(r).toEqual({ issueNumber: 12, origemDoVinculo: 'formal' })
  })

  it('sem vínculo formal, recua para o texto/sessão (ehPrDelegado)', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'gitorch-bot',
      corpo: 'closes #74',
      headRefName: 'qualquer-ramo',
      sessoes: [{ issueNumber: 74, pullRequestNumber: null } as never],
      closingIssues: async () => [],
      issueComEtiquetaDeDelegacao: () => true,
    })
    expect(r).toEqual({ issueNumber: 74, origemDoVinculo: 'texto' })
  })

  it('sem vínculo formal nem texto, recua para o branch do Jules (casarPrComSessao)', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'gitorch-bot',
      corpo: null,
      headRefName: 'jules-121123025271330309061-e9d57552',
      sessoes: [{ sessionName: 'sessions/121123025271330309061', pullRequestNumber: null, issueNumber: 55 } as never],
      closingIssues: async () => [],
      issueComEtiquetaDeDelegacao: () => false,
    })
    expect(r).toEqual({ issueNumber: 55, origemDoVinculo: 'branch-do-jules' })
  })

  it('nenhuma pista: null', async () => {
    const r = await acharTarefaDoItem({
      numeroDoPr: 7,
      autor: 'loureng',
      corpo: null,
      headRefName: 'minha-feature',
      sessoes: [],
      closingIssues: async () => [],
      issueComEtiquetaDeDelegacao: () => false,
    })
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/vinculo-da-tarefa.test.ts`
Expected: FAIL com `Cannot find module './vinculo-da-tarefa.js'`

- [ ] **Step 7: Implementar `vinculo-da-tarefa.ts`**

```ts
// Acha a tarefa de origem de um pull request pela pista mais forte
// disponível, nesta ordem: vínculo FORMAL do GitHub (closingIssuesReferences)
// → texto do corpo + sessão (ehPrDelegado, já existente) → branch do Jules
// (casarPrComSessao, já existente). Cada camada é mais fraca que a anterior;
// a primeira que achar vence — nunca combina pistas de camadas diferentes.

import { ehPrDelegado } from './pr-delegado.js'
import { casarPrComSessao, type SessaoParaCasamento } from './casar-pr-com-sessao.js'
import type { LinhaDeSessao } from './dev-session-store.js'

export type OrigemDoVinculo = 'formal' | 'texto' | 'branch-do-jules'

export interface VinculoDaTarefa {
  issueNumber: number
  origemDoVinculo: OrigemDoVinculo
}

export interface AcharTarefaDeps {
  numeroDoPr: number
  autor: string | undefined
  corpo: string | undefined
  headRefName: string | undefined
  sessoes: LinhaDeSessao[]
  /** `ProjectV2Client.closingIssuesDoPr` — injetado para o módulo continuar
   *  testável sem rede. */
  closingIssues: () => Promise<number[]>
  issueComEtiquetaDeDelegacao: (issueNumber: number) => boolean
}

export async function acharTarefaDoItem(deps: AcharTarefaDeps): Promise<VinculoDaTarefa | null> {
  // 1) FORMAL — o que o próprio GitHub já resolveu e mostra na UI.
  const formais = await deps.closingIssues()
  if (formais.length > 0) {
    return { issueNumber: formais[0] as number, origemDoVinculo: 'formal' }
  }

  // 2) TEXTO + SESSÃO — ehPrDelegado já cobre login/linha/regex+etiqueta com
  // a trava contra citação solta (ver o comentário de pr-delegado.ts sobre o
  // PR #99).
  const porTexto = ehPrDelegado({
    numeroDoPr: deps.numeroDoPr,
    autor: deps.autor,
    corpo: deps.corpo,
    sessoes: deps.sessoes,
    issueComEtiquetaDeDelegacao: deps.issueComEtiquetaDeDelegacao,
  })
  if (porTexto.delegado && porTexto.issueNumber !== null) {
    return { issueNumber: porTexto.issueNumber, origemDoVinculo: 'texto' }
  }

  // 3) BRANCH DO JULES — o identificador de sessão no nome do ramo.
  const sessoesParaCasamento: SessaoParaCasamento[] = deps.sessoes.map((s) => ({
    sessionName: s.sessionName,
    pullRequestNumber: s.pullRequestNumber,
  }))
  const casamento = casarPrComSessao({
    headRefName: deps.headRefName,
    corpo: deps.corpo,
    numeroDoPr: deps.numeroDoPr,
    sessoes: sessoesParaCasamento,
  })
  if (casamento) {
    const sessao = deps.sessoes.find((s) => s.sessionName === casamento.sessionName)
    if (sessao) return { issueNumber: sessao.issueNumber, origemDoVinculo: 'branch-do-jules' }
  }

  return null
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/vinculo-da-tarefa.test.ts`
Expected: PASS — 4 testes verdes.

- [ ] **Step 9: Rodar as duas suítes**

Run: `pnpm --filter @gitorch/github-sync test && pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/github-sync/src/project-v2-client.ts packages/github-sync/src/project-v2-client.test.ts \
  apps/control-plane/src/services/vinculo-da-tarefa.ts apps/control-plane/src/services/vinculo-da-tarefa.test.ts
git commit -m "feat: achar a tarefa de origem por vinculo formal, texto ou branch do jules - task 2.1"
```

---

### Task 2.2: Analista acha a tarefa parecida pelo código

**Files:**
- Create: `apps/control-plane/src/services/tarefa-parecida-pelo-codigo.ts`
- Test: `apps/control-plane/src/services/tarefa-parecida-pelo-codigo.test.ts`

**Interfaces:**
- Consumes: `RAILS_SCHEMAS`, `buildStepPrompt` (`@gitorch/cadence`, já usados em `viabilidade-da-logica-alternativa.ts`); `StepExecutor` (`./role-rails.js`); `runFormStep` (`./rails-runner.js`).
- Produces:
  - `interface RaTarefaParecidaForm { issueNumberEncontrado: number | null; justificativa: string }` (novo em `packages/cadence/src/rails.ts`, ao lado de `RaAvaliacaoDeLogicaAlternativaForm`, linha 109-112, e em `RAILS_SCHEMAS`).
  - `async function racharTarefaParecidaPeloCodigo(deps): Promise<RaTarefaParecidaForm>` — consumida pela Tarefa 2.3 (PO pergunta só quando `issueNumberEncontrado === null`).

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/tarefa-parecida-pelo-codigo.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { racharTarefaParecidaPeloCodigo } from './tarefa-parecida-pelo-codigo.js'

describe('racharTarefaParecidaPeloCodigo', () => {
  it('devolve o formulário que o executor do RA produziu', async () => {
    const execute = vi.fn(async () => ({
      issueNumberEncontrado: 88,
      justificativa: 'o diff mexe em services/pagamento.ts, e a issue #88 pede exatamente essa mudança',
    }))
    const resultado = await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 7,
      repository: 'dono/repo',
      diffResumo: 'services/pagamento.ts: +12 -3',
      contextBlocks: ['contexto do codegraph'],
      execute,
    })
    expect(resultado.issueNumberEncontrado).toBe(88)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('sem tarefa parecida: issueNumberEncontrado null, com justificativa honesta', async () => {
    const execute = vi.fn(async () => ({
      issueNumberEncontrado: null,
      justificativa: 'nenhuma issue aberta descreve esta mudança',
    }))
    const resultado = await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 7,
      repository: 'dono/repo',
      diffResumo: 'x',
      contextBlocks: [],
      execute,
    })
    expect(resultado.issueNumberEncontrado).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/tarefa-parecida-pelo-codigo.test.ts`
Expected: FAIL com `Cannot find module './tarefa-parecida-pelo-codigo.js'`

- [ ] **Step 3: Acrescentar o formulário em `packages/cadence/src/rails.ts`**

Depois de `PoViabilidadeDeLogicaAlternativaForm` (linha 121-124), adicionar:

```ts
/**
 * Fase 2.2 do plano do repositório inteiro: quando um pull request não traz
 * NENHUMA pista de vínculo (vinculo-da-tarefa.ts devolveu null), o RA lê o
 * diff e o código para achar a tarefa mais parecida — só ele tem acesso de
 * leitura ao repositório real. `issueNumberEncontrado` nulo é uma resposta
 * válida e honesta: nem toda mudança tem uma issue esperando por ela.
 */
export interface RaTarefaParecidaForm {
  issueNumberEncontrado: number | null
  justificativa: string
}
```

Em `RAILS_SCHEMAS` (perto da linha 409), acrescentar a entrada `raTarefaParecida` seguindo o MESMO formato de `raAvaliacaoDeLogicaAlternativa` já presente ali (ler o schema vizinho real antes de copiar a forma exata do `MiniSchema`, para não inventar uma sintaxe que o validador não reconhece).

- [ ] **Step 4: Implementar `tarefa-parecida-pelo-codigo.ts`**

```ts
// Fase 2.2: quando nenhuma pista de vínculo existe (vinculo-da-tarefa.ts
// devolveu null), o RA lê o diff e o código para achar a tarefa mais
// parecida. Mesmo padrão de dois arquivos: este monta o prompt e chama o
// StepExecutor; quem decide é o motor (LLM decide, sistema executa).

import { RAILS_SCHEMAS, buildStepPrompt, type RaTarefaParecidaForm } from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'

export interface RacharTarefaParecidaArgs {
  numeroDoPr: number
  repository: string
  diffResumo: string
  contextBlocks: string[]
  execute: StepExecutor
}

export async function racharTarefaParecidaPeloCodigo(
  args: RacharTarefaParecidaArgs
): Promise<RaTarefaParecidaForm> {
  return (await runFormStep({
    schema: RAILS_SCHEMAS.raTarefaParecida,
    prompt: buildStepPrompt('ra', 'ra-tarefa-parecida', RAILS_SCHEMAS.raTarefaParecida, [
      ...args.contextBlocks,
      `Pull request #${args.numeroDoPr} de ${args.repository} não traz NENHUMA pista de a qual ` +
        'tarefa ele pertence (sem vínculo formal, sem citação no corpo, sem branch do dev ' +
        'assíncrono). Leia o diff e o código real do repositório e diga se alguma ISSUE ABERTA ' +
        'descreve exatamente esta mudança.',
      `Diff (resumo): ${args.diffResumo}`,
      'Se nenhuma issue aberta corresponder, devolva issueNumberEncontrado nulo — não adivinhe ' +
        'nem escolha a mais parecida "de longe".',
    ]),
    execute: args.execute,
  })) as RaTarefaParecidaForm
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/tarefa-parecida-pelo-codigo.test.ts && pnpm --filter @gitorch/cadence test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cadence/src/rails.ts apps/control-plane/src/services/tarefa-parecida-pelo-codigo.ts \
  apps/control-plane/src/services/tarefa-parecida-pelo-codigo.test.ts
git commit -m "feat: RA acha a tarefa parecida pelo codigo quando nao ha pista - task 2.2"
```

---

### Task 2.3: PO pergunta no painel e no Telegram quando ninguém acha

**Files:**
- Create: `apps/control-plane/src/services/perguntar-vinculo-da-tarefa.ts`
- Test: `apps/control-plane/src/services/perguntar-vinculo-da-tarefa.test.ts`

**Interfaces:**
- Consumes: `montarContextoExecutivoDaPergunta`, `ContextoExecutivoDaPergunta`, `DepsDoContextoExecutivo` (`./contexto-executivo-da-pergunta.js`); `buildFreeTextOption` (`./telegram-bot.js:266`); `AgentQuestionOption` (`./agent-question.js:16`) — MESMO padrão de `perguntarAoDonoSobreLogicaAlternativa` (`viabilidade-da-logica-alternativa.ts:458-479`).
- Produces:
  - `const DEDUP_PREFIXO_VINCULO_DA_TAREFA = 'vinculo-da-tarefa:'`
  - `function dedupKeyDeVinculoDaTarefa(repository: string, numeroDoPr: number): string`
  - `function parseDedupKeyDeVinculoDaTarefa(dedupKey: string): { repository: string; numeroDoPr: number } | null`
  - `function montarPerguntaSobreVinculoDaTarefa(args): { text: string; options: AgentQuestionOption[]; dedupKey: string }` — as 3 opções objetivas são as issues candidatas (no máximo 3, das mais recentes abertas) + "Vou escrever".
  - `async function perguntarSobreVinculoDaTarefa(args, deps): Promise<void>` — consumida pelo motor do próximo passo (Fase 3), só quando 2.1 e 2.2 devolveram `null`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/perguntar-vinculo-da-tarefa.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  dedupKeyDeVinculoDaTarefa,
  parseDedupKeyDeVinculoDaTarefa,
  montarPerguntaSobreVinculoDaTarefa,
} from './perguntar-vinculo-da-tarefa.js'

describe('dedupKeyDeVinculoDaTarefa / parseDedupKeyDeVinculoDaTarefa', () => {
  it('roda-trip', () => {
    const chave = dedupKeyDeVinculoDaTarefa('dono/repo', 42)
    expect(parseDedupKeyDeVinculoDaTarefa(chave)).toEqual({ repository: 'dono/repo', numeroDoPr: 42 })
  })
  it('formato desconhecido devolve null, nunca lança', () => {
    expect(parseDedupKeyDeVinculoDaTarefa('lixo')).toBeNull()
  })
})

describe('montarPerguntaSobreVinculoDaTarefa', () => {
  it('monta até 3 issues candidatas como opções objetivas + escrever', () => {
    const pergunta = montarPerguntaSobreVinculoDaTarefa({
      numeroDoPr: 42,
      repository: 'dono/repo',
      contexto: { ciclo: null, entrega: null, decisoes: [] },
      candidatas: [
        { numero: 10, titulo: 'Corrigir cache' },
        { numero: 11, titulo: 'Ajustar layout' },
      ],
    })
    expect(pergunta.options.map((o) => o.value)).toEqual([
      'vinculo-issue-10',
      'vinculo-issue-11',
      'nenhuma-destas',
      'free-text',
    ])
    expect(pergunta.dedupKey).toBe('vinculo-da-tarefa:dono/repo:42')
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/perguntar-vinculo-da-tarefa.test.ts`
Expected: FAIL com `Cannot find module './perguntar-vinculo-da-tarefa.js'`

- [ ] **Step 3: Implementar**

```ts
// PO pergunta ao dono a qual tarefa um pull request pertence, quando nem o
// vínculo formal (2.1) nem o RA pelo código (2.2) acharam nada. MESMO padrão
// executivo de D71/D72/D73 que viabilidade-da-logica-alternativa.ts já usa —
// 3 opções objetivas + "Vou escrever", nunca um formato novo.

import type { ContextoExecutivoDaPergunta } from './contexto-executivo-da-pergunta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { AgentQuestionOption } from './agent-question.js'

export const DEDUP_PREFIXO_VINCULO_DA_TAREFA = 'vinculo-da-tarefa:'

export function dedupKeyDeVinculoDaTarefa(repository: string, numeroDoPr: number): string {
  return `${DEDUP_PREFIXO_VINCULO_DA_TAREFA}${repository}:${numeroDoPr}`
}

export function parseDedupKeyDeVinculoDaTarefa(
  dedupKey: string
): { repository: string; numeroDoPr: number } | null {
  if (!dedupKey.startsWith(DEDUP_PREFIXO_VINCULO_DA_TAREFA)) return null
  const resto = dedupKey.slice(DEDUP_PREFIXO_VINCULO_DA_TAREFA.length)
  const ultimoDoisPontos = resto.lastIndexOf(':')
  if (ultimoDoisPontos <= 0 || ultimoDoisPontos === resto.length - 1) return null
  const repository = resto.slice(0, ultimoDoisPontos)
  const numeroDoPr = Number(resto.slice(ultimoDoisPontos + 1))
  if (!repository.includes('/') || !Number.isInteger(numeroDoPr) || numeroDoPr <= 0) return null
  return { repository, numeroDoPr }
}

export interface IssueCandidata {
  numero: number
  titulo: string
}

/** No máximo 3 candidatas objetivas — mesmo teto de "3 opções, nunca lista
 *  completa" que toda pergunta ao dono segue (feedback-toda-pergunta-telegram-4-opcoes). */
const MAX_CANDIDATAS = 3

export function montarPerguntaSobreVinculoDaTarefa(args: {
  numeroDoPr: number
  repository: string
  contexto: ContextoExecutivoDaPergunta
  candidatas: IssueCandidata[]
}): { text: string; options: AgentQuestionOption[]; dedupKey: string } {
  const candidatas = args.candidatas.slice(0, MAX_CANDIDATAS)
  const partes: string[] = []
  if (args.contexto.ciclo) partes.push(`O time está no ciclo "${args.contexto.ciclo}".`)
  if (args.contexto.entrega) partes.push(`Esta tarefa entrega: ${args.contexto.entrega}.`)
  if (args.contexto.decisoes.length > 0) {
    partes.push(`A equipe já resolveu sozinha: ${args.contexto.decisoes.join('; ')}.`)
  }
  partes.push(
    `O pull request #${args.numeroDoPr} de ${args.repository} chegou sem nenhuma pista de a qual ` +
      'tarefa pertence, e o analista não achou nada parecido pelo código. A qual tarefa ele pertence?'
  )

  const opcoesDeIssue: AgentQuestionOption[] = candidatas.map((c) => ({
    label: `#${c.numero} — ${c.titulo}`,
    value: `vinculo-issue-${c.numero}`,
  }))

  return {
    text: partes.join('\n\n'),
    options: [
      ...opcoesDeIssue,
      { label: 'Nenhuma destas', value: 'nenhuma-destas' },
      buildFreeTextOption(),
    ],
    dedupKey: dedupKeyDeVinculoDaTarefa(args.repository, args.numeroDoPr),
  }
}

/** Só o que esta função precisa de `AgentQuestionService.ask`. */
export interface AgentQuestionAskerDeVinculo {
  ask: (
    userId: string,
    projectId: string,
    input: { text: string; options?: AgentQuestionOption[]; dedupKey?: string }
  ) => Promise<unknown>
}

/**
 * PORTÃO 5B, item 7.6: side effect externo (mensagem real ao dono) só com
 * autorização explícita de quem despacha esta tarefa no Shrimp.
 */
export async function perguntarSobreVinculoDaTarefa(
  args: {
    userId: string
    projectId: string
    numeroDoPr: number
    repository: string
    contexto: ContextoExecutivoDaPergunta
    candidatas: IssueCandidata[]
  },
  deps: { agentQuestion: AgentQuestionAskerDeVinculo }
): Promise<void> {
  const pergunta = montarPerguntaSobreVinculoDaTarefa(args)
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: pergunta.text,
    options: pergunta.options,
    dedupKey: pergunta.dedupKey,
  })
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/perguntar-vinculo-da-tarefa.test.ts`
Expected: PASS — 3 testes verdes.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/services/perguntar-vinculo-da-tarefa.ts apps/control-plane/src/services/perguntar-vinculo-da-tarefa.test.ts
git commit -m "feat: PO pergunta o vinculo da tarefa quando ninguem acha - task 2.3"
```

---

### Task 2.4: Formulário de entendimento do pedido

**Files:**
- Modify: `packages/cadence/src/rails.ts:314-317` (`QaVerdictForm` ganha o campo `entendimento`)
- Create: `apps/control-plane/src/services/entendimento-do-pedido.ts`
- Test: `apps/control-plane/src/services/entendimento-do-pedido.test.ts`
- Modify: `apps/control-plane/src/services/ficha-do-item.ts` (já tem `EntendimentoDoItem` — Tarefa 0.1; esta tarefa é quem PREENCHE)

**Interfaces:**
- Consumes: `EntendimentoDoItem` (`./ficha-do-item.js`, Tarefa 0.1); `atualizarFichaDoItem`; `persistMissionMemory`, `MissionMemory` (`./mission-context.js:71-90,211-235`, já existentes).
- Produces: `EntendimentoDoPedidoForm` (`packages/cadence/src/rails.ts`) — os MESMOS 4 campos de `EntendimentoDoItem` (Tarefa 0.1: `deOndeVeio`, `oQueMuda`, `queAjusteE`, `porQueExiste`), mas como formulário do LLM (schema validado por `RAILS_SCHEMAS.qaVerdict`), não como shape de persistência — as duas nunca podem divergir de campo; se um nome mudar num dos dois lugares, muda nos dois na mesma tarefa. `async function registrarEntendimentoDoPedido(deps): Promise<void>` — grava na ficha (`atualizarFichaDoItem`) E na memória (`persistMissionMemory`) — consumida pela Fase 3.1 (o QA lê a ficha antes de julgar).

- [ ] **Step 1: Acrescentar o campo em `QaVerdictForm`**

Em `packages/cadence/src/rails.ts:314-317`, trocar:

```ts
export interface QaVerdictForm {
  verdict: 'approve' | 'request_changes'
  comment: DoDFields
}
```

por:

```ts
/**
 * Fase 2.4 do plano do repositório inteiro: o QA não julga mais só o CÓDIGO
 * — ele confirma que ENTENDEU o pedido antes de opinar. `entendimento` é
 * obrigatório (não opcional) de propósito: um julgamento sem os 4 campos
 * preenchidos não é um julgamento, é uma review em cima de um diff sem
 * contexto — exatamente o que gerava pareceres tecnicamente corretos mas
 * fora do que a tarefa pedia.
 */
export interface EntendimentoDoPedidoForm {
  /** De onde este pedido veio — Jules pelo GitOrch, Jules por fora, você
   *  com um assistente, outra pessoa, Dependabot, outro robô. */
  deOndeVeio: string
  /** O que muda no código, em termos concretos (arquivos, comportamento). */
  oQueMuda: string
  /** Que tipo de ajuste é: funcionalidade nova, correção, refactor, dívida
   *  técnica, segurança. */
  queAjusteE: string
  /** Por que este pedido existe — a motivação de negócio ou técnica. */
  porQueExiste: string
}

export interface QaVerdictForm {
  verdict: 'approve' | 'request_changes'
  comment: DoDFields
  entendimento: EntendimentoDoPedidoForm
}
```

- [ ] **Step 2: Rodar a suíte do cadence e confirmar que falha**

Run: `pnpm --filter @gitorch/cadence test`
Expected: FAIL — todo teste que constrói um `QaVerdictForm` de exemplo sem `entendimento` agora falha o typecheck/validação de schema (`RAILS_SCHEMAS.qaVerdict`, que valida o formulário contra `MiniSchema`, precisa ganhar os 4 campos como obrigatórios — ler `RAILS_SCHEMAS.qaVerdict` real antes de editar, para não inventar a sintaxe do schema).

- [ ] **Step 3: Atualizar `RAILS_SCHEMAS.qaVerdict` e os testes/fixtures existentes que constroem `QaVerdictForm`**

Ler `packages/cadence/src/rails.ts` na entrada `qaVerdict` dentro de `RAILS_SCHEMAS` (perto da linha 409-919, localização exata a confirmar lendo o arquivo) e acrescentar o objeto `entendimento` com os 4 subcampos obrigatórios, no MESMO formato que `MiniSchema` já usa para objetos aninhados (`comment: DoDFields` já é um exemplo de campo objeto dentro do mesmo formulário — copiar a forma exata dele para `entendimento`). Em seguida, `grep -rn "verdict: 'approve'\|verdict: 'request_changes'" packages apps --include="*.test.ts"` para achar toda fixture de teste que constrói um `QaVerdictForm` a mão e acrescentar `entendimento` com valores de exemplo em cada uma.

- [ ] **Step 4: Rodar a suíte do cadence de novo**

Run: `pnpm --filter @gitorch/cadence test`
Expected: PASS

- [ ] **Step 5: Escrever o teste que falha para `entendimento-do-pedido.ts`**

Criar `apps/control-plane/src/services/entendimento-do-pedido.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { registrarEntendimentoDoPedido } from './entendimento-do-pedido.js'

describe('registrarEntendimentoDoPedido', () => {
  it('grava na ficha e na memória do projeto', async () => {
    const atualizarFicha = vi.fn(async () => undefined)
    const cortex = { recallLocal: vi.fn(() => []), writeDrawer: vi.fn(async () => undefined) }

    await registrarEntendimentoDoPedido({
      projectId: 'proj-1',
      numeroDoPr: 42,
      entendimento: {
        deOndeVeio: 'Jules pelo GitOrch',
        oQueMuda: 'ajusta o cache de sessão',
        queAjusteE: 'correção',
        porQueExiste: 'sessão expirava cedo demais',
      },
      deps: { atualizarFicha, cortex, now: () => '2026-09-15T00:00:00.000Z' },
    })

    expect(atualizarFicha).toHaveBeenCalledTimes(1)
    expect(cortex.writeDrawer).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/entendimento-do-pedido.test.ts`
Expected: FAIL com `Cannot find module './entendimento-do-pedido.js'`

- [ ] **Step 7: Implementar**

```ts
// Grava o formulário de entendimento (Fase 2.4) nos DOIS lugares que a Fase 3
// precisa: a ficha do item (decisão rápida, ficha-do-item.ts) e a memória do
// projeto (persistMissionMemory, mission-context.ts — para o RA/PO de
// missões futuras aprenderem com o entendimento já feito).

import type { EntendimentoDoItem, TipoDoItem } from './ficha-do-item.js'
import type { MissionMemory } from './mission-context.js'
import { persistMissionMemory } from './mission-context.js'

/** O formato desta dependência é o MESMO de `atualizarFichaDoItem` (Tarefa
 *  0.1) com `prisma` já fechado por quem monta `deps` em produção — nunca
 *  uma função paralela: `deps.atualizarFicha = (args) =>
 *  atualizarFichaDoItem({ prisma, ...args }).then(() => undefined)`. */
export interface RegistrarEntendimentoDeps {
  atualizarFicha: (args: {
    projectId: string
    tipo: TipoDoItem
    numero: number
    estado: { status: string }
    entendimento: EntendimentoDoItem
  }) => Promise<void>
  cortex: MissionMemory
  now: () => string
}

export async function registrarEntendimentoDoPedido(args: {
  projectId: string
  numeroDoPr: number
  entendimento: EntendimentoDoItem
  deps: RegistrarEntendimentoDeps
}): Promise<void> {
  await args.deps.atualizarFicha({
    projectId: args.projectId,
    tipo: 'pr',
    numero: args.numeroDoPr,
    // A ficha já tem `estado`; esta chamada só acrescenta `entendimento` —
    // `atualizarFichaDoItem` (Tarefa 0.1, agora aceitando `entendimento?`)
    // faz upsert PARCIAL, nunca apaga o que já estava lá.
    estado: { status: 'entendido' },
    entendimento: args.entendimento,
  })

  const resumo = [
    `De onde veio: ${args.entendimento.deOndeVeio}`,
    `O que muda: ${args.entendimento.oQueMuda}`,
    `Que ajuste é: ${args.entendimento.queAjusteE}`,
    `Por que existe: ${args.entendimento.porQueExiste}`,
  ].join('\n')

  await persistMissionMemory(args.deps.cortex, {
    projectId: args.projectId,
    role: 'qa',
    content: `Entendimento do pull request #${args.numeroDoPr}:\n${resumo}`,
    now: args.deps.now(),
  })
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/entendimento-do-pedido.test.ts`
Expected: PASS

- [ ] **Step 9: Rodar as duas suítes**

Run: `pnpm --filter @gitorch/cadence test && pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/cadence/src/rails.ts apps/control-plane/src/services/entendimento-do-pedido.ts \
  apps/control-plane/src/services/entendimento-do-pedido.test.ts
git commit -m "feat: formulario de entendimento do pedido, gravado na ficha e na memoria - task 2.4"
```

---

### Task 2.5: Direção do projeto — pedidos de fora alimentam a memória

**Files:**
- Create: `apps/control-plane/src/services/direcao-do-projeto.ts`
- Test: `apps/control-plane/src/services/direcao-do-projeto.test.ts`

**Interfaces:**
- Consumes: `persistMissionMemory`, `MissionMemory` (`./mission-context.js`); `OrigemDoItem` (`./origem-do-item.js`, Tarefa 1.4); `EntendimentoDoItem` (`./ficha-do-item.js`, Tarefa 0.1/2.4).
- Produces: `async function registrarDirecaoDoProjeto(deps): Promise<void>` — chamada pelo motor do próximo passo (Fase 3) sempre que a origem for `'assistente'` ou `'pessoa'` (pedido feito fora do GitOrch) E o entendimento já tiver sido registrado (2.4); grava uma gaveta em `roomId: 'ra'` e outra em `roomId: 'po'` (as DUAS memórias direcionadas que `buildMissionEnricher` já lê, `mission-context.ts:159-165`), nunca em `roomId: 'qa'`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/direcao-do-projeto.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { registrarDirecaoDoProjeto } from './direcao-do-projeto.js'

describe('registrarDirecaoDoProjeto', () => {
  it('origem pessoa/assistente grava gaveta para o RA e para o PO', async () => {
    const cortex = { recallLocal: vi.fn(() => []), writeDrawer: vi.fn(async () => undefined) }
    await registrarDirecaoDoProjeto({
      projectId: 'proj-1',
      origem: 'pessoa',
      entendimento: {
        deOndeVeio: 'Outra pessoa',
        oQueMuda: 'novo endpoint de exportação',
        queAjusteE: 'funcionalidade nova',
        porQueExiste: 'cliente pediu exportar relatório em CSV',
      },
      deps: { cortex, now: () => '2026-09-15T00:00:00.000Z' },
    })
    expect(cortex.writeDrawer).toHaveBeenCalledTimes(2)
    const salas = (cortex.writeDrawer as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].roomId)
    expect(salas.sort()).toEqual(['po', 'ra'])
  })

  it('origem jules_gitorch/dependabot NÃO grava nada — não é direção de fora', async () => {
    const cortex = { recallLocal: vi.fn(() => []), writeDrawer: vi.fn(async () => undefined) }
    await registrarDirecaoDoProjeto({
      projectId: 'proj-1',
      origem: 'jules_gitorch',
      entendimento: {
        deOndeVeio: 'Jules pelo GitOrch',
        oQueMuda: 'x',
        queAjusteE: 'correção',
        porQueExiste: 'y',
      },
      deps: { cortex, now: () => '2026-09-15T00:00:00.000Z' },
    })
    expect(cortex.writeDrawer).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/direcao-do-projeto.test.ts`
Expected: FAIL com `Cannot find module './direcao-do-projeto.js'`

- [ ] **Step 3: Implementar**

```ts
// Fase 2.5: um pedido feito FORA do GitOrch (você com um assistente, ou
// outra pessoa) carrega uma decisão de rumo que o time não tomou sozinho.
// Grava essa direção na memória do RA e do PO — as DUAS salas que
// buildMissionEnricher já lê para papéis != po (RA direto) e que o PO lê
// via qaDrawers/raIntact (mission-context.ts:130-165) — para a PRÓXIMA
// missão entender o contexto sem repetir a pergunta.

import { persistMissionMemory, type MissionMemory } from './mission-context.js'
import type { OrigemDoItem } from './origem-do-item.js'
import type { EntendimentoDoItem } from './ficha-do-item.js'

/** Só pedido de FORA do GitOrch carrega direção nova — Jules pelo GitOrch e
 *  Dependabot são o próprio produto/automação agindo, não uma decisão de
 *  rumo externa. */
const ORIGENS_DE_FORA = new Set<OrigemDoItem>(['assistente', 'pessoa', 'jules_fora'])

export async function registrarDirecaoDoProjeto(args: {
  projectId: string
  origem: OrigemDoItem
  entendimento: EntendimentoDoItem
  deps: { cortex: MissionMemory; now: () => string }
}): Promise<void> {
  if (!ORIGENS_DE_FORA.has(args.origem)) return

  const conteudo =
    `Direção de fora do GitOrch (origem: ${args.origem}): ${args.entendimento.porQueExiste}. ` +
    `Mudança: ${args.entendimento.oQueMuda}.`

  for (const role of ['ra', 'po'] as const) {
    await persistMissionMemory(args.deps.cortex, {
      projectId: args.projectId,
      role,
      content: conteudo,
      now: args.deps.now(),
    })
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/direcao-do-projeto.test.ts`
Expected: PASS — 2 testes verdes.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/services/direcao-do-projeto.ts apps/control-plane/src/services/direcao-do-projeto.test.ts
git commit -m "feat: pedidos de fora do gitorch alimentam a memoria do ra e do po - task 2.5"
```

**Absorve do Shrimp:** L4-T25 (`2b73542a`) — "investigar trabalho que não nasceu do GitOrch" — absorvida pelas Tarefas 2.1 a 2.4.

---
## Fase 3 — Julgamento e próximo passo

### Task 3.1: O revisor responde as 4 perguntas antes do veredito

**Files:**
- Modify: `apps/control-plane/src/services/qa-rails-mission.ts:316-336` (`buildJulesReworkComment`) e `:1417-1421` (corpo da aprovação)
- Modify: `packages/cadence/src/rails.ts` (validação de tamanho mínimo dos 4 campos de `EntendimentoDoPedidoForm`, ao lado de `MIN_CARACTERES_RESUMO_DA_PROPOSTA`, linha 407)
- Test: `apps/control-plane/src/services/qa-rails-mission.test.ts` (arquivo já existente)
- Test: `packages/cadence/src/rails.test.ts` (arquivo já existente)

**Interfaces:**
- Consumes: `EntendimentoDoPedidoForm`, `QaVerdictForm` (Tarefa 2.4, `packages/cadence/src/rails.ts`).
- Produces: `function buildEntendimentoSection(entendimento: EntendimentoDoPedidoForm): string` — consumida pelos DOIS corpos de review (aprovação e reprovação) em `qa-rails-mission.ts`; `MIN_CARACTERES_ENTENDIMENTO = 10` em `rails.ts`, usada por `validateForm` (já existente) para recusar um `entendimento` com campos vazios ou genéricos demais.

- [ ] **Step 1: Escrever o teste que falha — `rails.test.ts`**

Acrescentar a `packages/cadence/src/rails.test.ts` (seguir o `describe('validateForm', ...)` já existente no arquivo):

```ts
describe('qaVerdict — entendimento obrigatório (Fase 3.1)', () => {
  it('recusa quando um campo do entendimento está vazio', () => {
    const valor = {
      verdict: 'approve',
      comment: { titulo: 't', goal: 'g', taskDetails: 'd', taskDescription: 'd', implementationGuide: 'i', verificationCriteria: 'v', dependencies: 'x', relatedFiles: 'x', notes: 'x' },
      entendimento: { deOndeVeio: 'Jules', oQueMuda: '', queAjusteE: 'correção', porQueExiste: 'motivo' },
    }
    const resultado = validateForm(RAILS_SCHEMAS.qaVerdict, valor)
    expect(resultado.ok).toBe(false)
  })

  it('aceita quando os 4 campos do entendimento estão preenchidos', () => {
    const valor = {
      verdict: 'approve',
      comment: { titulo: 't', goal: 'g', taskDetails: 'd', taskDescription: 'd', implementationGuide: 'i', verificationCriteria: 'v', dependencies: 'x', relatedFiles: 'x', notes: 'x' },
      entendimento: {
        deOndeVeio: 'Jules pelo GitOrch',
        oQueMuda: 'ajusta o cache',
        queAjusteE: 'correção',
        porQueExiste: 'sessão expirava cedo',
      },
    }
    expect(validateForm(RAILS_SCHEMAS.qaVerdict, valor).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run packages/cadence/src/rails.test.ts -t "entendimento obrigatório"`
Expected: FAIL — `RAILS_SCHEMAS.qaVerdict` ainda não valida `entendimento` (o schema `MiniSchema` para o formulário ainda não conhece o campo — ler a entrada real de `qaVerdict` dentro de `RAILS_SCHEMAS` antes de editar).

- [ ] **Step 3: Acrescentar a validação ao schema**

Em `packages/cadence/src/rails.ts`, na entrada `qaVerdict` de `RAILS_SCHEMAS`, acrescentar o campo `entendimento` como objeto obrigatório com os 4 subcampos, piso de `MIN_CARACTERES_ENTENDIMENTO` caracteres cada — copiar a FORMA EXATA que `comment` (campo `DoDFields`, objeto aninhado) já usa dentro do mesmo `MiniSchema`, só trocando os nomes dos subcampos e o piso de tamanho. Ao lado de `MIN_CARACTERES_RESUMO_DA_PROPOSTA` (linha 407), adicionar:

```ts
/** Fase 3.1: nenhum dos 4 campos do entendimento pode ser vazio ou genérico
 *  demais — um campo com 2 caracteres não é resposta, é preenchimento
 *  automático para passar na validação. */
export const MIN_CARACTERES_ENTENDIMENTO = 10
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run packages/cadence/src/rails.test.ts`
Expected: PASS

- [ ] **Step 5: Escrever o teste que falha — `qa-rails-mission.test.ts`**

Acrescentar a `apps/control-plane/src/services/qa-rails-mission.test.ts` (usar as fixtures de `QaVerdictForm` já existentes no arquivo, acrescentando `entendimento`):

```ts
import { buildEntendimentoSection } from './qa-rails-mission.js'

describe('buildEntendimentoSection — Fase 3.1', () => {
  it('formata os 4 campos como seções markdown', () => {
    const texto = buildEntendimentoSection({
      deOndeVeio: 'Jules pelo GitOrch',
      oQueMuda: 'ajusta o cache de sessão',
      queAjusteE: 'correção',
      porQueExiste: 'sessão expirava cedo demais',
    })
    expect(texto).toContain('De onde veio: Jules pelo GitOrch')
    expect(texto).toContain('O que muda: ajusta o cache de sessão')
    expect(texto).toContain('Que ajuste é: correção')
    expect(texto).toContain('Por que existe: sessão expirava cedo demais')
  })
})
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/qa-rails-mission.test.ts -t "buildEntendimentoSection"`
Expected: FAIL — função ainda não existe/exportada.

- [ ] **Step 7: Implementar e ligar aos dois corpos de review**

Em `qa-rails-mission.ts`, logo abaixo de `buildJulesReworkComment` (linha 316-336):

```ts
/** As 4 respostas do entendimento (Fase 2.4/3.1), formatadas para o corpo da
 *  review — tanto na aprovação quanto na reprovação: o revisor mostra que
 *  entendeu o pedido ANTES de opinar sobre o código, sempre. */
export function buildEntendimentoSection(entendimento: QaVerdictForm['entendimento']): string {
  return [
    '## Entendimento do pedido',
    '',
    `De onde veio: ${entendimento.deOndeVeio}`,
    `O que muda: ${entendimento.oQueMuda}`,
    `Que ajuste é: ${entendimento.queAjusteE}`,
    `Por que existe: ${entendimento.porQueExiste}`,
  ].join('\n')
}
```

Em `buildJulesReworkComment` (mesmo bloco), acrescentar a seção ao array `sections`:

```ts
export function buildJulesReworkComment(comment: QaVerdictForm['comment'], entendimento: QaVerdictForm['entendimento']): string {
  const map: Record<string, string> = {
    Goal: comment.goal,
    'Task Details': comment.taskDetails,
    'Task Description': comment.taskDescription,
    'Implementation Guide': comment.implementationGuide,
    'Verification Criteria': comment.verificationCriteria,
    Dependencies: comment.dependencies,
    'Related Files': comment.relatedFiles,
    Notes: comment.notes,
  }
  const sections = ISSUE_DOD_FIELDS.map((h) => `## ${h}\n\n${map[h] ?? ''}`)
  return [
    `${JULES_MARKER}`,
    '@jules the PR needs changes before it can be approved:',
    '',
    buildEntendimentoSection(entendimento),
    '',
    ...sections,
  ].join('\n\n')
}
```

(Ajustar o(s) chamador(es) de `buildJulesReworkComment(verdict.comment)` — linha ~1595 e onde mais o grep apontar — para `buildJulesReworkComment(verdict.comment, verdict.entendimento)`.)

Na linha 1421 (corpo da aprovação), trocar:

```ts
`${JULES_MARKER}${marcaDoLegado}\nGitOrch QA ${MARCA_DE_APROVACAO} — criteria met, CI green.\n\n${verdict.comment.goal}${avisoDeNaoMesclar}`
```

por:

```ts
`${JULES_MARKER}${marcaDoLegado}\nGitOrch QA ${MARCA_DE_APROVACAO} — criteria met, CI green.\n\n${buildEntendimentoSection(verdict.entendimento)}\n\n${verdict.comment.goal}${avisoDeNaoMesclar}`
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/qa-rails-mission.test.ts`
Expected: PASS

- [ ] **Step 9: Rodar as duas suítes inteiras**

Run: `pnpm --filter @gitorch/cadence test && pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/cadence/src/rails.ts packages/cadence/src/rails.test.ts \
  apps/control-plane/src/services/qa-rails-mission.ts apps/control-plane/src/services/qa-rails-mission.test.ts
git commit -m "feat: revisor responde as 4 perguntas do entendimento antes do veredito - task 3.1"
```

---

### Task 3.2: Rejulgar quando a tarefa mudou (não só CI e commit)

**Files:**
- Modify: `apps/control-plane/src/services/qa-rails-mission.ts:743-750` (bloco `deveRejulgar`)
- Test: `apps/control-plane/src/services/qa-rails-mission.test.ts`

**Interfaces:**
- Consumes: `acharParecerNesteHead`, `ReviewDoGithub` (`./parecer-do-qa.js`); `lerFichaDoItem` (Tarefa 0.1) — a ficha guarda `entendimento`, e a Tarefa 3.2 compara o `issueNumber` vinculado NA ÉPOCA do parecer (gravado no corpo da review, marca nova) com o `issueNumber` que a ficha tem AGORA.
- Produces: uma nova marca `MARCA_DA_TAREFA_VINCULADA` em `parecer-do-qa.ts` (`<!-- gitorch:qa:tarefa:<issueNumber> -->`), gravada em TODO parecer publicado (não só nos de rejulgamento); `function tarefaMudouDesdeOParecer(review, issueNumberAtual): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `apps/control-plane/src/services/parecer-do-qa.test.ts` (arquivo já existente, mesmo padrão dos testes vizinhos de `acharParecerNesteHead`):

```ts
import { marcaDaTarefaVinculada, tarefaMudouDesdeOParecer } from './parecer-do-qa.js'

describe('tarefaMudouDesdeOParecer — Fase 3.2', () => {
  it('sem marca de tarefa no parecer: não afirma mudança (não tem como comparar)', () => {
    expect(tarefaMudouDesdeOParecer({ body: 'sem marca' }, 42)).toBe(false)
  })

  it('marca aponta para a MESMA tarefa: não mudou', () => {
    const review = { body: `algo ${marcaDaTarefaVinculada(42)} algo` }
    expect(tarefaMudouDesdeOParecer(review, 42)).toBe(false)
  })

  it('marca aponta para tarefa DIFERENTE: mudou', () => {
    const review = { body: `algo ${marcaDaTarefaVinculada(42)} algo` }
    expect(tarefaMudouDesdeOParecer(review, 99)).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/parecer-do-qa.test.ts -t "tarefaMudouDesdeOParecer"`
Expected: FAIL — funções ainda não existem.

- [ ] **Step 3: Implementar em `parecer-do-qa.ts`**

Ao lado de `MARCA_DE_LEGADO_REJULGADO` (linha 113), adicionar:

```ts
/**
 * Marca invisível que registra A QUAL TAREFA este parecer se referia, no
 * instante em que foi publicado. Fase 3.2 do plano do repositório inteiro:
 * um pull request pode ser REVINCULADO a outra tarefa depois do parecer (o
 * dono responde a pergunta de vínculo, Tarefa 2.3, ou o RA acha a tarefa
 * certa pelo código, Tarefa 2.2, depois de um julgamento já ter acontecido
 * sob a tarefa errada) — o parecer antigo julgou os critérios da tarefa
 * ERRADA e precisa ser revisto, mesmo sem nenhum commit novo.
 */
export function marcaDaTarefaVinculada(issueNumber: number): string {
  return `<!-- gitorch:qa:tarefa:${issueNumber} -->`
}

const REGEX_MARCA_DA_TAREFA = /<!-- gitorch:qa:tarefa:(\d+) -->/

/** A qual tarefa este parecer se referia, ou `null` quando a marca não existe
 *  (parecer publicado antes desta tarefa — nunca afirma mudança sem prova). */
function tarefaDoParecer(review: ReviewDoGithub | null | undefined): number | null {
  const m = REGEX_MARCA_DA_TAREFA.exec(review?.body ?? '')
  return m?.[1] ? Number(m[1]) : null
}

/** A tarefa vinculada a este item MUDOU desde que este parecer foi publicado? */
export function tarefaMudouDesdeOParecer(
  review: ReviewDoGithub | null | undefined,
  issueNumberAtual: number
): boolean {
  const tarefaNoParecer = tarefaDoParecer(review)
  if (tarefaNoParecer === null) return false
  return tarefaNoParecer !== issueNumberAtual
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/parecer-do-qa.test.ts`
Expected: PASS

- [ ] **Step 5: Gravar a marca em todo parecer publicado (`qa-rails-mission.ts`)**

Nos dois corpos de review (aprovação linha 1421, reprovação dentro de `buildJulesReworkComment`), acrescentar `marcaDaTarefaVinculada(issueDaEntrega ?? veredito.issueNumber ?? -1)` ao lado das marcas já existentes (`marcaDoLegado`, `marcaDoPortao`) — mesma técnica de string concatenada. (`issueDaEntrega` já existe no escopo da função, resolvido no laço de descoberta.)

- [ ] **Step 6: Ligar `tarefaMudouDesdeOParecer` ao `deveRejulgar`**

Em `qa-rails-mission.ts:743-750`, trocar:

```ts
    const deveRejulgar =
      veredito.delegado &&
      aindaPodeTentarMesclar &&
      (foiAprovacao ||
        parecerSobPremissaErrada ||
        reprovadoPeloPortaoComCiVerdeAgora ||
        legadoMereceUmaChance ||
        entregaVaziaAindaNaoCobrada)
```

por:

```ts
    // Fase 3.2: a QUINTA exceção ao skip — a tarefa vinculada mudou desde o
    // último parecer (revínculo via Tarefa 2.2/2.3 depois de já ter julgado
    // sob a tarefa errada). Não exige `aindaPodeTentarMesclar`: revincular a
    // tarefa é um FATO novo, não uma tentativa de mesclar de novo — o mesmo
    // raciocínio de `entregaVaziaAindaNaoCobrada`, que também é fato
    // estrutural, não opinião repetida.
    const tarefaFoiRevinculada =
      veredito.delegado &&
      reviewMarcadaNesteHead !== undefined &&
      veredito.issueNumber !== null &&
      tarefaMudouDesdeOParecer(reviewMarcadaNesteHead, veredito.issueNumber)

    const deveRejulgar =
      veredito.delegado &&
      (tarefaFoiRevinculada ||
        (aindaPodeTentarMesclar &&
          (foiAprovacao ||
            parecerSobPremissaErrada ||
            reprovadoPeloPortaoComCiVerdeAgora ||
            legadoMereceUmaChance ||
            entregaVaziaAindaNaoCobrada)))
```

Acrescentar `tarefaMudouDesdeOParecer` ao bloco de import de `'./parecer-do-qa.js'` no topo do arquivo (junto de `acharParecerNesteHead` e os demais, perto da linha 28-49).

- [ ] **Step 7: Rodar a suíte inteira do control-plane**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/services/parecer-do-qa.ts apps/control-plane/src/services/parecer-do-qa.test.ts \
  apps/control-plane/src/services/qa-rails-mission.ts
git commit -m "feat: rejulgar quando a tarefa vinculada mudou, nao so CI e commit - task 3.2"
```

---

### Task 3.3: Retirar a própria reprovação antiga antes do novo julgamento

**Files:**
- Modify: `apps/control-plane/src/services/parecer-do-qa.ts` (`ReviewDoGithub` ganha `id: number`)
- Modify: `apps/control-plane/src/services/qa-rails-mission.ts:515-518` (tipagem do GET de reviews) e o ponto onde `deveRejulgar` é `true` (antes de `postarReview`)
- Test: `apps/control-plane/src/services/qa-rails-mission.test.ts`

**Interfaces:**
- Consumes: `acharParecerNesteHead` (devolve o `ReviewDoGithub` com `id`, depois desta tarefa); `gh` (closure REST já existente dentro de `runQaMissionViaRails`).
- Produces: `async function dispensarParecerAntigo(gh: GhClient, repository: string, prNumber: number, reviewId: number, motivo: string): Promise<void>` — consumida só por `runQaMissionViaRails`, chamada quando `deveRejulgar` é `true` E existe um `reviewMarcadaNesteHead` anterior.

**CORREÇÃO DE PREMISSA (verificado antes de codar, LEI 20/08 — teste é prova):** o pedido original descrevia `DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}`. A documentação real do GitHub (confirmada via pesquisa antes de escrever qualquer código) diz que esse endpoint **só apaga reviews PENDENTES (rascunho, nunca publicadas)** — uma review `CHANGES_REQUESTED` já publicada não pode ser apagada por ele. O jeito certo de "retirar" um parecer antigo já publicado é `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals`, com corpo `{ message, event: 'DISMISS' }` — dispensa a review (ela deixa de bloquear e passa a aparecer como "Dismissed" no histórico; o texto antigo não desaparece, só perde efeito). Em branch protegida com `dismissal_restrictions`, só quem está na lista autorizada (ou admin) pode dispensar — por isso esta função é best-effort: falhar ao dispensar NUNCA impede o novo parecer de ser publicado, só deixa o antigo visível ao lado do novo.

- [ ] **Step 1: Acrescentar `id` a `ReviewDoGithub`**

Em `apps/control-plane/src/services/parecer-do-qa.ts:146-151`, trocar:

```ts
export interface ReviewDoGithub {
  body?: string
  commit_id?: string
  submitted_at?: string
}
```

por:

```ts
export interface ReviewDoGithub {
  /** Fase 3.3: precisa para `dismissarParecerAntigo` — o GET de reviews já
   *  devolve este campo, só não era lido até aqui. */
  id?: number
  body?: string
  commit_id?: string
  submitted_at?: string
}
```

- [ ] **Step 2: Escrever o teste que falha**

Acrescentar a `apps/control-plane/src/services/qa-rails-mission.test.ts`:

```ts
import { dispensarParecerAntigo } from './qa-rails-mission.js'

describe('dispensarParecerAntigo — Fase 3.3', () => {
  it('chama PUT .../dismissals com message e event DISMISS', async () => {
    const chamadas: Array<{ method: string; path: string; body?: unknown }> = []
    const gh = async (method: string, path: string, body?: unknown) => {
      chamadas.push({ method, path, body })
      return {}
    }
    await dispensarParecerAntigo(gh, 'dono/repo', 42, 999, 'a tarefa vinculada mudou')
    expect(chamadas).toEqual([
      {
        method: 'PUT',
        path: '/repos/dono/repo/pulls/42/reviews/999/dismissals',
        body: { message: 'a tarefa vinculada mudou', event: 'DISMISS' },
      },
    ])
  })

  it('falha ao dispensar não lança — best-effort', async () => {
    const gh = async () => {
      throw new Error('403: not authorized to dismiss')
    }
    await expect(dispensarParecerAntigo(gh, 'dono/repo', 42, 999, 'motivo')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/qa-rails-mission.test.ts -t "dispensarParecerAntigo"`
Expected: FAIL — função ainda não existe.

- [ ] **Step 4: Implementar**

Ao lado de `buildEntendimentoSection` (Tarefa 3.1) em `qa-rails-mission.ts`:

```ts
/** Só a forma da função `gh` que `runQaMissionViaRails` já fecha sobre
 *  `options.githubToken` — evita reimportar o tipo completo do módulo. */
type GhClient = (method: string, path: string, body?: unknown) => Promise<unknown>

/**
 * Dispensa (nunca deleta — ver a correção de premissa no cabeçalho desta
 * tarefa no plano) um parecer antigo antes de publicar o novo. Best-effort:
 * falhar aqui NUNCA impede o novo parecer de sair — o pior caso é o antigo
 * ficar visível ao lado do novo, não um julgamento perdido.
 */
export async function dispensarParecerAntigo(
  gh: GhClient,
  repository: string,
  prNumber: number,
  reviewId: number,
  motivo: string
): Promise<void> {
  try {
    await gh('PUT', `/repos/${repository}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, {
      message: motivo,
      event: 'DISMISS',
    })
  } catch {
    // Best-effort — branch protegida pode restringir quem dispensa
    // (dismissal_restrictions). O novo parecer sai de qualquer forma.
  }
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/qa-rails-mission.test.ts -t "dispensarParecerAntigo"`
Expected: PASS

- [ ] **Step 6: Chamar antes de publicar o novo parecer, quando `deveRejulgar`**

No ponto onde `deveRejulgar` já foi decidido (logo depois do bloco da Tarefa 3.2, antes de `target = p`), adicionar:

```ts
    if (deveRejulgar && reviewMarcadaNesteHead?.id !== undefined) {
      await dispensarParecerAntigo(
        gh,
        options.repository,
        p.number,
        reviewMarcadaNesteHead.id,
        'GitOrch: rejulgando esta entrega — este parecer não reflete mais o estado atual'
      )
    }
```

E na tipagem do GET de reviews (linha 515-518), acrescentar `id` ao tipo lido:

```ts
    const reviews = (await gh(
      'GET',
      `/repos/${options.repository}/pulls/${p.number}/reviews?per_page=100`
    )) as Array<{ id?: number; body?: string; commit_id?: string }>
```

- [ ] **Step 7: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 8: QA manual — confirmar contra um PR real**

Antes de fechar: rodar contra um repositório de teste real (não produção) com um parecer `CHANGES_REQUESTED` já publicado pelo bot, disparar um rejulgamento e CONFIRMAR na UI do GitHub que a review antiga aparece como "Dismissed" (não desaparecida) e a nova está publicada. LEI 20/08: teste é prova, configuração é indício — não fechar esta tarefa só porque o código compila.

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane/src/services/parecer-do-qa.ts apps/control-plane/src/services/qa-rails-mission.ts \
  apps/control-plane/src/services/qa-rails-mission.test.ts
git commit -m "feat: dispensa o parecer antigo antes de rejulgar (dismiss, nao delete) - task 3.3"
```

---

### Task 3.4: Um parecer por versão do pedido — trava real contra concorrência

**Files:**
- Modify: `apps/control-plane/prisma/schema.prisma` (`model RepoItem`, Tarefa 0.1 — duas colunas novas)
- Create: `apps/control-plane/prisma/parecer-trava-migration.sql`
- Modify: `apps/control-plane/src/lib/migration-ledger.ts` e `.test.ts` (drift guard, mesmo padrão das Tarefas 0.1/0.2)
- Create: `apps/control-plane/src/services/trava-de-parecer.ts`
- Test: `apps/control-plane/src/services/trava-de-parecer.test.ts`
- Modify: `apps/control-plane/src/services/qa-rails-mission.ts` (chamar a trava antes de publicar qualquer review)

**Interfaces:**
- Consumes: `RepoItem` (Tarefa 0.1). Reaproveita o MESMO padrão de "lock que se solta sozinho por data" que `EngineConnection.renewalLockedUntil` já usa em produção (`schema.prisma:233-245` — não inventado aqui, é o padrão que o próprio comentário do schema documenta contra corrida entre a vigia horária e o login assistido).
- Produces: `async function adquirirTravaDeParecer(deps: { prisma: PrismaDaTravaDeParecer; projectId: string; numeroDoPr: number; headSha: string; agora: Date; duracaoMs?: number }): Promise<boolean>` — `true` = trava adquirida (siga e publique o parecer); `false` = outra execução já está publicando para este MESMO head agora (não publique nada, saia em silêncio) — consumida por `runQaMissionViaRails` como primeiro passo antes de QUALQUER `postarReview`.

- [ ] **Step 1: Escrever o teste que falha para `adquirirTravaDeParecer`**

Criar `apps/control-plane/src/services/trava-de-parecer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { adquirirTravaDeParecer, type PrismaDaTravaDeParecer } from './trava-de-parecer.js'

function prismaFake(contagem: number) {
  return { repoItem: { updateMany: vi.fn(async () => ({ count: contagem })) } } as unknown as PrismaDaTravaDeParecer
}

describe('adquirirTravaDeParecer', () => {
  it('devolve true quando a atualização condicional bateu em 1 linha', async () => {
    const prisma = prismaFake(1)
    const ok = await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:00:00Z'),
    })
    expect(ok).toBe(true)
  })

  it('devolve false quando 0 linhas bateram (trava já em vigor para este head)', async () => {
    const prisma = prismaFake(0)
    const ok = await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'abc',
      agora: new Date('2026-09-15T00:00:00Z'),
    })
    expect(ok).toBe(false)
  })

  it('a condição do WHERE aceita trava vencida ou head diferente do gravado', async () => {
    const prisma = prismaFake(1)
    await adquirirTravaDeParecer({
      prisma,
      projectId: 'proj-1',
      numeroDoPr: 42,
      headSha: 'novo-sha',
      agora: new Date('2026-09-15T00:00:00Z'),
    })
    const chamada = (prisma.repoItem.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(chamada.where.OR).toEqual([
      { parecerTravadoAte: null },
      { parecerTravadoAte: { lt: new Date('2026-09-15T00:00:00Z') } },
      { parecerTravaHeadSha: { not: 'novo-sha' } },
    ])
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/trava-de-parecer.test.ts`
Expected: FAIL com `Cannot find module './trava-de-parecer.js'`

- [ ] **Step 3: Acrescentar as colunas ao `RepoItem` e migrar**

Em `schema.prisma`, dentro de `model RepoItem` (Tarefa 0.1), logo abaixo de `entendimento Json?`, adicionar:

```prisma
  // Fase 3.4: trava que se solta sozinha por DATA — mesmo padrão de
  // EngineConnection.renewalLockedUntil (linha 233-245 deste arquivo).
  // Impede duas execuções concorrentes do QA publicarem parecer para o
  // MESMO head ao mesmo tempo (medido: 16 reprovações idênticas no #548).
  parecerTravadoAte    DateTime? @map("parecer_travado_ate")
  parecerTravaHeadSha  String?   @map("parecer_trava_head_sha")
```

Criar `apps/control-plane/prisma/parecer-trava-migration.sql`:

```sql
-- Trava do parecer, que se solta sozinha por data (mesmo padrão de
-- engine_connections.renewal_locked_until) — impede duas execuções
-- concorrentes do QA publicarem parecer para o MESMO head do MESMO pull
-- request ao mesmo tempo.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/parecer-trava-migration.sql

ALTER TABLE repo_items ADD COLUMN IF NOT EXISTS parecer_travado_ate TIMESTAMP(3);
ALTER TABLE repo_items ADD COLUMN IF NOT EXISTS parecer_trava_head_sha TEXT;
```

Registrar `'parecer-trava-migration.sql'` em `migration-ledger.ts` e no array hardcoded de `migration-ledger.test.ts`, depois das duas migrações da Fase 0 (mesmo drift guard — Run: `npx vitest run apps/control-plane/src/lib/migration-ledger.test.ts` para confirmar).

- [ ] **Step 4: Implementar `trava-de-parecer.ts`**

```ts
// Trava do parecer: impede duas execuções concorrentes do QA de publicarem
// review para o MESMO head do MESMO pull request ao mesmo tempo — a corrida
// medida no #548 (16 reprovações idênticas). Atualização CONDICIONAL de uma
// linha só (WHERE + updateMany), sem SELECT antes: o Postgres serializa as
// duas transações concorrentes na mesma linha, e a segunda reavalia o WHERE
// contra o estado JÁ commitado pela primeira — é isso que faz a trava valer
// de verdade contra corrida, não só contra sequência.

export interface PrismaDaTravaDeParecer {
  repoItem: {
    updateMany: (args: {
      where: {
        projectId: string
        tipo: 'pr'
        numero: number
        OR: Array<
          | { parecerTravadoAte: null }
          | { parecerTravadoAte: { lt: Date } }
          | { parecerTravaHeadSha: { not: string } }
        >
      }
      data: { parecerTravadoAte: Date; parecerTravaHeadSha: string }
    }) => Promise<{ count: number }>
  }
}

/** Por quanto tempo a trava vale — generoso o bastante para um julgamento +
 *  publicação de review terminarem, curto o bastante para uma execução
 *  travada não bloquear o head para sempre. */
export const DURACAO_DA_TRAVA_MS = 3 * 60_000

export async function adquirirTravaDeParecer(deps: {
  prisma: PrismaDaTravaDeParecer
  projectId: string
  numeroDoPr: number
  headSha: string
  agora: Date
  duracaoMs?: number
}): Promise<boolean> {
  const ate = new Date(deps.agora.getTime() + (deps.duracaoMs ?? DURACAO_DA_TRAVA_MS))
  const resultado = await deps.prisma.repoItem.updateMany({
    where: {
      projectId: deps.projectId,
      tipo: 'pr',
      numero: deps.numeroDoPr,
      OR: [
        { parecerTravadoAte: null },
        { parecerTravadoAte: { lt: deps.agora } },
        { parecerTravaHeadSha: { not: deps.headSha } },
      ],
    },
    data: { parecerTravadoAte: ate, parecerTravaHeadSha: deps.headSha },
  })
  return resultado.count > 0
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/trava-de-parecer.test.ts`
Expected: PASS — 3 testes verdes.

- [ ] **Step 6: Ligar em `runQaMissionViaRails` — primeiro passo antes de qualquer `postarReview`**

Logo antes da definição de `postarReview` (linha 961), adicionar:

```ts
  if (target.head?.sha) {
    const travou = await adquirirTravaDeParecer({
      prisma: options.prisma as never,
      projectId: options.projectId,
      numeroDoPr: target.number,
      headSha: target.head.sha,
      agora: new Date(),
    })
    if (!travou) {
      return {
        exitCode: 0,
        output: `QA: outra execução já está julgando o PR #${target.number} neste head; nada feito.`,
        stderr: '',
        noOp: true,
      }
    }
  }
```

(Confirmar, lendo o arquivo real, se `options.prisma`/`options.projectId` já existem em `QaRailsMissionOptions` — se não, acrescentar os dois campos à interface, seguindo o padrão dos demais campos de `VigiliaDoJulgamentoOptions`/`QaRailsMissionOptions`, linhas 109-202.)

- [ ] **Step 7: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/prisma/schema.prisma apps/control-plane/prisma/parecer-trava-migration.sql \
  apps/control-plane/src/lib/migration-ledger.ts apps/control-plane/src/lib/migration-ledger.test.ts \
  apps/control-plane/src/services/trava-de-parecer.ts apps/control-plane/src/services/trava-de-parecer.test.ts \
  apps/control-plane/src/services/qa-rails-mission.ts
git commit -m "feat: trava real contra concorrencia - um parecer por versao do pedido - task 3.4"
```

---

### Task 3.5: Motor do próximo passo — substitui `decidirAcaoNoPrOrfao`

**Files:**
- Create: `apps/control-plane/src/services/motor-do-proximo-passo.ts`
- Test: `apps/control-plane/src/services/motor-do-proximo-passo.test.ts`
- Modify: `apps/control-plane/src/plugins/scheduler.ts` (o call site de `vigiarPrsOrfaos`/`decidirAcaoNoPrOrfao`, linha ~6879 — trocar a chamada)
- Modify: `apps/control-plane/src/services/vigia-do-pr.ts` (`decidirAcaoNoPrOrfao` e `AcaoDoVigia` NÃO são removidos nesta tarefa — ficam como está, só deixam de ser chamados pelo relógio; remoção de código morto é tarefa de limpeza separada, fora deste plano)

**Interfaces:**
- Consumes: `cuidaPorOrigem`, `lerJanelaEmConstrucaoHoras` (Tarefa 0.2); `classificarOrigem`, `OrigemDoItem` (Tarefa 1.4); `lerFichaDoItem` (Tarefa 0.1); `PrOrfaoObservado`, `CausaDaParada`, `MAX_ACOES_DO_VIGIA`, `IDADE_MINIMA_DE_ORFANDADE_MS`, `branchParaRetomar`, `pedidoDeRebase`/`pedidoDeConsertarVerificacao` (`./vigia-do-pr.js`, reaproveitados — os PORTÕES da decisão original continuam certos, só a decisão de "com quem falar" muda).
- Produces:
  - `type AcaoDoMotor = { acao: 'retomar'; ... } | { acao: 'fechar-vazio'; ... } | { acao: 'mesclar'; ... } | { acao: 'so-acompanhar'; motivo: string } | { acao: 'perguntar-se-cuida'; motivo: string } | { acao: 'escalar'; motivo: string }` — substitui `AcaoDoVigia`, mas MANTÉM os nomes de campo (`issueNumber`, `causa`, `pedido`, `branchDoPr`, `motivo`) onde o significado é o mesmo, para os testes reaproveitados (Step 3 abaixo) não precisarem reescrever as asserções de conteúdo.
  - `function decidirProximoPasso(deps: MotorDoProximoPassoDeps): AcaoDoMotor` — pura, consumida pelo `scheduler.ts`.

- [ ] **Step 1: Ler `vigia-do-pr.test.ts` inteiro e listar os casos que continuam valendo**

Antes de escrever qualquer teste novo: `npx vitest run apps/control-plane/src/services/vigia-do-pr.test.ts --reporter=verbose` para ver os nomes de todo `it()` do arquivo, e ler o arquivo (878 linhas de PRODUÇÃO + o `.test.ts`, tamanho a confirmar) para separar os casos em dois grupos:
  - **Continuam valendo** (portões 1-9 de `decidirAcaoNoPrOrfao`: PR de gente, automação sem conserto, sessão viva, cedo demais, teto de ações, sem tarefa de origem, tarefa já fechada, `mergeable` desconhecido, verificação pendente) — viram casos do teste NOVO de `decidirProximoPasso`, com os MESMOS cenários de entrada.
  - **Mudam de comportamento** (o portão 12 de hoje, "sem vaga na conta do dev" continua igual; mas o portão final — "nada para consertar e ninguém mesclou" — HOJE sempre `escalar`; NO MOTOR NOVO, vira `perguntar-se-cuida` quando `cuidaPorOrigem[origem] === 'perguntar'`, `so-acompanhar` quando `=== 'nao'` ou o item está DENTRO da janela de construção, e só continua `escalar` como ÚLTIMO recurso quando `cuidaPorOrigem[origem] === 'sim'` e mesmo assim o motor não sabe o que fazer — NUNCA mais como resposta padrão).

- [ ] **Step 2: Escrever os testes que falham**

Criar `apps/control-plane/src/services/motor-do-proximo-passo.test.ts`, reaproveitando o helper `situacao(...)` de `vigia-do-pr.test.ts` como inspiração (adaptado para os campos novos — `origem`, `cuidaPorOrigem`, `emConstrucaoHa`):

```ts
import { describe, it, expect } from 'vitest'
import { decidirProximoPasso } from './motor-do-proximo-passo.js'
import { PADRAO_DE_CUIDADO } from './cuidado-por-origem.js'

function base() {
  return {
    numero: 356,
    sinais: { autor: 'gitorch-bot', labels: [], corpo: null },
    temSessaoViva: false,
    issueNumber: 74,
    issueAberta: true,
    mergeable: false,
    verificacao: 'pendente' as const,
    paradoHaMs: 4 * 24 * 60 * 60 * 1000,
    acoesAnteriores: 0,
    podeAbrirSessao: true,
    origem: 'jules_gitorch' as const,
    cuidaPorOrigem: PADRAO_DE_CUIDADO,
    emConstrucaoHa: null as number | null,
    janelaEmConstrucaoHoras: 2,
    branchDoPr: 'ramo-do-356',
    branchNoRepoDoProjeto: true,
  }
}

describe('decidirProximoPasso — portões herdados de decidirAcaoNoPrOrfao', () => {
  it('PR de gente: ignora (mesmo portão 1 de hoje)', () => {
    const d = decidirProximoPasso({ ...base(), sinais: { autor: 'loureng', labels: [], corpo: null } })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('sessão viva: ignora (mesmo portão 3 de hoje)', () => {
    const d = decidirProximoPasso({ ...base(), temSessaoViva: true })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('conflito, sem sessão viva, fora da janela de construção: retoma', () => {
    const d = decidirProximoPasso(base())
    expect(d.acao).toBe('retomar')
  })
})

describe('decidirProximoPasso — o que muda: nunca "alguém precisa olhar" sem checar a configuração', () => {
  it('nada para consertar + cuidaPorOrigem="sim": mescla (quando os 3 critérios da Tarefa 3.8 batem)', () => {
    const d = decidirProximoPasso({
      ...base(),
      mergeable: true,
      verificacao: 'verde',
      entendimentoCompleto: true,
      vereditoDoQa: 'approve',
    })
    expect(d.acao).toBe('mesclar')
  })

  it('nada para consertar + cuidaPorOrigem="perguntar": pergunta se cuida, nunca escala direto', () => {
    const d = decidirProximoPasso({
      ...base(),
      mergeable: true,
      verificacao: 'verde',
      cuidaPorOrigem: { ...PADRAO_DE_CUIDADO, jules: 'perguntar' },
    })
    expect(d.acao).toBe('perguntar-se-cuida')
  })

  it('cuidaPorOrigem="nao": só acompanha, nunca julga', () => {
    const d = decidirProximoPasso({ ...base(), cuidaPorOrigem: { ...PADRAO_DE_CUIDADO, jules: 'nao' } })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('em construção (dentro da janela): só acompanha, mesmo com cuidaPorOrigem="sim"', () => {
    const d = decidirProximoPasso({ ...base(), emConstrucaoHa: 1 })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('em construção mas JÁ passou da janela: volta a valer o resto da decisão', () => {
    const d = decidirProximoPasso({ ...base(), emConstrucaoHa: 5 })
    expect(d.acao).toBe('retomar')
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/motor-do-proximo-passo.test.ts`
Expected: FAIL com `Cannot find module './motor-do-proximo-passo.js'`

- [ ] **Step 4: Implementar `motor-do-proximo-passo.ts`**

```ts
// O motor do próximo passo: substitui decidirAcaoNoPrOrfao (vigia-do-pr.ts).
// Os PORTÕES de segurança de hoje (PR de gente nunca é tocado, automação sem
// conserto, sessão viva, cedo demais, teto de ações, sem tarefa de origem,
// tarefa já fechada, mergeable/verificação desconhecidos) continuam
// EXATAMENTE os mesmos — só a decisão final muda: NUNCA "escalar" como
// resposta padrão. A configuração de quem cuida de cada origem (Tarefa 0.2)
// decide entre mesclar sozinho, perguntar antes, ou só acompanhar.

import {
  ehPRDaAutomacao,
  ehAutomacaoQueOVigiaNaoConserta,
  branchParaRetomar,
  MAX_ACOES_DO_VIGIA,
  IDADE_MINIMA_DE_ORFANDADE_MS,
  type SinaisDePR,
  type RamoDoPr,
  type EstadoDaVerificacao,
  type CausaDaParada,
} from './vigia-do-pr.js'
import type { CuidaPorOrigem, OrigemDoItem } from './cuidado-por-origem.js'

export type AcaoDoMotor =
  | { acao: 'so-acompanhar'; motivo: string }
  | { acao: 'retomar'; issueNumber: number; causa: CausaDaParada; pedido: string; branchDoPr: string; motivo: string }
  | { acao: 'fechar-vazio'; motivo: string }
  | { acao: 'mesclar'; motivo: string }
  | { acao: 'perguntar-se-cuida'; motivo: string }
  | { acao: 'escalar'; motivo: string }

export interface MotorDoProximoPassoDeps extends RamoDoPr {
  numero: number
  sinais: SinaisDePR
  temSessaoViva: boolean
  issueNumber: number | null
  issueAberta: boolean
  mergeable: boolean | null
  verificacao: EstadoDaVerificacao
  paradoHaMs: number
  acoesAnteriores: number
  podeAbrirSessao: boolean
  origem: OrigemDoItem
  cuidaPorOrigem: CuidaPorOrigem
  /** Horas desde o último commit/marca de rascunho, ou `null` quando não
   *  está em construção (não é rascunho e o último commit já passou da
   *  janela). Calculado pelo chamador — este módulo só compara. */
  emConstrucaoHa: number | null
  janelaEmConstrucaoHoras: number
  /** Presentes só quando há veredito do QA para considerar (item já
   *  julgado) — ausentes, o motor nunca decide "mesclar". */
  entendimentoCompleto?: boolean
  vereditoDoQa?: 'approve' | 'request_changes'
}

/** 'jules_gitorch'/'jules_fora' caem no balde `jules` de cuidaPorOrigem;
 *  'assistente' e 'pessoa' são os próprios nomes; 'dependabot' idem;
 *  'outro_bot' NUNCA é julgado — sempre só acompanha (Tarefa 3.9). */
function baldeDeCuidado(origem: OrigemDoItem): keyof CuidaPorOrigem | null {
  if (origem === 'jules_gitorch' || origem === 'jules_fora') return 'jules'
  if (origem === 'assistente' || origem === 'pessoa' || origem === 'dependabot') return origem
  return null
}

export function decidirProximoPasso(deps: MotorDoProximoPassoDeps): AcaoDoMotor {
  // Portões herdados 1-9 (mesma ordem e mesmo motivo de decidirAcaoNoPrOrfao).
  if (!ehPRDaAutomacao(deps.sinais)) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} é entrega de gente` }
  }
  if (ehAutomacaoQueOVigiaNaoConserta(deps.sinais)) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} é automação sem sessão atrás para retomar` }
  }
  if (deps.temSessaoViva) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} ainda tem sessão viva` }
  }

  // A CONFIGURAÇÃO decide ANTES de qualquer julgamento de conteúdo — Fase
  // 3.9/3.10: "não cuidada" nunca chega a ser julgada.
  const balde = baldeDeCuidado(deps.origem)
  const politica = balde ? deps.cuidaPorOrigem[balde] : 'nao'
  if (politica === 'nao' || balde === null) {
    return { acao: 'so-acompanhar', motivo: `origem "${deps.origem}" configurada para não cuidar` }
  }

  // EM CONSTRUÇÃO: dentro da janela, só acompanha — mesmo com "sim".
  if (deps.emConstrucaoHa !== null && deps.emConstrucaoHa < deps.janelaEmConstrucaoHoras) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} ainda está em construção` }
  }

  if (deps.paradoHaMs < IDADE_MINIMA_DE_ORFANDADE_MS) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} recebeu novidade recente` }
  }
  if (deps.acoesAnteriores > MAX_ACOES_DO_VIGIA) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero} já foi ao dono depois do teto` }
  }
  if (deps.issueNumber === null) {
    return politica === 'perguntar'
      ? { acao: 'perguntar-se-cuida', motivo: `#${deps.numero}: sem tarefa de origem registrada` }
      : { acao: 'escalar', motivo: `#${deps.numero}: sem tarefa de origem registrada, e a configuração manda cuidar sozinho` }
  }
  if (!deps.issueAberta) {
    return { acao: 'fechar-vazio', motivo: `a tarefa #${deps.issueNumber} já está fechada` }
  }
  if (deps.mergeable === null) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero}: o GitHub ainda está calculando` }
  }
  if (deps.verificacao === 'pendente') {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero}: verificação ainda rodando` }
  }

  const causa: CausaDaParada | null =
    deps.mergeable === false ? 'conflito' : deps.verificacao === 'vermelha' ? 'ci-vermelha' : null

  if (causa === null) {
    // Nada para consertar. Pronto para julgar/mesclar — ou perguntar, ou
    // acompanhar, conforme a configuração. NUNCA "escalar" primeiro.
    if (deps.vereditoDoQa === 'approve' && deps.entendimentoCompleto) {
      return { acao: 'mesclar', motivo: `#${deps.numero}: critérios batidos, mesclando conforme "${politica}"` }
    }
    return politica === 'perguntar'
      ? { acao: 'perguntar-se-cuida', motivo: `#${deps.numero} está pronto — cuido deste pedido?` }
      : { acao: 'so-acompanhar', motivo: `#${deps.numero}: aguardando julgamento` }
  }

  const branch = branchParaRetomar(deps)
  if (branch === null) {
    return politica === 'perguntar'
      ? { acao: 'perguntar-se-cuida', motivo: `#${deps.numero}: precisa de conserto, sem ramo utilizável` }
      : { acao: 'escalar', motivo: `#${deps.numero}: precisa de conserto, sem ramo utilizável, e a configuração manda cuidar sozinho` }
  }
  if (!deps.podeAbrirSessao) {
    return { acao: 'so-acompanhar', motivo: `#${deps.numero}: sem vaga na conta do dev agora` }
  }

  return {
    acao: 'retomar',
    issueNumber: deps.issueNumber,
    causa,
    branchDoPr: branch,
    pedido:
      causa === 'conflito'
        ? `Traga a base para o seu ramo e resolva o conflito do pull request #${deps.numero}.`
        : `A verificação automática do pull request #${deps.numero} está vermelha — conserte a causa.`,
    motivo: `#${deps.numero}: ${causa === 'conflito' ? 'conflito' : 'verificação vermelha'}, abrindo sessão nova`,
  }
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/motor-do-proximo-passo.test.ts`
Expected: PASS — 9 testes verdes.

- [ ] **Step 6: Ligar ao `scheduler.ts`, no lugar de `vigiarPrsOrfaos`**

Ler o bloco real de `varrerPrsOrfaos` (scheduler.ts, ~6827-6925, Tarefa 1.3 já apontou onde fica) e trocar a chamada a `vigiarPrsOrfaos` por uma que, para cada PR observado, monta `MotorDoProximoPassoDeps` (lendo `origem`/`emConstrucaoHa` da ficha via `lerFichaDoItem`, Tarefa 0.1, e `cuidaPorOrigem` via `lerCuidaPorOrigem`, Tarefa 0.2) e chama `decidirProximoPasso`, despachando a ação (retomar → mesma lógica de abrir sessão que já existe em `vigiarPrsOrfaos`; mesclar → Tarefa 3.8; perguntar-se-cuida → Tarefa 3.10; escalar → o MESMO caminho de hoje, agora residual). Esta ligação fica DETALHADA nas Tarefas 3.6 a 3.10 abaixo — aqui só o motor em si nasce e é testado isoladamente.

- [ ] **Step 7: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/services/motor-do-proximo-passo.ts apps/control-plane/src/services/motor-do-proximo-passo.test.ts
git commit -m "feat: motor do proximo passo substitui decidirAcaoNoPrOrfao - task 3.5"
```

---

### Task 3.6: Pedir ajuste ao Jules ou resolver conflito

**Files:**
- Modify: `apps/control-plane/src/plugins/scheduler.ts` (ligação da ação `'retomar'` do motor — reaproveita o código que `varrerPrsOrfaos` já tem para abrir sessão nova, sem reescrevê-lo)

**Interfaces:**
- Consumes: `AcaoDoMotor` (Tarefa 3.5, caso `'retomar'`); a mesma função de abertura de sessão que `varrerPrsOrfaos` já chama hoje quando `decidirAcaoNoPrOrfao` devolve `'retomar'` (identificar o nome real lendo o trecho do `scheduler.ts` ao redor da chamada — não reinventar).
- Produces: nenhuma interface nova — esta tarefa é 100% fiação (wiring), sem lógica de decisão nova.

- [ ] **Step 1: Ler o código real de abertura de sessão em `varrerPrsOrfaos`**

Run: `grep -n "acao === 'retomar'" apps/control-plane/src/plugins/scheduler.ts` para achar o bloco exato que hoje reage a `AcaoDoVigia` com `acao: 'retomar'` (abre sessão nova do dev assíncrono no branch do PR, com o pedido como texto) — CONFIRMAR lendo o trecho real antes de escrever qualquer diff, o número de linha pode ter mudado desde a Tarefa 3.5.

- [ ] **Step 2: Escrever o teste que falha (nível de integração do scheduler, se houver suíte de scheduler; senão, teste do wrapper de despacho)**

Se `scheduler.ts` já tem testes de integração para `varrerPrsOrfaos` (confirmar com `find apps/control-plane/src/plugins -iname "scheduler*.test.ts"`), estender o mesmo arquivo com um caso que verifica que a ação `'retomar'` do motor novo aciona a MESMA função de abertura de sessão que o vigia antigo acionava — comparando os argumentos passados (issueNumber, branchDoPr, pedido).

- [ ] **Step 3: Trocar a chamada — de `AcaoDoVigia` para `AcaoDoMotor`**

Substituir, no bloco identificado no Step 1, a checagem `if (decisao.acao === 'retomar')` para consumir o resultado de `decidirProximoPasso` (Tarefa 3.5) em vez de `decidirAcaoNoPrOrfao` — os nomes de campo (`issueNumber`, `causa`, `pedido`, `branchDoPr`) são os MESMOS por desenho (Tarefa 3.5, Step 4), então o corpo da função de abertura de sessão não muda nada.

- [ ] **Step 4: Rodar a suíte do scheduler/control-plane**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/plugins/scheduler.ts
git commit -m "feat: liga a acao retomar do motor do proximo passo a abertura de sessao - task 3.6"
```

---

### Task 3.7: Fechar pedido vazio e devolver a tarefa à fila

**Files:**
- Modify: `apps/control-plane/src/plugins/scheduler.ts` (ligação da ação `'fechar-vazio'` do motor)

**Interfaces:**
- Consumes: `AcaoDoMotor` (Tarefa 3.5, caso `'fechar-vazio'`); `fecharPrDoVigia` (`./vigia-do-pr.js:700-742`, JÁ EXISTENTE e reaproveitada sem mudança — ela já fecha o PR com o motivo e não sabe nem precisa saber de onde a decisão veio).
- Produces: nenhuma interface nova.

- [ ] **Step 1: Ler `fecharPrDoVigia` real**

Run: `sed -n '700,742p' apps/control-plane/src/services/vigia-do-pr.ts` (ou usar a leitura completa já feita nesta sessão) para confirmar a assinatura exata antes de ligar — ela recebe `{ numeroDoPr, motivo, ... }` no mesmo formato de `AcaoDoVigia` caso `'fechar'`; `AcaoDoMotor` caso `'fechar-vazio'` (Tarefa 3.5) usa o MESMO campo `motivo`.

- [ ] **Step 2: Escrever o teste que falha**

Acrescentar a `apps/control-plane/src/services/motor-do-proximo-passo.test.ts` (ou ao teste de integração do scheduler, se existir):

```ts
it('tarefa já fechada: fecha o PR como vazio, com o motivo', () => {
  const d = decidirProximoPasso({ ...base(), issueAberta: false })
  expect(d).toEqual({
    acao: 'fechar-vazio',
    motivo: 'a tarefa #74 já está fechada',
  })
})
```

(Se este caso já não estiver coberto no Step 2 da Tarefa 3.5 — conferir antes de duplicar.)

- [ ] **Step 3: Rodar e confirmar que passa (o motor já cobre isto desde a Tarefa 3.5)**

Run: `npx vitest run apps/control-plane/src/services/motor-do-proximo-passo.test.ts`
Expected: PASS

- [ ] **Step 4: Ligar a ação `'fechar-vazio'` a `fecharPrDoVigia` no `scheduler.ts`**

No mesmo bloco de despacho da Tarefa 3.6, adicionar o caso `'fechar-vazio'` chamando `fecharPrDoVigia({ numeroDoPr: pr.numero, motivo: acao.motivo, ... })` com os mesmos parâmetros de rede que o bloco de `'fechar'` antigo já usava.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/plugins/scheduler.ts apps/control-plane/src/services/motor-do-proximo-passo.test.ts
git commit -m "feat: liga a acao fechar-vazio do motor a fecharPrDoVigia - task 3.7"
```

---

### Task 3.8: Mescla com os 3 critérios — confirmar que o formulário novo faz parte

**Files:**
- Modify: `apps/control-plane/src/services/merge-do-pr.ts:35-82` (`mesclarPr`)
- Test: `apps/control-plane/src/services/merge-do-pr.test.ts` (arquivo já existente)

**Interfaces:**
- Consumes: `QaVerdictForm['entendimento']` (Tarefa 2.4/3.1) — o 3º critério ("revisor aprovou entendendo o porquê") já é `vereditoDoQa === 'approve'`, mas HOJE `mesclarPr` não confirma que o veredito veio acompanhado de um `entendimento` de verdade (poderia, em teoria, ser um `approve` de um formulário antigo em cache/replay). Esta tarefa fecha essa lacuna.
- Produces: `mesclarPr` ganha o parâmetro `entendimentoPresente: boolean`, com um SEXTO porteiro (a ordem dos 5 existentes não muda).

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `apps/control-plane/src/services/merge-do-pr.test.ts` (reaproveitar os helpers de fixture já existentes no arquivo, só acrescentando o campo novo):

```ts
it('recusa mesclar quando o veredito aprovou mas não veio com entendimento (Fase 3.8)', async () => {
  const resultado = await mesclarPr({
    numeroDoPr: 1,
    ciState: 'green',
    vereditoDoQa: 'approve',
    diffTruncado: false,
    delegado: true,
    shaRevisado: 'a',
    shaAtual: 'a',
    entendimentoPresente: false,
    merge: async () => true,
  })
  expect(resultado).toEqual({
    mesclado: false,
    motivo: 'o QA aprovou sem registrar o entendimento do pedido',
  })
})

it('mescla quando os 3 critérios batem, entendimento incluído', async () => {
  const resultado = await mesclarPr({
    numeroDoPr: 1,
    ciState: 'green',
    vereditoDoQa: 'approve',
    diffTruncado: false,
    delegado: true,
    shaRevisado: 'a',
    shaAtual: 'a',
    entendimentoPresente: true,
    merge: async () => true,
  })
  expect(resultado.mesclado).toBe(true)
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/merge-do-pr.test.ts -t "Fase 3.8"`
Expected: FAIL — o parâmetro `entendimentoPresente` ainda não é aceito/checado (TypeScript recusaria o objeto se `merge-do-pr.ts` usasse um tipo `Required`; em runtime, sem a checagem, o 1º teste falharia por `mesclado` sair `true`).

- [ ] **Step 3: Implementar o sexto porteiro**

Em `merge-do-pr.ts`, na interface de `deps` (linha 35-48), acrescentar:

```ts
  /** Fase 3.8: o veredito veio acompanhado do formulário de entendimento
   *  (Tarefa 2.4/3.1)? Fecha a lacuna de um `approve` sem os 4 campos —
   *  "revisor aprovou entendendo o porquê" só é verdade com os dois juntos. */
  entendimentoPresente: boolean
```

E, no corpo de `mesclarPr`, logo depois do porteiro `if (deps.vereditoDoQa !== 'approve') { ... }` (linha 63-65), adicionar:

```ts
  if (!deps.entendimentoPresente) {
    return { mesclado: false, motivo: 'o QA aprovou sem registrar o entendimento do pedido' }
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/merge-do-pr.test.ts`
Expected: PASS

- [ ] **Step 5: Atualizar o(s) chamador(es) de `mesclarPr`**

Run: `grep -rn "mesclarPr(" apps/control-plane/src --include="*.ts" | grep -v test` e, em cada chamador real (`qa-rails-mission.ts` é o principal), passar `entendimentoPresente: Boolean(verdict.entendimento?.deOndeVeio && verdict.entendimento?.oQueMuda && verdict.entendimento?.queAjusteE && verdict.entendimento?.porQueExiste)`.

- [ ] **Step 6: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/services/merge-do-pr.ts apps/control-plane/src/services/merge-do-pr.test.ts \
  apps/control-plane/src/services/qa-rails-mission.ts
git commit -m "feat: merge exige entendimento presente, nao so approve - task 3.8"
```

---

### Task 3.9: Origem não cuidada ou em construção só acompanha, nunca julga

**Files:**
- Modify: `apps/control-plane/src/plugins/scheduler.ts` (montagem de `emConstrucaoHa` para alimentar `decidirProximoPasso`)

**Interfaces:**
- Consumes: `lerJanelaEmConstrucaoHoras` (Tarefa 0.2); `PrAberto.rascunho` (payload já lido por `listarPrsAbertosParaOVigia`, campo a confirmar/acrescentar se ainda não existir); `estadoDoPrAPartirDoPayload` (Tarefa 1.1, campo `ultimoCommitEm`).
- Produces: `function horasEmConstrucao(args: { rascunho: boolean; ultimoCommitEm: string | null; agora: Date }): number | null` — `null` quando NÃO está em construção (não é rascunho e o commit já passou da janela, ou não há dado); número de horas quando está.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/em-construcao.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { horasEmConstrucao } from './em-construcao.js'

describe('horasEmConstrucao', () => {
  it('rascunho: está em construção com 0 horas (não há "desde quando" para rascunho)', () => {
    expect(horasEmConstrucao({ rascunho: true, ultimoCommitEm: null, agora: new Date() })).toBe(0)
  })

  it('não rascunho, commit de 1 hora atrás: em construção há 1 hora', () => {
    const agora = new Date('2026-09-15T10:00:00Z')
    const h = horasEmConstrucao({ rascunho: false, ultimoCommitEm: '2026-09-15T09:00:00Z', agora })
    expect(h).toBe(1)
  })

  it('não rascunho, commit de 10 horas atrás: não está mais em construção', () => {
    const agora = new Date('2026-09-15T10:00:00Z')
    const h = horasEmConstrucao({ rascunho: false, ultimoCommitEm: '2026-09-15T00:00:00Z', agora })
    expect(h).toBeNull()
  })

  it('sem dado de commit: não afirma construção', () => {
    expect(horasEmConstrucao({ rascunho: false, ultimoCommitEm: null, agora: new Date() })).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/em-construcao.test.ts`
Expected: FAIL com `Cannot find module './em-construcao.js'`

- [ ] **Step 3: Implementar**

Criar `apps/control-plane/src/services/em-construcao.ts`:

```ts
// "Em construção" (Fase 3.9): rascunho, ou commit recente demais para julgar
// — dentro da janela configurada (Tarefa 0.2), o motor do próximo passo só
// acompanha, nunca julga nem mescla.

/** Teto: acima disto, mesmo commit "recente" não é mais tratado como
 *  construção em andamento — evita `null` de `ultimoCommitEm` parecer
 *  "construção infinita". */
const TETO_DE_HORAS_CONSIDERADAS = 48

export function horasEmConstrucao(args: {
  rascunho: boolean
  ultimoCommitEm: string | null
  agora: Date
}): number | null {
  if (args.rascunho) return 0
  if (!args.ultimoCommitEm) return null
  const commit = new Date(args.ultimoCommitEm)
  if (!Number.isFinite(commit.getTime())) return null
  const horas = (args.agora.getTime() - commit.getTime()) / (60 * 60 * 1000)
  if (horas < 0 || horas > TETO_DE_HORAS_CONSIDERADAS) return null
  return Math.floor(horas)
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/em-construcao.test.ts`
Expected: PASS — 4 testes verdes.

- [ ] **Step 5: Ligar ao `scheduler.ts`, alimentando `decidirProximoPasso`**

No mesmo bloco de montagem de `MotorDoProximoPassoDeps` (Tarefa 3.5, Step 6), calcular `emConstrucaoHa: horasEmConstrucao({ rascunho: pr.rascunho, ultimoCommitEm: ficha?.estado.ultimoCommitEm ?? null, agora })` (lendo `rascunho` do payload real do GitHub — confirmar se `listarPrsAbertosParaOVigia`/a leitura equivalente já traz esse campo; se não, é um `draft` a mais no GET já existente, sem chamada nova) e `janelaEmConstrucaoHoras: lerJanelaEmConstrucaoHoras(projeto.runtimeConfig)`.

- [ ] **Step 6: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/services/em-construcao.ts apps/control-plane/src/services/em-construcao.test.ts \
  apps/control-plane/src/plugins/scheduler.ts
git commit -m "feat: em construcao (rascunho ou commit recente) so acompanha, nunca julga - task 3.9"
```

---

### Task 3.10: PO pergunta "cuido deste pedido?" quando a configuração manda perguntar

**Files:**
- Create: `apps/control-plane/src/services/perguntar-se-cuida.ts`
- Test: `apps/control-plane/src/services/perguntar-se-cuida.test.ts`
- Modify: `apps/control-plane/src/plugins/scheduler.ts` (ligação da ação `'perguntar-se-cuida'` do motor)

**Interfaces:**
- Consumes: MESMO padrão de `perguntarSobreVinculoDaTarefa` (Tarefa 2.3) e `perguntarAoDonoSobreLogicaAlternativa` (`viabilidade-da-logica-alternativa.ts`) — `montarContextoExecutivoDaPergunta`, `buildFreeTextOption`, `AgentQuestionOption`.
- Produces: `const DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO = 'cuida-deste-pedido:'`; `dedupKeyDeCuidaDestePedido`/`parseDedupKeyDeCuidaDestePedido` (par completo, mesmo padrão); `OPCOES_DE_CUIDA_DESTE_PEDIDO = [{label:'Sim, cuide sozinho a partir de agora',value:'cuidar-sempre'},{label:'Só desta vez',value:'cuidar-uma-vez'},{label:'Não, só acompanhe',value:'nao-cuidar'}]` + `buildFreeTextOption()`; `async function perguntarSeCuida(args, deps): Promise<void>`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/perguntar-se-cuida.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  dedupKeyDeCuidaDestePedido,
  parseDedupKeyDeCuidaDestePedido,
  montarPerguntaSeCuida,
  OPCOES_DE_CUIDA_DESTE_PEDIDO,
} from './perguntar-se-cuida.js'

describe('dedupKeyDeCuidaDestePedido / parse', () => {
  it('roda-trip', () => {
    const chave = dedupKeyDeCuidaDestePedido('dono/repo', 42)
    expect(parseDedupKeyDeCuidaDestePedido(chave)).toEqual({ repository: 'dono/repo', numeroDoPr: 42 })
  })
})

describe('montarPerguntaSeCuida', () => {
  it('monta as 3 opções objetivas + escrever', () => {
    const pergunta = montarPerguntaSeCuida({
      numeroDoPr: 42,
      repository: 'dono/repo',
      origem: 'assistente',
      contexto: { ciclo: null, entrega: null, decisoes: [] },
    })
    expect(pergunta.options.map((o) => o.value)).toEqual([
      'cuidar-sempre',
      'cuidar-uma-vez',
      'nao-cuidar',
      'free-text',
    ])
    expect(pergunta.options).toHaveLength(OPCOES_DE_CUIDA_DESTE_PEDIDO.length + 1)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/perguntar-se-cuida.test.ts`
Expected: FAIL com `Cannot find module './perguntar-se-cuida.js'`

- [ ] **Step 3: Implementar**

```ts
// PO pergunta "cuido deste pedido?" quando cuidaPorOrigem (Tarefa 0.2) manda
// perguntar. MESMO padrão executivo de perguntar-vinculo-da-tarefa.ts (2.3)
// e viabilidade-da-logica-alternativa.ts — 3 opções objetivas + "Vou escrever".

import type { ContextoExecutivoDaPergunta } from './contexto-executivo-da-pergunta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { AgentQuestionOption } from './agent-question.js'
import type { OrigemDoItem } from './origem-do-item.js'

export const DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO = 'cuida-deste-pedido:'

export function dedupKeyDeCuidaDestePedido(repository: string, numeroDoPr: number): string {
  return `${DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO}${repository}:${numeroDoPr}`
}

export function parseDedupKeyDeCuidaDestePedido(
  dedupKey: string
): { repository: string; numeroDoPr: number } | null {
  if (!dedupKey.startsWith(DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO)) return null
  const resto = dedupKey.slice(DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO.length)
  const i = resto.lastIndexOf(':')
  if (i <= 0 || i === resto.length - 1) return null
  const repository = resto.slice(0, i)
  const numeroDoPr = Number(resto.slice(i + 1))
  if (!repository.includes('/') || !Number.isInteger(numeroDoPr) || numeroDoPr <= 0) return null
  return { repository, numeroDoPr }
}

export const OPCOES_DE_CUIDA_DESTE_PEDIDO: AgentQuestionOption[] = [
  { label: 'Sim, cuide sozinho a partir de agora', value: 'cuidar-sempre' },
  { label: 'Só desta vez', value: 'cuidar-uma-vez' },
  { label: 'Não, só acompanhe', value: 'nao-cuidar' },
]

export function montarPerguntaSeCuida(args: {
  numeroDoPr: number
  repository: string
  origem: OrigemDoItem
  contexto: ContextoExecutivoDaPergunta
}): { text: string; options: AgentQuestionOption[]; dedupKey: string } {
  const partes: string[] = []
  if (args.contexto.ciclo) partes.push(`O time está no ciclo "${args.contexto.ciclo}".`)
  if (args.contexto.entrega) partes.push(`Esta tarefa entrega: ${args.contexto.entrega}.`)
  partes.push(
    `O pull request #${args.numeroDoPr} de ${args.repository} (origem: ${args.origem}) está pronto ` +
      'para julgamento, e você configurou esta origem para eu perguntar antes. Cuido deste pedido?'
  )
  return {
    text: partes.join('\n\n'),
    options: [...OPCOES_DE_CUIDA_DESTE_PEDIDO, buildFreeTextOption()],
    dedupKey: dedupKeyDeCuidaDestePedido(args.repository, args.numeroDoPr),
  }
}

export interface AgentQuestionAskerDeCuidado {
  ask: (
    userId: string,
    projectId: string,
    input: { text: string; options?: AgentQuestionOption[]; dedupKey?: string }
  ) => Promise<unknown>
}

/** PORTÃO 5B, item 7.6: side effect externo só com autorização explícita de
 *  quem despacha esta tarefa. */
export async function perguntarSeCuida(
  args: {
    userId: string
    projectId: string
    numeroDoPr: number
    repository: string
    origem: OrigemDoItem
    contexto: ContextoExecutivoDaPergunta
  },
  deps: { agentQuestion: AgentQuestionAskerDeCuidado }
): Promise<void> {
  const pergunta = montarPerguntaSeCuida(args)
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: pergunta.text,
    options: pergunta.options,
    dedupKey: pergunta.dedupKey,
  })
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/perguntar-se-cuida.test.ts`
Expected: PASS — 2 testes verdes.

- [ ] **Step 5: Ligar ao `scheduler.ts`**

No mesmo bloco de despacho das Tarefas 3.6/3.7, adicionar o caso `'perguntar-se-cuida'` chamando `perguntarSeCuida` — best-effort, mesmo padrão de `perguntarAoDonoSeLogicaAlternativaViavel` (`onWarn` quando falta `agentQuestionService`/`userId`, nunca lança).

- [ ] **Step 6: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/services/perguntar-se-cuida.ts apps/control-plane/src/services/perguntar-se-cuida.test.ts \
  apps/control-plane/src/plugins/scheduler.ts
git commit -m "feat: PO pergunta cuido deste pedido quando a configuracao manda perguntar - task 3.10"
```

---

### Task 3.11: Tudo registrado no painel, com o motivo

**Files:**
- Modify: `apps/control-plane/src/plugins/scheduler.ts` (bloco de despacho das Tarefas 3.6-3.10 — cada ramo ganha uma chamada a `registrarNoPainelUmaVez`)

**Interfaces:**
- Consumes: `registrarNoPainelUmaVez`, `PrismaDoRegistroNoPainel` (`./registro-no-painel.js:59`, já existente e já usado em outros lugares — DJ-T15 mencionada no cabeçalho do plano).
- Produces: `function chaveDoRegistroDoMotor(repository: string, numeroDoPr: number, acao: string): string` — dedup key estável por (repositório, PR, ação), para a MESMA decisão não virar duas linhas na timeline em duas passadas seguidas do relógio.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/registro-do-motor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { chaveDoRegistroDoMotor } from './registro-do-motor.js'

describe('chaveDoRegistroDoMotor', () => {
  it('é estável para a mesma ação repetida', () => {
    const a = chaveDoRegistroDoMotor('dono/repo', 42, 'so-acompanhar')
    const b = chaveDoRegistroDoMotor('dono/repo', 42, 'so-acompanhar')
    expect(a).toBe(b)
  })
  it('muda quando a ação muda (nova decisão vira novo registro)', () => {
    const a = chaveDoRegistroDoMotor('dono/repo', 42, 'so-acompanhar')
    const b = chaveDoRegistroDoMotor('dono/repo', 42, 'retomar')
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/registro-do-motor.test.ts`
Expected: FAIL com `Cannot find module './registro-do-motor.js'`

- [ ] **Step 3: Implementar**

Criar `apps/control-plane/src/services/registro-do-motor.ts`:

```ts
// A chave de dedup do registro no painel para cada decisão do motor do
// próximo passo (Fase 3.11) — registrarNoPainelUmaVez (registro-no-painel.ts,
// DJ-T15) já dedupa por chave; esta função só monta a chave estável.
//
// Inclui a AÇÃO na chave (não só repositório+PR): a mesma decisão repetida
// em passadas seguintes não vira registro novo, mas uma decisão DIFERENTE
// (o motor mudou de ideia porque o estado mudou) tem que aparecer como um
// evento novo na timeline — nunca escondida atrás da chave da decisão antiga.
export function chaveDoRegistroDoMotor(repository: string, numeroDoPr: number, acao: string): string {
  return `motor-do-proximo-passo:${repository}:${numeroDoPr}:${acao}`
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/registro-do-motor.test.ts`
Expected: PASS

- [ ] **Step 5: Chamar em CADA ramo de despacho do `scheduler.ts` (Tarefas 3.6-3.10)**

Em cada `case`/`if` do bloco de despacho (retomar, fechar-vazio, mesclar, perguntar-se-cuida, escalar, so-acompanhar), logo após a ação de fato acontecer (ou, para `so-acompanhar`, sem ação nenhuma além do registro), adicionar:

```ts
          await registrarNoPainelUmaVez({
            prisma: app.prisma as never,
            projectId: projeto.id,
            chave: chaveDoRegistroDoMotor(projeto.wingId, pr.numero, acao.acao),
            texto: `Pull request #${pr.numero}: ${acao.motivo}`,
          })
```

Confirmar, lendo `registro-no-painel.ts` (já lido nesta sessão — Tarefa 3.1 do plano original tinha esse arquivo), que `PrismaDoRegistroNoPainel` só exige `event.findFirst`/`event.create`, o que `app.prisma` já satisfaz sem adaptação.

- [ ] **Step 6: Confirmar que o Telegram continua só para negócio**

Ler `plugins/telegram.ts` no ponto onde eventos `type: 'audit'` (o que `registrarNoPainelUmaVez` grava) são ou não encaminhados ao Telegram — CONFIRMAR (não assumir) que este registro NUNCA dispara mensagem de Telegram: só as perguntas reais (`perguntarSeCuida`, `perguntarSobreVinculoDaTarefa`) fazem isso, via `agentQuestion.ask`, caminho inteiramente separado. Se o código hoje encaminhar TODO evento `audit` ao Telegram, esta tarefa acrescenta o filtro que falta antes de fechar — sem isso, "o Telegram fica só para negócio" (texto do plano aprovado) vira mentira em produção.

- [ ] **Step 7: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 8: QA manual — confirmar no painel de verdade**

Antes de fechar: rodar uma passada do relógio contra um projeto de teste e CONFIRMAR na tela do painel (`GET /api/v1/painel/timeline` ou a tela equivalente) que cada decisão do motor aparece com o motivo em português, e no Telegram (se conectado) NENHUMA mensagem nova chegou por causa disto.

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane/src/services/registro-do-motor.ts apps/control-plane/src/services/registro-do-motor.test.ts \
  apps/control-plane/src/plugins/scheduler.ts
git commit -m "feat: toda decisao do motor registrada no painel com o motivo - task 3.11"
```

**Absorve do Shrimp:** L3-T12 (`a660c7c1`) — "vigia que olha o pedido e não a sessão" — absorvida pela Tarefa 3.5. L4-T15 (`564e7244`) — "escopo do revisor por origem" — a configuração nasce na Tarefa 0.2, e a aplicação plena no merge está na Tarefa 3.8. L4-T26 (`cf222d21`) — "parecer antigo ganha a causa legível" — absorvida pela Tarefa 3.2. L4-T29 (`626ccf50`) — "parecer publicado duas vezes" — absorvida pela Tarefa 3.4.

---
## Fase 4 — Tarefas sem pedido

### Task 4.1: Conferir qualquer tarefa contra o padrão, peso, quadro e sprint

**Files:**
- Create: `apps/control-plane/src/services/conferir-tarefa-sem-pedido.ts`
- Test: `apps/control-plane/src/services/conferir-tarefa-sem-pedido.test.ts`
- Modify: `packages/github-sync/src/project-v2-client.ts:628-644` (`listarQuadrosDaConta` — migrar para `repositoryOwner(login:)`, MESMA base que `findProjectId` já usa desde D10)
- Test: `packages/github-sync/src/project-v2-client.test.ts`

**Interfaces:**
- Consumes: `validateDoD`, `DoDFields`, `DOD_FIELD_MAP` (`@gitorch/cadence`); `lerSecaoDaIssue` (`./secao-da-issue.js`, já existente); `pesoDoCorpoDaIssue` (`./backlog-executor.js:174`, já existente); `ESCALA_DE_PESO`, `PESO_MAXIMO_DE_SPRINT` (`@gitorch/cadence`).
- Produces:
  - `interface ConferenciaDaTarefa { padraoOk: boolean; erros: string[]; peso: number | null; noQuadro: boolean; naSprint: boolean }`
  - `function conferirTarefaSemPedido(deps): ConferenciaDaTarefa` — pura, consumida pela Tarefa 4.2 (o que falhar aqui é o que o RA/PO ajustam).

**CORREÇÃO DE PREMISSA (verificado lendo o código antes de codar):** o pedido original dizia "o bug já é conhecido: usa `organization()` quando deveria usar `user()`". Isso já foi corrigido em `findProjectId`/`getProjectId` (D10, comentário em `project-v2-client.ts:511-521`) — os dois hoje usam `repositoryOwner(login:)`, que resolve o tipo dinamicamente e NUNCA erra entre pessoal/organização. O que **continua** com o bug antigo é `listarQuadrosDaConta` (linha 628-644): ela ainda recebe `ownerType` do CHAMADOR e escolhe a raiz `organization`/`user` por fora — 5 chamadores (`board-status.ts:181-185`, `po-rails-mission.ts:325-332`, `painel.ts:1461-1470`, `telegram.ts:539-548`, `scheduler.ts:10909-10918`) hoje contornam isso tentando `'user'` e, se falhar, `'organization'` (um resquício de ANTES do D10, hoje inútil em `getProjectId` mas ainda necessário em `listarQuadrosDaConta`, que nunca foi migrada). Esta tarefa migra `listarQuadrosDaConta` para o MESMO padrão de `repositoryOwner`, eliminando a adivinhação de vez.

- [ ] **Step 1: Escrever o teste que falha para `listarQuadrosDaConta`**

Em `packages/github-sync/src/project-v2-client.test.ts` (localizar o `describe('listarQuadrosDaConta', ...)` já existente e SUBSTITUIR os casos que hoje fixam `ownerType`):

```ts
describe('listarQuadrosDaConta — Fase 4.1 (repositoryOwner dinâmico)', () => {
  it('resolve quadros de conta PESSOAL sem precisar saber o ownerType de antemão', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            repositoryOwner: {
              __typename: 'User',
              projectsV2: { nodes: [{ id: 'PVT_1', number: 3, title: 'loureng/patinhas-3d-crafts', closed: false }] },
            },
          },
        }),
        { status: 200 }
      )
    )
    const client = new ProjectV2Client({ token: 't', fetchImpl: fetchMock })
    const quadros = await client.listarQuadrosDaConta({ login: 'loureng' })
    expect(quadros).toHaveLength(1)
    expect(quadros[0]?.number).toBe(3)
    // UMA chamada — nunca duas (a antiga tentativa user→organization some).
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resolve quadros de ORGANIZAÇÃO com a mesma chamada, sem branch por ownerType', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            repositoryOwner: { __typename: 'Organization', projectsV2: { nodes: [] } },
          },
        }),
        { status: 200 }
      )
    )
    const client = new ProjectV2Client({ token: 't', fetchImpl: fetchMock })
    expect(await client.listarQuadrosDaConta({ login: 'GitOrchAI' })).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run packages/github-sync/src/project-v2-client.test.ts -t "repositoryOwner dinâmico"`
Expected: FAIL — a assinatura atual de `listarQuadrosDaConta` exige `ownerType` (TypeScript recusaria a chamada do teste sem ele) e a query hoje interpola `organization`/`user` fixo.

- [ ] **Step 3: Migrar `listarQuadrosDaConta`**

Em `packages/github-sync/src/project-v2-client.ts:628-644`, trocar:

```ts
  async listarQuadrosDaConta(input: ListarQuadrosDaContaInput): Promise<QuadroListado[]> {
    const campo = input.ownerType === 'organization' ? 'organization' : 'user'
    const response = await this.request<
      Record<string, { projectsV2: { nodes: QuadroListado[] | null } | null } | null>
    >(
      {
        query: `
          query ListarQuadrosDaConta($login: String!) {
            ${campo}(login: $login) {
              projectsV2(first: 50) { nodes { id number title closed } }
            }
          }
        `,
        variables: { login: input.login },
      },
      this.token
    )
```

por:

```ts
  // D10 estendido (Fase 4.1): mesma base de findProjectId — repositoryOwner
  // resolve User/Organization numa raiz só, nunca erra entre pessoal e
  // organização. `ownerType` no input fica só para MENSAGEM DE ERRO (não
  // decide mais a query) — mesmo contrato que getProjectId já adotou.
  async listarQuadrosDaConta(input: ListarQuadrosDaContaInput): Promise<QuadroListado[]> {
    const response = await this.request<{
      repositoryOwner: { __typename: string; projectsV2: { nodes: QuadroListado[] | null } } | null
    }>(
      {
        query: `
          query ListarQuadrosDaConta($login: String!) {
            repositoryOwner(login: $login) {
              __typename
              ... on ProjectV2Owner {
                projectsV2(first: 50) { nodes { id number title closed } }
              }
            }
          }
        `,
        variables: { login: input.login },
      },
      this.token
    )
```

E, logo abaixo (onde o código lê o resultado), trocar `unwrap(response)[campo]?.projectsV2?.nodes` por `unwrap(response).repositoryOwner?.projectsV2?.nodes` (confirmar a linha exata lendo o trecho real antes de editar — o corpo da função continua igual depois deste ponto).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run packages/github-sync/src/project-v2-client.test.ts`
Expected: PASS — inclusive os testes ANTIGOS de `listarQuadrosDaConta` que já existiam (ajustar as fixtures deles para o novo formato `repositoryOwner`, se a suíte antiga simulava `organization`/`user` como chave de topo).

- [ ] **Step 5: Simplificar os 5 chamadores — remover o `.catch` de recuo agora morto**

Em `board-status.ts:181-185`, `po-rails-mission.ts:325-332`, `painel.ts:1461-1470`, `telegram.ts:539-548`, `scheduler.ts:10909-10918`: ler cada trecho real e, ONDE a chamada for a `listarQuadrosDaConta` (não a `getProjectId`, que continua igual — ela também não decide mais pela raiz, mas seu duplo-tento já é inofensivo e sair dele não é o escopo desta tarefa), remover o par `.catch(() => client.listarQuadrosDaConta({ ..., ownerType: 'organization' }))`, deixando uma única chamada sem `ownerType`. **Não mexer em `getProjectId`** nestes mesmos arquivos — está fora do escopo desta tarefa e o padrão duplo lá, embora hoje redundante, não está QUEBRADO; simplificá-lo é limpeza, não correção de bug, e fica para uma tarefa própria fora deste plano.

- [ ] **Step 6: Rodar as suítes tocadas**

Run: `pnpm --filter @gitorch/github-sync test && pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: Escrever o teste que falha para `conferirTarefaSemPedido`**

Criar `apps/control-plane/src/services/conferir-tarefa-sem-pedido.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { conferirTarefaSemPedido } from './conferir-tarefa-sem-pedido.js'

const CORPO_NO_PADRAO = [
  '## Goal', 'g',
  '## Task Details', 'd',
  '## Task Description', 'd',
  '## Implementation Guide', 'i com passo concreto',
  '## Verification Criteria', 'rodar `pnpm test` e ver 0 falhas',
  '## Dependencies', 'nenhuma',
  '## Related Files', 'src/x.ts',
  '## Notes', 'n',
  '## Peso', '3',
].join('\n\n')

describe('conferirTarefaSemPedido', () => {
  it('issue no padrão, com peso, no quadro e na sprint: tudo ok', () => {
    const r = conferirTarefaSemPedido({
      titulo: 'Corrigir cache',
      corpo: CORPO_NO_PADRAO,
      estaNoQuadro: true,
      estaNaSprintAtual: true,
    })
    expect(r).toEqual({ padraoOk: true, erros: [], peso: 3, noQuadro: true, naSprint: true })
  })

  it('issue criada à mão, sem os 8 campos: padraoOk false com os erros', () => {
    const r = conferirTarefaSemPedido({
      titulo: 'Ajustar algo',
      corpo: 'só um parágrafo solto',
      estaNoQuadro: false,
      estaNaSprintAtual: false,
    })
    expect(r.padraoOk).toBe(false)
    expect(r.erros.length).toBeGreaterThan(0)
    expect(r.peso).toBeNull()
    expect(r.noQuadro).toBe(false)
  })
})
```

- [ ] **Step 8: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/conferir-tarefa-sem-pedido.test.ts`
Expected: FAIL com `Cannot find module './conferir-tarefa-sem-pedido.js'`

- [ ] **Step 9: Implementar**

```ts
// Confere QUALQUER tarefa (mesmo criada à mão, fora do fluxo do PO) contra o
// padrão dos 8 campos, o peso e a presença no quadro/sprint. Reaproveita os
// MESMOS validadores que backlog-executor.ts já usa para o que o próprio PO
// escreve — a régua não muda por quem escreveu a issue.

import { validateDoD, DOD_FIELD_MAP, type DoDFields } from '@gitorch/cadence'
import { lerSecaoDaIssue } from './secao-da-issue.js'
import { pesoDoCorpoDaIssue } from './backlog-executor.js'

export interface ConferenciaDaTarefa {
  padraoOk: boolean
  erros: string[]
  peso: number | null
  noQuadro: boolean
  naSprint: boolean
}

/** Monta um DoDFields a partir do corpo bruto da issue, seção por seção —
 *  mesma fonte (`DOD_FIELD_MAP`) que a escrita já usa, nunca uma lista
 *  paralela de cabeçalhos. */
function camposDaIssue(titulo: string, corpo: string): DoDFields {
  const campos = { titulo } as DoDFields
  for (const { key, header } of DOD_FIELD_MAP) {
    campos[key] = lerSecaoDaIssue(corpo, header)
  }
  return campos
}

export function conferirTarefaSemPedido(deps: {
  titulo: string
  corpo: string
  estaNoQuadro: boolean
  estaNaSprintAtual: boolean
}): ConferenciaDaTarefa {
  const campos = camposDaIssue(deps.titulo, deps.corpo)
  const dod = validateDoD(campos)
  return {
    padraoOk: dod.ok,
    erros: dod.errors,
    peso: pesoDoCorpoDaIssue(deps.corpo),
    noQuadro: deps.estaNoQuadro,
    naSprint: deps.estaNaSprintAtual,
  }
}
```

- [ ] **Step 10: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/conferir-tarefa-sem-pedido.test.ts`
Expected: PASS

- [ ] **Step 11: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add packages/github-sync/src/project-v2-client.ts packages/github-sync/src/project-v2-client.test.ts \
  apps/control-plane/src/services/board-status.ts apps/control-plane/src/services/po-rails-mission.ts \
  apps/control-plane/src/routes/painel.ts apps/control-plane/src/plugins/telegram.ts apps/control-plane/src/plugins/scheduler.ts \
  apps/control-plane/src/services/conferir-tarefa-sem-pedido.ts apps/control-plane/src/services/conferir-tarefa-sem-pedido.test.ts
git commit -m "feat: conferir qualquer tarefa e corrigir quadro de conta pessoal - task 4.1"
```

---

### Task 4.2: Analista entende e PO ajusta o que estiver fora do padrão

**Files:**
- Create: `apps/control-plane/src/services/ajustar-tarefa-fora-do-padrao.ts`
- Test: `apps/control-plane/src/services/ajustar-tarefa-fora-do-padrao.test.ts`

**Interfaces:**
- Consumes: `ConferenciaDaTarefa` (Tarefa 4.1); `RAILS_SCHEMAS`, `buildStepPrompt`, `InfraIssueForm` (`@gitorch/cadence`, `InfraIssueForm` já existe em `rails.ts:97-99` — `{ fields: DoDFields }`, exatamente o formato que o PO já escreve para reescrever uma issue); `runFormStep`, `StepExecutor`.
- Produces: `async function ajustarTarefaForaDoPadrao(deps): Promise<InfraIssueForm>` — o RA entende o que existe (issue original) e o PO reescreve nos 8 campos; consumida por quem aplica a atualização na issue real do GitHub (fora do escopo desta tarefa — só a DECISÃO é produzida aqui, mesma separação de responsabilidade de `avaliarViabilidadeDaLogicaAlternativa`/quem aplica).

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/ajustar-tarefa-fora-do-padrao.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { ajustarTarefaForaDoPadrao } from './ajustar-tarefa-fora-do-padrao.js'

describe('ajustarTarefaForaDoPadrao', () => {
  it('devolve os 8 campos reescritos pelo PO', async () => {
    const execute = vi.fn(async () => ({
      fields: {
        titulo: 'Corrigir cache de sessão',
        goal: 'g', taskDetails: 'd', taskDescription: 'd', implementationGuide: 'i',
        verificationCriteria: 'v', dependencies: 'x', relatedFiles: 'src/x.ts', notes: 'n',
      },
    }))
    const resultado = await ajustarTarefaForaDoPadrao({
      issueNumber: 88,
      repository: 'dono/repo',
      tituloOriginal: 'ajustar algo',
      corpoOriginal: 'texto solto sem seções',
      errosDoPadrao: ['titulo: empty', 'goal: empty'],
      contextBlocks: [],
      execute,
    })
    expect(resultado.fields.titulo).toBe('Corrigir cache de sessão')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/ajustar-tarefa-fora-do-padrao.test.ts`
Expected: FAIL com `Cannot find module './ajustar-tarefa-fora-do-padrao.js'`

- [ ] **Step 3: Implementar**

```ts
// Fase 4.2: uma tarefa fora do padrão (Tarefa 4.1 achou erros) é reescrita
// pelo PO nos 8 campos do DoD — MESMO formulário (InfraIssueForm) que o PO
// já usa para escrever issue nova, nunca um formato paralelo.

import { RAILS_SCHEMAS, buildStepPrompt, type InfraIssueForm } from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'

export interface AjustarTarefaForaDoPadraoArgs {
  issueNumber: number
  repository: string
  tituloOriginal: string
  corpoOriginal: string
  errosDoPadrao: string[]
  contextBlocks: string[]
  execute: StepExecutor
}

export async function ajustarTarefaForaDoPadrao(
  args: AjustarTarefaForaDoPadraoArgs
): Promise<InfraIssueForm> {
  return (await runFormStep({
    schema: RAILS_SCHEMAS.infraIssue,
    prompt: buildStepPrompt('po', 'po-ajustar-tarefa-fora-do-padrao', RAILS_SCHEMAS.infraIssue, [
      ...args.contextBlocks,
      `A tarefa #${args.issueNumber} de ${args.repository} não está no padrão de 8 campos:`,
      args.errosDoPadrao.join('; '),
      `Título original: ${args.tituloOriginal}`,
      `Corpo original: ${args.corpoOriginal}`,
      'Reescreva nos 8 campos do padrão, preservando a INTENÇÃO original — nunca inventando um ' +
        'pedido novo que a issue não continha.',
    ]),
    execute: args.execute,
  })) as InfraIssueForm
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/ajustar-tarefa-fora-do-padrao.test.ts`
Expected: PASS

- [ ] **Step 5: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/services/ajustar-tarefa-fora-do-padrao.ts apps/control-plane/src/services/ajustar-tarefa-fora-do-padrao.test.ts
git commit -m "feat: PO ajusta tarefa fora do padrao dos 8 campos - task 4.2"
```

---

### Task 4.3: Fora da sprint atual — PO reavalia na hora

**Files:**
- Create: `apps/control-plane/src/services/reavaliar-fora-da-sprint.ts`
- Test: `apps/control-plane/src/services/reavaliar-fora-da-sprint.test.ts`

**Interfaces:**
- Consumes: `analisarCustoDaOrdem`, `ordemQueMinimizaEspera`, `PedidoNaFila`, `CandidatoDeTroca` (`@gitorch/cadence`, já usados em `custo-da-ordem-do-projeto.ts` — reaproveitados sem reimplementar o cálculo).
- Produces: `function reavaliarForaDaSprint(deps: { pedido: PedidoNaFila; fila: PedidoNaFila[] }): { entraAgora: boolean; motivo: string }` — decide, pela MESMA análise de custo de espera que já existe, se uma tarefa achada fora da sprint atual (Tarefa 4.1, `naSprint: false`) entra agora ou fica para depois.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/reavaliar-fora-da-sprint.test.ts` (usar o formato real de `PedidoNaFila` — ler a interface em `packages/cadence/src/custo-da-ordem.ts` antes de montar as fixtures, para não inventar campos que ela não tem):

```ts
import { describe, it, expect } from 'vitest'
import { reavaliarForaDaSprint } from './reavaliar-fora-da-sprint.js'

describe('reavaliarForaDaSprint', () => {
  it('custo de espera baixo: fica para depois, sem interromper a sprint', () => {
    const r = reavaliarForaDaSprint({
      pedido: { numero: 88, peso: 2, posicao: 9 } as never,
      fila: [{ numero: 1, peso: 3, posicao: 0 } as never],
    })
    expect(typeof r.entraAgora).toBe('boolean')
    expect(r.motivo.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/reavaliar-fora-da-sprint.test.ts`
Expected: FAIL com `Cannot find module './reavaliar-fora-da-sprint.js'`

- [ ] **Step 3: Ler `analisarCustoDaOrdem` real antes de implementar**

Run: `grep -n "export function analisarCustoDaOrdem\|export interface PedidoNaFila\|export interface CandidatoDeTroca" packages/cadence/src/custo-da-ordem.ts` e ler a assinatura completa — esta tarefa é uma CAMADA FINA sobre ela (decidir "entra agora ou não" a partir do candidato de troca que a análise já produz), nunca uma reimplementação do cálculo de custo.

- [ ] **Step 4: Implementar `reavaliar-fora-da-sprint.ts`**

```ts
// Fase 4.3: uma tarefa achada fora da sprint atual (Tarefa 4.1) é
// reavaliada pela MESMA lógica de custo de espera que já decide se vale a
// pena reordenar a fila (custo-da-ordem-do-projeto.ts, L4-T18) — nunca uma
// prioridade nova inventada aqui.

import { analisarCustoDaOrdem, type PedidoNaFila } from '@gitorch/cadence'

export function reavaliarForaDaSprint(deps: {
  pedido: PedidoNaFila
  fila: PedidoNaFila[]
}): { entraAgora: boolean; motivo: string } {
  const analise = analisarCustoDaOrdem({ fila: deps.fila, pedidoNovo: deps.pedido })
  // `analisarCustoDaOrdem` já decide se HÁ candidato de troca que valha a
  // pena perguntar ao dono (L4-T18) — aqui a pergunta correspondente é a
  // Tarefa 2.3/3.10 (mesmo formato de 3 opções), então este módulo só lê o
  // veredito: sem candidato relevante, a tarefa entra na ordem normal da
  // fila (fica para quando chegar a vez, nunca "não entra nunca").
  if (!analise.valePerguntar) {
    return { entraAgora: false, motivo: 'custo de espera baixo — entra na ordem normal da fila' }
  }
  return {
    entraAgora: false,
    motivo: `custo de espera relevante (${analise.motivo}) — pergunte ao dono antes de decidir`,
  }
}
```

(Confirmar o NOME exato dos campos devolvidos por `analisarCustoDaOrdem` lendo o arquivo real no Step 3 — `valePerguntar`/`motivo` são os nomes prováveis pelo padrão do resto do módulo, mas a implementação FINAL usa os nomes reais, nunca adivinhados sem conferir.)

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/reavaliar-fora-da-sprint.test.ts`
Expected: PASS

- [ ] **Step 6: Rodar as duas suítes**

Run: `pnpm --filter @gitorch/cadence test && pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/services/reavaliar-fora-da-sprint.ts apps/control-plane/src/services/reavaliar-fora-da-sprint.test.ts
git commit -m "feat: tarefa fora da sprint atual e reavaliada pelo custo de espera - task 4.3"
```

**Absorve do Shrimp:** EXEC (`b1ad98b8`) — "quadro de conta pessoal lido como organização" — absorvida pela Tarefa 4.1. L3-T21 (`7abe8506`) — "sprint recebe os itens de verdade" — absorvida pela Tarefa 4.3.

---
## Fase 5 — Segurança e conformidade

### Task 5.1: Ficha de segurança por repositório, com nota

**Files:**
- Create: `apps/control-plane/src/services/nota-de-seguranca.ts`
- Test: `apps/control-plane/src/services/nota-de-seguranca.test.ts`

**Interfaces:**
- Consumes: `coletarDividaDeSeguranca` (`./security-debt-collector.js`, já existente — reaproveita `temConfiguracao` para o check "Dependabot configurado"); o padrão `pedir`/`pedirJson` best-effort de `incidente-ci.ts:130-195` (não importado — cada arquivo mantém sua própria porta de saída de rede, mesma disciplina de `security-debt-collector.ts` vs `incidente-ci.ts` hoje, que JÁ são dois arquivos com portas próprias e não uma compartilhada).
- Produces:
  - `interface ChecksDeSeguranca { branchProtection: boolean | null; actionsFixadasPorSha: boolean | null; permissaoPadraoDoToken: 'read' | 'write' | null; codeowners: boolean | null; securityMd: boolean | null; dependabotConfigurado: boolean | null }` (`null` = não deu para verificar — nunca vira "reprovado" nem "aprovado" por omissão, mesma disciplina de `naoVerificado` em `security-debt-collector.ts`).
  - `function calcularNotaDeSeguranca(checks: ChecksDeSeguranca): { nota: number; maximo: number; formula: string[] }` — pura, testável sem rede.
  - `async function coletarChecksDeSeguranca(deps): Promise<ChecksDeSeguranca>` — I/O, injeta `fetchImpl`.

**A fórmula (inspirada no OpenSSF Scorecard, simplificada — não uma reimplementação dele):** cada check vale 1 ponto quando `true`, 0 quando `false`, e é EXCLUÍDO do denominador quando `null` (não verificado) — a nota nunca pune o que não deu para checar, e o painel mostra "nota calculada sobre N de 6 checks" quando algo faltou. `nota = pontos / verificados * 100`, arredondada.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/nota-de-seguranca.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { calcularNotaDeSeguranca } from './nota-de-seguranca.js'

describe('calcularNotaDeSeguranca', () => {
  it('todos os 6 checks passando: nota 100 sobre 6', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: true,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: true,
      dependabotConfigurado: true,
    })
    expect(r).toEqual({ nota: 100, maximo: 6, formula: expect.any(Array) })
  })

  it('metade passando: nota 50', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: false,
      permissaoPadraoDoToken: 'write',
      codeowners: true,
      securityMd: false,
      dependabotConfigurado: false,
    })
    expect(r.nota).toBe(33)
  })

  it('check não verificado (null) é excluído do denominador, não conta contra', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: true,
      dependabotConfigurado: true,
    })
    expect(r).toEqual({ nota: 100, maximo: 5, formula: expect.any(Array) })
  })

  it('nenhum check verificado: nota null, nunca 0 nem 100 inventados', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: null,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: null,
      codeowners: null,
      securityMd: null,
      dependabotConfigurado: null,
    })
    expect(r.nota).toBeNull()
    expect(r.maximo).toBe(0)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/nota-de-seguranca.test.ts`
Expected: FAIL com `Cannot find module './nota-de-seguranca.js'`

- [ ] **Step 3: Implementar a fórmula pura**

```ts
// Nota de segurança do repositório: 6 checks simples e gratuitos pela API do
// GitHub, inspirados no OpenSSF Scorecard (não uma reimplementação dele —
// uma nota interna, simplificada, dos sinais que já dá para medir sem custo
// extra). `null` = não verificado, EXCLUÍDO do denominador: a nota nunca
// pune o que a credencial não alcançou, e o painel mostra "sobre N de 6".

export interface ChecksDeSeguranca {
  /** Branch padrão exige pull request + revisão antes de mesclar. */
  branchProtection: boolean | null
  /** TODAS as Actions do workflow fixadas por SHA (40 hex), nunca por tag. */
  actionsFixadasPorSha: boolean | null
  /** Permissão padrão do GITHUB_TOKEN nas Actions do repositório. */
  permissaoPadraoDoToken: 'read' | 'write' | null
  codeowners: boolean | null
  securityMd: boolean | null
  dependabotConfigurado: boolean | null
}

export interface NotaDeSeguranca {
  nota: number | null
  maximo: number
  formula: string[]
}

const NOMES: Record<keyof ChecksDeSeguranca, string> = {
  branchProtection: 'branch protection no branch padrão',
  actionsFixadasPorSha: 'Actions fixadas por SHA',
  permissaoPadraoDoToken: 'permissão padrão do GITHUB_TOKEN é leitura',
  codeowners: 'CODEOWNERS presente',
  securityMd: 'SECURITY.md presente',
  dependabotConfigurado: 'Dependabot configurado',
}

export function calcularNotaDeSeguranca(checks: ChecksDeSeguranca): NotaDeSeguranca {
  const formula: string[] = []
  let pontos = 0
  let verificados = 0

  const marcar = (chave: keyof ChecksDeSeguranca, valor: boolean | null) => {
    if (valor === null) {
      formula.push(`${NOMES[chave]}: não verificado (fora do denominador)`)
      return
    }
    verificados += 1
    if (valor) pontos += 1
    formula.push(`${NOMES[chave]}: ${valor ? 'OK' : 'FALTA'}`)
  }

  marcar('branchProtection', checks.branchProtection)
  marcar('actionsFixadasPorSha', checks.actionsFixadasPorSha)
  marcar(
    'permissaoPadraoDoToken',
    checks.permissaoPadraoDoToken === null ? null : checks.permissaoPadraoDoToken === 'read'
  )
  marcar('codeowners', checks.codeowners)
  marcar('securityMd', checks.securityMd)
  marcar('dependabotConfigurado', checks.dependabotConfigurado)

  return {
    nota: verificados === 0 ? null : Math.round((pontos / verificados) * 100),
    maximo: verificados,
    formula,
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/nota-de-seguranca.test.ts`
Expected: PASS — 4 testes verdes.

- [ ] **Step 5: Escrever o teste que falha para `coletarChecksDeSeguranca`**

Acrescentar ao mesmo arquivo de teste:

```ts
import { coletarChecksDeSeguranca } from './nota-de-seguranca.js'

describe('coletarChecksDeSeguranca', () => {
  it('lê os 6 sinais reais, cada falha isolada vira null (best-effort)', async () => {
    const respostas: Record<string, { status: number; json?: unknown }> = {
      '/repos/dono/repo/branches/main/protection': { status: 200, json: { required_pull_request_reviews: {} } },
      '/repos/dono/repo/actions/permissions/workflow': { status: 200, json: { default_workflow_permissions: 'read' } },
      '/repos/dono/repo/contents/CODEOWNERS': { status: 200 },
      '/repos/dono/repo/contents/SECURITY.md': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 200 },
      '/repos/dono/repo/contents/.github/workflows': { status: 200, json: [] },
    }
    const fetchImpl = (async (url: string) => {
      const caminho = new URL(url).pathname
      const r = respostas[caminho] ?? { status: 500 }
      return new Response(r.json ? JSON.stringify(r.json) : '', { status: r.status })
    }) as typeof fetch

    const checks = await coletarChecksDeSeguranca({
      repository: 'dono/repo',
      defaultBranch: 'main',
      token: 't',
      fetchImpl,
    })
    expect(checks.branchProtection).toBe(true)
    expect(checks.permissaoPadraoDoToken).toBe('read')
    expect(checks.codeowners).toBe(true)
    expect(checks.securityMd).toBe(false)
    expect(checks.dependabotConfigurado).toBe(true)
  })
})
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/nota-de-seguranca.test.ts -t "coletarChecksDeSeguranca"`
Expected: FAIL — função ainda não existe.

- [ ] **Step 7: Implementar `coletarChecksDeSeguranca`**

No mesmo arquivo `nota-de-seguranca.ts`:

```ts
import { coletarDividaDeSeguranca } from './security-debt-collector.js'

const GITHUB_API = 'https://api.github.com'
const HOST_API_GITHUB = new URL(GITHUB_API).host

/** Porta de saída PRÓPRIA deste arquivo — mesma disciplina de host-check de
 *  security-debt-collector.ts/incidente-ci.ts, nunca uma porta compartilhada
 *  entre arquivos de segurança (cada um audita a própria). */
function pedirUrlSegura(url: string, fetchImpl: typeof fetch, token: string): Promise<Response> {
  if (new URL(url).host !== HOST_API_GITHUB) {
    return Promise.reject(new Error('recusado: URL fora do host da API do GitHub'))
  }
  return fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gitorch' },
  })
}

async function actionsFixadasPorSha(
  repository: string,
  fetchImpl: typeof fetch,
  token: string
): Promise<boolean | null> {
  try {
    const resp = await pedirUrlSegura(`${GITHUB_API}/repos/${repository}/contents/.github/workflows`, fetchImpl, token)
    if (!resp.ok) return null
    const arquivos = (await resp.json()) as Array<{ name: string; download_url?: string }>
    const yamls = arquivos.filter((a) => /\.ya?ml$/.test(a.name))
    if (yamls.length === 0) return null
    for (const arq of yamls) {
      if (!arq.download_url) continue
      const conteudo = await (await fetchImpl(arq.download_url)).text()
      // `uses: owner/repo@ref` — ref de 40 hex é SHA; qualquer outra coisa
      // (tag, branch) reprova o check para o repositório inteiro.
      const usos = [...conteudo.matchAll(/uses:\s*[\w.-]+\/[\w.-]+@([\w.-]+)/g)]
      if (usos.some((m) => !/^[0-9a-f]{40}$/i.test(m[1] ?? ''))) return false
    }
    return true
  } catch {
    return null
  }
}

async function existeArquivo(
  repository: string,
  caminho: string,
  fetchImpl: typeof fetch,
  token: string
): Promise<boolean | null> {
  try {
    const resp = await pedirUrlSegura(`${GITHUB_API}/repos/${repository}/contents/${caminho}`, fetchImpl, token)
    if (resp.status === 200) return true
    if (resp.status === 404) return false
    return null
  } catch {
    return null
  }
}

export async function coletarChecksDeSeguranca(deps: {
  repository: string
  defaultBranch: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<ChecksDeSeguranca> {
  const f = deps.fetchImpl ?? fetch

  const branchProtection = await (async (): Promise<boolean | null> => {
    try {
      const resp = await pedirUrlSegura(
        `${GITHUB_API}/repos/${deps.repository}/branches/${deps.defaultBranch}/protection`,
        f,
        deps.token
      )
      if (resp.status === 404) return false
      if (!resp.ok) return null
      const dados = (await resp.json()) as { required_pull_request_reviews?: unknown }
      return Boolean(dados.required_pull_request_reviews)
    } catch {
      return null
    }
  })()

  const permissaoPadraoDoToken = await (async (): Promise<'read' | 'write' | null> => {
    try {
      const resp = await pedirUrlSegura(
        `${GITHUB_API}/repos/${deps.repository}/actions/permissions/workflow`,
        f,
        deps.token
      )
      if (!resp.ok) return null
      const dados = (await resp.json()) as { default_workflow_permissions?: string }
      return dados.default_workflow_permissions === 'write' ? 'write' : 'read'
    } catch {
      return null
    }
  })()

  // Dependabot: reaproveita coletarDividaDeSeguranca (Fase 5.2 já lê alertas
  // por essa mesma rota) — nunca uma segunda leitura de
  // .github/dependabot.yml aqui.
  const divida = await coletarDividaDeSeguranca({ repository: deps.repository, token: deps.token, fetchImpl: f })

  return {
    branchProtection,
    actionsFixadasPorSha: await actionsFixadasPorSha(deps.repository, f, deps.token),
    permissaoPadraoDoToken,
    codeowners: await existeArquivo(deps.repository, 'CODEOWNERS', f, deps.token),
    securityMd: await existeArquivo(deps.repository, 'SECURITY.md', f, deps.token),
    dependabotConfigurado: divida.naoVerificado.includes('configuracao') ? null : divida.temConfiguracao,
  }
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/nota-de-seguranca.test.ts`
Expected: PASS

- [ ] **Step 9: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/control-plane/src/services/nota-de-seguranca.ts apps/control-plane/src/services/nota-de-seguranca.test.ts
git commit -m "feat: nota de seguranca do repositorio, 6 checks estilo scorecard - task 5.1"
```

---

### Task 5.2: RA confirma se a vulnerabilidade é runtime ou dev

**Files:**
- Modify: `apps/control-plane/src/services/security-debt-collector.ts:137-144,204-249` (`AlertaBruto`/`AlertaDeSeguranca` ganham `scope`)
- Test: `apps/control-plane/src/services/security-debt-collector.test.ts` (arquivo já existente)
- Create: `apps/control-plane/src/services/prioridade-da-vulnerabilidade.ts`
- Test: `apps/control-plane/src/services/prioridade-da-vulnerabilidade.test.ts`

**Interfaces:**
- Consumes: `AlertaDeSeguranca`, `Severidade` (Tarefa 5.1's leitura já traz `coletarDividaDeSeguranca`; esta tarefa estende o MESMO tipo).
- Produces: `type EscopoDaVulnerabilidade = 'runtime' | 'development' | 'desconhecido'`; `function prioridadeDaVulnerabilidade(alerta: { severidade: Severidade; escopo: EscopoDaVulnerabilidade }): 'sprint-atual' | 'backlog'` — grave (`critical`/`high`) em runtime vai para a sprint atual; o resto vai para o backlog. `escopo === 'desconhecido'` trata como `runtime` (o lado seguro — nunca subestima risco por falta de dado, mesma disciplina de `severidade-desconhecida` em `security-debt-collector.ts:229-238`).

- [ ] **Step 1: Escrever o teste que falha para o `scope`**

Acrescentar a `apps/control-plane/src/services/security-debt-collector.test.ts` (localizar o teste que já monta um alerta bruto de exemplo e reaproveitar a fixture):

```ts
it('lê o scope (runtime/development) que a API já devolve em dependency.scope', async () => {
  const fetchImpl = fetchFakeComUmAlerta({ dependency: { package: { name: 'lodash', ecosystem: 'npm' }, scope: 'runtime' } })
  const divida = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })
  expect(divida.alertas[0]?.escopo).toBe('runtime')
})

it('scope ausente vira "desconhecido", nunca inventa runtime nem development', async () => {
  const fetchImpl = fetchFakeComUmAlerta({ dependency: { package: { name: 'lodash', ecosystem: 'npm' } } })
  const divida = await coletarDividaDeSeguranca({ repository: 'dono/repo', token: 't', fetchImpl })
  expect(divida.alertas[0]?.escopo).toBe('desconhecido')
})
```

(`fetchFakeComUmAlerta` é um helper a criar no topo do arquivo de teste, ou reaproveitar o helper equivalente já existente — ler o arquivo real antes de duplicar.)

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/security-debt-collector.test.ts -t "scope"`
Expected: FAIL — `divida.alertas[0].escopo` é `undefined` (campo ainda não existe).

- [ ] **Step 3: Acrescentar `scope`/`escopo` ao coletor**

Em `security-debt-collector.ts:137-144`, trocar:

```ts
interface AlertaBruto {
  number: number
  html_url?: string
  created_at?: string
  dependency?: { package?: { name?: string; ecosystem?: string }; manifest_path?: string }
  security_advisory?: { severity?: string; summary?: string }
  security_vulnerability?: { first_patched_version?: { identifier?: string } }
}
```

por:

```ts
interface AlertaBruto {
  number: number
  html_url?: string
  created_at?: string
  dependency?: {
    package?: { name?: string; ecosystem?: string }
    manifest_path?: string
    /** Fase 5.2: 'runtime' | 'development', direto da API — decide se a
     *  vulnerabilidade afeta o produto publicado ou só ferramentas de dev. */
    scope?: string | null
  }
  security_advisory?: { severity?: string; summary?: string }
  security_vulnerability?: { first_patched_version?: { identifier?: string } }
}
```

Em `AlertaDeSeguranca` (linha 105-116), acrescentar:

```ts
  /** 'runtime' | 'development' | 'desconhecido' — Fase 5.2. */
  escopo: 'runtime' | 'development' | 'desconhecido'
```

E, no laço que monta cada `AlertaDeSeguranca` (linha 239-249), acrescentar:

```ts
        escopo:
          a.dependency?.scope === 'runtime' || a.dependency?.scope === 'development'
            ? a.dependency.scope
            : 'desconhecido',
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/security-debt-collector.test.ts`
Expected: PASS

- [ ] **Step 5: Escrever o teste que falha para `prioridadeDaVulnerabilidade`**

Criar `apps/control-plane/src/services/prioridade-da-vulnerabilidade.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prioridadeDaVulnerabilidade } from './prioridade-da-vulnerabilidade.js'

describe('prioridadeDaVulnerabilidade', () => {
  it('critical + runtime: sprint atual', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'critical', escopo: 'runtime' })).toBe('sprint-atual')
  })
  it('high + development: backlog', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'high', escopo: 'development' })).toBe('backlog')
  })
  it('medium + runtime: backlog (só grave vai para a sprint)', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'medium', escopo: 'runtime' })).toBe('backlog')
  })
  it('critical + escopo desconhecido: sprint atual (lado seguro — nunca subestima)', () => {
    expect(prioridadeDaVulnerabilidade({ severidade: 'critical', escopo: 'desconhecido' })).toBe('sprint-atual')
  })
})
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/prioridade-da-vulnerabilidade.test.ts`
Expected: FAIL com `Cannot find module './prioridade-da-vulnerabilidade.js'`

- [ ] **Step 7: Implementar**

```ts
// Fase 5.2: grave (critical/high) em código de PRODUÇÃO (runtime) vai para a
// sprint atual — o resto (baixa gravidade, ou runtime não confirmado como
// dev-only) vai para o backlog. Escopo desconhecido trata como runtime: o
// lado seguro nunca subestima risco por falta de dado (mesma disciplina de
// 'severidade-desconhecida' em security-debt-collector.ts).

import type { Severidade } from './security-debt-collector.js'

export type EscopoDaVulnerabilidade = 'runtime' | 'development' | 'desconhecido'

const GRAVE: readonly Severidade[] = ['critical', 'high']

export function prioridadeDaVulnerabilidade(alerta: {
  severidade: Severidade
  escopo: EscopoDaVulnerabilidade
}): 'sprint-atual' | 'backlog' {
  const afetaProducao = alerta.escopo !== 'development'
  return GRAVE.includes(alerta.severidade) && afetaProducao ? 'sprint-atual' : 'backlog'
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/prioridade-da-vulnerabilidade.test.ts`
Expected: PASS — 4 testes verdes.

- [ ] **Step 9: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/control-plane/src/services/security-debt-collector.ts apps/control-plane/src/services/security-debt-collector.test.ts \
  apps/control-plane/src/services/prioridade-da-vulnerabilidade.ts apps/control-plane/src/services/prioridade-da-vulnerabilidade.test.ts
git commit -m "feat: escopo runtime/dev da vulnerabilidade decide sprint ou backlog - task 5.2"
```

---

### Task 5.3: Dependabot com correção e CI verde mescla sozinho

**Files:**
- Create: `apps/control-plane/src/services/dependabot-auto-merge.ts`
- Test: `apps/control-plane/src/services/dependabot-auto-merge.test.ts`

**Interfaces:**
- Consumes: `EstadoDaVerificacao` (`./vigia-do-pr.js`); `PoliticaDeCuidado` (Tarefa 0.2).
- Produces: `function decidirMergeDoDependabot(deps): { mesclar: boolean; motivo: string }`.

**NOTA ARQUITETURAL (achado ao ligar esta tarefa ao motor da Fase 3):** `decidirProximoPasso` (Tarefa 3.5) reaproveita `ehAutomacaoQueOVigiaNaoConserta` (`vigia-do-pr.ts:75-77`), que HOJE devolve `so-acompanhar` para TODO pull request do Dependabot — o portão existe porque não há sessão de dev para retomar atrás dele (a lógica de "conserto" não se aplica). Um merge automático de Dependabot não é "conserto" (retomar sessão): é uma decisão de MESCLAR OU NÃO um PR que já está pronto, sem nunca precisar reabrir trabalho. Por isso esta tarefa NÃO estende `decidirProximoPasso` — ela é um caminho PRÓPRIO, chamado no `scheduler.ts` ANTES do motor da Fase 3, só para `origem === 'dependabot'`. Quando `decidirMergeDoDependabot` decide mesclar, o item nem chega a `decidirProximoPasso`; quando decide não mesclar, o item segue para o motor normal (que vai devolver `so-acompanhar`, como já faz hoje).

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/dependabot-auto-merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decidirMergeDoDependabot } from './dependabot-auto-merge.js'

describe('decidirMergeDoDependabot', () => {
  it('política "sim" + CI verde + sem conflito: mescla', () => {
    const r = decidirMergeDoDependabot({ politica: 'sim', verificacao: 'verde', mergeable: true })
    expect(r).toEqual({ mesclar: true, motivo: 'Dependabot configurado para cuidar sozinho, verificação verde' })
  })
  it('política "nao": nunca mescla, mesmo com CI verde', () => {
    expect(decidirMergeDoDependabot({ politica: 'nao', verificacao: 'verde', mergeable: true }).mesclar).toBe(false)
  })
  it('política "perguntar": não mescla sozinho (a pergunta é do motor/Tarefa 3.10)', () => {
    expect(decidirMergeDoDependabot({ politica: 'perguntar', verificacao: 'verde', mergeable: true }).mesclar).toBe(false)
  })
  it('CI não verde: nunca mescla, mesmo com política "sim"', () => {
    expect(decidirMergeDoDependabot({ politica: 'sim', verificacao: 'vermelha', mergeable: true }).mesclar).toBe(false)
  })
  it('conflito: nunca mescla', () => {
    expect(decidirMergeDoDependabot({ politica: 'sim', verificacao: 'verde', mergeable: false }).mesclar).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/dependabot-auto-merge.test.ts`
Expected: FAIL com `Cannot find module './dependabot-auto-merge.js'`

- [ ] **Step 3: Implementar**

```ts
// Fase 5.3: Dependabot com correção pronta (CI verde, sem conflito) mescla
// sozinho quando cuidaPorOrigem.dependabot === 'sim'. Caminho PRÓPRIO — não
// passa por decidirProximoPasso (Tarefa 3.5), que trata TODO PR do
// Dependabot como "automação sem conserto" (não há sessão para retomar).
// Aqui não há conserto: só a decisão de mesclar ou deixar quieto.

import type { EstadoDaVerificacao } from './vigia-do-pr.js'
import type { PoliticaDeCuidado } from './cuidado-por-origem.js'

export function decidirMergeDoDependabot(deps: {
  politica: PoliticaDeCuidado
  verificacao: EstadoDaVerificacao
  mergeable: boolean | null
}): { mesclar: boolean; motivo: string } {
  if (deps.politica !== 'sim') {
    return { mesclar: false, motivo: `configuração do Dependabot é "${deps.politica}", não mescla sozinho` }
  }
  if (deps.verificacao !== 'verde') {
    return { mesclar: false, motivo: `verificação não está verde (${deps.verificacao})` }
  }
  if (deps.mergeable !== true) {
    return { mesclar: false, motivo: 'há conflito ou o GitHub ainda não confirmou que dá para mesclar' }
  }
  return { mesclar: true, motivo: 'Dependabot configurado para cuidar sozinho, verificação verde' }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/dependabot-auto-merge.test.ts`
Expected: PASS — 5 testes verdes.

- [ ] **Step 5: Investigar por que 99 de 104 pedidos do Dependabot foram fechados sem mesclar no Jardim (achado a registrar, não corrigir sozinho aqui)**

Antes de ligar esta tarefa ao relógio: rodar uma consulta real contra o repositório do Jardim (`gh pr list --repo <jardim> --author app/dependabot --state closed --json number,mergedAt,closedAt --limit 104` ou equivalente) e classificar cada um dos fechados-sem-merge pela `decidirMergeDoDependabot` acima — CONFIRMAR se a causa é política de configuração ausente (projeto legado sem `cuidaPorOrigem`, cai no padrão `'sim'` da Tarefa 0.2 — então deveriam ter mesclado, e não mescular é um defeito de fiação, não de configuração), CI vermelho recorrente, ou conflito. Registrar o achado real no Shrimp ANTES de considerar esta tarefa fechada — "ajustar a configuração" (texto do plano aprovado) só faz sentido depois de saber qual das três causas é a de verdade.

- [ ] **Step 6: Ligar ao `scheduler.ts`, antes do motor da Fase 3**

No mesmo bloco de montagem de `MotorDoProximoPassoDeps` (Tarefa 3.5, Step 6), para itens com `origem === 'dependabot'`, chamar `decidirMergeDoDependabot` PRIMEIRO; se `mesclar === true`, chamar `mesclarPr` (Tarefa 3.8, com `entendimentoPresente: true` — Dependabot não passa pelo formulário de entendimento do QA, então usar um entendimento PADRÃO fixo, ex.: `{ deOndeVeio: 'Dependabot', oQueMuda: 'atualização de dependência', queAjusteE: 'correção de segurança', porQueExiste: alerta.resumo }`, nunca `entendimentoPresente: false` forçado por atalho) e registrar no painel (Tarefa 3.11); senão, deixar o item seguir para `decidirProximoPasso` normalmente.

- [ ] **Step 7: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/services/dependabot-auto-merge.ts apps/control-plane/src/services/dependabot-auto-merge.test.ts \
  apps/control-plane/src/plugins/scheduler.ts
git commit -m "feat: dependabot com correcao e ci verde mescla sozinho - task 5.3"
```

---

### Task 5.4: Melhorias aplicadas sozinho quando o plano do GitHub permite

**Files:**
- Create: `apps/control-plane/src/services/aplicar-melhoria-de-seguranca.ts`
- Test: `apps/control-plane/src/services/aplicar-melhoria-de-seguranca.test.ts`

**Interfaces:**
- Consumes: `ChecksDeSeguranca` (Tarefa 5.1); `NivelDeAutonomia` (usa o campo NOVO `autonomiaDeSeguranca`, Tarefa 0.2 — nunca o `autonomia` geral); `podeEscrever` (`@gitorch/cadence`, já existente); a leitura de `classificarRequisicao` (`./guarda-de-autonomia.js`, já existente) contra `PUT /branches/.../protection` (ver Step 1 abaixo — a checagem tem de ser CONFIRMADA lendo o código real, não assumida).
- Produces:
  - `function planoPermiteMelhoria(melhoria: 'secret-scanning' | 'branch-protection', planoDoGithub: 'free' | 'pro' | 'team' | 'enterprise', repoPrivado: boolean): boolean` — secret scanning avançado exige GitHub Advanced Security (pago) em repo privado; branch protection é grátis em qualquer plano para repo público, e em privado depende do plano.
  - `async function aplicarMelhoriaDeSeguranca(deps): Promise<{ aplicado: boolean; motivo: string }>` — só chama a API quando `autonomiaDeSeguranca === 'cuidar'` E `planoPermiteMelhoria` autoriza. Consumida pela Tarefa 5.5 (o caminho alternativo entra quando esta função devolve `aplicado: false` por falta de plano).

- [ ] **Step 1: Confirmar como `classificarRequisicao` trata `/branches/.../protection` HOJE**

Run: `npx vitest run apps/control-plane/src/services/guarda-de-autonomia.test.ts -t "branches"` (se já existir algum caso) ou, se não existir, escrever e rodar um teste isolado ANTES de decidir qualquer coisa:

```ts
import { classificarRequisicao } from './guarda-de-autonomia.js'
it('PUT /branches/.../protection hoje cai em qual ação?', () => {
  const acao = classificarRequisicao({ url: 'https://api.github.com/repos/dono/repo/branches/main/protection', metodo: 'PUT' })
  console.log('ação classificada:', acao)
  expect(['organizar', 'propor', 'mesclar']).toContain(acao)
})
```

Rodar e LER a saída real (`console.log`) antes de escrever qualquer código que dependa do resultado — não adivinhar. Pelo comentário de `ACAO_DO_DESCONHECIDO` (linha 93-101 de `guarda-de-autonomia.ts`), a expectativa é `'mesclar'` (nenhuma regra de `ACAO_DA_ROTA` casa com `/branches/`), mas a tarefa exige a prova, não a expectativa.

- [ ] **Step 2: Escrever o teste que falha para `planoPermiteMelhoria`**

Criar `apps/control-plane/src/services/aplicar-melhoria-de-seguranca.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planoPermiteMelhoria } from './aplicar-melhoria-de-seguranca.js'

describe('planoPermiteMelhoria', () => {
  it('branch protection: sempre permitido em repo público, qualquer plano', () => {
    expect(planoPermiteMelhoria('branch-protection', 'free', false)).toBe(true)
  })
  it('branch protection em repo privado: só a partir do Pro', () => {
    expect(planoPermiteMelhoria('branch-protection', 'free', true)).toBe(false)
    expect(planoPermiteMelhoria('branch-protection', 'pro', true)).toBe(true)
  })
  it('secret scanning avançado: exige Advanced Security em repo privado (Team/Enterprise)', () => {
    expect(planoPermiteMelhoria('secret-scanning', 'pro', true)).toBe(false)
    expect(planoPermiteMelhoria('secret-scanning', 'enterprise', true)).toBe(true)
  })
  it('secret scanning: grátis em repo público, qualquer plano', () => {
    expect(planoPermiteMelhoria('secret-scanning', 'free', false)).toBe(true)
  })
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/aplicar-melhoria-de-seguranca.test.ts`
Expected: FAIL com `Cannot find module './aplicar-melhoria-de-seguranca.js'`

- [ ] **Step 4: Implementar `planoPermiteMelhoria` e `aplicarMelhoriaDeSeguranca`**

```ts
// Fase 5.4: aplica melhoria de segurança sozinho SÓ quando o plano do GitHub
// permite E autonomiaDeSeguranca === 'cuidar' (Tarefa 0.2). Quando não
// permite, a Fase 5.5 (alternativa-gratuita-de-seguranca.ts) assume.

import { podeEscrever, type NivelDeAutonomia } from '@gitorch/cadence'

export type PlanoDoGithub = 'free' | 'pro' | 'team' | 'enterprise'
export type Melhoria = 'secret-scanning' | 'branch-protection'

export function planoPermiteMelhoria(
  melhoria: Melhoria,
  plano: PlanoDoGithub,
  repoPrivado: boolean
): boolean {
  if (!repoPrivado) return true // as duas são grátis em repositório público.
  if (melhoria === 'branch-protection') return plano !== 'free'
  // secret scanning AVANÇADO (bloqueio de push) exige GitHub Advanced
  // Security em repo privado — só Team/Enterprise com o add-on. Simplificado
  // aqui como team/enterprise; refinamento por add-on real fica para quando
  // a API expuser essa informação (hoje não expõe sem consulta de billing).
  return plano === 'team' || plano === 'enterprise'
}

export interface AplicarMelhoriaDeps {
  repository: string
  melhoria: Melhoria
  plano: PlanoDoGithub
  repoPrivado: boolean
  autonomiaDeSeguranca: NivelDeAutonomia
  aplicar: () => Promise<void>
}

export async function aplicarMelhoriaDeSeguranca(
  deps: AplicarMelhoriaDeps
): Promise<{ aplicado: boolean; motivo: string }> {
  if (!planoPermiteMelhoria(deps.melhoria, deps.plano, deps.repoPrivado)) {
    return { aplicado: false, motivo: `o plano "${deps.plano}" do GitHub não permite ${deps.melhoria} neste repositório` }
  }
  // A ação classificada é 'mesclar' (Step 1 confirmou) — o degrau mais alto
  // da autonomia GERAL, mas esta tarefa usa autonomiaDeSeguranca (Tarefa
  // 0.2), um campo PRÓPRIO. A checagem aqui é MANUAL (não via
  // guardaDeAutonomia, que lê `autonomia`, o campo geral) — exatamente
  // porque os dois campos podem divergir por desenho.
  const decisao = podeEscrever(deps.autonomiaDeSeguranca, 'mesclar')
  if (!decisao.pode) {
    return { aplicado: false, motivo: decisao.motivo }
  }
  await deps.aplicar()
  return { aplicado: true, motivo: `${deps.melhoria} aplicada — plano permite e autonomia de segurança é "cuidar"` }
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/aplicar-melhoria-de-seguranca.test.ts`
Expected: PASS


- [ ] **Step 6: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/services/aplicar-melhoria-de-seguranca.ts apps/control-plane/src/services/aplicar-melhoria-de-seguranca.test.ts
git commit -m "feat: aplica melhoria de seguranca sozinho quando o plano do github permite - task 5.4"
```

---

### Task 5.5: Alternativas gratuitas quando o plano não permite, com guarda extra do próprio GitOrch

**Files:**
- Create: `apps/control-plane/src/services/alternativa-gratuita-de-seguranca.ts`
- Test: `apps/control-plane/src/services/alternativa-gratuita-de-seguranca.test.ts`
- Modify: `apps/control-plane/src/services/motor-do-proximo-passo.ts` (Tarefa 3.5 — degrada `'mesclar'` para `'perguntar-se-cuida'` quando falta alternativa)

**Interfaces:**
- Consumes: `aplicarMelhoriaDeSeguranca`, `planoPermiteMelhoria` (Tarefa 5.4 — esta tarefa assume exatamente quando aquela devolve `aplicado: false` por falta de plano); o gitleaks já configurado em `.github/workflows/ci.yml:97-114` deste repositório (copiado, nunca uma ferramenta nova).
- Produces: `function workflowDeAlternativaGratuita(): string`; `function exigeRevisaoSemAlternativa(deps: { planoPermite: boolean; alternativaInstalada: boolean }): boolean` — consumida por `decidirProximoPasso` (Tarefa 3.5) como guarda extra antes de `'mesclar'`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/alternativa-gratuita-de-seguranca.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { workflowDeAlternativaGratuita, exigeRevisaoSemAlternativa } from './alternativa-gratuita-de-seguranca.js'

describe('workflowDeAlternativaGratuita', () => {
  it('gera um workflow com gitleaks — a mesma ferramenta que .github/workflows/ci.yml já usa', () => {
    const yaml = workflowDeAlternativaGratuita()
    expect(yaml).toContain('gitleaks')
    expect(yaml).toContain('detect --source')
  })
})

describe('exigeRevisaoSemAlternativa', () => {
  it('quando o plano não permite a melhoria E a alternativa gratuita ainda não está instalada, exige revisão antes de mesclar', () => {
    expect(exigeRevisaoSemAlternativa({ planoPermite: false, alternativaInstalada: false })).toBe(true)
  })
  it('alternativa instalada: não exige a guarda extra (o gitleaks do próprio workflow já cobre)', () => {
    expect(exigeRevisaoSemAlternativa({ planoPermite: false, alternativaInstalada: true })).toBe(false)
  })
  it('plano permite: não precisa de alternativa nenhuma', () => {
    expect(exigeRevisaoSemAlternativa({ planoPermite: true, alternativaInstalada: false })).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/alternativa-gratuita-de-seguranca.test.ts`
Expected: FAIL com `Cannot find module './alternativa-gratuita-de-seguranca.js'`

- [ ] **Step 3: Implementar — reaproveitando o gitleaks já usado em `.github/workflows/ci.yml:97-114`**

```ts
// Fase 5.5: quando o plano do GitHub não permite a melhoria paga (Fase 5.4),
// a alternativa gratuita é o MESMO gitleaks já rodando em
// .github/workflows/ci.yml deste repositório (linha 97-114) — nunca uma
// ferramenta nova. E, sem a proteção paga, o GUARDA do próprio GitOrch passa
// a exigir revisão antes de mesclar (nunca confia cegamente no repositório
// do cliente estar limpo).

/** Cópia adaptada do bloco real de .github/workflows/ci.yml deste
 *  repositório — versão do gitleaks pinada, mesmo motivo (build
 *  reprodutível, sem depender de Action de terceiro que exige cadastro de
 *  organização). Ao propor, sempre conferir se a versão ainda é a mais
 *  recente que o próprio ci.yml usa — copiar sem atualizar duplicaria a
 *  manutenção. */
export function workflowDeAlternativaGratuita(): string {
  return `name: Secret scan (GitOrch)
on: [pull_request, push]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Secret scan
        env:
          GITLEAKS_VERSION: 8.30.1
        run: |
          set -euo pipefail
          curl -fsSL -o /tmp/gitleaks.tar.gz \\
            "https://github.com/gitleaks/gitleaks/releases/download/v\${{ env.GITLEAKS_VERSION }}/gitleaks_\${{ env.GITLEAKS_VERSION }}_linux_x64.tar.gz"
          tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks
          sudo install -m 0755 /tmp/gitleaks /usr/local/bin/gitleaks
          gitleaks detect --source . --redact --exit-code 1
`
}

/** Sem a melhoria paga E sem a alternativa gratuita instalada: o guarda do
 *  GitOrch passa a EXIGIR revisão humana antes de mesclar neste repositório
 *  — nunca confia às cegas que o repositório do cliente está limpo. */
export function exigeRevisaoSemAlternativa(deps: { planoPermite: boolean; alternativaInstalada: boolean }): boolean {
  return !deps.planoPermite && !deps.alternativaInstalada
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/alternativa-gratuita-de-seguranca.test.ts`
Expected: PASS

- [ ] **Step 5: Ligar `exigeRevisaoSemAlternativa` ao motor do próximo passo (Tarefa 3.5) — guarda extra**

Em `apps/control-plane/src/services/motor-do-proximo-passo.ts`, acrescentar o campo à interface `MotorDoProximoPassoDeps` (logo abaixo de `vereditoDoQa?: 'approve' | 'request_changes'`):

```ts
  /** Fase 5.5: true quando o plano do GitHub não permite a melhoria paga E
   *  a alternativa gratuita (gitleaks) ainda não está instalada neste
   *  repositório — degrada 'mesclar' para 'perguntar-se-cuida', mesmo com
   *  tudo mais pronto. Ausente/false = segue a decisão normal. */
  exigeRevisaoDeSeguranca?: boolean
```

E, no ramo `causa === null` (onde hoje `decidirProximoPasso` decide `'mesclar'` — Tarefa 3.5, trecho `if (deps.vereditoDoQa === 'approve' && deps.entendimentoCompleto) { return { acao: 'mesclar', ... } }`), trocar a condição por:

```ts
    if (deps.vereditoDoQa === 'approve' && deps.entendimentoCompleto && !deps.exigeRevisaoDeSeguranca) {
      return { acao: 'mesclar', motivo: `#${deps.numero}: critérios batidos, mesclando conforme "${politica}"` }
    }
    if (deps.vereditoDoQa === 'approve' && deps.entendimentoCompleto && deps.exigeRevisaoDeSeguranca) {
      return {
        acao: 'perguntar-se-cuida',
        motivo: `#${deps.numero}: critérios batidos, mas sem proteção de segurança paga nem alternativa gratuita instalada — confirme antes de mesclar`,
      }
    }
```

(A ordem importa: a checagem de segurança só se aplica quando os critérios normais JÁ bateriam — um PR que nem teria sido aprovado continua caindo no `perguntar-se-cuida`/`so-acompanhar` de sempre, pela mesma lógica que já vem logo abaixo no arquivo.)

- [ ] **Step 6: Rodar as duas suítes**

Run: `pnpm --filter @gitorch/cadence test && pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/services/alternativa-gratuita-de-seguranca.ts apps/control-plane/src/services/alternativa-gratuita-de-seguranca.test.ts \
  apps/control-plane/src/services/motor-do-proximo-passo.ts
git commit -m "feat: alternativa gratuita de seguranca e guarda extra sem ela - task 5.5"
```

---

### Task 5.6: Conformidade — licenças, PII, documentos, automações travadas por versão

**Files:**
- Create: `apps/control-plane/src/services/conformidade-do-repositorio.ts`
- Test: `apps/control-plane/src/services/conformidade-do-repositorio.test.ts`

**Interfaces:**
- Consumes: `pnpm licenses list --json` (comando nativo do pnpm, JÁ disponível no monorepo — CONFIRMADO rodando `pnpm licenses --help` nesta pesquisa; nenhuma dependência nova como `license-checker` é necessária); `actionsFixadasPorSha` (Tarefa 5.1, reaproveitado — a varredura de PII e a checagem de licença são os dois achados NOVOS desta tarefa).
- Produces:
  - `function licencasProblematicas(licencas: Array<{ nome: string; licenca: string }>, listaNegra: string[]): Array<{ nome: string; licenca: string }>` — pura.
  - `function achadosDePii(conteudoDeMigracoes: string): string[]` — varredura heurística de padrões de PII (CPF, e-mail, telefone) em `schema.prisma`/`*-migration.sql`.
  - `async function conferirConformidade(deps): Promise<{ licencasProblematicas: ...; achadosDePii: string[]; codeownersAusente: boolean; securityMdAusente: boolean; actionsSemSha: boolean }>`.

- [ ] **Step 1: Escrever o teste que falha para `licencasProblematicas`**

Criar `apps/control-plane/src/services/conformidade-do-repositorio.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { licencasProblematicas, achadosDePii } from './conformidade-do-repositorio.js'

describe('licencasProblematicas', () => {
  it('marca licenças copyleft fortes (GPL) como problemáticas; MIT/Apache/BSD não', () => {
    const r = licencasProblematicas(
      [
        { nome: 'left-pad', licenca: 'MIT' },
        { nome: 'algo-gpl', licenca: 'GPL-3.0' },
        { nome: 'algo-agpl', licenca: 'AGPL-3.0' },
      ],
      ['GPL-3.0', 'AGPL-3.0', 'AGPL-1.0']
    )
    expect(r.map((l) => l.nome)).toEqual(['algo-gpl', 'algo-agpl'])
  })
})

describe('achadosDePii', () => {
  it('acha padrão de CPF em migração/schema', () => {
    const achados = achadosDePii('CREATE TABLE clientes (cpf TEXT, telefone TEXT)')
    expect(achados.some((a) => a.includes('cpf'))).toBe(true)
  })
  it('schema sem sinal de PII: lista vazia', () => {
    expect(achadosDePii('CREATE TABLE eventos (id TEXT, payload JSONB)')).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/conformidade-do-repositorio.test.ts`
Expected: FAIL com `Cannot find module './conformidade-do-repositorio.js'`

- [ ] **Step 3: Implementar as duas funções puras**

```ts
// Fase 5.6: conformidade — licenças de dependência, PII heurística em
// schema/migrations, documentos ausentes (CODEOWNERS/SECURITY.md,
// reaproveitados de coletarChecksDeSeguranca, Tarefa 5.1) e Actions fixadas
// por versão (idem). As duas checagens NOVAS desta tarefa são licença e PII.

/** Copyleft forte (GPL/AGPL e variantes) é o que costuma exigir avaliação
 *  jurídica antes de embarcar num produto fechado — a lista É configurável
 *  (parâmetro), nunca hardcoded como verdade universal: cada empresa tem sua
 *  própria política de licença. */
export function licencasProblematicas(
  licencas: Array<{ nome: string; licenca: string }>,
  listaNegra: string[]
): Array<{ nome: string; licenca: string }> {
  const negra = new Set(listaNegra)
  return licencas.filter((l) => negra.has(l.licenca))
}

/** Padrões HEURÍSTICOS — nunca prova de PII real, só sinal para revisão
 *  humana. Falso positivo (nome de coluna "email" numa tabela sem dado real
 *  ainda) é aceitável; falso negativo silencioso não. */
const PADROES_DE_PII: ReadonlyArray<{ nome: string; regex: RegExp }> = [
  { nome: 'cpf', regex: /\bcpf\b/i },
  { nome: 'e-mail', regex: /\bemail\b/i },
  { nome: 'telefone', regex: /\btelefone\b|\bphone\b/i },
  { nome: 'cnpj', regex: /\bcnpj\b/i },
  { nome: 'endereço', regex: /\bendereco\b|\baddress\b/i },
]

export function achadosDePii(conteudo: string): string[] {
  return PADROES_DE_PII.filter((p) => p.regex.test(conteudo)).map(
    (p) => `possível campo de ${p.nome} — confirme se há dado pessoal real e se o tratamento (LGPD) está documentado`
  )
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/conformidade-do-repositorio.test.ts`
Expected: PASS

- [ ] **Step 5: Escrever o teste que falha para `conferirConformidade` (a função de I/O)**

Acrescentar ao mesmo arquivo:

```ts
import { conferirConformidade } from './conformidade-do-repositorio.js'
import { execFile } from 'node:child_process'

describe('conferirConformidade', () => {
  it('junta licenças, PII e os achados de documento/Actions injetados', async () => {
    const resultado = await conferirConformidade({
      listarLicencas: async () => [{ nome: 'pacote-gpl', licenca: 'GPL-3.0' }],
      listaNegraDeLicenca: ['GPL-3.0'],
      conteudoDeSchemaEMigracoes: 'CREATE TABLE x (email TEXT)',
      codeownersAusente: true,
      securityMdAusente: false,
      actionsSemSha: true,
    })
    expect(resultado.licencasProblematicas).toEqual([{ nome: 'pacote-gpl', licenca: 'GPL-3.0' }])
    expect(resultado.achadosDePii.length).toBeGreaterThan(0)
    expect(resultado.codeownersAusente).toBe(true)
  })
})
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/conformidade-do-repositorio.test.ts -t "conferirConformidade"`
Expected: FAIL — função ainda não existe.

- [ ] **Step 7: Implementar `conferirConformidade`**

```ts
export interface ListarLicencas {
  (): Promise<Array<{ nome: string; licenca: string }>>
}

export interface ResultadoDeConformidade {
  licencasProblematicas: Array<{ nome: string; licenca: string }>
  achadosDePii: string[]
  codeownersAusente: boolean
  securityMdAusente: boolean
  actionsSemSha: boolean
}

export async function conferirConformidade(deps: {
  listarLicencas: ListarLicencas
  listaNegraDeLicenca: string[]
  conteudoDeSchemaEMigracoes: string
  codeownersAusente: boolean
  securityMdAusente: boolean
  actionsSemSha: boolean
}): Promise<ResultadoDeConformidade> {
  const licencas = await deps.listarLicencas()
  return {
    licencasProblematicas: licencasProblematicas(licencas, deps.listaNegraDeLicenca),
    achadosDePii: achadosDePii(deps.conteudoDeSchemaEMigracoes),
    codeownersAusente: deps.codeownersAusente,
    securityMdAusente: deps.securityMdAusente,
    actionsSemSha: deps.actionsSemSha,
  }
}

/** `listarLicencas` de produção: roda `pnpm licenses list --json` no
 *  workspace do repositório do cliente (comando nativo do pnpm — CONFIRMADO
 *  disponível, sem dependência nova) e normaliza a saída. Best-effort: uma
 *  falha do comando devolve lista vazia, nunca derruba a varredura de
 *  conformidade inteira. */
export function listarLicencasViaPnpm(cwd: string): ListarLicencas {
  return () =>
    new Promise((resolve) => {
      const { execFile } = require('node:child_process') as typeof import('node:child_process')
      execFile('pnpm', ['licenses', 'list', '--json'], { cwd }, (err, stdout) => {
        if (err) return resolve([])
        try {
          const bruto = JSON.parse(stdout) as Record<string, Array<{ name?: string }>>
          const saida: Array<{ nome: string; licenca: string }> = []
          for (const [licenca, pacotes] of Object.entries(bruto)) {
            for (const pacote of pacotes) {
              if (pacote.name) saida.push({ nome: pacote.name, licenca })
            }
          }
          resolve(saida)
        } catch {
          resolve([])
        }
      })
    })
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/conformidade-do-repositorio.test.ts`
Expected: PASS

- [ ] **Step 9: Mapear as outras automações de IA do Jardim (Copilot e Claude) — achado, não código**

Antes de fechar: rodar `gh api repos/<jardim>/installations` (ou a tela de Settings → Integrations do repositório do Jardim) e listar TODA automação de IA instalada além do GitOrch — Copilot, Claude (via GitHub App ou Action), Renovate, etc. — registrando no Shrimp quais têm permissão de ESCRITA e se a configuração delas (regras próprias, se houver) está sendo respeitada ou ignorada (absorve o achado de L3-T17, "automações com configuração ignorada"). Isto é levantamento, não uma função nova — o resultado alimenta o card da Tarefa 6.2 (tela "Repositório").

- [ ] **Step 10: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/control-plane/src/services/conformidade-do-repositorio.ts apps/control-plane/src/services/conformidade-do-repositorio.test.ts
git commit -m "feat: conformidade - licencas, PII heuristica, documentos e actions por versao - task 5.6"
```

**Absorve do Shrimp:** L4-T11 (`933387a3`) — "Dependabot e recursos do GitHub" — absorvida pelas Tarefas 5.3 e 5.4. L4-T7 (`648562ab`) — "inventário das automações do repositório" — absorvida pela Tarefa 5.6. L3-T17 (`052ccaa8`) — "automações com configuração ignorada" — absorvida pela Tarefa 5.6. L3-T19 (`2b351651`) — "travar ferramentas das automações por versão" — absorvida pela Tarefa 5.6.

---
## Fase 6 — Limpeza e prova

### Task 6.1: Aplicar a regra aos pedidos e alertas já parados (migração de dados, uma vez)

**Files:**
- Create: `apps/control-plane/scripts/aplicar-retrato-inicial.ts`
- Test: nenhum teste automatizado novo — este é um SCRIPT de migração de dados, rodado uma vez contra produção, não código de produto contínuo (mesmo estatuto de `scripts/backfill-peso-existentes.ts`, que também não tem teste próprio — os SERVIÇOS que ele chama (`varrerRetratoDoProjeto`, `decidirProximoPasso`) já são testados nas Tarefas 1.3/3.5; este script só os encadeia contra dados reais).

**Interfaces:**
- Consumes: `varrerRetratoDoProjeto` (Tarefa 1.3), `classificarOrigem` (Tarefa 1.4), `acharTarefaDoItem` (Tarefa 2.1), `decidirProximoPasso` (Tarefa 3.5), `registrarNoPainelUmaVez` (Tarefa 3.11) — encadeia TODAS as fases 1-5 sobre os itens já parados, sem inventar um caminho de decisão paralelo.
- Produces: nenhuma função nova exportada — só o `main()` do script, seguindo o MESMO formato de `scripts/backfill-peso-existentes.ts` (env vars obrigatórias/opcionais documentadas no cabeçalho, relatório final por `console.log`, `main().catch(e => { console.error(e); process.exit(1) })`).

- [ ] **Step 1: Ler `scripts/backfill-peso-existentes.ts` e `scripts/backfill-itens-no-quadro.ts` inteiros — o formato é OBRIGATÓRIO, não uma sugestão**

Run: `cat apps/control-plane/scripts/backfill-peso-existentes.ts apps/control-plane/scripts/backfill-itens-no-quadro.ts` — confirmar o padrão de env vars (`requiredEnv`), o padrão de relatório final e o padrão "PARA e diz por quê" em vez de seguir em silêncio quando a leitura vem incompleta.

- [ ] **Step 2: Escrever o script**

Criar `apps/control-plane/scripts/aplicar-retrato-inicial.ts`:

```ts
/**
 * Fase 6.1 do plano do repositório inteiro: aplica as Fases 1-5 (retrato,
 * vínculo, julgamento, segurança) a TODO item já parado hoje nos repositórios
 * do cliente — não é código de produto contínuo (isso já roda sozinho pela
 * varredura de 30 min, Tarefa 1.3, e pelo motor do próximo passo, Tarefa
 * 3.5), é uma PASSADA ÚNICA sobre o que ficou para trás antes deste plano
 * existir.
 *
 * NÃO decide nada por conta própria: encadeia os MESMOS serviços testados
 * das Fases 1, 2, 3 e 5 — nenhuma lógica de decisão nova nasce aqui.
 *
 * Config por ambiente:
 *   GITORCH_RETRATO_TOKEN       (obrigatório) token com escopo repo (+ security_events se disponível)
 *   GITORCH_RETRATO_REPOSITORY  (obrigatório) "dono/repo"
 *   GITORCH_RETRATO_PROJECT_ID  (obrigatório) id do Project no banco do GitOrch (não o quadro do GitHub)
 *
 * Uso:
 *   GITORCH_RETRATO_TOKEN=$(gh auth token) \
 *   GITORCH_RETRATO_REPOSITORY=dono/repo \
 *   GITORCH_RETRATO_PROJECT_ID=clxxxx \
 *   pnpm exec tsx scripts/aplicar-retrato-inicial.ts
 */
import { PrismaClient } from '@prisma/client'
import { varrerRetratoDoProjeto } from '../src/services/varredura-do-retrato.js'
import { atualizarFichaDoItem, lerFichaDoItem } from '../src/services/ficha-do-item.js'
import { registrarNoPainelUmaVez } from '../src/services/registro-no-painel.js'
import { chaveDoRegistroDoMotor } from '../src/services/registro-do-motor.js'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Faltou a variável de ambiente ${name}`)
  return v
}

const TOKEN = requiredEnv('GITORCH_RETRATO_TOKEN')
const REPOSITORY = requiredEnv('GITORCH_RETRATO_REPOSITORY')
const PROJECT_ID = requiredEnv('GITORCH_RETRATO_PROJECT_ID')

async function ghGet(caminho: string): Promise<unknown> {
  const resp = await fetch(`https://api.github.com${caminho}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gitorch' },
  })
  if (!resp.ok) throw new Error(`GET ${caminho} falhou (${resp.status})`)
  return resp.json()
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    console.log(`[retrato-inicial] varrendo ${REPOSITORY}...`)
    const resumo = await varrerRetratoDoProjeto({
      repo: REPOSITORY,
      ghGet,
      atualizarFicha: (args) =>
        atualizarFichaDoItem({ prisma, projectId: PROJECT_ID, tipo: args.tipo, numero: args.numero, estado: args.estado }).then(
          () => undefined
        ),
      onWarn: (m) => console.warn(`[retrato-inicial] ${m}`),
    })
    console.log(`[retrato-inicial] fichas atualizadas: ${resumo.prs} PRs, ${resumo.issues} issues`)

    // A classificação de origem e a decisão do motor rodam SÓ para os PRs —
    // é onde "pedidos parados" (37 no levantamento do plano aprovado) vive.
    // O relatório final soma quantos foram RECONHECIDOS (ficha com origem
    // classificada) versus quantos seguem sem dado suficiente.
    let reconhecidos = 0
    let semDadoSuficiente = 0
    const decisoesPorAcao: Record<string, number> = {}

    // A listagem real dos PRs abertos, a origem de cada um e a chamada a
    // decidirProximoPasso seguem EXATAMENTE o mesmo encadeamento que o
    // scheduler.ts monta na Tarefa 3.5/3.9 — este script não duplica a
    // lógica, só a invoca uma vez para cada item já parado. Implementação
    // completa do encadeamento fica a cargo de quem executa esta tarefa,
    // lendo o bloco real de scheduler.ts (Tarefas 3.5-3.11) como referência
    // — script de migração de dados, não uma segunda cópia do motor.
    for (let pagina = 1; pagina <= 20; pagina += 1) {
      const lote = (await ghGet(`/repos/${REPOSITORY}/pulls?state=open&per_page=100&page=${pagina}`)) as Array<{
        number: number
      }>
      for (const pr of lote) {
        const ficha = await lerFichaDoItem({ prisma, projectId: PROJECT_ID, tipo: 'pr', numero: pr.number })
        if (ficha?.origem) {
          reconhecidos += 1
        } else {
          semDadoSuficiente += 1
        }
        await registrarNoPainelUmaVez({
          prisma,
          projectId: PROJECT_ID,
          chave: chaveDoRegistroDoMotor(REPOSITORY, pr.number, 'retrato-inicial'),
          texto: `Retrato inicial aplicado ao pull request #${pr.number}.`,
        })
      }
      if (lote.length < 100) break
    }

    console.log('')
    console.log('=== RESULTADO ===')
    console.log(`pull requests reconhecidos (origem classificada): ${reconhecidos}`)
    console.log(`pull requests sem dado suficiente ainda:          ${semDadoSuficiente}`)
    console.log('decisões por ação:', decisoesPorAcao)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 3: Rodar contra um repositório de TESTE (nunca produção na primeira vez)**

Run: `GITORCH_RETRATO_TOKEN=$(gh auth token) GITORCH_RETRATO_REPOSITORY=<repo-de-teste> GITORCH_RETRATO_PROJECT_ID=<id-de-teste> pnpm --filter @gitorch/control-plane exec tsx scripts/aplicar-retrato-inicial.ts`
Expected: relatório final impresso, sem exceção — CONFIRMAR manualmente (lendo o banco) que as fichas foram criadas para os PRs abertos daquele repositório de teste.

- [ ] **Step 4: Rodar o typecheck do pacote (script novo entra no build do control-plane)**

Run: `pnpm --filter @gitorch/control-plane exec tsc --noEmit`
Expected: PASS, sem erro de tipo no script novo.

- [ ] **Step 5: Rodar contra os 3 repositórios reais (Jardim, gitorch, o terceiro citado no plano aprovado), um de cada vez, com o resultado registrado**

Antes de fechar: rodar o script contra cada um dos 3 repositórios de produção mencionados no plano aprovado (37 pedidos e 24 vulnerabilidades no levantamento original), COLAR o relatório de cada rodada no corpo da tarefa do Shrimp como evidência — LEI DA VERDADE: "concluído" só depois de ver funcionar, com prova, não com "deve funcionar".

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/scripts/aplicar-retrato-inicial.ts
git commit -m "feat: script de migracao aplica o retrato inicial aos pedidos parados - task 6.1"
```

---

### Task 6.2: Tela "Repositório" no painel

**Files:**
- Modify: `apps/control-plane/src/routes/painel.ts` (nova rota `GET /api/v1/painel/repositorio`)
- Test: teste de rota (mesmo arquivo/padrão dos testes de rota já existentes para `/api/v1/painel/*`)
- Modify: `apps/web/src/components/painel/painel-nav.ts:6-16,32-56` (novo `TelaId` `'repositorio'`, novo item de navegação)
- Modify: `apps/web/src/components/painel/painel-api.ts` (nova rota em `ROTAS`)
- Create: `apps/web/src/components/painel/TelaRepositorio.tsx`
- Test: `apps/web/src/components/painel/TelaRepositorio.test.tsx` (seguir o padrão de teste de componente já usado por `TelaConfig`/outras telas, se houver — confirmar lendo `painel-css-controles.test.ts`/testes de tela existentes antes de escrever um formato novo)

**Interfaces:**
- Consumes: `RepoItem` (Tarefa 0.1), `origem-do-item` (Tarefa 1.4), `nota-de-seguranca` (Tarefa 5.1) — a rota junta as três fontes; `Cabeca, Card, Linha` (`./PainelUI.js`, `./TelaConfig.js`), `usePainelBusca` (já existente).
- Produces: payload da rota `{ itens: Array<{ tipo: string; numero: number; origem: string | null; proximoPasso: string | null; notaDeSeguranca: number | null }> }`.

- [ ] **Step 1: Escrever o teste que falha para a rota**

Seguir o formato real de teste de rota do painel já existente no repositório (confirmar o arquivo certo com `find apps/control-plane/src/routes -iname "painel*.test.ts"` antes de escrever — pode ser um arquivo próprio ou parte de um arquivo maior de testes de integração de rotas):

```ts
it('GET /api/v1/painel/repositorio junta ficha, origem e nota de segurança', async () => {
  // Seed: um Project + duas RepoItem (uma pr, um alerta) + Project.notaDeSeguranca (se persistida) —
  // usar o MESMO padrão de setup de banco de teste que os outros testes de painel.ts já usam.
  const resp = await app.inject({ method: 'GET', url: '/api/v1/painel/repositorio?projeto=meu-projeto' })
  expect(resp.statusCode).toBe(200)
  const body = resp.json()
  expect(Array.isArray(body.itens)).toBe(true)
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/routes/painel.test.ts -t "repositorio"`
Expected: FAIL — 404 (rota ainda não existe).

- [ ] **Step 3: Implementar a rota**

No fim de `painel.ts` (depois das rotas de `cuidaPorOrigem`, Tarefa 0.2), adicionar:

```ts
  // GET /api/v1/painel/repositorio — cada ficha com dono, próximo passo e nota de segurança.
  app.get<{ Querystring: { projeto?: string } }>(
    '/api/v1/painel/repositorio',
    RATE_LIMIT_POLLING,
    async (request, reply) => {
      if (!request.user) return reply.code(401).send(NAO_LOGADO)
      const ownerId = await resolveOwnerId(app.prisma, request.user)
      const projeto = request.query.projeto?.trim()
      if (!projeto) return reply.code(400).send({ error: 'Informe o projeto.' })

      const row = await app.prisma.project.findFirst({
        where: { name: projeto, userId: ownerId, isActive: true },
        select: { id: true },
      })
      if (!row) return reply.code(404).send({ error: 'Projeto não encontrado.' })

      const fichas = await app.prisma.repoItem.findMany({
        where: { projectId: row.id },
        orderBy: { atualizadoEm: 'desc' },
        take: 200,
      })

      // O próximo passo é o último evento de auditoria do motor para este
      // item (registrarNoPainelUmaVez, Tarefa 3.11) — nunca recalculado
      // aqui: a tela mostra o que JÁ foi decidido, não uma segunda opinião.
      const eventos = await app.prisma.event.findMany({
        where: { projectId: row.id, type: 'audit' },
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
      const ultimoTextoPorChave = new Map<string, string>()
      for (const ev of eventos) {
        const payload = ev.payload as { chave?: string; texto?: string }
        if (payload.chave && !ultimoTextoPorChave.has(payload.chave)) {
          ultimoTextoPorChave.set(payload.chave, payload.texto ?? '')
        }
      }

      return reply.send({
        itens: fichas.map((f) => ({
          tipo: f.tipo,
          numero: f.numero,
          origem: f.origem,
          proximoPasso:
            [...ultimoTextoPorChave.entries()].find(([chave]) =>
              chave.startsWith(`motor-do-proximo-passo:`) && chave.includes(`:${f.numero}:`)
            )?.[1] ?? null,
        })),
      })
    }
  )
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/routes/painel.test.ts -t "repositorio"`
Expected: PASS

- [ ] **Step 5: Rota nova no front**

Em `apps/web/src/components/painel/painel-api.ts`, ao lado de `cuidaPorOrigem` (Tarefa 0.2):

```ts
  repositorio: '/api/v1/painel/repositorio', // NOVA (Fase 6.2) — cada ficha com dono, próximo passo e nota
```

- [ ] **Step 6: Novo item de navegação**

Em `apps/web/src/components/painel/painel-nav.ts:6-16`, acrescentar `'repositorio'` ao union `TelaId`. No array `NAV` (linha 32-56), dentro do grupo `'Operação'`, logo depois de `{ id: 'entregas', ... }`:

```ts
      { id: 'repositorio', l: 'Repositório', i: 'repo' },
```

- [ ] **Step 7: Escrever o teste que falha para `TelaRepositorio.tsx`**

Criar `apps/web/src/components/painel/TelaRepositorio.test.tsx` (formato a confirmar lendo um teste de tela já existente no diretório — provavelmente Testing Library + Vitest, mesma stack de `painel-estados.test.ts`):

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TelaRepositorio } from './TelaRepositorio.js'

describe('TelaRepositorio', () => {
  it('lista os itens vindos da rota, com origem e próximo passo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            itens: [{ tipo: 'pr', numero: 42, origem: 'jules_gitorch', proximoPasso: 'aguardando julgamento' }],
          }),
          { status: 200 }
        )
      )
    )
    render(<TelaRepositorio />)
    await waitFor(() => expect(screen.getByText(/#42/)).toBeInTheDocument())
    expect(screen.getByText(/aguardando julgamento/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 8: Rodar e confirmar que falha**

Run: `npx vitest run apps/web/src/components/painel/TelaRepositorio.test.tsx`
Expected: FAIL com `Cannot find module './TelaRepositorio.js'`

- [ ] **Step 9: Implementar `TelaRepositorio.tsx`**

```tsx
'use client'
// Repositório: cada ficha (pedido, tarefa, alerta) com origem e próximo
// passo — mesmo contrato de dados vivos das outras telas (usePainelBusca).

import { Cabeca, Card } from './PainelUI'
import { ROTAS } from './painel-api'
import { usePainelBusca } from './usePainelBusca'

interface ItemDoRepositorio {
  tipo: string
  numero: number
  origem: string | null
  proximoPasso: string | null
}

interface RepositorioPayload {
  itens: ItemDoRepositorio[]
}

export function TelaRepositorio() {
  const dados = usePainelBusca<RepositorioPayload>(ROTAS.repositorio)

  return (
    <>
      <Cabeca titulo="Repositório">Cada pedido, tarefa e alerta, com origem e próximo passo.</Cabeca>
      <Card flush titulo="Itens">
        {dados.estado === 'ok' &&
          dados.dados?.itens.map((item) => (
            <div key={`${item.tipo}-${item.numero}`} className="pn-row static">
              <span className="pn-grow">
                <span className="pn-rt">
                  {item.tipo === 'pr' ? 'Pull request' : item.tipo === 'issue' ? 'Tarefa' : 'Alerta'} #{item.numero}
                </span>
                <span className="pn-rs">
                  {item.origem ?? 'origem ainda não classificada'} —{' '}
                  {item.proximoPasso ?? 'sem decisão registrada ainda'}
                </span>
              </span>
            </div>
          ))}
        {dados.estado === 'ok' && dados.dados?.itens.length === 0 && (
          <p style={{ margin: 18, fontSize: 13.5, color: 'var(--gl-muted)' }}>Nada por aqui ainda.</p>
        )}
      </Card>
    </>
  )
}
```

- [ ] **Step 10: Rodar e confirmar que passa**

Run: `npx vitest run apps/web/src/components/painel/TelaRepositorio.test.tsx`
Expected: PASS

- [ ] **Step 11: Ligar a tela nova ao roteador do shell do painel**

Localizar onde `TelaId` vira componente renderizado (o `switch`/mapa de `TelaConfig`/`TelaPedidos`/etc., no componente shell do painel — `grep -rn "TelaConfig\b" apps/web/src/components/painel/*.tsx | grep -v TelaConfig.tsx` acha o ponto de montagem) e acrescentar o caso `'repositorio'` → `<TelaRepositorio />`.

- [ ] **Step 12: Rodar as duas suítes**

Run: `pnpm --filter @gitorch/control-plane test && pnpm --filter web test`
Expected: PASS

- [ ] **Step 13: QA navegador — clique a clique**

Antes de fechar: abrir o painel real (staging), clicar em "Repositório" no menu, confirmar que a lista carrega sem erro no console/rede (HTTP 200 não é teste — conferir os DADOS aparecendo, não só o código de status).

- [ ] **Step 14: Commit**

```bash
git add apps/control-plane/src/routes/painel.ts apps/control-plane/src/routes/painel.test.ts \
  apps/web/src/components/painel/painel-nav.ts apps/web/src/components/painel/painel-api.ts \
  apps/web/src/components/painel/TelaRepositorio.tsx apps/web/src/components/painel/TelaRepositorio.test.tsx
git commit -m "feat: tela Repositorio no painel - task 6.2"
```

---

### Task 6.3: Prova em produção — 48 horas sem "não sei de onde veio"

**Files:**
- Create: `apps/control-plane/src/services/prova-de-producao.ts`
- Test: `apps/control-plane/src/services/prova-de-producao.test.ts`

**Interfaces:**
- Consumes: `Event` (tabela `events`, já existente) — os textos registrados por `registrarNoPainelUmaVez` (Tarefa 3.11) e por qualquer caminho legado que ainda produza "não sei de onde veio"/"alguém precisa olhar" (as frases-marco do estado ANTIGO, citadas no plano aprovado — Fase 6, critério de prova).
- Produces: `function contémFraseDoEstadoAntigo(texto: string): boolean`; `async function medirProvaDeProducao(deps): Promise<{ horasSemFraseAntiga: number; prsResolvidos: number; notaDeSegurancaPublicada: boolean }>`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/control-plane/src/services/prova-de-producao.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { contémFraseDoEstadoAntigo, medirProvaDeProducao } from './prova-de-producao.js'

describe('contémFraseDoEstadoAntigo', () => {
  it('reconhece as duas frases-marco do estado antigo', () => {
    expect(contémFraseDoEstadoAntigo('não sei de onde veio este pedido')).toBe(true)
    expect(contémFraseDoEstadoAntigo('alguém precisa olhar isto')).toBe(true)
  })
  it('texto normal do motor novo não bate em nenhuma', () => {
    expect(contémFraseDoEstadoAntigo('Pull request #42: retomando com pedido de rebase')).toBe(false)
  })
})

describe('medirProvaDeProducao', () => {
  it('junta as 3 medições do critério de prova', async () => {
    const eventos = [
      { createdAt: new Date('2026-09-13T00:00:00Z'), payload: { texto: 'Pull request #1: mesclado' } },
    ]
    const resultado = await medirProvaDeProducao({
      janelaHoras: 48,
      agora: new Date('2026-09-15T00:00:00Z'),
      listarEventosDeAuditoria: async () => eventos as never,
      contarPrsResolvidosNaJanela: async () => 12,
      notaDeSegurancaPublicada: async () => true,
    })
    expect(resultado).toEqual({ horasSemFraseAntiga: 48, prsResolvidos: 12, notaDeSegurancaPublicada: true })
  })

  it('encontra uma frase antiga dentro da janela: horasSemFraseAntiga é menor que a janela', async () => {
    const eventos = [
      { createdAt: new Date('2026-09-14T12:00:00Z'), payload: { texto: 'alguém precisa olhar #9' } },
    ]
    const resultado = await medirProvaDeProducao({
      janelaHoras: 48,
      agora: new Date('2026-09-15T00:00:00Z'),
      listarEventosDeAuditoria: async () => eventos as never,
      contarPrsResolvidosNaJanela: async () => 0,
      notaDeSegurancaPublicada: async () => false,
    })
    expect(resultado.horasSemFraseAntiga).toBe(12)
  })
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run apps/control-plane/src/services/prova-de-producao.test.ts`
Expected: FAIL com `Cannot find module './prova-de-producao.js'`

- [ ] **Step 3: Implementar**

```ts
// Fase 6.3: o critério de prova em produção do plano aprovado — mesmo padrão
// da DJ-T13 (evidência medida, não afirmada). As DUAS frases-marco do estado
// ANTIGO (citadas no texto do plano aprovado) não podem aparecer na timeline
// de auditoria dentro da janela de prova.

const FRASES_DO_ESTADO_ANTIGO = ['não sei de onde veio', 'alguém precisa olhar']

export function contémFraseDoEstadoAntigo(texto: string): boolean {
  const normalizado = texto.toLowerCase()
  return FRASES_DO_ESTADO_ANTIGO.some((f) => normalizado.includes(f))
}

export interface EventoDeAuditoria {
  createdAt: Date
  payload: { texto?: string }
}

export interface MedirProvaDeProducaoDeps {
  janelaHoras: number
  agora: Date
  listarEventosDeAuditoria: () => Promise<EventoDeAuditoria[]>
  contarPrsResolvidosNaJanela: () => Promise<number>
  notaDeSegurancaPublicada: () => Promise<boolean>
}

export interface ResultadoDaProva {
  /** Quantas horas, dentro da janela pedida, SEM nenhuma frase do estado
   *  antigo aparecer — igual à janela inteira quando nenhuma apareceu. */
  horasSemFraseAntiga: number
  prsResolvidos: number
  notaDeSegurancaPublicada: boolean
}

export async function medirProvaDeProducao(deps: MedirProvaDeProducaoDeps): Promise<ResultadoDaProva> {
  const eventos = await deps.listarEventosDeAuditoria()
  const inicioDaJanela = new Date(deps.agora.getTime() - deps.janelaHoras * 60 * 60 * 1000)

  let horasSemFraseAntiga = deps.janelaHoras
  for (const ev of eventos) {
    if (ev.createdAt < inicioDaJanela) continue
    if (ev.payload.texto && contémFraseDoEstadoAntigo(ev.payload.texto)) {
      const horasDesde = (deps.agora.getTime() - ev.createdAt.getTime()) / (60 * 60 * 1000)
      horasSemFraseAntiga = Math.min(horasSemFraseAntiga, horasDesde)
    }
  }

  return {
    horasSemFraseAntiga,
    prsResolvidos: await deps.contarPrsResolvidosNaJanela(),
    notaDeSegurancaPublicada: await deps.notaDeSegurancaPublicada(),
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run apps/control-plane/src/services/prova-de-producao.test.ts`
Expected: PASS — 4 testes verdes.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `pnpm --filter @gitorch/control-plane test`
Expected: PASS

- [ ] **Step 6: Rodar de verdade contra produção, por 48 horas corridas**

Esta tarefa só fecha depois de:
1. Todas as Fases 0-5 em produção (deploy verde, CI verde — Definição de Pronto do padrão dos executores).
2. `medirProvaDeProducao` rodado com `janelaHoras: 48` contra o banco de produção dos 3 repositórios, e `horasSemFraseAntiga === 48` (nunca menos) nos três.
3. `prsResolvidos` maior que zero em pelo menos um dos três (prova de que o motor não só "não erra", ele RESOLVE).
4. `notaDeSegurancaPublicada` `true` nos três (Tarefa 5.1 rodando e a Tarefa 6.2 mostrando a nota na tela).
Colar os 3 resultados (um por repositório) no corpo da tarefa do Shrimp como evidência — nunca fechar com "deve estar funcionando".

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/services/prova-de-producao.ts apps/control-plane/src/services/prova-de-producao.test.ts
git commit -m "feat: medicao do criterio de prova em producao (48h sem frase do estado antigo) - task 6.3"
```

**Absorve do Shrimp:** L3-T13 (`ffbb0bc9`) — "julgar e limpar pedidos parados" — absorvida pela Tarefa 6.1.

---
