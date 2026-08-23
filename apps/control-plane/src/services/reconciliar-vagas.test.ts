import { describe, expect, it } from 'vitest'
import {
  vagasOrfas,
  varrerVagasVazadas,
  IDADE_MINIMA_PADRAO_MS,
  TETO_PADRAO_POR_VARREDURA,
} from './reconciliar-vagas.js'

// POR QUE ESTE ARQUIVO EXISTE — a segunda metade do vazamento de vagas.
//
// O conserto anterior (PR #160) fez o FECHAMENTO arquivar do lado do
// fornecedor. Isso estanca o sangramento novo e não devolve uma gota do que já
// vazou: medido em 21/08/2026, das dezenove sessões ativas lá fora, duas o
// produto já tinha fechado aqui e três ele nem conhecia. Essas cinco vagas
// ficam presas para sempre — ninguém as fecha porque, do ponto de vista do
// banco, elas não existem.
//
// A varredura de reconciliação é a resposta. E ela é PERIGOSA: uma sessão
// nasce lá fora ANTES de a linha ser gravada aqui, e nessa fresta uma
// varredura ingênua arquivaria a delegação recém-nascida — quebrando
// exatamente a esteira que veio consertar. Por isso a guarda de idade mínima
// tem teste próprio, e por isso idade DESCONHECIDA nunca é tratada como velha.

const AGORA = new Date('2026-08-22T12:00:00Z')

function sessao(nome: string, minutosDeIdade: number, extra: Partial<{ archived: boolean }> = {}) {
  return {
    sessionName: nome,
    archived: extra.archived ?? false,
    criadaEm: new Date(AGORA.getTime() - minutosDeIdade * 60_000).toISOString(),
  }
}

describe('vagasOrfas', () => {
  it('a vaga presa é encontrada: ativa lá fora, sem linha viva aqui', () => {
    const orfas = vagasOrfas({
      ativasNoFornecedor: [sessao('sessions/presa', 120)],
      vivasNoBanco: [],
      agora: AGORA,
    })
    expect(orfas).toEqual(['sessions/presa'])
  })

  it('sessão com linha viva no banco NUNCA é órfã — é trabalho em andamento', () => {
    const orfas = vagasOrfas({
      ativasNoFornecedor: [sessao('sessions/trabalhando', 300)],
      vivasNoBanco: ['sessions/trabalhando'],
      agora: AGORA,
    })
    expect(orfas).toEqual([])
  })

  it('A GUARDA DE IDADE: a sessão recém-nascida não é tocada', () => {
    // Este é o caso da corrida. A sessão nasceu lá fora há segundos e a linha
    // aqui ainda não foi gravada — o banco diz, com toda a sinceridade, que
    // não a conhece. Arquivá-la mataria a delegação no berço, e o sintoma
    // seria idêntico ao defeito original: issue etiquetada, nada acontecendo.
    const orfas = vagasOrfas({
      ativasNoFornecedor: [sessao('sessions/recem-nascida', 0.5)],
      vivasNoBanco: [],
      agora: AGORA,
    })
    expect(orfas).toEqual([])
  })

  it('a guarda vale até o limite, e solta um instante depois', () => {
    const limite = IDADE_MINIMA_PADRAO_MS / 60_000
    expect(
      vagasOrfas({
        ativasNoFornecedor: [sessao('sessions/no-limite', limite - 0.01)],
        vivasNoBanco: [],
        agora: AGORA,
      })
    ).toEqual([])
    expect(
      vagasOrfas({
        ativasNoFornecedor: [sessao('sessions/passou', limite + 0.01)],
        vivasNoBanco: [],
        agora: AGORA,
      })
    ).toEqual(['sessions/passou'])
  })

  it('idade DESCONHECIDA não é idade velha — na dúvida, não arquiva', () => {
    // O fornecedor pode omitir `createTime`. Tratar ausência como "muito
    // antiga" inverteria a guarda justamente no caso em que não temos
    // informação nenhuma para decidir. O default seguro é não tocar.
    const orfas = vagasOrfas({
      ativasNoFornecedor: [{ sessionName: 'sessions/sem-data', archived: false, criadaEm: null }],
      vivasNoBanco: [],
      agora: AGORA,
    })
    expect(orfas).toEqual([])
  })

  it('data ilegível recebe o mesmo tratamento de data ausente', () => {
    const orfas = vagasOrfas({
      ativasNoFornecedor: [
        { sessionName: 'sessions/lixo', archived: false, criadaEm: 'nao-e-data' },
      ],
      vivasNoBanco: [],
      agora: AGORA,
    })
    expect(orfas).toEqual([])
  })

  it('sessão já arquivada não entra na conta — a vaga já está livre', () => {
    const orfas = vagasOrfas({
      ativasNoFornecedor: [sessao('sessions/ja-arquivada', 500, { archived: true })],
      vivasNoBanco: [],
      agora: AGORA,
    })
    expect(orfas).toEqual([])
  })

  it('a lista de vivas é do INSTÂNCIA INTEIRA, não de um projeto', () => {
    // Guarda contra o pior erro possível aqui: passar só as sessões de UM
    // projeto faria a varredura arquivar o trabalho em andamento de todos os
    // outros. O teste prende o contrato — quem chama tem que trazer tudo.
    const orfas = vagasOrfas({
      ativasNoFornecedor: [
        sessao('sessions/projeto-a', 120),
        sessao('sessions/projeto-b', 120),
        sessao('sessions/ninguem', 120),
      ],
      vivasNoBanco: ['sessions/projeto-a', 'sessions/projeto-b'],
      agora: AGORA,
    })
    expect(orfas).toEqual(['sessions/ninguem'])
  })

  it('idade mínima é ajustável, para a varredura poder ser mais conservadora', () => {
    const orfas = vagasOrfas({
      ativasNoFornecedor: [sessao('sessions/uma-hora', 60)],
      vivasNoBanco: [],
      agora: AGORA,
      idadeMinimaMs: 2 * 60 * 60_000,
    })
    expect(orfas).toEqual([])
  })

  it('nada a fazer devolve lista vazia, nunca undefined', () => {
    expect(vagasOrfas({ ativasNoFornecedor: [], vivasNoBanco: [], agora: AGORA })).toEqual([])
  })
})

