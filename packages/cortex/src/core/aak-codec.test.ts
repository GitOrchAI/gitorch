import { describe, expect, it } from 'vitest'
import { AakCodec, type AakEncodedRecord, type AakInput } from './aak-codec'

describe('AakCodec', () => {
  it('encodes the official AAAK header and body format', () => {
    const input: AakInput = {
      wingId: 'proj_fin',
      roomId: 'room_pay',
      date: '2026-04-10',
      sourceStem: 'stripe_svc',
      confidence: 0.9,
      entities: ['stripe', 'pci'],
      topic: 'api',
      sentence: 'impl integracao Stripe pagtos intl pci-dss Q3',
      emotion: 'neutral',
      flag: 'CORE',
    }

    expect(AakCodec.encode(input)).toBe(
      'proj_fin|room_pay|2026-04-10|stripe_svc|0:0.9:STRIPE+PCI|api|impl integracao Stripe pagtos intl pci-dss Q3|neutral|CORE'
    )
  })

  it('truncates sentences to 55 characters', () => {
    const input: AakInput = {
      wingId: 'wing',
      roomId: 'room',
      date: '2026-06-19',
      sourceStem: 'stem',
      confidence: 0.8,
      entities: ['auth'],
      topic: 'security',
      sentence: '123456789012345678901234567890123456789012345678901234567890',
      emotion: 'high',
      flag: 'STD',
    }

    expect(AakCodec.encode(input)).toBe(
      'wing|room|2026-06-19|stem|0:0.8:AUTH|security|1234567890123456789012345678901234567890123456789012345|high|STD'
    )
  })

  it('parses encoded records back into structured values', () => {
    const encoded =
      'proj_fin|room_pay|2026-04-10|stripe_svc|0:0.9:STRIPE+PCI|api|impl integracao Stripe pagtos intl pci-dss Q3|neutral|CORE'

    expect(AakCodec.decode(encoded)).toEqual({
      version: 0,
      wingId: 'proj_fin',
      roomId: 'room_pay',
      date: '2026-04-10',
      sourceStem: 'stripe_svc',
      confidence: 0.9,
      entities: ['STRIPE', 'PCI'],
      topic: 'api',
      sentence: 'impl integracao Stripe pagtos intl pci-dss Q3',
      emotion: 'neutral',
      flag: 'CORE',
    } satisfies AakEncodedRecord)
  })

  it('throws on malformed records', () => {
    expect(() => AakCodec.decode('too|few|parts')).toThrow('Malformed AAAK record')
  })
})
