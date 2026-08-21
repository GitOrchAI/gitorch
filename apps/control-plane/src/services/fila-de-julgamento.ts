// A fila de acordadas de julgamento que o SM levanta a cada ciclo.
//
// O SM é o orquestrador do julgamento (docs/agents/quality-assurance.md
// §3.1). Até aqui o julgamento só era acordado por aviso do GitHub (CI
// concluído, pull request aberto) ou pela vigília de uma sessão viva — uma
// entrega cuja verificação terminou dias atrás e cuja sessão já encerrou não
// tinha quem chamasse o QA. Foi assim que o #97 ficou parado desde 15/08 com
// a verificação verde.
//
// Por que uma FILA e não um disparo direto de dentro do ciclo do SM: aquele
// ciclo roda DENTRO de uma missão, e o teto de concorrência do relógio conta
// a própria missão do SM. Disparar de lá voltaria "ocupado" sempre —
// funcionaria em teste e seria inerte em produção. Enfileirar e drenar no
// tique põe o disparo fora da missão do SM.
//
// Em memória de propósito: o critério da fila é o estado do GitHub (entrega
// aberta sem parecer nosso no commit de agora), não uma anotação nossa, então
// toda acordada do SM a redescobre inteira. Reiniciar o processo não perde
// nada que a próxima acordada não levante de novo — e não custa migração.

export interface FilaDeJulgamento {
  /**
   * Registra que este projeto tem `quantas` entregas esperando parecer.
   *
   * É `max`, nunca soma: a próxima acordada do SM redescobre as MESMAS
   * entregas enquanto elas não tiverem parecer, e somar faria a fila crescer
   * para sempre em cima da mesma entrega — a rajada que este desenho existe
   * para evitar.
   */
  enfileirar(projectId: string, quantas: number): void
  /**
   * Tira UMA vez da frente da fila e devolve de qual projeto ela é.
   *
   * Um por chamada (e o tique chama uma vez por minuto): com o teto de
   * concorrência em 1, pedir a fila inteira de uma vez só produziria recusas
   * por ocupado. O projeto atendido volta para o FIM da fila — sem esse
   * rodízio, um repositório com muitas entregas paradas deixaria o outro
   * esperando para sempre.
   */
  proxima(): string | undefined
  /** Devolve a vez à fila quando o disparo foi recusado por motivo temporário. */
  devolver(projectId: string): void
  pendentes(projectId: string): number
  /** Quantos projetos têm vez pendente. */
  tamanho(): number
}

export function criarFilaDeJulgamento(): FilaDeJulgamento {
  // A ordem de inserção do Map É a ordem da fila; o rodízio de `proxima` é
  // feito apagando e reinserindo a chave, que a manda para o fim.
  const pendentesPorProjeto = new Map<string, number>()

  return {
    enfileirar(projectId, quantas) {
      if (quantas <= 0) return
      const atual = pendentesPorProjeto.get(projectId) ?? 0
      pendentesPorProjeto.set(projectId, Math.max(atual, quantas))
    },
    proxima() {
      const primeira = pendentesPorProjeto.entries().next()
      if (primeira.done) return undefined
      const [projectId, pendentes] = primeira.value
      pendentesPorProjeto.delete(projectId)
      if (pendentes > 1) pendentesPorProjeto.set(projectId, pendentes - 1)
      return projectId
    },
    devolver(projectId) {
      pendentesPorProjeto.set(projectId, (pendentesPorProjeto.get(projectId) ?? 0) + 1)
    },
    pendentes(projectId) {
      return pendentesPorProjeto.get(projectId) ?? 0
    },
    tamanho() {
      return pendentesPorProjeto.size
    },
  }
}
