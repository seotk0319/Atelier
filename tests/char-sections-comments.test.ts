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
