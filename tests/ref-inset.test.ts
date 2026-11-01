import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildInsetSource,
  cropInsetResult,
  INSET_MAX_PX,
  INSET_CROP_MARGIN,
  insetPlan,
  insetShare,
  pngTextChunks
} from '../src/main/refs/inset'

const dir = mkdtempSync(join(tmpdir(), 'nais3-inset-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('reference inset (V5)', () => {
  it('maps strength to panel share and keeps the canvas free-sized', () => {
    expect(insetShare(0)).toBeCloseTo(0.3)
    expect(insetShare(1)).toBeCloseTo(0.5)
    expect(insetShare(0.6)).toBeCloseTo(0.42)
    for (const [w, h] of [
      [832, 1216],
      [1216, 832],
      [1024, 1024]
    ]) {
      const plan = insetPlan(w, h, insetShare(0.6))
      expect(plan.canvasW * plan.canvasH).toBeLessThanOrEqual(INSET_MAX_PX)
      expect(plan.canvasW % 64).toBe(0)
      expect(plan.canvasH % 64).toBe(0)
      expect(plan.panelW % 8).toBe(0)
      // 그리는 쪽 비율이 원하는 비율과 크게 다르지 않다
      const drawRatio = (plan.canvasW - plan.panelW) / plan.canvasH
      expect(Math.abs(drawRatio - w / h) / (w / h)).toBeLessThan(0.12)
    }
  })

  it('builds the canvas with the reference on the left and masks only the right side', async () => {
    const refPath = join(dir, 'ref.png')
    writeFileSync(
      refPath,
      await sharp({ create: { width: 300, height: 600, channels: 3, background: '#ff0000' } })
        .png()
        .toBuffer()
    )
    const plan = insetPlan(832, 1216, 0.4)
    const built = await buildInsetSource(refPath, plan)
    const img = sharp(Buffer.from(built.imageBase64, 'base64'))
    const meta = await img.metadata()
    expect([meta.width, meta.height]).toEqual([plan.canvasW, plan.canvasH])
    const mask = await sharp(Buffer.from(built.maskBase64, 'base64'))
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number): number => mask.data[y * mask.info.width + x]
    expect(at(plan.panelW - 1, 10)).toBe(0)
    expect(at(plan.panelW, 10)).toBe(255)
    expect(at(plan.canvasW - 1, plan.canvasH - 1)).toBe(255)
    // 빨간 참고 그림이 왼쪽 칸 가운데에 있다
    const px = await img
      .extract({
        left: Math.floor((plan.panelW - plan.divider) / 2),
        top: Math.floor(plan.canvasH / 2),
        width: 1,
        height: 1
      })
      .raw()
      .toBuffer()
    expect([px[0], px[1], px[2]]).toEqual([255, 0, 0])
  })

  it('crops the panel off and carries the NAI text chunks over', async () => {
    const plan = insetPlan(832, 1216, 0.4)
    const raw = await sharp({
      create: { width: plan.canvasW, height: plan.canvasH, channels: 3, background: '#00ff00' }
    })
      .png()
      .toBuffer()
    const chunk = (() => {
      const data = Buffer.concat([Buffer.from('Comment\0{"prompt":"x"}', 'latin1')])
      const out = Buffer.alloc(12 + data.length)
      out.writeUInt32BE(data.length, 0)
      out.write('tEXt', 4, 'ascii')
      data.copy(out, 8)
      return out
    })()
    const withText = Buffer.concat([raw.subarray(0, 33), chunk, raw.subarray(33)])
    const out = await cropInsetResult(withText, 'png', plan)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(plan.canvasW - plan.panelW - INSET_CROP_MARGIN)
    expect(meta.height).toBe(plan.canvasH)
    expect(pngTextChunks(out).map((c) => c.toString('latin1', 8, 15))).toEqual(['Comment'])
  })
})
