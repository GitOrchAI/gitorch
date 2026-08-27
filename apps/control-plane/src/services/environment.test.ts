import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClientEnvironmentService } from './environment.js'
import { LocalWorkspaceProvider } from '@gitorch/workspace-engine'

// Partial mock: mantém TODAS as funções reais de fs/promises (os testes usam
// disco de verdade — mkdtemp/mkdir/writeFile/stat), mas devolve um objeto
// configurável para que UM teste possa `vi.spyOn(fs, 'rm')` (o namespace ESM
// nativo é read-only e não deixa espionar).
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return { ...actual, default: actual }
})

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fake do Prisma para a tabela client_environments: store em memória com os
// 3 métodos que o serviço usa. Mesmo padrão de engine-connection.test.ts.
function fakePrisma() {
  const store = new Map<string, any>()
  let seq = 0
  return {
    store,
    clientEnvironment: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        // `status` ausente = sem filtro de status (é o que o Prisma real faz com
        // uma chave undefined) — current() consulta o ambiente do usuário seja
        // ele provisional ou fixed.
        let rows = [...store.values()].filter(
          (r) =>
            r.userId === where.userId && (where.status === undefined || r.status === where.status)
        )
        if (orderBy?.createdAt === 'desc') {
          rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        return rows[0] ?? null
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date()
        // `lastActivityAt` espelha o DEFAULT do banco (@default(now())).
        const rec = {
          id: `env_${++seq}`,
          fixedAt: null,
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
          ...data,
        }
        store.set(rec.id, rec)
        return rec
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rec = { ...store.get(where.id), ...data, updatedAt: new Date() }
        store.set(where.id, rec)
        return rec
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let rows = [...store.values()].filter((r) => {
          if (where?.userId && r.userId !== where.userId) return false
          if (where?.status && r.status !== where.status) return false
          if (where?.createdAt?.lt && !(r.createdAt < where.createdAt.lt)) return false
          if (where?.lastActivityAt?.lt && !(r.lastActivityAt < where.lastActivityAt.lt)) {
            return false
          }
          return true
        })
        if (orderBy?.createdAt === 'desc') {
          rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        return rows
      }),
      findUnique: vi.fn(async ({ where }: any) => store.get(where.id) ?? null),
      delete: vi.fn(async ({ where }: any) => {
        const rec = store.get(where.id)
        store.delete(where.id)
        return rec ?? null
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const [k, r] of store) {
          if (where?.userId && r.userId !== where.userId) continue
          if (where?.status && r.status !== where.status) continue
          store.set(k, { ...r, ...data })
          count++
        }
        return { count }
      }),
    },
  }
}

describe('ClientEnvironmentService.createProvisional', () => {
  let baseDir: string
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-envtest-'))
  })
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test('cria ambiente provisional com diretório exclusivo, só para o dono (0700)', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const env = await svc.createProvisional('user_1')

    expect(env.status).toBe('provisional')
    expect(env.userId).toBe('user_1')
    expect(env.path).toBe(path.join(baseDir, env.id))
    const stat = await fs.stat(env.path)
    expect(stat.isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      // group e other não podem ter NENHUM acesso (guarda credenciais do cliente)
      expect(stat.mode & 0o077).toBe(0)
    }
  })

  test('idempotente: segunda chamada reusa o provisional aberto (não multiplica ambiente)', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const a = await svc.createProvisional('user_1')
    const b = await svc.createProvisional('user_1')

    expect(b.id).toBe(a.id)
    expect(prisma.clientEnvironment.create).toHaveBeenCalledTimes(1)
  })

  test('usuários diferentes recebem ambientes isolados distintos', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const a = await svc.createProvisional('user_1')
    const b = await svc.createProvisional('user_2')

    expect(b.id).not.toBe(a.id)
    expect(b.path).not.toBe(a.path)
  })

  test('corrida: se outro request criou um provisional mais novo, destrói o próprio e devolve o vencedor', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)
    const winner = {
      id: 'env_winner',
      userId: 'user_1',
      status: 'provisional',
      path: path.join(baseDir, 'env_winner'),
      fixedAt: null,
      createdAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    }
    // 1ª chamada (check inicial): nada; 2ª (recheck pós-create): o vencedor
    // da corrida já existe — simula outro request criando em paralelo.
    prisma.clientEnvironment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner as any)

    const result = await svc.createProvisional('user_1')

    expect(result.id).toBe('env_winner')
    // o perdedor (env_1) foi destruído: registro fora do store e dir apagado
    expect(prisma.store.has('env_1')).toBe(false)
    await expect(fs.stat(path.join(baseDir, 'env_1'))).rejects.toThrow()
  })
})

