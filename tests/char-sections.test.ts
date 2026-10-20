import { describe, expect, it } from 'vitest'
import {
  applyCharSections,
  joinPromptSections,
  splitCharSections
} from '../src/shared/char-sections'

const req = (over: Record<string, unknown> = {}) => ({
  prompt: '',
  negativePrompt: '',
  characterPrompts: [] as { prompt: string; negativePrompt: string; enabled: boolean }[],
  ...over
})

describe('char sections', () => {
  it('splits base and characters; other # headings stay as comments in place', () => {
    const s = splitCharSections(
      [
        '2girls, classroom',
        '# == 구도 ==',
        'cowboy shot',
        '# == char1 ==',
        'black hair, smile',
        '# == char2 ==',
        'blonde hair,',
        '# == base ==',
        'window'
      ].join('\n')
    )
    expect(s.base).toBe('2girls, classroom\n# == 구도 ==\ncowboy shot\nwindow')
    expect(s.chars.get(1)).toBe('black hair, smile')
    expect(s.chars.get(2)).toBe('blonde hair')
  })

  it('leaves a request without char markers untouched', () => {
    const r = req({ prompt: 'girl, smile\n# == 배경 ==\ncafe' })
    expect(applyCharSections(r)).toBe(r)
  })

  it('appends to enabled characters in order and creates missing ones', () => {
    const r = req({
      prompt: '2girls\n# == char1 ==\nwaving\n# == char2 ==\nsitting',
      negativePrompt: 'lowres\n# == char2 ==\nhat',
      characterPrompts: [
        { prompt: 'off card', negativePrompt: '', enabled: false },
        { prompt: 'girl, black hair', negativePrompt: '', enabled: true }
      ]
    })
    const out = applyCharSections(r)
    expect(out.prompt).toBe('2girls')
    expect(out.negativePrompt).toBe('lowres')
    expect(out.characterPrompts[0].prompt).toBe('off card')
    expect(out.characterPrompts[1].prompt).toBe('girl, black hair, waving')
    expect(out.characterPrompts[2]).toEqual({
      prompt: 'sitting',
      negativePrompt: 'hat',
      enabled: true
    })
  })

  it('splits each prompt part separately and respects the character limit', () => {
    const out = applyCharSections(
      req({
        prompt: 'ignored',
        promptParts: {
          base: 'base tags\n# == char1 ==\nfrom fixed',
          additional: 'extra',
          detail: '# == char1 ==\nfrom detail\n# == char7 ==\nnope'
        }
      }),
      1
    )
    expect(out.promptParts).toEqual({ base: 'base tags', additional: 'extra', detail: '' })
    expect(out.characterPrompts).toEqual([
      { prompt: 'from fixed, from detail', negativePrompt: '', enabled: true }
    ])
  })

  it('joins base + scene keeping markers at line start and sending plain scene text back to base', () => {
    expect(joinPromptSections('girl,', '# == char1 ==\nsmile')).toBe(
      'girl,\n# == char1 ==\nsmile'
    )
    expect(joinPromptSections('2girls\n# == char2 ==\nhat', 'cafe')).toBe(
      '2girls\n# == char2 ==\nhat\n# == base ==\ncafe'
    )
    expect(joinPromptSections('girl,', 'smile\n# hidden')).toBe('girl, smile')
  })
})
