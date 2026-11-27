import { describe, expect, it } from 'vitest'
import {
  buildClaudeRequest,
  checkJobs,
  parseMainParams,
  seedFor
} from '../src/main/claude-gen/build'
import { buildGenerateImagePayload } from '../src/main/nai/payload'

const job = {
  name: 'NPC_레온',
  prompt: '# 캐릭터\nboy, blue eyes, 1.1::short hair ::, 1boy, solo, standing',
  negativePrompt: 'extra arms'
}

describe('claude-gen buildClaudeRequest', () => {
  it('3분할이면 고정 칸만 가져오고 가변·디테일 칸(지금 뽑던 인물)은 버린다', () => {
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
      additional: '',
      detail: 'boy, blue eyes, 1.1::short hair ::, 1boy, solo, standing'
    })
    expect(req.prompt).toBe(
      'artist:a, masterpiece, boy, blue eyes, 1.1::short hair ::, 1boy, solo, standing'
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

  it('건에 charRefs가 있으면 그것만 extraCharRefs로 싣고 메인의 레퍼는 버린다', () => {
    const base = parseMainParams(
      JSON.stringify({
        model: 'nai-diffusion-5-full',
        prompt: '',
        extraCharRefs: [{ filePath: 'C:/old.png', refType: 'style', strength: 1, fidelity: 1 }]
      })
    )
    const req = buildClaudeRequest(
      base,
      false,
      { ...job, charRefs: [{ filePath: 'D:/ref/E01.webp', refType: 'character', strength: 2.5 }] },
      1,
      { width: 1024, height: 1024 },
      { allowAnlas: true, seed: 9 }
    )
    expect(req.extraCharRefs).toEqual([
      { filePath: 'D:/ref/E01.webp', refType: 'character', strength: 2.5, fidelity: 1 }
    ])
  })

  it('main_params가 깨졌으면 기본값으로 시작한다', () => {
    expect(parseMainParams('{oops').steps).toBe(28)
    expect(parseMainParams(null).prompt).toBe('')
  })
})

describe('claude-gen seedFor', () => {
  it('시드를 받으면 장마다 하나씩 올리고, 넘치면 0부터', () => {
    expect(seedFor({ name: 'a', prompt: 'x', seed: 2107633743 }, 0)).toBe(2107633743)
    expect(seedFor({ name: 'a', prompt: 'x', seed: 2107633743 }, 1)).toBe(2107633744)
    expect(seedFor({ name: 'a', prompt: 'x', seed: 4294967295 }, 1)).toBe(0)
  })
  it('시드가 없으면 무작위 정수', () => {
    const v = seedFor({ name: 'a', prompt: 'x' }, 0)
    expect(Number.isInteger(v) && v >= 0 && v < 4294967296).toBe(true)
  })
})

describe('claude-gen checkJobs', () => {
  it('정상 입력은 글을 고치지 않고 돌려준다', () => {
    const r = checkJobs([{ ...job, count: 2, width: 832, height: 1216 }])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.jobs[0].prompt).toBe(job.prompt)
  })

  it('seed는 그대로 넘긴다', () => {
    const r = checkJobs([
      { ...job, seed: 0 },
      { ...job, name: 'b', seed: 4294967295 }
    ])
    expect(r.ok && r.jobs.map((j) => j.seed)).toEqual([0, 4294967295])
  })

  it('charRefs는 종류 기본 character·강도 기본 1로 받고, 윈도 경로를 그대로 둔다', () => {
    const r = checkJobs([
      {
        ...job,
        charRefs: [
          { filePath: 'D:\\에셋\\E01_레퍼.webp', refType: 'character', strength: 2.5 },
          { filePath: 'C:/a/b.png' }
        ]
      }
    ])
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.jobs[0].charRefs).toEqual([
        { filePath: 'D:\\에셋\\E01_레퍼.webp', refType: 'character', strength: 2.5 },
        { filePath: 'C:/a/b.png', refType: 'character', strength: 1 }
      ])
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
    [Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, prompt: 'x', count: 7 })), '32장'],
    [[{ name: 'a', prompt: 'x', seed: -1 }], 'seed'],
    [[{ name: 'a', prompt: 'x', seed: 1.5 }], 'seed'],
    [[{ name: 'a', prompt: 'x', seed: 4294967296 }], 'seed'],
    [[{ name: 'a', prompt: 'x', charRefs: [{ filePath: 'rel/a.png' }] }], '절대 경로'],
    [[{ name: 'a', prompt: 'x', charRefs: [{ filePath: 'C:/a.gif' }] }], '절대 경로'],
    [
      [{ name: 'a', prompt: 'x', charRefs: [{ filePath: 'C:/a.png', refType: 'delta' }] }],
      'refType'
    ],
    [[{ name: 'a', prompt: 'x', charRefs: [{ filePath: 'C:/a.png', strength: 6 }] }], 'strength'],
    [
      [
        {
          name: 'a',
          prompt: 'x',
          charRefs: Array.from({ length: 5 }, () => ({ filePath: 'C:/a.png' }))
        }
      ],
      '4장'
    ]
  ])('잘못된 입력을 거절한다 %#', (input, message) => {
    const r = checkJobs(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(message)
  })
})