describe('ClientEnvironmentService.cloneInto', () => {
  test('clona cada repo no ambiente, reusando o provider com o token do cliente', async () => {
    const prisma = fakePrisma()
    const allocateWorkspace = vi.fn(async (envId: string, repo: string) => ({
      id: `ws:${envId}:${repo}`,
      userId: envId,
      projectId: repo,
      path: `/base/${envId}/${repo.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      status: 'active' as const,
    }))
    const svc = new ClientEnvironmentService(prisma as any, '/base', { allocateWorkspace })

    const result = await svc.cloneInto('env_1', ['octo/repo-a', 'octo/repo-b'], 'tok_123')

    expect(allocateWorkspace).toHaveBeenCalledTimes(2)
    // projectId é o SLUG sanitizado (o provider rejeita '/'); o nome real do
    // repo segue intacto em `repository` (é ele que vira a URL do clone).
    expect(allocateWorkspace).toHaveBeenCalledWith('env_1', 'octo_repo-a', {
      repository: 'octo/repo-a',
      token: 'tok_123',
    })
    expect(result.map((r) => r.repo)).toEqual(['octo/repo-a', 'octo/repo-b'])
    // clonado dentro do ambiente (envId no caminho)
    expect(result[0]!.path).toContain('env_1')
  })

  test('sem repos selecionados não chama o provider (nada a clonar)', async () => {
    const prisma = fakePrisma()
    const allocateWorkspace = vi.fn()
    const svc = new ClientEnvironmentService(prisma as any, '/base', { allocateWorkspace })

    const result = await svc.cloneInto('env_1', [])

    expect(allocateWorkspace).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  test('REGRESSÃO C1: repo real "owner/repo" passa pelo provider REAL (validateInput rejeita barra)', async () => {
    // Este teste usa o LocalWorkspaceProvider DE VERDADE (só o git é fake):
    // exercita o validateInput real, que rejeita '/' no projectId. Antes do
    // fix, cloneInto passava o repo cru e QUALQUER repositório real quebrava
    // o /setup/clone em produção — e nenhum teste pegava, porque todos
    // mockavam o provider inteiro.
    const prisma = fakePrisma()
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-c1-'))
    const gitCalls: string[][] = []
    const fakeGit = async (args: string[]) => {
      gitCalls.push(args)
      return { stdout: '', stderr: '' }
    }
    const realProvider = new LocalWorkspaceProvider(baseDir, fakeGit)
    const svc = new ClientEnvironmentService(prisma as any, baseDir, realProvider)

    const result = await svc.cloneInto('env_1', ['octocat/hello-world'], 'tok')

    // não lançou; o dir usa o slug sanitizado (mesmo esquema do repoPathInEnv)
    expect(result[0]!.path).toContain(path.join('env_1', 'octocat_hello-world'))
    // e o clone em si usa o NOME REAL do repo na URL (o slug é só o dir)
    const cloneArgs = gitCalls.find((a) => a.includes('clone'))
    expect(cloneArgs?.join(' ')).toContain('https://github.com/octocat/hello-world.git')

    await fs.rm(baseDir, { recursive: true, force: true })
  })
})

describe('ClientEnvironmentService.repoPathInEnv', () => {
  let baseDir: string
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-repopath-'))
  })
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test('retorna o path do clone quando o repo já existe no ambiente (reuso)', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_1')
    await fs.mkdir(path.join(envPath, 'octo_repo', '.git'), { recursive: true })
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const p = await svc.repoPathInEnv('user_1', 'octo/repo')

    expect(p).toBe(path.join(envPath, 'octo_repo'))
  })

  test('retorna null quando o repo ainda não foi clonado', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_1')
    await fs.mkdir(envPath, { recursive: true })
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    expect(await svc.repoPathInEnv('user_1', 'octo/repo')).toBeNull()
  })

  test('retorna null quando o usuário não tem ambiente', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)
    expect(await svc.repoPathInEnv('user_1', 'octo/repo')).toBeNull()
  })

  // Achado do CodeQL (uncontrolled data used in path expression): `repo` é
  // input do cliente. O replace já elimina barra/ponto, mas o guard de
  // contenção (resolvedDir dentro de env.path) é a defesa em profundidade —
  // este teste trava que MESMO um `repo` tentando escapar nunca produz um
  // path fora do ambiente do usuário.
  test('repo com tentativa de path traversal nunca escapa do diretório do ambiente (defesa em profundidade)', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_1')
    await fs.mkdir(envPath, { recursive: true })
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const result = await svc.repoPathInEnv('user_1', '../../../../etc/passwd')

    // O repo malicioso não tem .git (não foi clonado) — o resultado é null,
    // mas o ponto do teste é que NADA fora de baseDir foi acessado/retornado.
    expect(result).toBeNull()
  })
})

describe('ClientEnvironmentService — faxina (TTL 24h)', () => {
  let baseDir: string
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-faxina-'))
  })
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  const DAY = 24 * 60 * 60 * 1000

  test('listExpired ainda encontra ambiente abandonado com resourcesStatus "ready" (a faxina NÃO escapa mais do bug de timing)', async () => {
    // O risco de SEGURANÇA que o desacoplamento fecha: antes deste fix, o
    // bootstrap sobrescrevia `status` para 'ready'/'error'/'provisioning', e
    // um ambiente ABANDONADO nesse estado (bootstrap rodou no clone, cliente
    // nunca voltou pro submit) escapava do filtro `status: 'provisional'`
    // desta query — a faxina de 24h (que existe para apagar credencial/OAuth
    // órfã) nunca o encontrava. Aqui `status` continua 'provisional' (o
    // bootstrap não mexe nele) mesmo com o bootstrap já concluído.
    const prisma = fakePrisma()
    const now = 1_000_000_000_000
    prisma.store.set('abandonado_com_bootstrap_pronto', {
      id: 'abandonado_com_bootstrap_pronto',
      userId: 'u',
      status: 'provisional',
      resourcesStatus: 'ready',
      path: '/x',
      createdAt: new Date(now - 3 * DAY),
      lastActivityAt: new Date(now - 25 * 60 * 60 * 1000),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const expired = await svc.listExpired(DAY, now)

    expect(expired.map((e) => e.id)).toEqual(['abandonado_com_bootstrap_pronto'])
  })

  test('listExpired corta por INATIVIDADE, não por idade (fixados nunca expiram)', async () => {
    const prisma = fakePrisma()
    const now = 1_000_000_000_000
    // Abandonado de verdade: nasceu há dias E não tem atividade há 25h.
    prisma.store.set('abandonado', {
      id: 'abandonado',
      userId: 'u',
      status: 'provisional',
      path: '/x',
      createdAt: new Date(now - 3 * DAY),
      lastActivityAt: new Date(now - 25 * 60 * 60 * 1000),
    })
    // Ativo: também nasceu há dias, mas o cliente mexeu nele há 1h. A faxina por
    // IDADE apagava este — no meio do cadastro do cliente.
    prisma.store.set('ativo', {
      id: 'ativo',
      userId: 'u',
      status: 'provisional',
      path: '/x',
      createdAt: new Date(now - 3 * DAY),
      lastActivityAt: new Date(now - 60 * 60 * 1000),
    })
    prisma.store.set('fixed', {
      id: 'fixed',
      userId: 'u',
      status: 'fixed',
      path: '/x',
      createdAt: new Date(now - 100 * DAY),
      lastActivityAt: new Date(now - 100 * DAY),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const expired = await svc.listExpired(DAY, now)

    expect(expired.map((e) => e.id)).toEqual(['abandonado'])
  })

  test('ambiente VELHO com atividade recente NUNCA é apagado (o cliente voltou pra terminar)', async () => {
    // O cenário do bug: aceita os termos, conecta os motores, some por 2 dias e
    // volta pra terminar o wizard. A faxina por idade destruía o ambiente no meio
    // do processo — junto com o clone e as credenciais que o CLI gravou no HOME.
    const prisma = fakePrisma()
    const now = 1_000_000_000_000
    prisma.store.set('voltou', {
      id: 'voltou',
      userId: 'u',
      status: 'provisional',
      path: '/x',
      createdAt: new Date(now - 10 * DAY),
      lastActivityAt: new Date(now - 5 * 60 * 1000), // mexeu há 5 minutos
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    expect(await svc.listExpired(DAY, now)).toEqual([])
  })

  test('destroy apaga o diretório (com as credenciais) e o registro', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_kill')
    await fs.mkdir(path.join(envPath, '.engine-home'), { recursive: true })
    await fs.writeFile(path.join(envPath, '.engine-home', 'secret'), 'oauth-token')
    prisma.store.set('env_kill', {
      id: 'env_kill',
      userId: 'u',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    await svc.destroy('env_kill')

    await expect(fs.stat(envPath)).rejects.toThrow()
    expect(prisma.store.has('env_kill')).toBe(false)
  })

  test('destroy NÃO apaga o registro se o rm do dir falhar (evita credencial órfã fora do alcance do GC)', async () => {
    // Se o fs.rm falha (disco ocupado, permissão, lock), o dir com a
    // credencial em texto puro CONTINUA em disco. O registro no banco é a
    // ÚNICA forma do GC reencontrar esse dir (listExpired varre linhas do
    // banco). Apagar o registro aqui deixaria o dir órfão pra SEMPRE, fora do
    // alcance da faxina. Então: rm falhou ⇒ registro PERMANECE e o GC retenta
    // o destroy no próximo tick.
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_orphan')
    await fs.mkdir(path.join(envPath, '.engine-home'), { recursive: true })
    await fs.writeFile(path.join(envPath, '.engine-home', 'secret'), 'oauth-token')
    prisma.store.set('env_orphan', {
      id: 'env_orphan',
      userId: 'u',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)
    const rmSpy = vi
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'))

    await svc.destroy('env_orphan')

    // o registro CONTINUA no store (o GC vai retentar); o delete NÃO rodou
    expect(prisma.store.has('env_orphan')).toBe(true)
    expect(prisma.clientEnvironment.delete).not.toHaveBeenCalled()

    rmSpy.mockRestore()
  })

  test('destroy NÃO apaga fora do baseDir (guard de path-traversal) mas remove o registro', async () => {
    const prisma = fakePrisma()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-outside-'))
    await fs.writeFile(path.join(outside, 'important'), 'do not delete')
    prisma.store.set('evil', {
      id: 'evil',
      userId: 'u',
      status: 'provisional',
      path: outside,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    await svc.destroy('evil')

    expect(await fs.readFile(path.join(outside, 'important'), 'utf8')).toBe('do not delete')
    expect(prisma.store.has('evil')).toBe(false)
    await fs.rm(outside, { recursive: true, force: true })
  })

  test('destroy com path apontando pro PRÓPRIO baseDir não apaga a raiz de ambientes', async () => {
    // Antes do fix, o guard tinha um ramo `resolved === root` que autorizava
    // fs.rm do baseDir inteiro — os ambientes de TODOS os clientes de uma vez.
    const prisma = fakePrisma()
    await fs.writeFile(path.join(baseDir, 'outro-cliente.marker'), 'vivo')
    prisma.store.set('root-attack', {
      id: 'root-attack',
      userId: 'u',
      status: 'provisional',
      path: baseDir,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    await svc.destroy('root-attack')

    // a raiz sobreviveu (com o conteúdo dos outros clientes); só o registro saiu
    expect(await fs.readFile(path.join(baseDir, 'outro-cliente.marker'), 'utf8')).toBe('vivo')
    expect(prisma.store.has('root-attack')).toBe(false)
  })
})

describe('ClientEnvironmentService — renovação por atividade (o relógio da faxina)', () => {
  let baseDir: string
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-touch-'))
  })
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  const DAY = 24 * 60 * 60 * 1000

  test('createProvisional RENOVA o relógio ao reusar o ambiente (voltar ao wizard é atividade)', async () => {
    // createProvisional é o funil de TODA atividade do wizard: aceitar os termos,
    // clonar os repos (/setup/clone) e iniciar o login de motor passam por ele.
    // Reusando a linha sem renovar, o relógio ficava preso no `createdAt` e o
    // ambiente morria 24h depois do PRIMEIRO passo, mesmo em uso.
    const prisma = fakePrisma()
    const stale = new Date(Date.now() - 23 * 60 * 60 * 1000)
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: path.join(baseDir, 'env_1'),
      fixedAt: null,
      createdAt: stale,
      updatedAt: stale,
      lastActivityAt: stale,
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const env = await svc.createProvisional('user_1')

    expect(env.id).toBe('env_1')
    // não criou um segundo ambiente...
    expect(prisma.clientEnvironment.create).not.toHaveBeenCalled()
    // ...e o relógio da faxina foi renovado
    expect(prisma.store.get('env_1')?.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime())
  })

  test('touch renova o ambiente provisório do usuário (concluir o login de motor é atividade)', async () => {
    const prisma = fakePrisma()
    const stale = new Date(Date.now() - 20 * 60 * 60 * 1000)
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: '/x',
      fixedAt: null,
      createdAt: stale,
      updatedAt: stale,
      lastActivityAt: stale,
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    await svc.touch('user_1')

    expect(prisma.store.get('env_1')?.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime())
  })

  test('touch é inofensivo para quem não tem ambiente aberto (idempotente, sem criar nada)', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    await expect(svc.touch('user_sem_ambiente')).resolves.toBeUndefined()
    expect(prisma.clientEnvironment.create).not.toHaveBeenCalled()
  })

  test('touch NÃO ressuscita ambiente FIXADO nem mexe no de outro cliente', async () => {
    // A renovação é do ambiente provisório DAQUELE dono. Um fixado já está fora
    // da faxina (não precisa), e o de outro cliente jamais pode ser tocado.
    const prisma = fakePrisma()
    const stale = new Date(Date.now() - 20 * 60 * 60 * 1000)
    prisma.store.set('meu', {
      id: 'meu',
      userId: 'user_1',
      status: 'provisional',
      path: '/x',
      createdAt: stale,
      lastActivityAt: stale,
    })
    prisma.store.set('alheio', {
      id: 'alheio',
      userId: 'user_2',
      status: 'provisional',
      path: '/x',
      createdAt: stale,
      lastActivityAt: stale,
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    await svc.touch('user_1')

    expect(prisma.store.get('meu')?.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime())
    expect(prisma.store.get('alheio')?.lastActivityAt.getTime()).toBe(stale.getTime())
  })

  test('o ambiente renovado sai da mira da faxina; sem renovar, continua na mira', async () => {
    // Fecha o ciclo ponta a ponta: renovar tira da lista de expirados. É o que
    // impede o GC de destruir o ambiente de um cliente que está usando o wizard.
    const prisma = fakePrisma()
    const stale = new Date(Date.now() - 30 * 60 * 60 * 1000)
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: '/x',
      createdAt: stale,
      lastActivityAt: stale,
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    // sem atividade: está na mira
    expect((await svc.listExpired(DAY)).map((e) => e.id)).toEqual(['env_1'])

    await svc.touch('user_1')

    // depois da atividade: saiu da mira
    expect(await svc.listExpired(DAY)).toEqual([])
  })
})

describe('ClientEnvironmentService.fix', () => {
  test('fixa o provisional do user (provisional → fixed) no aceite final', async () => {
    const prisma = fakePrisma()
    prisma.store.set('e1', {
      id: 'e1',
      userId: 'u',
      status: 'provisional',
      path: '/x',
      fixedAt: null,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, '/base')

    await svc.fix('u')

    expect(prisma.store.get('e1')?.status).toBe('fixed')
    expect(prisma.store.get('e1')?.fixedAt).toBeTruthy()
  })

  test('é idempotente: fix sem provisional não quebra', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, '/base')
    await expect(svc.fix('u')).resolves.toBeUndefined()
  })

  test('PROVA do fix de timing: fixa normalmente mesmo com resourcesStatus já "ready" (bootstrap concluído ANTES do submit)', async () => {
    // O cenário exato do bug: o bootstrap agora dispara no CLONE (passo 4/5),
    // bem antes do aceite final (passo 10). Antes deste fix, o bootstrap
    // sobrescrevia `status` para 'ready' e este updateMany (que filtra
    // status: 'provisional') nunca mais encontrava o ambiente — o aceite
    // final NUNCA fixava. Com os dois campos desacoplados, `status` continua
    // 'provisional' até fix() rodar, mesmo com o bootstrap já pronto.
    const prisma = fakePrisma()
    prisma.store.set('e1', {
      id: 'e1',
      userId: 'u',
      status: 'provisional',
      resourcesStatus: 'ready',
      resourcesLock: { engines: {} },
      path: '/x',
      fixedAt: null,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, '/base')

    await svc.fix('u')

    expect(prisma.store.get('e1')?.status).toBe('fixed')
    expect(prisma.store.get('e1')?.fixedAt).toBeTruthy()
    // fix() nunca mexe no progresso do bootstrap — ele continua honesto.
    expect(prisma.store.get('e1')?.resourcesStatus).toBe('ready')
  })

  test('dedup: com 2 provisionais (corrida), fixa só o mais recente e DESTRÓI o duplicado', async () => {
    // Sem o dedup, o updateMany fixava os dois: o duplicado (vazio, com
    // credencial em disco) virava permanente e escapava da faxina 24h pra
    // sempre — lixo com segredo que nenhuma rotina varre.
    const prisma = fakePrisma()
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-dedup-'))
    const oldDir = path.join(baseDir, 'e_old')
    const newDir = path.join(baseDir, 'e_new')
    await fs.mkdir(oldDir, { recursive: true })
    await fs.mkdir(newDir, { recursive: true })
    prisma.store.set('e_old', {
      id: 'e_old',
      userId: 'u',
      status: 'provisional',
      path: oldDir,
      fixedAt: null,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    prisma.store.set('e_new', {
      id: 'e_new',
      userId: 'u',
      status: 'provisional',
      path: newDir,
      fixedAt: null,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    await svc.fix('u')

    // o canônico (mais recente) fixou e o dir dele vive
    expect(prisma.store.get('e_new')?.status).toBe('fixed')
    expect((await fs.stat(newDir)).isDirectory()).toBe(true)
    // o duplicado sumiu por inteiro: registro e diretório (com a credencial)
    expect(prisma.store.has('e_old')).toBe(false)
    await expect(fs.stat(oldDir)).rejects.toThrow()

    await fs.rm(baseDir, { recursive: true, force: true })
  })
})

describe('ClientEnvironmentService.current', () => {
  test('devolve o ambiente mais recente do usuário (provisional ou fixed)', async () => {
    const prisma = fakePrisma()
    prisma.store.set('e_old', {
      id: 'e_old',
      userId: 'u',
      status: 'fixed',
      path: '/base/e_old',
      createdAt: new Date('2026-07-10T10:00:00Z'),
    })
    prisma.store.set('e_new', {
      id: 'e_new',
      userId: 'u',
      status: 'provisional',
      path: '/base/e_new',
      createdAt: new Date('2026-07-14T10:00:00Z'),
    })
    const svc = new ClientEnvironmentService(prisma as any, '/base')

    const env = await svc.current('u')

    expect(env?.id).toBe('e_new')
    expect(env?.status).toBe('provisional')
  })

  test('usuário sem ambiente -> null (o status do wizard não inventa um)', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, '/base')

    expect(await svc.current('ninguem')).toBeNull()
  })
})

describe('ClientEnvironmentService.bootstrapResources', () => {
  let baseDir: string
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-bootstrap-'))
  })
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  // Formato real gravado pelo bootstrap-env.sh privado (ver env-lock.json de
  // produção): versões dos 3 motores + referência dos recursos nativos.
  const LOCK_CONTENT = {
    generatedAt: '2026-07-20T00:00:00Z',
    engines: {
      claude: { npm: '@anthropic-ai/claude-code', version: '2.1.200', cache: '/x' },
      codex: { npm: '@openai/codex', version: '0.142.5', cache: '/x' },
      antigravity: { binary: 'agy', version: '1.1.4', sha256: 'abc', arch: 'arm64', cache: '/x' },
    },
    resources: { repo: 'https://github.com/loureng/gitorch.git', commit: 'abc123' },
  }

  test('bootstrap OK: grava resourcesLock e marca resourcesStatus ready — status (ciclo de vida) INTOCADO', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_ok')
    await fs.mkdir(envPath, { recursive: true })
    // status 'provisional' de propósito (não 'fixed'): prova o ponto central
    // do fix de timing — o bootstrap dispara cedo agora (no clone), enquanto
    // o ambiente ainda está no MEIO do wizard. Antes deste fix, esta mesma
    // chamada sobrescrevia `status` para 'ready' e o fix()/createProvisional()
    // (que filtram status:'provisional') nunca mais reconheciam o ambiente.
    prisma.store.set('env_ok', {
      id: 'env_ok',
      userId: 'u',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    // Runner fake: mimetiza o efeito real do script (escreve o env-lock.json
    // dentro do ambiente) sem rodar nada de verdade — nenhum teste de CI roda
    // o bootstrap real.
    const runner = vi.fn(async (dir: string) => {
      await fs.mkdir(path.join(dir, '.gitorch'), { recursive: true })
      await fs.writeFile(path.join(dir, '.gitorch', 'env-lock.json'), JSON.stringify(LOCK_CONTENT))
      return { exitCode: 0, stderr: '' }
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

    const result = await svc.bootstrapResources('env_ok')

    expect(result).toEqual({ ok: true, lock: LOCK_CONTENT })
    expect(runner).toHaveBeenCalledWith(envPath)
    expect(prisma.store.get('env_ok')?.resourcesStatus).toBe('ready')
    expect(prisma.store.get('env_ok')?.resourcesLock).toEqual(LOCK_CONTENT)
    // O CERNE do desacoplamento: o ciclo de vida nunca muda por causa do
    // bootstrap. Sem isto, fix() (que só reconhece status:'provisional')
    // jamais fixaria este ambiente no aceite final.
    expect(prisma.store.get('env_ok')?.status).toBe('provisional')
  })

  test('bootstrap falha (exit != 0): resourcesStatus error com a causa real, resourcesLock NÃO gravado, status intocado', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_fail')
    await fs.mkdir(envPath, { recursive: true })
    prisma.store.set('env_fail', {
      id: 'env_fail',
      userId: 'u',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const runner = vi.fn(async () => ({
      exitCode: 1,
      stderr: 'erro: sha256 do agy do host DIVERGE do manifesto',
    }))
    const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

    const result = await svc.bootstrapResources('env_fail')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('sha256 do agy do host DIVERGE')
    expect(prisma.store.get('env_fail')?.resourcesStatus).toBe('error')
    expect(prisma.store.get('env_fail')?.resourcesLock).toBeUndefined()
    expect(prisma.store.get('env_fail')?.status).toBe('provisional')
  })

  test('env-lock.json ausente mesmo com exit 0: resourcesStatus error (nunca "ativo" sem os recursos)', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_nolock')
    await fs.mkdir(envPath, { recursive: true })
    prisma.store.set('env_nolock', {
      id: 'env_nolock',
      userId: 'u',
      status: 'fixed',
      path: envPath,
      createdAt: new Date(),
    })
    // Exit 0 "de mentira": o script terminou sem erro, mas por qualquer razão
    // não escreveu o env-lock.json. Honestidade > confiar no código de saída.
    const runner = vi.fn(async () => ({ exitCode: 0, stderr: '' }))
    const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

    const result = await svc.bootstrapResources('env_nolock')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('env-lock.json')
    expect(prisma.store.get('env_nolock')?.resourcesStatus).toBe('error')
    expect(prisma.store.get('env_nolock')?.resourcesLock).toBeUndefined()
  })

  test('env-lock.json corrompido (JSON inválido): resourcesStatus error com a causa', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_corrupt')
    await fs.mkdir(path.join(envPath, '.gitorch'), { recursive: true })
    await fs.writeFile(path.join(envPath, '.gitorch', 'env-lock.json'), '{ isto não é json')
    prisma.store.set('env_corrupt', {
      id: 'env_corrupt',
      userId: 'u',
      status: 'fixed',
      path: envPath,
      createdAt: new Date(),
    })
    const runner = vi.fn(async () => ({ exitCode: 0, stderr: '' }))
    const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

    const result = await svc.bootstrapResources('env_corrupt')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('env-lock.json inválido')
    expect(prisma.store.get('env_corrupt')?.resourcesStatus).toBe('error')
  })

  test('runner lança (ex.: GITORCH_BOOTSTRAP_SCRIPT ausente): captura, não propaga, marca resourcesStatus error', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_throw')
    await fs.mkdir(envPath, { recursive: true })
    prisma.store.set('env_throw', {
      id: 'env_throw',
      userId: 'u',
      status: 'fixed',
      path: envPath,
      createdAt: new Date(),
    })
    const runner = vi.fn(async () => {
      throw new Error('GITORCH_BOOTSTRAP_SCRIPT não definido')
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

    const result = await svc.bootstrapResources('env_throw')

    expect(result).toEqual({ ok: false, error: 'GITORCH_BOOTSTRAP_SCRIPT não definido' })
    expect(prisma.store.get('env_throw')?.resourcesStatus).toBe('error')
  })

  test('ambiente inexistente: devolve erro sem lançar e sem tentar rodar o script', async () => {
    const prisma = fakePrisma()
    const runner = vi.fn()
    const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

    const result = await svc.bootstrapResources('nao-existe')

    expect(result).toEqual({ ok: false, error: 'ambiente não encontrado' })
    expect(runner).not.toHaveBeenCalled()
  })

  test('marca resourcesStatus "provisioning" ANTES de rodar o script (progresso visível durante a instalação)', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_prog')
    await fs.mkdir(envPath, { recursive: true })
    prisma.store.set('env_prog', {
      id: 'env_prog',
      userId: 'u',
      status: 'fixed',
      path: envPath,
      createdAt: new Date(),
    })
    let resourcesStatusDuringRun: string | undefined
    const runner = vi.fn(async (dir: string) => {
      resourcesStatusDuringRun = prisma.store.get('env_prog')?.resourcesStatus
      await fs.mkdir(path.join(dir, '.gitorch'), { recursive: true })
      await fs.writeFile(path.join(dir, '.gitorch', 'env-lock.json'), JSON.stringify(LOCK_CONTENT))
      return { exitCode: 0, stderr: '' }
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

    await svc.bootstrapResources('env_prog')

    expect(resourcesStatusDuringRun).toBe('provisioning')
  })

  // Guard de reentrância: agora que o disparo acontece no CLONE (passo 4/5) E
  // de novo como salvaguarda no SUBMIT (passo 10, ver routes/setup.ts), a
  // MESMA função pode ser chamada 2x para o mesmo ambiente. Rodar o script de
  // bootstrap 2x em paralelo é uma corrida real — dois processos escrevendo
  // env-lock.json ao mesmo tempo.
  describe('guard de reentrância', () => {
    test('resourcesStatus "ready": devolve ok com o lock já gravado, sem rodar o runner de novo', async () => {
      const prisma = fakePrisma()
      const envPath = path.join(baseDir, 'env_already_ready')
      await fs.mkdir(envPath, { recursive: true })
      prisma.store.set('env_already_ready', {
        id: 'env_already_ready',
        userId: 'u',
        status: 'fixed',
        path: envPath,
        resourcesStatus: 'ready',
        resourcesLock: LOCK_CONTENT,
        createdAt: new Date(),
      })
      const runner = vi.fn()
      const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

      const result = await svc.bootstrapResources('env_already_ready')

      expect(result).toEqual({ ok: true, lock: LOCK_CONTENT })
      expect(runner).not.toHaveBeenCalled()
    })

    test('resourcesStatus "provisioning": devolve erro sem tocar em nada, sem rodar o runner', async () => {
      const prisma = fakePrisma()
      const envPath = path.join(baseDir, 'env_inflight')
      await fs.mkdir(envPath, { recursive: true })
      prisma.store.set('env_inflight', {
        id: 'env_inflight',
        userId: 'u',
        status: 'fixed',
        path: envPath,
        resourcesStatus: 'provisioning',
        createdAt: new Date(),
      })
      const runner = vi.fn()
      const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

      const result = await svc.bootstrapResources('env_inflight')

      expect(result).toEqual({ ok: false, error: 'bootstrap já em andamento' })
      expect(runner).not.toHaveBeenCalled()
      // nada foi tocado: nem resourcesStatus nem resourcesLock mudaram
      expect(prisma.clientEnvironment.update).not.toHaveBeenCalled()
    })

    test('2 chamadas em sequência para o MESMO ambiente: o runner roda só na 1ª (a 2ª acha resourcesStatus ready)', async () => {
      const prisma = fakePrisma()
      const envPath = path.join(baseDir, 'env_twice')
      await fs.mkdir(envPath, { recursive: true })
      prisma.store.set('env_twice', {
        id: 'env_twice',
        userId: 'u',
        status: 'provisional',
        path: envPath,
        createdAt: new Date(),
      })
      const runner = vi.fn(async (dir: string) => {
        await fs.mkdir(path.join(dir, '.gitorch'), { recursive: true })
        await fs.writeFile(
          path.join(dir, '.gitorch', 'env-lock.json'),
          JSON.stringify(LOCK_CONTENT)
        )
        return { exitCode: 0, stderr: '' }
      })
      const svc = new ClientEnvironmentService(prisma as any, baseDir, undefined, runner)

      // 1ª chamada: dispara de verdade (ex.: clone-time).
      const first = await svc.bootstrapResources('env_twice')
      // 2ª chamada: dispara de novo (ex.: submit-time, salvaguarda) — o
      // ambiente já está ready, então é um no-op seguro.
      const second = await svc.bootstrapResources('env_twice')

      expect(first).toEqual({ ok: true, lock: LOCK_CONTENT })
      expect(second).toEqual({ ok: true, lock: LOCK_CONTENT })
      expect(runner).toHaveBeenCalledTimes(1)
    })
  })
})
