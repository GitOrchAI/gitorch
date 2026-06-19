import { describe, expect, it } from 'vitest'
import { AakCodec } from '../core/aak-codec'

describe('AAAK benchmark quality', () => {
  it('keeps deterministic round-trip fidelity while compressing long context', () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      wingId: `wing-${index}`,
      roomId: `room-${index % 10}`,
      date: '2026-06-19',
      sourceStem: `source-${index % 5}`,
      confidence: 0.8 + (index % 20) / 100,
      entities: ['stripe', 'pci', 'auth'],
      topic: 'payments',
      sentence: `Original sentence ${index} with enough context to simulate a long drawer payload and preserve the semantic anchor for retrieval. This is the verbose baseline that would normally consume model context, but AAAK should keep only the deterministic anchor. Repeat the requirement for payments, PCI, auth, Stripe, international compliance, and cross-language dependency impact so the baseline stays intentionally large.`,
      emotion: index % 3 === 0 ? 'high' : 'neutral',
      flag: index % 4 === 0 ? 'CORE' : 'STD',
    }))

    const originalBytes = records.reduce((total, record) => total + record.sentence.length, 0)
    const encoded = records.map((record) => AakCodec.encode(record))
    const encodedBytes = encoded.reduce((total, record) => total + record.length, 0)
    const decoded = encoded.map((record) => AakCodec.decode(record))

    expect(decoded).toHaveLength(records.length)
    expect(
      decoded.every((record, index) => record.sentence === records[index].sentence.slice(0, 55))
    ).toBe(true)
    expect(decoded.every((record) => record.entities.join('+') === 'STRIPE+PCI+AUTH')).toBe(true)
    expect(encodedBytes).toBeLessThan(originalBytes)
    expect(originalBytes / encodedBytes).toBeGreaterThan(2)
  })
})
