import { describe, expect, it } from 'vitest'
import { issuesComPrAbertoDoDev } from './sm-delegation.js'

// A devolução à fila do vigia é "fechar o PR antigo": a tarefa só sai do
// bloqueio "PR aberto do dev" quando o PR deixa de estar aberto no GitHub.
describe('issuesComPrAbertoDoDev — PR fechado libera a tarefa', () => {
  const sessoes = [
    {
      sessionName: 'sessions/1',
      issueNumber: 3987,
      pullRequestNumber: 3995,
    },
  ] as unknown as Parameters<typeof issuesComPrAbertoDoDev>[0]['sessoes']

  it('com o PR aberto a tarefa fica bloqueada', async () => {
    const r = await issuesComPrAbertoDoDev({
      repository: 'o/r',
      sessoes,
      gh: async () => [{ number: 3995 }],
    })
    expect([...r]).toEqual([3987])
  })

  it('com o PR fechado a tarefa volta a poder ser delegada', async () => {
    const r = await issuesComPrAbertoDoDev({
      repository: 'o/r',
      sessoes,
      gh: async () => [],
    })
    expect(r.size).toBe(0)
  })
})
