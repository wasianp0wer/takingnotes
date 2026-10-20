import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToHslTriplet, isHexColor } from './color'

describe('hexToHslTriplet', () => {
  it('converts white, black and red', () => {
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%')
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%')
    expect(hexToHslTriplet('#ff0000')).toBe('0 100% 50%')
  })
})

describe('isHexColor', () => {
  it('accepts #rrggbb only', () => {
    expect(isHexColor('#AbCdEf')).toBe(true)
    for (const bad of ['#fff', 'red', 'rgb(0,0,0)', '#ff00001', 5, null]) {
      expect(isHexColor(bad)).toBe(false)
    }
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })
})
