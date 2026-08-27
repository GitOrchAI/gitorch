import { describe, expect, it } from 'vitest'
import { desvioDaAgenda, JANELA_DE_ESPALHAMENTO_MIN, relogioDaAgenda } from './espalhar-agendas.js'

// Os ids reais dos dois projetos, do banco de produção em 26/08.
const GITORCH = 'cmshlgrz6001cp5vyha5vkti4'
const PATINHAS = 'cmshvhkqu00bqp5vykx1peqf7'

describe('espalhar as agendas', () => {
  it('os dois projetos REAIS deixam de acordar o RA no mesmo minuto', () => {
    // A regressão medida: last_triggered_at idêntico até os milissegundos
    // (os dois RA às 18:01:00.339).
    expect(desvioDaAgenda(GITORCH, 'ra')).not.toBe(desvioDaAgenda(PATINHAS, 'ra'))
  })

  it('o desvio é estável: o mesmo projeto e papel caem sempre no mesmo minuto', () => {
    // Se andasse a cada reinício, ninguém conseguiria prever nem depurar
    // quando um papel roda.
    const primeiro = desvioDaAgenda(GITORCH, 'qa')
    for (let i = 0; i < 50; i += 1) expect(desvioDaAgenda(GITORCH, 'qa')).toBe(primeiro)
  })

  it('o desvio cabe na janela', () => {
    for (const papel of ['ra', 'po', 'sm', 'qa']) {
      for (const projeto of [GITORCH, PATINHAS, 'proj_x', 'proj_y', '']) {
        const desvio = desvioDaAgenda(projeto, papel)
        expect(desvio).toBeGreaterThanOrEqual(0)
        expect(desvio).toBeLessThan(JANELA_DE_ESPALHAMENTO_MIN)
      }
    }
  })

  it('um empate num papel NÃO arrasta os outros três', () => {
    // É por isso que o papel entra na conta junto com o projeto: sem ele, dois
    // projetos azarados colidiriam nos quatro papéis, todo dia, para sempre.
    const papeis = ['ra', 'po', 'sm', 'qa']
    const empates = papeis.filter((p) => desvioDaAgenda(GITORCH, p) === desvioDaAgenda(PATINHAS, p))
    expect(empates.length).toBeLessThan(papeis.length)
  })

  it('o relógio da agenda recua exatamente o desvio — o cron segue em hora redonda', () => {
    const agora = new Date('2026-08-26T18:07:00.000Z')
    const desvio = desvioDaAgenda(GITORCH, 'ra')
    expect(relogioDaAgenda(agora, GITORCH, 'ra').getTime()).toBe(agora.getTime() - desvio * 60_000)
  })

  it('espalha de verdade: cem projetos não caem todos no mesmo minuto', () => {
    const desvios = new Set(
      Array.from({ length: 100 }, (_, i) => desvioDaAgenda(`proj_${i}`, 'qa'))
    )
    // Com janela de 15, cem projetos devem ocupar quase todos os minutos.
    expect(desvios.size).toBeGreaterThanOrEqual(JANELA_DE_ESPALHAMENTO_MIN - 2)
  })
})
