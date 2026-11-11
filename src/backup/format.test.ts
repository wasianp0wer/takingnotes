import { describe, expect, it } from 'vitest'
import {
  BACKUP_MAGIC,
  BackupFormatError,
  buildBackupBlob,
  decodeRecord,
  encodeRecord,
  readBackupHeader,
  sliceBinary,
  type BackupManifest,
} from './format'

const baseManifest: Omit<BackupManifest, 'binaries'> = {
  format: 1,
  appVersion: '1.2.3',
  dbVersion: 7,
  exportedAt: 1700000000000,
  stores: { notes: [{ key: null, value: { id: 'n1', text: 'héllo ✓' } }] },
  localStorage: { theme: 'dark' },
}

async function bytes(b: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await b.arrayBuffer()))
}

async function catchError(p: Promise<unknown>): Promise<BackupFormatError> {
  try {
    await p
  } catch (e) {
    return e as BackupFormatError
  }
  throw new Error('expected rejection')
}

describe('backup codec', () => {
  it('round-trips a manifest and two binaries', async () => {
    const blob = buildBackupBlob(baseManifest, [
      new Blob([Uint8Array.of(1, 2, 3)]),
      new Blob([Uint8Array.of(9)]),
    ])
    const { manifest, binaryStart } = await readBackupHeader(blob)
    expect(manifest).toEqual({
      ...baseManifest,
      binaries: [
        { offset: 0, length: 3 },
        { offset: 3, length: 1 },
      ],
    })
    expect(await bytes(sliceBinary(blob, binaryStart, manifest.binaries[1]))).toEqual([9])
    expect(await bytes(sliceBinary(blob, binaryStart, manifest.binaries[0]))).toEqual([1, 2, 3])
  })

  it('round-trips empty and repeated buffers', async () => {
    const buf = Uint8Array.of(4, 5).buffer
    const collected: ArrayBuffer[] = []
    const sink = (b: ArrayBuffer) => collected.push(b) - 1
    const encoded = encodeRecord({ a: buf, b: buf, c: new ArrayBuffer(0), d: Uint8Array.of(7).buffer }, sink)
    const blob = buildBackupBlob(baseManifest, collected.map((b) => new Blob([b])))
    const { manifest, binaryStart } = await readBackupHeader(blob)
    const loaded = await Promise.all(
      manifest.binaries.map((r) => sliceBinary(blob, binaryStart, r).arrayBuffer()),
    )
    const out = decodeRecord(encoded, (i) => loaded[i]) as Record<string, ArrayBuffer>
    expect(Array.from(new Uint8Array(out.a))).toEqual([4, 5])
    expect(Array.from(new Uint8Array(out.b))).toEqual([4, 5])
    expect(out.c.byteLength).toBe(0)
    expect(Array.from(new Uint8Array(out.d))).toEqual([7])
  })

  it('encodes nested ArrayBuffers inside arrays', () => {
    const collected: ArrayBuffer[] = []
    const sink = (b: ArrayBuffer) => collected.push(b) - 1
    const encoded = encodeRecord({ segments: [{ data: Uint8Array.of(1).buffer, n: 2 }] }, sink)
    expect(encoded).toEqual({ segments: [{ data: { $tnbin: 0 }, n: 2 }] })
    const out = decodeRecord(encoded, (i) => collected[i]) as { segments: { data: ArrayBuffer }[] }
    expect(out.segments[0].data).toBe(collected[0])
  })

  it('encodes only the slice a typed-array view covers', () => {
    const collected: ArrayBuffer[] = []
    const sink = (b: ArrayBuffer) => collected.push(b) - 1
    const view = new Uint8Array(Uint8Array.of(0, 1, 2, 3).buffer, 1, 2)
    encodeRecord({ v: view }, sink)
    expect(Array.from(new Uint8Array(collected[0]))).toEqual([1, 2])
  })

  it('refuses non-plain objects instead of flattening them to {}', () => {
    const sink = () => 0
    for (const [label, bad] of [
      ['Date', new Date(0)],
      ['Map', new Map([[1, 2]])],
      ['Set', new Set([1])],
      ['Blob', new Blob(['x'])],
      ['class instance', new (class Thing {})()],
    ] as const) {
      expect(() => encodeRecord({ nested: [{ v: bad }] }, sink), label).toThrow(
        /cannot back up a non-plain object/i,
      )
    }
  })

  it('accepts plain objects, null-prototype objects, arrays and binaries', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 })
    expect(encodeRecord({ bare, list: [1, { b: null }], bytes: new Uint8Array([1]) }, () => 7)).toEqual({
      bare: { a: 1 },
      list: [1, { b: null }],
      bytes: { $tnbin: 7 },
    })
  })

  it('rejects a file without the magic', async () => {
    const err = await catchError(readBackupHeader(new Blob([Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)])))
    expect(err).toBeInstanceOf(BackupFormatError)
    expect(err.reason).toBe('not-a-backup')
  })

  it('rejects a truncated file', async () => {
    const blob = buildBackupBlob(baseManifest, [new Blob([Uint8Array.of(1, 2, 3)])])
    const inManifest = await catchError(readBackupHeader(blob.slice(0, BACKUP_MAGIC.length + 12 + 5)))
    expect(inManifest.reason).toBe('truncated')
    const shortOfMagic = await catchError(readBackupHeader(blob.slice(0, 4)))
    expect(shortOfMagic.reason).toBe('truncated')
    const inBinary = await catchError(readBackupHeader(blob.slice(0, blob.size - 1)))
    expect(inBinary.reason).toBe('truncated')
  })

  it('rejects corrupt manifest JSON', async () => {
    const json = '{not json!'
    const len = String(new TextEncoder().encode(json).length).padStart(12, '0')
    const err = await catchError(readBackupHeader(new Blob([BACKUP_MAGIC, len, json])))
    expect(err.reason).toBe('corrupt')
    const badLen = await catchError(readBackupHeader(new Blob([BACKUP_MAGIC, 'abcdefghijkl', json])))
    expect(badLen.reason).toBe('corrupt')
  })
})
