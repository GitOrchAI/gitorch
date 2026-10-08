// Trava do parecer: impede duas execuções concorrentes do QA de publicarem
// review para o MESMO head do MESMO pull request ao mesmo tempo — a corrida
// medida no #548 (16 reprovações idênticas). Atualização CONDICIONAL de uma
// linha só (WHERE + updateMany), sem SELECT antes: o Postgres serializa as
// duas transações concorrentes na mesma linha, e a segunda reavalia o WHERE
// contra o estado JÁ commitado pela primeira — é isso que faz a trava valer
// de verdade contra corrida, não só contra sequência.

import type { PrismaClient } from '@prisma/client'

export type PrismaDaTravaDeParecer = Pick<PrismaClient, 'repoItem'>

/** O Prisma recusou a escrita por violar uma chave única (código `P2002`). */
function ehConflitoDeUnicidade(erro: unknown): boolean {
  return typeof erro === 'object' && erro !== null && 'code' in erro && erro.code === 'P2002'
}

/**
 * A trava tem DUAS janelas de validade.
 *
 * EM VOO: vale desde que a missão a toma, ANTES de o motor rodar, até o parecer
 * sair. Tem de ser maior que o teto de tempo de qualquer motor (o do
 * Antigravity chega a 20 min): se vencesse com o motor ainda julgando, uma
 * segunda missão a tomaria e publicaria um segundo parecer no mesmo commit.
 * Aqui ela é só a rede de segurança contra a queda do processo, que não chega a
 * soltar a trava; quando a missão falha com o processo de pé, ela é solta
 * (`liberarTravaDeParecer`).
 */
export const DURACAO_EM_VOO_MS = 30 * 60_000

/**
 * FOLGA APÓS PUBLICAR: com o parecer já no GitHub, a validade é ENCURTADA para
 * isto (`assentarTravaDeParecer`). Cobre só a defasagem com que a lista de
 * reviews do GitHub passa a mostrar o parecer novo a quem a lê logo em seguida;
 * depois dela, o mesmo commit volta a poder ser julgado.
 */
export const FOLGA_APOS_PUBLICAR_MS = 3 * 60_000

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
  //
  // Duas chamadas simultâneas para uma ficha que ainda não existe: as duas
  // tentam criar, e a segunda esbarra na chave única (`P2002`) — medido contra
  // Postgres real, o upsert do Prisma não absorve esta corrida. O conflito só
  // diz que a OUTRA chamada acabou de criar a ficha, que é exatamente o que se
  // queria garantir; quem fica com a trava é decidido pelo passo 2.
  try {
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
  } catch (erro) {
    if (!ehConflitoDeUnicidade(erro)) throw erro
  }

  // 2) Tenta adquirir a trava condicionalmente
  const ate = new Date(deps.agora.getTime() + (deps.duracaoMs ?? DURACAO_EM_VOO_MS))
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

/**
 * Solta a trava de um commit que a missão tomou e NÃO chegou a publicar (o
 * motor caiu, a cota acabou). Sem isto, a nova tentativa — inclusive a troca
 * automática de motor — perderia a trava para uma missão que não existe mais e
 * o commit ficaria até `DURACAO_EM_VOO_MS` sem parecer.
 *
 * Só solta a trava do commit informado: um commit novo tomou a sua própria.
 *
 * LIMITE CONHECIDO: soltar não prova posse. Uma missão que passe de
 * `DURACAO_EM_VOO_MS`, perca a validade e depois falhe poderia soltar a trava
 * que outra missão tomou no mesmo commit nesse meio-tempo. O pior efeito é
 * deixar passar um segundo julgamento do mesmo commit, o mesmo defeito que a
 * trava existe para evitar, mas só numa janela rara; nunca bloqueia um commit
 * para sempre.
 */
export async function liberarTravaDeParecer(deps: {
  prisma: PrismaDaTravaDeParecer
  projectId: string
  numeroDoPr: number
  headSha: string
}): Promise<void> {
  await deps.prisma.repoItem.updateMany({
    where: {
      projectId: deps.projectId,
      tipo: 'pr',
      numero: deps.numeroDoPr,
      parecerTravaHeadSha: deps.headSha,
    },
    data: { parecerTravadoAte: null },
  })
}

/**
 * Encurta a validade da trava de um commit cujo parecer acabou de ser
 * publicado: de `DURACAO_EM_VOO_MS` para `FOLGA_APOS_PUBLICAR_MS` a contar de
 * `agora`. Até a folga vencer, quem leu a lista de reviews antes do parecer
 * aparecer nela continua barrado; depois, o commit pode ser julgado de novo.
 *
 * Só mexe na trava do commit informado: um commit novo tomou a sua própria, e
 * encurtá-la cortaria a proteção de um julgamento que está em voo.
 */
export async function assentarTravaDeParecer(deps: {
  prisma: PrismaDaTravaDeParecer
  projectId: string
  numeroDoPr: number
  headSha: string
  agora: Date
  duracaoMs?: number
}): Promise<void> {
  await deps.prisma.repoItem.updateMany({
    where: {
      projectId: deps.projectId,
      tipo: 'pr',
      numero: deps.numeroDoPr,
      parecerTravaHeadSha: deps.headSha,
    },
    data: {
      parecerTravadoAte: new Date(
        deps.agora.getTime() + (deps.duracaoMs ?? FOLGA_APOS_PUBLICAR_MS)
      ),
    },
  })
}
