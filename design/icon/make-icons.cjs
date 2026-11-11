// node design/icon/make-icons.cjs  → design/icon/{a,b,c}.svg, preview.png
// node design/icon/make-icons.cjs apply a  → build/icon.png, build/icon-win.png, resources/icon.png, resources/icon-inverted.png
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const dir = __dirname
const root = path.join(dir, '..', '..')

const A = (stroke, w = 104) =>
  `<path d="M300 770 L512 262 L724 770" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="M404 604 H620" fill="none" stroke="${stroke}" stroke-width="${w * 0.82}" stroke-linecap="round"/>`
// pad: 아이콘 둘레 여백 (Windows는 작게, 일반은 조금 크게)
const frame = (inner, bg, pad) => {
  const s = 1024 - pad * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="${pad}" y="${pad}" width="${s}" height="${s}" rx="${s * 0.225}" fill="${bg}"/><g transform="translate(${pad} ${pad}) scale(${s / 1024})">${inner}</g></svg>`
}
const designs = {
  a: { name: '파랑 바탕 · 흰 A', bg: '#3182f6', inner: A('#ffffff') },
  b: { name: '파랑 바탕 · 흰 마름모', bg: '#3182f6', inner: '<rect x="322" y="322" width="380" height="380" rx="56" fill="#ffffff" transform="rotate(45 512 512)"/>' },
  c: { name: '짙은 바탕 · 파랑 A', bg: '#191f28', inner: A('#4593fc') }
}
const inverted = { a: { bg: '#ffffff', inner: A('#3182f6') }, b: { bg: '#ffffff', inner: '<rect x="322" y="322" width="380" height="380" rx="56" fill="#3182f6" transform="rotate(45 512 512)"/>' }, c: { bg: '#f2f4f6', inner: A('#191f28') } }

async function main() {
  const [, , cmd, pick] = process.argv
  if (cmd === 'apply') {
    const d = designs[pick]
    if (!d) throw new Error('pick a, b or c')
    const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
    fs.writeFileSync(path.join(root, 'build', 'icon.png'), await png(frame(d.inner, d.bg, 100), 1024))
    fs.writeFileSync(path.join(root, 'build', 'icon-win.png'), await png(frame(d.inner, d.bg, 24), 1024))
    fs.writeFileSync(path.join(root, 'resources', 'icon.png'), await png(frame(d.inner, d.bg, 24), 512))
    const inv = inverted[pick]
    fs.writeFileSync(path.join(root, 'resources', 'icon-inverted.png'), await png(frame(inv.inner, inv.bg, 24), 512))
    fs.writeFileSync(path.join(dir, 'icon.svg'), frame(d.inner, d.bg, 24))
    console.log('applied', pick)
    return
  }
  const cells = []
  let x = 40
  for (const [k, d] of Object.entries(designs)) {
    const svg = frame(d.inner, d.bg, 24)
    fs.writeFileSync(path.join(dir, k + '.svg'), svg)
    let cx = x
    for (const size of [256, 64, 32, 16]) {
      cells.push({ input: await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer(), left: cx, top: 60 + (256 - size) })
      cx += size + 24
    }
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="40"><text x="0" y="28" font-family="Malgun Gothic, sans-serif" font-size="24" fill="#191f28">${k.toUpperCase()} · ${d.name}</text></svg>`
    cells.push({ input: Buffer.from(label), left: x, top: 340 })
    x += 480
  }
  // 작업 표시줄 느낌: 어두운 띠 위의 32px
  const bar = `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="72"><rect width="100%" height="100%" fill="#1f1f25"/></svg>`
  cells.push({ input: Buffer.from(bar), left: 0, top: 400 })
  let bx = 40
  for (const [, d] of Object.entries(designs)) {
    cells.push({ input: await sharp(Buffer.from(frame(d.inner, d.bg, 24))).resize(40, 40).png().toBuffer(), left: bx, top: 416 })
    bx += 480
  }
  await sharp({ create: { width: x, height: 472, channels: 4, background: '#f2f4f6' } }).composite(cells).png().toFile(path.join(dir, 'preview.png'))
  console.log('preview', path.join(dir, 'preview.png'))
}
main().catch((e) => { console.error(e); process.exit(1) })
