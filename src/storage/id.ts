/** Random identifier for stored records. Available in Node 20+ and secure browser contexts. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}
