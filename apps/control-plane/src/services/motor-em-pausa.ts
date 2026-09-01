/**
 * O motor que morreu pedindo login descansa — e volta sozinho.
 *
 * DECISÃO DO DONO (D2, 20/08): "falha de autenticação não deve consumir vaga
 * do teto, e o produto deve avisar na primeira vez em vez de tentar 13 vezes".
 *
 * O que aconteceu: o antigravity estava deslogado desde 20/07 e o produto
 * seguiu disparando missão nele. Treze falhas queimaram metade da cota do dia,
 * o failsafe travou, e RA, PO e SM foram pulados 834 vezes em duas horas — a
 * esteira parada de 17 a 20/08 por causa de uma credencial vencida que ninguém
 * viu. Insistir num motor deslogado não produz nada: só gasta cota e faz
 * barulho.
 *
 * A pausa é de MEMÓRIA de propósito. Ela não pode exigir intervenção para se
 * desfazer, e o pior caso de perdê-la num reinício é uma tentativa a mais —
 * barato. Gravar no banco criaria o problema oposto: um motor marcado como
 * morto que ninguém desmarca, e aí o produto para de usar um motor que já
 * voltou. Já aconteceu neste projeto, com o banco dizendo `connected` para
 * motores vencidos havia semanas.
 *
 * Ela se desfaz de dois jeitos, e os dois sem ninguém pedir: qualquer sucesso
 * naquele motor apaga a marca na hora, e o tempo apaga sozinho, para o caso de
 * o dono religar sem que nenhuma missão tenha rodado.
 */

/**
 * Quanto tempo o motor morto fica de fora.
 *
 * Uma hora é o equilíbrio: curto o bastante para o motor religado voltar ao
 * rodízio sem ninguém pedir, e longo o bastante para não repetir o desperdício
 * a cada tique do relógio.
 */
export const DESCANSO_DO_MOTOR_MORTO_MS = 60 * 60_000

/**
 * Quantas falhas IGUAIS SEGUIDAS tiram o motor do rodízio.
 *
 * A pausa acima nasceu só para credencial vencida. Mas o desperdício não é
 * exclusivo dela: medido no journal de 31/08 (janela de 9h48), 'erro
 * recuperável em antigravity' apareceu 24 vezes, e 100% dessas falhas eram o
 * MESMO `invalid model selection`; 'erro recuperável em codex' apareceu 30
 * vezes, todas o mesmo 401. São 54 tentativas queimadas em ~10 horas, cada uma
 * pagando um `podman run` inteiro (~15s só no Codex, cronometrado ao vivo).
 * Um motor quebrado tentado a cada poucos minutos, para sempre, é pior do que
 * um motor desligado — gasta cota e enche o log sem nunca produzir nada.
 *
 * TRÊS, e não uma: uma falha isolada é ruído do mundo (rede, container, um
 * repositório estranho). Três iguais SEGUIDAS são um defeito, não azar. E o
 * critério é a IGUALDADE do erro justamente para não desligar o motor bom: um
 * motor que erra por motivos variados está vivo e reagindo — é o que erra
 * sempre a mesma coisa que não vai melhorar sozinho.
 */
export const FALHAS_IGUAIS_ATE_PAUSAR = 3

/**
 * A "impressão digital" de uma falha, para saber se é a MESMA de antes.
 *
 * Comparar a mensagem crua nunca funcionaria: ela carrega o nome do container
 * (`gitorch-mission-<id>`), caminhos temporários e horários — cada falha
 * pareceria inédita e o contador nunca chegaria ao teto. Aqui some tudo que
 * muda de missão para missão e fica o que descreve o DEFEITO.
 */
