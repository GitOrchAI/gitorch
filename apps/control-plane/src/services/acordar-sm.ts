// Fila coalescida de "vaga liberada" — acorda o SM assim que sobrar espaço no
// dev assíncrono, em vez de esperar a próxima janela do cron (padrão de
// 0 5,11,17,23 * * * podia deixar uma vaga livre por até 6h sem ninguém
// preenchê-la).
//
// MESMO desenho de `fila-de-julgamento.ts` (a fila que o SM levanta para o
// julgamento): o evento é registrado num Set por projeto e drenado no tique
// do relógio, fora de qualquer missão — disparar de dentro de uma missão
// voltaria "ocupado" sempre, porque o teto de concorrência do relógio conta a
// própria missão que estaria chamando.
//
// Por que Set e não contador: aqui não importa QUANTAS vagas liberaram no
// mesmo projeto no mesmo tique — o SM redescobre TODAS as tasks prontas numa
// única acordada (runSmDelegation varre o board inteiro). Contar "3 vagas
// liberadas → 3 disparos" gastaria duas missões à toa; o Set garante 1
// disparo por projeto por tique não importa quantos eventos chegaram.

export interface FilaDeVagaLiberada {
  /** Registra que este projeto teve uma vaga liberada. Idempotente por tique. */
  acordarSm(projectId: string): void
  /**
   * Tira UM projeto da frente da fila. Um por chamada (o tique chama uma vez
   * por minuto), mesmo rodízio de `fila-de-julgamento.ts`.
   */
  proxima(): string | undefined
  /** Devolve a vez à fila quando o disparo foi recusado por motivo temporário. */
  devolver(projectId: string): void
  /** Quantos projetos têm vez pendente. */
  tamanho(): number
}

export function criarFilaDeVagaLiberada(): FilaDeVagaLiberada {
  // A ordem de inserção do Set É a ordem da fila; o rodízio de `proxima` é
  // feito apagando e reinserindo a chave, que a manda para o fim.
  const pendentes = new Set<string>()

  return {
    acordarSm(projectId) {
      pendentes.add(projectId)
    },
    proxima() {
      const primeira = pendentes.values().next()
      if (primeira.done) return undefined
      pendentes.delete(primeira.value)
      return primeira.value
    },
    devolver(projectId) {
      pendentes.add(projectId)
    },
    tamanho() {
      return pendentes.size
    },
  }
}
