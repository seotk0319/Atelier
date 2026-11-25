import { describe, expect, it } from 'vitest'
import { buildClaudeRequest, checkJobs, parseMainParams } from '../src/main/claude-gen/build'
import { buildGenerateImagePayload } from '../src/main/nai/payload'

const job = {
  name: 'NPC_레온',
  prompt: '# 캐릭터\nboy, blue eyes, 1.1::short hair ::, 1boy, solo, standing',
  negativePrompt: 'extra arms'
}

describe('claude-gen buildClaudeRequest', () => {
  it('3분할이면 씬 글을 디테일 칸 앞에 넣고 고정·가변 칸은 그대로 둔다', () => {
    const base = parseMainParams(
      JSON.stringify({
        prompt: 'artist:a, masterpiece, x, detail',
        promptParts: { base: 'artist:a, masterpiece', additional: 'x', detail: 'detail' },
        negativePrompt: 'lowres',
        model: 'nai-diffusion-5-full',
        weakenGeneral: true,
        characterPrompts: [
          { prompt: 'sidebar girl', negativePrompt: '', center: { x: 0.5, y: 0.5 }, enabled: true }
        ],
        extraCharRefs: [{ path: 'a.png', refType: 'character' }],
        source: { imageBase64: 'x', strength: 1, noise: 0 }
      })
    )
    const req = buildClaudeRequest(
      base,
      true,
      job,
      7,
      { width: 832, height: 1216 },
      {
        allowAnlas: false,
        seed: 123
      }
    )
    expect(req.promptParts).toEqual({
      base: 'artist:a, masterpiece',
      additional: 'x',
      detail: 'boy, blue eyes, 1.1::short hair ::, 1boy, solo, standing, detail'
    })
    expect(req.prompt).toBe(
      'artist:a, masterpiece, x, boy, blue eyes, 1.1::short hair ::, 1boy, solo, standing, detail'
    )
    expect(req.negativePrompt).toBe('lowres, extra arms')
    expect(req.characterPrompts).toEqual([])
    expect(req.source).toBeUndefined()
    expect(req.extraCharRefs).toBeUndefined()
    expect(req).toMatchObject({
      sceneId: 7,
      seed: 123,
      width: 832,
      height: 1216,
      origin: 'claude',
      allowAnlas: false,
      weakenGeneral: true,
      model: 'nai-diffusion-5-full'
    })
  })

  it('3분할이 꺼져 있으면 메인 프롬프트 뒤에 잇고 promptParts를 싣지 않는다', () => {
    const base = parseMainParams(
      JSON.stringify({
        prompt: 'artist:a',
        promptParts: { base: 'artist:a', additional: '', detail: '' },
        negativePrompt: ''
      })
    )
    const req = buildClaudeRequest(
      base,
      false,
      { ...job, model: 'nai-diffusion-5-full' },
      1,
      {
        width: 1216,
        height: 832
      },
      { allowAnlas: true, seed: 1 }
    )
    expect(req.promptParts).toBeUndefined()
    expect(req.prompt).toBe('artist:a, boy, blue eyes, 1.1::short hair ::, 1boy, solo, standing')
    expect(req.negativePrompt).toBe('extra arms')
    expect(req.allowAnlas).toBe(true)
    expect(req.model).toBe('nai-diffusion-5-full')
  })

  it('보내는 payload에 origin·allowAnlas가 섞이지 않고 가중치 글이 그대로 간다', () => {
    const base = parseMainParams(JSON.stringify({ model: 'nai-diffusion-5-full', prompt: '' }))
    const req = buildClaudeRequest(
      base,
      false,
      job,
      1,
      { width: 832, height: 1216 },
      {
        allowAnlas: false,
        seed: 5
      }
    )
    const payload = buildGenerateImagePayload(req) as unknown as Record<string, unknown>
    const text = JSON.stringify(payload)
    expect(text).not.toContain('"origin"')
    expect(text).not.toContain('"allowAnlas"')
    expect(text).toContain('1.1::short hair ::')
    expect(text).not.toContain('# 캐릭터')
  })

  it('main_params가 깨졌으면 기본값으로 시작한다', () => {
    expect(parseMainParams('{oops').steps).toBe(28)
    expect(parseMainParams(null).prompt).toBe('')
  })
})

describe('claude-gen checkJobs', () => {
  it('정상 입력은 글을 고치지 않고 돌려준다', () => {
    const r = checkJobs([{ ...job, count: 2, width: 832, height: 1216 }])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.jobs[0].prompt).toBe(job.prompt)
  })

  it.each([
    [[], 'jobs가 비었어요'],
    [[{ name: '', prompt: 'x' }], 'name'],
    [[{ name: 'a', prompt: '  ' }], 'prompt'],
    [[{ name: 'a', prompt: 'x', width: 800 }], 'width'],
    [[{ name: 'a', prompt: 'x', count: 9 }], 'count'],
    [
      [
        { name: 'a', prompt: 'x' },
        { name: 'a', prompt: 'y' }
      ],
      '같은 이름'
    ],
    [[{ name: 'a', prompt: 'x', model: 'gpt-image' }], 'model'],
    [Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, prompt: 'x', count: 7 })), '32장']
  ])('잘못된 입력을 거절한다 %#', (input, message) => {
    const r = checkJobs(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(message)
  })
})
