import { describe, expect, it } from 'vitest'
import { applyCharSections } from '../src/shared/char-sections'
import { removeComments } from '../src/shared/nai-presets'

describe('char sections next to comment lines', () => {
  it('does not glue the next text onto a trailing comment line', () => {
    const r = applyCharSections({
      prompt: '',
      negativePrompt: '',
      promptParts: {
        base: '# == char1 ==\nblue hair\n# 표정',
        additional: '',
        detail: '# == char1 ==\nsmile'
      },
      characterPrompts: [{ prompt: 'girl\n# 메모', negativePrompt: '', enabled: true }]
    } as never)
    const sent = removeComments(r.characterPrompts[0].prompt)
    expect(sent).toContain('girl')
    expect(sent).toContain('blue hair')
    expect(sent).toContain('smile')
  })
})

describe('char sections beyond the model limit', () => {
  it('keeps the text in the base prompt instead of dropping it', () => {
    const chars = Array.from({ length: 6 }, () => ({
      prompt: 'girl',
      negativePrompt: '',
      enabled: true
    }))
    const r = applyCharSections(
      {
        prompt: '6+girls\n# == char7 ==\nred ribbon',
        negativePrompt: '# == char7 ==\nhat',
        characterPrompts: chars
      } as never,
      6
    )
    expect(r.characterPrompts).toHaveLength(6)
    expect(r.prompt).toBe('6+girls, red ribbon')
    expect(r.negativePrompt).toBe('hat')
  })
})