describe('varrerVagasVazadas — a orquestração', () => {
  it('arquiva a órfã, não toca na que tem dono, e conta o que fez', async () => {
    const arquivadas: string[] = []
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [
        sessao('sessions/orfa', 120),
        sessao('sessions/com-dono', 120),
        sessao('sessions/bebe', 0.5),
      ],
      vivasNoBanco: async () => ['sessions/com-dono'],
      arquivarNoFornecedor: async (nome) => {
        arquivadas.push(nome)
        return true
      },
      agora: AGORA,
    })

    expect(arquivadas).toEqual(['sessions/orfa'])
    expect(r).toMatchObject({ examinadas: 3, orfas: 1, arquivadas: 1 })
  })

  it('fornecedor mudo (null) NÃO é fornecedor limpo: não arquiva nada', async () => {
    // Sem esta guarda, toda queda de rede viraria uma varredura que conclui
    // "não há nada ativo lá fora" — e, no dia em que a leitura do banco também
    // falhasse, o produto arquivaria trabalho vivo achando que era lixo.
    const arquivadas: string[] = []
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => null,
      vivasNoBanco: async () => [],
      arquivarNoFornecedor: async (n) => {
        arquivadas.push(n)
        return true
      },
      agora: AGORA,
    })

    expect(arquivadas).toEqual([])
    expect(r.naoConsultado).toBe(true)
  })

  it('arquivamento que falha é contado e AVISADO, sem derrubar os seguintes', async () => {
    const avisos: string[] = []
    const arquivadas: string[] = []
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [
        sessao('sessions/teimosa', 120),
        sessao('sessions/ok', 120),
        sessao('sessions/com-dono', 120),
      ],
      // Uma linha viva basta para a varredura sair da guarda do banco vazio.
      vivasNoBanco: async () => ['sessions/com-dono'],
      arquivarNoFornecedor: async (nome) => {
        if (nome === 'sessions/teimosa') return false
        arquivadas.push(nome)
        return true
      },
      agora: AGORA,
      onWarn: (m) => avisos.push(m),
    })

    expect(arquivadas).toEqual(['sessions/ok'])
    expect(r).toMatchObject({ orfas: 2, arquivadas: 1 })
    expect(avisos.some((m) => m.includes('sessions/teimosa'))).toBe(true)
  })

  it('arquivador que LANÇA não interrompe a varredura', async () => {
    const arquivadas: string[] = []
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [
        sessao('sessions/explode', 120),
        sessao('sessions/ok', 120),
        sessao('sessions/com-dono', 120),
      ],
      vivasNoBanco: async () => ['sessions/com-dono'],
      arquivarNoFornecedor: async (nome) => {
        if (nome === 'sessions/explode') throw new Error('rede caiu')
        arquivadas.push(nome)
        return true
      },
      agora: AGORA,
    })
    expect(arquivadas).toEqual(['sessions/ok'])
    expect(r.arquivadas).toBe(1)
  })

  it('teto por varredura: não despeja centenas de chamadas de uma vez', async () => {
    const muitas = Array.from({ length: 50 }, (_, i) => sessao(`sessions/${i}`, 120))
    const arquivadas: string[] = []
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [...muitas, sessao('sessions/com-dono', 120)],
      vivasNoBanco: async () => ['sessions/com-dono'],
      arquivarNoFornecedor: async (n) => {
        arquivadas.push(n)
        return true
      },
      agora: AGORA,
      teto: 5,
    })
    expect(arquivadas).toHaveLength(5)
    expect(r).toMatchObject({ orfas: 50, arquivadas: 5 })
  })

  it('falha ao ler o banco também aborta: metade da informação é pior que nenhuma', async () => {
    const arquivadas: string[] = []
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [sessao('sessions/qualquer', 120)],
      vivasNoBanco: async () => {
        throw new Error('banco fora')
      },
      arquivarNoFornecedor: async (n) => {
        arquivadas.push(n)
        return true
      },
      agora: AGORA,
    })
    expect(arquivadas).toEqual([])
    expect(r.naoConsultado).toBe(true)
  })
})

