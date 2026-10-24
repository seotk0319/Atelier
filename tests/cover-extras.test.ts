import { describe, expect, it } from 'vitest'
import {
  activeLayerId,
  alignLayerAcrossTypos,
  coverBlobKeys,
  findLayer,
  getCoverCanvas,
  getPlacement,
  newCoverProject,
  normalizeCoverProject,
  setPlacement,
  type CoverItem
} from '../src/shared/cover'

const item = (id: string, w: number, h: number): CoverItem => ({
  id,
  name: id,
  blobKey: 'key-' + id + '-0000',
  width: w,
  height: h
})

function project() {
  const p = newCoverProject('proj-00001', '작품')
  p.typos = [
    { ...item('ko', 1000, 600), extras: [item('ko-up', 1942, 809)] },
    { ...item('en', 1200, 400), extras: [item('en-up', 2400, 600)] },
    item('ja', 1000, 500)
  ]
  return p
}

describe('타이포 문구', () => {
  it('저장 파일을 다시 읽어도 문구·문구 위치·선택이 남는다', () => {
    const p = project()
    const c = getCoverCanvas('2x3')!
    setPlacement(p, 'ko-up', '2x3', { cx: 0.5, cy: 0.1, w: 0.8, h: 0.1 })
    p.selection.typoId = 'ko'
    p.selection.layerId = 'ko-up'
    const back = normalizeCoverProject(JSON.parse(JSON.stringify(p)))!
    expect(back.typos[0].extras?.map((e) => e.id)).toEqual(['ko-up'])
    expect(back.placements['ko-up@2x3']).toEqual({ cx: 0.5, cy: 0.1, w: 0.8, h: 0.1 })
    expect(activeLayerId(back)).toBe('ko-up')
    expect(getPlacement(back, back.typos[0].extras![0], c).cy).toBe(0.1)
  })

  it('다른 타이포의 문구를 고른 채로 저장돼 있으면 본체로 돌아간다', () => {
    const p = project()
    p.selection.typoId = 'en'
    p.selection.layerId = 'ko-up'
    const back = normalizeCoverProject(JSON.parse(JSON.stringify(p)))!
    expect(back.selection.layerId).toBeNull()
    expect(activeLayerId(back)).toBe('en')
  })

  it('문구 이미지도 작품 삭제 때 지울 목록에 들어간다', () => {
    expect(coverBlobKeys(project())).toContain('key-ko-up-0000')
  })

  it('문구 번호로 그 타이포를 찾는다', () => {
    const f = findLayer(project(), 'en-up')!
    expect(f.typo.id).toBe('en')
    expect(f.item.id).toBe('en-up')
  })

  it('문구 기본 위치는 위쪽', () => {
    const p = project()
    const pl = getPlacement(p, p.typos[0].extras![0], getCoverCanvas('2x3')!)
    expect(pl.cy).toBeLessThan(0.5)
    expect(pl.cy - pl.h / 2).toBeGreaterThan(0)
  })

  it('다른 언어도 같은 자리로: 같은 순번끼리 중심·높이를 맞추고 너비는 비율대로', () => {
    const p = project()
    setPlacement(p, 'ko-up', '2x3', { cx: 0.4, cy: 0.12, w: 0.9, h: 0.1 })
    const n = alignLayerAcrossTypos(p, 'ko-up', ['2x3'])
    // ja 는 문구가 없어서 빠진다
    expect(n).toBe(1)
    const en = p.placements['en-up@2x3']
    expect(en.cx).toBe(0.4)
    expect(en.cy).toBe(0.12)
    expect(en.h).toBe(0.1)
    // 2400x600 이미지, 캔버스 800x1200 → 높이 120px, 너비 480px
    expect(en.w * 800).toBeCloseTo(480)
    expect(p.placements['ko@2x3']).toBeUndefined()
  })
})