export function assinaturaDeFalha(mensagem: string): string {
  return (
    mensagem
      .toLowerCase()
      // Identificadores de missão/container/sessão (cuid, uuid, hex longo).
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
      .replace(/\bgitorch-mission-[a-z0-9-]+/g, 'gitorch-mission-<id>')
      .replace(/\bc[a-z0-9]{20,}\b/g, '<id>')
      .replace(/\b[0-9a-f]{12,}\b/g, '<id>')
      // Datas, horas e caminhos temporários.
      .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}[.\d]*z?/g, '<t>')
      .replace(/\/tmp\/[^\s"']+/g, '<tmp>')
      // Números soltos (duração, porta, pid, contagem) não distinguem defeito.
      .replace(/\b\d+\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      // Cauda longa demais vira ruído; o começo do texto já identifica o erro.
      .slice(0, 400)
  )
}

/** O que dizer quando a guarda acabou de tirar um motor do rodízio. */
export interface ResultadoDaFalha {
  /** true SÓ na virada — para o aviso sair uma vez, não a cada falha. */
  pausou: boolean
  /** O recado pronto: qual motor, quantas vezes e por quê. */
  motivo?: string
}

export interface MotorEmPausa {
  /** A credencial morreu: este motor sai do rodízio. */
  marcarMorto: (runtime: string, agora: Date) => void
  /**
   * Uma missão falhou neste motor. Conta as falhas IGUAIS seguidas e, ao
   * chegar no teto, tira o motor do rodízio — devolvendo o recado para quem
   * chamou registrar UMA vez.
   */
  marcarFalha: (runtime: string, mensagem: string, agora: Date) => ResultadoDaFalha
  /** Um sucesso prova que voltou: a marca some na hora. */
  marcarVivo: (runtime: string) => void
  estaEmPausa: (runtime: string, agora: Date) => boolean
  /** Os motores da cadeia que ainda podem rodar. */
  filtrarCadeia: <T extends { runtime: string }>(cadeia: T[], agora: Date) => T[]
}

export function criarRegistroDeMotorMorto(descansoMs = DESCANSO_DO_MOTOR_MORTO_MS): MotorEmPausa {
  const mortoDesde = new Map<string, number>()
  // Falhas IGUAIS seguidas por motor: a assinatura da última e quantas vezes.
  const falhasSeguidas = new Map<string, { assinatura: string; vezes: number }>()

  const estaEmPausa = (runtime: string, agora: Date): boolean => {
    const desde = mortoDesde.get(runtime)
    if (desde === undefined) return false
    if (agora.getTime() - desde >= descansoMs) {
      // O tempo passou: o motor volta ao rodízio sem ninguém pedir. É o
      // caminho de volta para quem religou a credencial na mão.
      mortoDesde.delete(runtime)
      return false
    }
    return true
  }

  return {
    marcarMorto(runtime, agora) {
      // A primeira marca é a que vale: remarcar a cada falha esticaria o
      // descanso para sempre num motor que falha em rajada.
      if (!mortoDesde.has(runtime)) mortoDesde.set(runtime, agora.getTime())
    },
    marcarFalha(runtime, mensagem, agora) {
      const assinatura = assinaturaDeFalha(mensagem)
      const anterior = falhasSeguidas.get(runtime)
      // Assinatura diferente ZERA a contagem: o motor está reagindo ao mundo,
      // não repetindo um defeito. É este ramo que impede a guarda de desligar
      // um motor bom que teve um dia ruim.
      const vezes = anterior && anterior.assinatura === assinatura ? anterior.vezes + 1 : 1
      falhasSeguidas.set(runtime, { assinatura, vezes })

      if (vezes < FALHAS_IGUAIS_ATE_PAUSAR) return { pausou: false }
      // Já estava de fora: não repete o recado a cada nova falha.
      if (estaEmPausa(runtime, agora)) return { pausou: false }

      mortoDesde.set(runtime, agora.getTime())
      return {
        pausou: true,
        motivo:
          `motor ${runtime} fora do rodízio: falhou ${vezes} vezes seguidas pelo MESMO erro. ` +
          `Ele volta sozinho em ${Math.round(descansoMs / 60_000)} min, ou na hora em que ` +
          `qualquer missão der certo nele. Último erro: ${mensagem.replace(/\s+/g, ' ').trim().slice(0, 500)}`,
      }
    },
    marcarVivo(runtime) {
      mortoDesde.delete(runtime)
      // O sucesso apaga a contagem também: senão duas falhas antigas somariam
      // com uma nova e derrubariam um motor que acabou de provar que funciona.
      falhasSeguidas.delete(runtime)
    },
    estaEmPausa,
    filtrarCadeia(cadeia, agora) {
      const vivos = cadeia.filter((m) => !estaEmPausa(m.runtime, agora))
      // Cadeia inteira em pausa devolve a original de propósito: ficar sem
      // motor nenhum seria parar a esteira por causa da própria proteção —
      // trocar um desperdício por uma paralisação. Melhor tentar e falhar.
      return vivos.length > 0 ? vivos : cadeia
    },
  }
}
