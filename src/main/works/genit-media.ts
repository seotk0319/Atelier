// 젠잇 이미지. 젠잇은 이미지를 사이트 안(작품의 에셋 폴더)에 올리고, 출력에서 {{url}}폴더/이름.webp로 부른다
// (아빠 결정: 젠잇은 사이트 내부 이미지). 편집기는 이미지를 따로 올리지 않고 작품 저장(PATCH) 본문에 같이 싣는다
// (2026-11-10 공개 스크립트: updateCharacter의 media_files + media_files_meta [{folder, filename}],
//  남길 기존 에셋은 image_source_urls + image_source_meta [{folder}], 대표 이미지는 profile_image_files +
//  profile_images_meta [{file_name, order, existing_media_id}]).
// 묶음 0 = 에셋(내부 이미지), 묶음 1 = 대표(프로필) 이미지.
import {
  character,
  genitAssets,
  genitProfiles,
  type AssetUpload,
  type GenitFormParts
} from './genit-form'
import type { FileRules, ImageChanges, ImageGroup, ImagePlanLine } from './types'

// 편집기는 webp가 아니면 브라우저에서 webp로 바꿔 올린다. 앱에는 바꾸는 기능이 없어 webp만 받는다.
// 크기 한도는 편집기 설정 REQUEST_SIZE_LIMITS.IMAGE_UPLOAD (5,242,880바이트).
export const GENIT_IMAGE_RULES: FileRules = { extensions: ['webp'], maxBytes: 5_242_880 }

export const ASSET_GROUP = 0
export const PROFILE_GROUP = 1

function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

export function genitImageGroups(raw: unknown): ImageGroup[] {
  const c = character(raw)
  return [
    {
      character: ASSET_GROUP,
      name: '에셋(내부 이미지)',
      images: genitAssets(c).map((a) => ({
        id: null,
        url: a.url,
        // 출력에서 부르는 이름 ({{url}} 뒤에 붙는 부분)
        label: a.folder ? a.folder + '/' + a.name : a.name,
        description: '',
        visibility: null,
        isDefault: false
      }))
    },
    {
      character: PROFILE_GROUP,
      name: '대표 이미지',
      images: genitProfiles(c).map((p, i) => ({
        id: p.id,
        url: p.url,
        label: p.fileName,
        description: '',
        visibility: null,
        isDefault: i === 0
      }))
    }
  ]
}

/** 에셋 이름 "폴더/이름(.webp)" → 폴더와 파일 이름. 편집기는 공백 든 파일 이름을 거절한다 */
function assetName(label: string): { folder: string; name: string } {
  const clean = label.trim().replace(/^\/+|\/+$/g, '')
  const cut = clean.lastIndexOf('/')
  const folder = cut >= 0 ? clean.slice(0, cut) : ''
  let name = cut >= 0 ? clean.slice(cut + 1) : clean
  if (!/\.webp$/i.test(name)) name = name.replace(/\.(png|jpe?g|gif)$/i, '') + '.webp'
  if (
    !name ||
    name === '.webp' ||
    /\s/.test(name) ||
    /[\\?#%]/.test(clean) ||
    folder
      .split('/')
      .some((part) => folder !== '' && (!part.trim() || part === '.' || part === '..'))
  )
    throw new Error('BAD_IMAGE_LABEL')
  return { folder, name }
}

/** 이미지 바꾸기를 저장 본문 묶음으로 옮긴다. 되지 않는 조합이면 던진다 */
export function genitImageParts(raw: unknown, changes: ImageChanges): GenitFormParts {
  const c = character(raw)
  const group = changes.character ?? ASSET_GROUP
  if (changes.order) throw new Error('BAD_CHANGES')

  if (group === ASSET_GROUP) {
    // 에셋은 편집기도 이름 순으로만 보여 준다. 대표 지정·공개 범위·설명 칸이 없다.
    if (changes.main) throw new Error('BAD_CHANGES')
    const assets = genitAssets(c)
    const gone = new Set((changes.remove ?? []).map((i) => at(i, assets.length)))
    if (gone.size !== (changes.remove ?? []).length) throw new Error('BAD_INDEX')
    const keep = assets.filter((_, i) => !gone.has(i))
    const taken = new Set(keep.map((a) => (a.folder + '/' + a.name).toLowerCase()))
    const uploads: AssetUpload[] = []
    for (const add of changes.add ?? []) {
      if (add.isDefault || add.description !== undefined || add.visibility !== undefined)
        throw new Error('BAD_CHANGES')
      const { folder, name } = assetName(add.label ?? add.file.name)
      const key = (folder + '/' + name).toLowerCase()
      // 같은 폴더에 같은 이름이 둘이면 출력에서 어느 쪽을 부를지 알 수 없다
      if (taken.has(key)) throw new Error('BAD_IMAGE_LABEL')
      taken.add(key)
      uploads.push({ file: add.file, folder, name })
    }
    if (!gone.size && !uploads.length) throw new Error('NO_CHANGES')
    return { content: true, keepAssets: keep, newAssets: uploads }
  }

  if (group === PROFILE_GROUP) {
    // 첫 장을 바꾸면 편집기는 목록용 작은 그림을 브라우저에서 새로 만들어 같이 보낸다. 그 과정은 옮기지 않았다.
    if (changes.main) throw new Error('BAD_CHANGES')
    const profiles = genitProfiles(c)
    const gone = new Set((changes.remove ?? []).map((i) => at(i, profiles.length)))
    if (gone.size !== (changes.remove ?? []).length) throw new Error('BAD_INDEX')
    if (gone.has(0)) throw new Error('KEEP_MAIN_IMAGE')
    const keep = profiles.filter((_, i) => !gone.has(i))
    if (keep.some((p) => !p.id)) throw new Error('WORK_SHAPE')
    const add = (changes.add ?? []).map((a) => {
      if (a.isDefault || a.description !== undefined || a.visibility !== undefined || a.label)
        throw new Error('BAD_CHANGES')
      if (/\s/.test(a.file.name)) throw new Error('BAD_IMAGE_LABEL')
      return a.file
    })
    if (!gone.size && !add.length) throw new Error('NO_CHANGES')
    return {
      // 대표 이미지만 바뀌면 편집기는 기본 정보 묶음으로만 저장한다
      content: false,
      profiles: {
        keep: keep.map((p) => ({ id: p.id!, fileName: p.fileName })),
        add
      }
    }
  }
  throw new Error('BAD_INDEX')
}

export function genitPlanImages(raw: unknown, changes: ImageChanges): ImagePlanLine[] {
  const parts = genitImageParts(raw, changes)
  const groups = genitImageGroups(raw)
  const group = changes.character ?? ASSET_GROUP
  const lines: ImagePlanLine[] = []
  for (const i of changes.remove ?? [])
    lines.push({
      action: 'remove',
      detail: '[' + i + '] ' + groups[group].images[i].label + ' 삭제'
    })
  for (const upload of parts.newAssets ?? [])
    lines.push({
      action: 'add',
      detail:
        '에셋 ← ' +
        upload.file.name +
        ' ({{url}}' +
        (upload.folder ? upload.folder + '/' : '') +
        upload.name +
        ')'
    })
  for (const file of parts.profiles?.add ?? [])
    lines.push({ action: 'add', detail: '대표 이미지 끝에 ← ' + file.name })
  return lines
}
