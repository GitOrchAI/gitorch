// Trava do parecer: impede duas execuções concorrentes do QA de publicarem
// review para o MESMO head do MESMO pull request ao mesmo tempo — a corrida
// medida no #548 (16 reprovações idênticas). Atualização CONDICIONAL de uma
// linha só (WHERE + updateMany), sem SELECT antes: o Postgres serializa as
// duas transações concorrentes na mesma linha, e a segunda reavalia o WHERE
// contra o estado JÁ commitado pela primeira — é isso que faz a trava valer
// de verdade contra corrida, não só contra sequência.

export interface PrismaDaTravaDeParecer {
  repoItem: {
    upsert: (args: {
      where: {
        projectId_tipo_numero: {
          projectId: string
          tipo: 'pr'
          numero: number
        }
      }
      create: {
        projectId: string
        tipo: 'pr'
        numero: number
        estado: { status: 'unknown' }
      }
      update: Record<string, never>
    }) => Promise<unknown>
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
  // 1) Garante que a linha existe SEM sobrescrever dados se ela já estiver lá
  // (um update vazio, só create no missing). Sem isso, o updateMany devolve
  // count 0 não só por trava vigente, mas também quando o repoItem ainda
  // não existe.
  await deps.prisma.repoItem.upsert({
    where: {
      projectId_tipo_numero: {
        projectId: deps.projectId,
        tipo: 'pr',
        numero: deps.numeroDoPr,
      },
    },
    create: {
      projectId: deps.projectId,
      tipo: 'pr',
      numero: deps.numeroDoPr,
      estado: { status: 'unknown' },
    },
    update: {},
  })

  // 2) Tenta adquirir a trava condicionalmente
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
