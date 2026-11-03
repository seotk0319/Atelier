import { describe, expect, it } from 'vitest'
import { knowledgeLevel, knowledgeModel, promptTags } from '../src/shared/tag-knowledge'

describe('tag knowledge', () => {
  it('maps counts to levels like the arca test (V5 mika track 9488 ok, new year 5388 poor)', () => {
    expect(knowledgeLevel(9488)).toBe('strong')
    expect(knowledgeLevel(5388)).toBe('fair')
    expect(knowledgeLevel(667)).toBe('weak')
    expect(knowledgeLevel(null)).toBe('unknown')
    expect(knowledgeModel('nai-diffusion-5-full-medium-inpainting')).toBe('nai-diffusion-5-full')
    expect(knowledgeModel('nai-diffusion-4-5-full')).toBe('nai-diffusion-4-5-full')
  })

  it('pulls plain tags out of weights, emphasis, fragments, comments and artist tags', () => {
    const text =
      '1girl, 0.9::artist:rurudo ::, -3::artist collaboration ::,\n# == char1 ==\n{mika (blue archive)}, [[school uniform]], <emotion>, a|b, 1.5::detailed shading ::, 1girl'
    const tags = promptTags(text)
    expect(tags.map((t) => t.key)).toEqual([
      '1girl',
      'artist collaboration',
      'mika (blue archive)',
      'school uniform',
      'detailed shading'
    ])
    const mika = tags[2]
    expect(text.slice(mika.start, mika.end)).toBe('mika (blue archive)')
  })
})
