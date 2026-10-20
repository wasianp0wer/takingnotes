import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PALETTE_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|shadow)-(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})\b/
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/

const sources = import.meta.glob('/src/**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
describe('no hard-coded colours', () => {
  it('keeps palette classes and hex colours out of component sources', () => {
    const offenders: string[] = []
    for (const [path, text] of Object.entries(sources)) {
      if (path.includes('/probe/') || path.includes('.test.')) continue
      for (const re of [PALETTE_CLASS, HEX]) {
        const match = text.match(re)
        if (match) offenders.push(`${path}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps hex and rgb( colours out of index.css', () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8')
    expect(css).toBeTruthy()
    expect(css.match(HEX)?.[0]).toBeUndefined()
    expect(css.includes('rgb(')).toBe(false)
  })
})
