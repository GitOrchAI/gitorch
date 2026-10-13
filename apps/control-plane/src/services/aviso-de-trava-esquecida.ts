import { decidirAvisoDeTravaEsquecida, type EstadoDaTrava } from './trava-de-entrega.js'

/**
 * Trava de entrega ligada há mais de 2 horas: avisa o dono UMA vez por período
 * de 2 horas (painel de cada projeto + canal da instância), nunca a cada tique.
 *
 * Não desliga a trava: quem a ligou (o entregador) ou o dono decide. Uma troca
 * de versão travada em silêncio deixa o produto parado sem ninguém saber, que é
 * o que este aviso existe para impedir.
 *
 * Devolve a nova marca de "último aviso" para o chamador guardar entre tiques.
 * Nunca lança: os dois canais são best-effort.
 */
export async function vigiarTravaEsquecida(args: {
  estado: EstadoDaTrava
  ultimoAviso: Date | null
  agora: Date
  /** Lido só quando há o que avisar, para o tique comum não gastar uma consulta. */
  listarProjetos: () => Promise<Array<{ id: string }>>
  /** Canal da instância (Telegram); `null` quando não há chat ligado. */
  avisar: ((texto: string) => Promise<boolean>) | null
  registrarNoPainel: (projectId: string, chave: string, texto: string) => Promise<void>
  log: { warn: (mensagem: string) => void }
}): Promise<Date | null> {
  const { estado, agora } = args
  const decisao = decidirAvisoDeTravaEsquecida({
    desde: estado.ligada ? estado.desde : null,
    ultimoAviso: args.ultimoAviso,
    agora,
  })
  if (!decisao.deveAvisar) return decisao.novoUltimoAviso

  const texto =
    `GitOrch: a atualização está em andamento há ${decisao.horasLigada} horas e o trabalho novo ` +
    'continua parado. Se não era para demorar tanto, a troca de versão pode ter travado: ' +
    'a trava de entrega nunca é solta sozinha.'
  args.log.warn(`[Entrega] ${texto}`)

  // Uma chave por período: o registro do painel é gravado uma vez só por chave.
  const chave = `trava-de-entrega-esquecida:${(estado.desde ?? agora).toISOString()}:${decisao.horasLigada}`
  const projetos = await args.listarProjetos().catch((err: unknown) => {
    args.log.warn(
      `[Entrega] não consegui listar os projetos para o aviso de trava esquecida: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return [] as Array<{ id: string }>
  })
  for (const projeto of projetos) {
    await args
      .registrarNoPainel(projeto.id, chave, texto)
      .catch((err: unknown) =>
        args.log.warn(
          `[Entrega] não consegui registrar o aviso de trava esquecida no painel: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      )
  }
  if (args.avisar) {
    await args
      .avisar(texto)
      .catch((err: unknown) =>
        args.log.warn(
          `[Entrega] não consegui avisar o dono sobre a trava esquecida: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      )
  }
  return decisao.novoUltimoAviso
}
