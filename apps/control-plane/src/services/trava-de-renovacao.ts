/**
 * Uma renovação por vez, por conta de motor.
 *
 * O refresh token de alguns provedores é de USO ÚNICO: quem usa recebe um novo
 * e o antigo morre na hora. O produto tem TRÊS caminhos capazes de renovar a
 * mesma conta — a vigília de hora em hora, a captura depois de cada missão, e
 * o login assistido — e sem trava entre eles, duas renovações simultâneas
 * fazem a segunda usar um token já queimado.
 *
 * MEDIDO AO VIVO em 26/08, com o codex: "Failed to refresh token: 401
 * Unauthorized: Your refresh token has already been used to generate a new
 * access token." O produto derrubou a credencial do próprio cliente e depois
 * avisou que "o motor pediu novo login" — jogando a culpa num deslogamento que
 * nunca aconteceu.
 *
 * A trava vive no BANCO, e não em memória, porque precisa valer entre caminhos
 * diferentes do mesmo processo E entre processos. E é uma DATA, não um
 * booleano, para se soltar sozinha: um processo que morre no meio da renovação
 * não pode deixar a conta travada para sempre.
 */

/**
 * Quanto tempo a trava vale.
 *
 * Dois minutos: mais que o suficiente para uma renovação real (chamar o CLI e
 * gravar), e curto o bastante para um processo morto não segurar a conta por
 * muito tempo. O custo de errar para menos é uma renovação perdida — a próxima
 * passada pega; para mais, é a conta parada esperando um fantasma.
 */
export const VALIDADE_DA_TRAVA_MS = 2 * 60_000

export interface PrismaParaTrava {
  engineConnection: {
    updateMany: (args: {
      where: {
        userId: string
        runtime: string
        OR: Array<{ renewalLockedUntil: null } | { renewalLockedUntil: { lt: Date } }>
      }
      data: { renewalLockedUntil: Date | null }
    }) => Promise<{ count: number }>
  }
}

/**
 * Tenta pegar a trava desta conta.
 *
 * `true` = é sua, pode renovar. `false` = outro caminho está renovando agora;
 * saia sem fazer nada. NÃO é erro: a próxima passada tenta de novo, e tentar
 * agora seria justamente queimar o token.
 *
 * A escrita é condicional (trava livre ou vencida), então dois chamadores
 * simultâneos nunca passam os dois — quem escreve zero linhas perdeu.
 */
export async function pegarATrava(args: {
  prisma: PrismaParaTrava
  userId: string
  runtime: string
  agora: Date
}): Promise<boolean> {
  const resultado = await args.prisma.engineConnection.updateMany({
    where: {
      userId: args.userId,
      runtime: args.runtime,
      // Livre, ou de alguém que já morreu sem soltar.
      OR: [{ renewalLockedUntil: null }, { renewalLockedUntil: { lt: args.agora } }],
    },
    data: { renewalLockedUntil: new Date(args.agora.getTime() + VALIDADE_DA_TRAVA_MS) },
  })
  return resultado.count > 0
}

/**
 * Devolve a trava assim que a renovação termina.
 *
 * Sem isto, a conta ficaria parada até a trava vencer — o que funciona, mas
 * faz a próxima renovação legítima esperar dois minutos à toa.
 */
export async function soltarATrava(args: {
  prisma: PrismaParaTrava
  userId: string
  runtime: string
  agora: Date
}): Promise<void> {
  await args.prisma.engineConnection.updateMany({
    where: {
      userId: args.userId,
      runtime: args.runtime,
      OR: [{ renewalLockedUntil: null }, { renewalLockedUntil: { lt: args.agora } }],
    },
    data: { renewalLockedUntil: null },
  })
}
