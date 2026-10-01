import { describe, expect, it } from 'vitest'
import { ehParticipanteDoRepo } from './participante-do-repo.js'

describe('ehParticipanteDoRepo — quem o dono deixou orquestrar o repositório', () => {
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('%s é participante', (associacao) => {
    expect(ehParticipanteDoRepo(associacao)).toBe(true)
  })

  it.each(['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN'])(
    '%s NÃO é participante',
    (associacao) => {
      expect(ehParticipanteDoRepo(associacao)).toBe(false)
    }
  )

  it('ausente, nulo ou vazio NÃO é participante (na dúvida, ninguém age)', () => {
    expect(ehParticipanteDoRepo(undefined)).toBe(false)
    expect(ehParticipanteDoRepo(null)).toBe(false)
    expect(ehParticipanteDoRepo('')).toBe(false)
    expect(ehParticipanteDoRepo('   ')).toBe(false)
  })

  it('valor que não é texto NÃO é participante', () => {
    expect(ehParticipanteDoRepo(42)).toBe(false)
    expect(ehParticipanteDoRepo({ toString: () => 'OWNER' })).toBe(false)
    expect(ehParticipanteDoRepo(['OWNER'])).toBe(false)
  })

  it('maiúscula/minúscula não muda a resposta; espaço e texto extra, sim', () => {
    expect(ehParticipanteDoRepo('collaborator')).toBe(true)
    expect(ehParticipanteDoRepo('Member')).toBe(true)
    expect(ehParticipanteDoRepo('none')).toBe(false)
    // Só o valor EXATO do GitHub vale: nada de "contém" ou "começa com".
    expect(ehParticipanteDoRepo(' OWNER')).toBe(false)
    expect(ehParticipanteDoRepo('OWNER ')).toBe(false)
    expect(ehParticipanteDoRepo('NOT_A_COLLABORATOR')).toBe(false)
    expect(ehParticipanteDoRepo('MEMBER,NONE')).toBe(false)
  })

  it('conta de aplicativo (type Bot) fica fora mesmo com associação de dono ou colaborador', () => {
    expect(ehParticipanteDoRepo('COLLABORATOR', 'Bot')).toBe(false)
    expect(ehParticipanteDoRepo('OWNER', 'bot')).toBe(false)
    expect(ehParticipanteDoRepo('MEMBER', 'User')).toBe(true)
    expect(ehParticipanteDoRepo('MEMBER', undefined)).toBe(true)
  })
})