describe('a guarda do banco vazio (achado das lentes)', () => {
  it('fornecedor com sessões e banco sem NENHUMA: não arquiva e diz por quê', async () => {
    // As duas explicações possíveis são incompatíveis e daqui não dá para
    // distinguir: ou tudo vazou mesmo, ou estamos lendo o banco errado —
    // instalação restaurada, base recriada, outra instância dividindo a mesma
    // chave de API. Na segunda, seguir em frente arquivaria o trabalho vivo de
    // outra gente, dez por hora, sem ninguém pedir.
    const arquivadas: string[] = []
    const avisos: string[] = []
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [sessao('sessions/a', 120), sessao('sessions/b', 120)],
      vivasNoBanco: async () => [],
      arquivarNoFornecedor: async (n) => {
        arquivadas.push(n)
        return true
      },
      agora: AGORA,
      onWarn: (m) => avisos.push(m),
    })

    expect(arquivadas).toEqual([])
    expect(r.naoConsultado).toBe(true)
    expect(avisos.join(' ')).toContain('banco errado')
  })

  it('fornecedor vazio E banco vazio é só um dia calmo, não suspeita', async () => {
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [],
      vivasNoBanco: async () => [],
      arquivarNoFornecedor: async () => true,
      agora: AGORA,
    })
    expect(r).toMatchObject({ examinadas: 0, orfas: 0, arquivadas: 0, naoConsultado: false })
  })

  it('com pelo menos uma linha viva, a varredura roda normalmente', async () => {
    const arquivadas: string[] = []
    await varrerVagasVazadas({
      listarNoFornecedor: async () => [sessao('sessions/viva', 120), sessao('sessions/orfa', 120)],
      vivasNoBanco: async () => ['sessions/viva'],
      arquivarNoFornecedor: async (n) => {
        arquivadas.push(n)
        return true
      },
      agora: AGORA,
    })
    expect(arquivadas).toEqual(['sessions/orfa'])
  })
})

