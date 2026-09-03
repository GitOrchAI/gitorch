import { resolverCredencialDoDev, recadoDaRecusa } from './credencial-do-dev-do-cliente.js'

/**
 * A resolução de "qual chave do dev assíncrono (Jules) usar" (BYOK, D34),
 * extraída de `plugins/scheduler.ts` para virar INJETÁVEL.
 *
 * Antes desta tarefa, `chaveDoDevDoProjeto`/`chaveDaConta`/`chaveDaSessao`
 * eram closures presas dentro de `schedulerPlugin` — só acessíveis para quem
 * roda dentro do relógio. `services/retomar-sessao-com-resposta.ts` (a
 * resposta do dono que retoma a sessão, L4-T3) roda FORA do scheduler — é
 * chamada por `agent-question.ts answer()`, ligada em `plugins/telegram.ts`
 * — e precisa da MESMA lógica de resolução de chave. Duplicá-la ali seria
 * exatamente o tipo de divergência que este produto já pagou caro por
 * (`credencial-do-dev-do-cliente.ts` documenta o mesmo cuidado). `scheduler.ts`
 * passa a DELEGAR para estas funções em vez de manter a própria cópia — as
 * 14 chamadas existentes (`chaveDoDevDoProjeto(...)`, `chaveDaConta(...)`,
 * `chaveDaSessao(...)`) continuam idênticas, só a implementação por trás
 * delas mudou de local.
 *
 * `resolverCredencialDoDev`/`decryptCredential` continuam PUROS
 * (`credencial-do-dev-do-cliente.ts`); este módulo é a camada que soma
 * Prisma + `process.env['JULES_API_KEY']` (injetado, nunca lido daqui) por
 * cima deles — mesma disciplina de nunca escrever a chave em log/arquivo.
 */

export interface PrismaParaChaveDoDev {
  project: {
    findUnique: (args: {
      where: { id: string }
      select: { encryptedDevApiKey: true }
    }) => Promise<{ encryptedDevApiKey: string | null } | null>
    findFirst: (args: {
      where: { devAccountId: string; encryptedDevApiKey: { not: null } }
      select: { encryptedDevApiKey: true }
    }) => Promise<{ encryptedDevApiKey: string | null } | null>
  }
  devSession: {
    findUnique: (args: {
      where: { sessionName: string }
      select: { devAccountId: true }
    }) => Promise<{ devAccountId: string | null } | null>
  }
}

interface DepsDaChave {
  prisma: PrismaParaChaveDoDev
  decifrar: (envelope: string) => string
  /** A chave da instância (do dono), lida do ambiente pelo CHAMADOR — este
   *  módulo nunca lê `process.env` diretamente (fica testável sem env). */
  chaveDaInstancia: string | undefined
  onWarn?: (mensagem: string) => void
}

/**
 * A chave do dev assíncrono que ESTE projeto usa (BYOK, D34).
 *
 * Decifrada no instante do uso e devolvida por valor, nunca guardada em
 * arquivo nem escrita em log. Recusa em vez de cair calada na conta do dono.
 */
export async function chaveDoDevDoProjeto(
  deps: DepsDaChave,
  projetoId: string
): Promise<string | undefined> {
  const registro = await deps.prisma.project.findUnique({
    where: { id: projetoId },
    select: { encryptedDevApiKey: true },
  })
  const resolvida = resolverCredencialDoDev({
    credencialCifrada: registro?.encryptedDevApiKey ?? null,
    chaveDaInstancia: deps.chaveDaInstancia,
    decifrar: deps.decifrar,
  })
  if (resolvida.ok) return resolvida.chave
  deps.onWarn?.(`projeto ${projetoId}: ${recadoDaRecusa(resolvida.motivo)}`)
  return undefined
}

/**
 * A chave de uma CONTA específica (BYOK, D34).
 *
 * Sem cair na conta da instância quando a conta é de cliente: uma sessão que
 * nasceu na conta do cliente só pode ser consultada, avisada ou arquivada com
 * a chave DELE.
 */
export async function chaveDaContaDoDev(
  deps: DepsDaChave,
  devAccountId: string | null | undefined
): Promise<string | undefined> {
  // Conta da instância: é a do dono, no ambiente.
  if (!devAccountId) return deps.chaveDaInstancia

  const dono = await deps.prisma.project.findFirst({
    where: { devAccountId, encryptedDevApiKey: { not: null } },
    select: { encryptedDevApiKey: true },
  })
  const resolvida = resolverCredencialDoDev({
    credencialCifrada: dono?.encryptedDevApiKey ?? null,
    // De propósito sem recuo para a chave da instância.
    chaveDaInstancia: null,
    decifrar: deps.decifrar,
  })
  if (resolvida.ok) return resolvida.chave
  deps.onWarn?.(
    `conta ${devAccountId} do dev assíncrono sem credencial utilizável: ` +
      `${recadoDaRecusa(resolvida.motivo)} — as sessões abertas nela ficam sem acompanhamento até religar`
  )
  return undefined
}

/**
 * A chave da conta em que ESTA sessão nasceu.
 *
 * A conta do PROJETO não serve aqui: ela muda quando o cliente conecta, troca
 * ou desconecta a dele, e a sessão continua existindo lá fora na conta antiga.
 * Quem manda é o carimbo da linha.
 */
export async function chaveDaSessaoDoDev(
  deps: DepsDaChave,
  sessionName: string
): Promise<string | undefined> {
  let linha: { devAccountId: string | null } | null
  try {
    linha = await deps.prisma.devSession.findUnique({
      where: { sessionName },
      select: { devAccountId: true },
    })
  } catch (err) {
    // Não saber de qual conta é a sessão NÃO autoriza usar a do dono: seria
    // mexer com a chave errada numa sessão que pode ser de um cliente.
    deps.onWarn?.(`não deu para descobrir a conta da sessão ${sessionName}: ${String(err)}`)
    return undefined
  }
  return chaveDaContaDoDev(deps, linha?.devAccountId ?? null)
}
