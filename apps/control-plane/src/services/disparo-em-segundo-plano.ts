// Dispara uma etapa do tique SEM esperá-la. O tique principal já passa do
// intervalo do relógio; uma etapa que pode levar até dezenas de segundos de
// rede (a leitura do GitHub de um projeto) não pode atrasar as seguintes.
//
// A guarda é própria da etapa (mesmo padrão de `tickEmAndamento`): enquanto a
// execução anterior não terminou, o disparo seguinte é pulado, com uma linha de
// debug para não poluir. Uma falha nunca vira rejeição sem tratamento: só chega
// ao `onWarn`, e a guarda é liberada de qualquer jeito. Os próprios `onWarn` e
// `onDebug` podem lançar (um log que quebra): isso também nunca sobe.

export interface DisparoEmSegundoPlano {
  nome: string
  /** A etapa. Pode rejeitar ou até lançar antes de devolver a promessa. */
  executar: () => Promise<void>
  onWarn: (erro: unknown, mensagem: string) => void
  onDebug: (mensagem: string) => void
}

function semLancar<A extends unknown[]>(funcao: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      funcao(...args)
    } catch {
      // o log que quebrou não derruba a etapa nem o tique
    }
  }
}

/** Devolve o disparador: `true` = iniciou a etapa; `false` = a anterior ainda está em voo. */
export function criarDisparoEmSegundoPlano(deps: DisparoEmSegundoPlano): () => boolean {
  const onWarn = semLancar(deps.onWarn)
  const onDebug = semLancar(deps.onDebug)
  let emAndamento = false

  return () => {
    if (emAndamento) {
      onDebug(`[Scheduler] ${deps.nome}: execução anterior ainda em andamento; pulando`)
      return false
    }
    emAndamento = true
    void (async () => {
      try {
        await deps.executar()
      } catch (erro) {
        onWarn(erro, `[Scheduler] ${deps.nome} falhou; tenta no próximo ciclo`)
      } finally {
        emAndamento = false
      }
    })()
    return true
  }
}
