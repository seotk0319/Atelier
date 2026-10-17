import sharp from 'sharp'

/**
 * 마스크 에디터 출력(칠한 곳=흰색, 나머지=검정)을 ChatGPT 이미지 편집용 알파 마스크로 바꾼다.
 * 칠한 곳은 투명(고칠 곳), 나머지는 불투명 검정. 고칠 그림과 같은 크기로 맞춘다.
 */
export async function alphaMask(maskB64: string, width: number, height: number): Promise<string> {
  const alpha = await sharp(Buffer.from(maskB64, 'base64'))
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    // 크기를 바꾸면 경계가 번지므로 칠한 곳/아닌 곳으로 딱 나눈다
    .threshold(128)
    .negate()
    .raw()
    .toBuffer()
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
  return png.toString('base64')
}
