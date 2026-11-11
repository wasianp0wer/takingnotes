/**
 * Framed `.tnbackup` file: MAGIC + 12-digit decimal manifest byte length +
 * manifest JSON + concatenated binary parts. Binaries (page renders, audio)
 * live outside the JSON so they are never base64-encoded and a reader only
 * has to hold the header in memory.
 */

export const BACKUP_MAGIC = 'TNBACKUP1\n';

const LENGTH_DIGITS = 12;

/** `key` is set only for out-of-line-key stores (pageRenders, recordingAudio). */
export type BackupEntry = { key: IDBValidKey | null; value: unknown };

/** Offsets are relative to the start of the binary section. */
export interface BinaryRef {
  offset: number;
  length: number;
}

export interface BackupManifest {
  format: 1;
  appVersion: string;
  dbVersion: number;
  exportedAt: number;
  stores: Record<string, BackupEntry[]>;
  localStorage: Record<string, string>;
  binaries: BinaryRef[];
}

export class BackupFormatError extends Error {
  readonly reason: 'not-a-backup' | 'truncated' | 'corrupt';
  constructor(reason: 'not-a-backup' | 'truncated' | 'corrupt', message?: string) {
    super(message ?? `Invalid backup file: ${reason}`);
    this.reason = reason;
    this.name = 'BackupFormatError';
  }
}

const BIN_KEY = '$tnbin';

function isBinRef(value: unknown): value is { [BIN_KEY]: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[BIN_KEY] === 'number'
  );
}

/**
 * Replaces every ArrayBuffer (or typed-array view, by the bytes it covers)
 * at any depth with `{ $tnbin: index }`. `sink` stores the buffer and returns
 * its index. The same buffer met twice in one call is sunk once.
 */
export function encodeRecord(value: unknown, sink: (buf: ArrayBuffer) => number): unknown {
  const seen = new Map<ArrayBuffer, number>();
  const sinkOnce = (buf: ArrayBuffer): number => {
    let index = seen.get(buf);
    if (index === undefined) {
      index = sink(buf);
      seen.set(buf, index);
    }
    return index;
  };
  const walk = (v: unknown): unknown => {
    if (v instanceof ArrayBuffer) return { [BIN_KEY]: sinkOnce(v) };
    if (ArrayBuffer.isView(v)) {
      const slice = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
      return { [BIN_KEY]: sink(slice) };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) out[k] = walk(child);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Reverses `encodeRecord`. Synchronous: the caller preloads the buffers. */
export function decodeRecord(value: unknown, load: (index: number) => ArrayBuffer): unknown {
  const walk = (v: unknown): unknown => {
    if (isBinRef(v)) return load(v[BIN_KEY]);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) out[k] = walk(child);
      return out;
    }
    return v;
  };
  return walk(value);
}

export function buildBackupBlob(
  manifest: Omit<BackupManifest, 'binaries'>,
  parts: Blob[],
): Blob {
  let offset = 0;
  const binaries: BinaryRef[] = parts.map((part) => {
    const ref = { offset, length: part.size };
    offset += part.size;
    return ref;
  });
  const json = JSON.stringify({ ...manifest, binaries });
  const length = String(new TextEncoder().encode(json).length).padStart(LENGTH_DIGITS, '0');
  return new Blob([BACKUP_MAGIC, length, json, ...parts]);
}

/** Reads only the header; binaries stay on disk. */
export async function readBackupHeader(
  file: Blob,
): Promise<{ manifest: BackupManifest; binaryStart: number }> {
  const prefixLen = BACKUP_MAGIC.length + LENGTH_DIGITS;
  const prefix = await file.slice(0, prefixLen).text();
  const magic = prefix.slice(0, BACKUP_MAGIC.length);
  // A short file that is a prefix of the magic was cut off; anything else is foreign.
  if (magic !== BACKUP_MAGIC) {
    throw new BackupFormatError(BACKUP_MAGIC.startsWith(magic) ? 'truncated' : 'not-a-backup');
  }
  const digits = prefix.slice(BACKUP_MAGIC.length);
  if (digits.length < LENGTH_DIGITS) throw new BackupFormatError('truncated');
  if (!/^\d{12}$/.test(digits)) throw new BackupFormatError('corrupt', 'Bad manifest length');
  const manifestLen = Number(digits);
  const binaryStart = prefixLen + manifestLen;
  if (binaryStart > file.size) throw new BackupFormatError('truncated');

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await file.slice(prefixLen, binaryStart).text()) as BackupManifest;
  } catch {
    throw new BackupFormatError('corrupt', 'Manifest is not valid JSON');
  }
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    manifest.format !== 1 ||
    !Array.isArray(manifest.binaries)
  ) {
    throw new BackupFormatError('corrupt', 'Manifest is malformed');
  }
  const last = manifest.binaries[manifest.binaries.length - 1];
  if (last && binaryStart + last.offset + last.length > file.size) {
    throw new BackupFormatError('truncated');
  }
  return { manifest, binaryStart };
}

export function sliceBinary(file: Blob, binaryStart: number, ref: BinaryRef): Blob {
  const start = binaryStart + ref.offset;
  return file.slice(start, start + ref.length);
}