// ── A calibragem medida ao vivo (22/08/2026 23:02) ─────────────────────────
//
// A primeira varredura em produção devolveu o número real, e ele não era o do
// plano: "2000 ativas no fornecedor, 1978 sem dono aqui, 10 devolvidas" — mais
// o aviso de que a listagem parou no teto de 20 páginas, ou seja, há MAIS de
// duas mil lá fora e não sabemos quantas.
//
// O plano falava em CINCO vagas presas. Os tetos foram calibrados para esse
// cenário, e com 1978 o de dez por varredura leva mais de oito dias só para as
// primeiras duas mil, enquanto o acúmulo cresce.
//
// A varredura em si está provada: 22 sessões vivas antes e depois, a do PR
// #157 intacta, zero erros. Então o que muda aqui é o NÚMERO, nunca a guarda.
describe('a varredura avisa quando ainda há fila', () => {
  it('bateu o teto: diz que sobrou trabalho para a próxima', async () => {
    // Sem este sinal, quem chama não tem como saber a diferença entre "acabou"
    // e "parou no meio" — e trataria as duas do mesmo jeito, esperando a hora
    // cheia enquanto milhares de vagas seguem presas.
    const muitas = Array.from({ length: 50 }, (_, i) => sessao(`sessions/${i}`, 120))
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [...muitas, sessao('sessions/com-dono', 120)],
      vivasNoBanco: async () => ['sessions/com-dono'],
      arquivarNoFornecedor: async () => true,
      agora: AGORA,
      teto: 5,
    })
    expect(r).toMatchObject({ orfas: 50, arquivadas: 5, atingiuOTeto: true })
  })

  it('coube tudo: diz que a fila acabou', async () => {
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [sessao('sessions/orfa', 120), sessao('sessions/dono', 120)],
      vivasNoBanco: async () => ['sessions/dono'],
      arquivarNoFornecedor: async () => true,
      agora: AGORA,
      teto: 5,
    })
    expect(r).toMatchObject({ orfas: 1, arquivadas: 1, atingiuOTeto: false })
  })

  it('varredura abortada nunca diz que bateu o teto', async () => {
    // Abortar é o oposto de "tem mais fila": não sabemos nada. Confundir os
    // dois faria a cadência acelerar justamente quando o fornecedor ou o banco
    // estão fora do ar — martelando um serviço que já não responde.
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => null,
      vivasNoBanco: async () => [],
      arquivarNoFornecedor: async () => true,
      agora: AGORA,
    })
    expect(r).toMatchObject({ naoConsultado: true, atingiuOTeto: false })
  })

  it('a guarda do banco vazio também não acelera nada', async () => {
    const r = await varrerVagasVazadas({
      listarNoFornecedor: async () => [sessao('sessions/a', 120)],
      vivasNoBanco: async () => [],
      arquivarNoFornecedor: async () => true,
      agora: AGORA,
    })
    expect(r).toMatchObject({ naoConsultado: true, atingiuOTeto: false })
  })

  it('o teto padrão dá conta do acúmulo medido em produção', async () => {
    // 1978 órfãs, medidas. Com o teto antigo de dez por hora seriam mais de
    // oito dias. O teto novo tem que drenar isso em poucas rodadas — e é por
    // isso que ele é um número medido, não um chute.
    expect(TETO_PADRAO_POR_VARREDURA).toBeGreaterThanOrEqual(100)
    // E continua sendo uma VÁLVULA: um erro de lógica não pode virar
    // arquivamento ilimitado numa tacada.
    expect(TETO_PADRAO_POR_VARREDURA).toBeLessThan(1000)
  })

  it('as três guardas continuam de pé depois da recalibragem', async () => {
    // A guarda contra o pior desfecho possível desta tarefa: subir os números
    // e, sem perceber, afrouxar o que impede arquivar trabalho vivo.
    const arquivadas: string[] = []
    const deps = {
      vivasNoBanco: async () => ['sessions/dono'],
      arquivarNoFornecedor: async (n: string) => {
        arquivadas.push(n)
        return true
      },
      agora: AGORA,
    }
    await varrerVagasVazadas({
      ...deps,
      listarNoFornecedor: async () => [
        sessao('sessions/dono', 500),
        sessao('sessions/bebe', 0.5),
        { sessionName: 'sessions/sem-data', archived: false, criadaEm: null },
        sessao('sessions/arquivada', 500, { archived: true }),
        sessao('sessions/legitima', 500),
      ],
    })
    expect(arquivadas).toEqual(['sessions/legitima'])
  })
})
