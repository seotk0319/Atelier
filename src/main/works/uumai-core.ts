// 우마이 연결부가 같이 쓰는 주소·모양·저장 본문 (uumai.ts와 uumai-media.ts가 함께 쓴다).
// 근거: 2026-11-10 우마이 공개 스크립트 (실제 호출 전).
//   주소표 43911 (chunks/1547): CREATOR_WORK.ROOT "/creator/work", SAVE "/creator/work/save",
//     DELETE(e) "/creator/work/{id}", SNAPSHOTS(e) "/creator/work/{id}/snapshot", SNAPSHOT(e,t) ".../snapshot/{sid}"
//   API 기준 주소: window.__ENV__.PUBLIC_API_URL = "https://api.uumm.ai/v1" (axios, Authorization: Bearer)
//   편집기(chunks/4368):
//     불러오기 86383 q(): GET snapshots → {snapshots, draftSnapshotId, publishedSnapshotId} →
//       draftSnapshotId의 스냅샷을 GET해 Bx(스냅샷)으로 폼을 만든다 (초안과 발행본이 다르면 사람에게 고르게 한다)
//     저장 2628 S(): NG(폼, {isPublish, workId}) → POST /creator/work/save → {workId, snapshotId}
//       isPublish false = "임시저장", true = "작품 등록(발행)"
//     91740 Bx(스냅샷→폼) / NG(폼→저장 본문) — 아래 uumaiSaveBody가 둘을 이어 옮긴 것이다
//     25529 H(): 로어북을 폴더 없는 것 먼저, 그다음 폴더 순서대로 다시 줄 세우고 order를 1부터 매긴다
//   저장 본문 규격(zod, 55962 CreatorWorkDraftItem / CreatorWorkSnapshotItem):
//     title ≤20, description(작품소개) ≤10,000, detailDescription(상세 작품소개) ≤100,000, prompt(상세 프롬프트) ≤50,000,
//     intros ≤10 {name ≤50, content ≤5,000, prompt ≤5,000, promptMaxTurn 1~255|null, recommends ≤3}, playGuide ≤5,000,
//     lorebooks ≤300 {name ≤30, keywords ≤50개·각 20자, content ≤10,000, notKeywords ≤5, scanTurns -1~5 …},
//     images ≤1,000 {imageId(uuid), isPublic, keyword ≤30, slug /^[a-z0-9]{5}$/}, jsx {fileName, sourceCode, compiledCode, components}
//   공개 여부 enum PublishStatus: Public 1 / Private 2 / LinkOnly 3
import type { WorkWrite } from './types'
import { UUID, UUID_RE, at, isObj, list, strOrNull, strings, text } from './shared'
export { UUID, UUID_RE, at, isObj, list, strOrNull, strings, text }

export const UUMAI_API = 'https://api.uumm.ai/v1'
export const UUMAI_SITE = 'https://uumm.ai'

export type Obj = Record<string, unknown>

export function uumaiWorkId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id
}

/** 우마이 API 주소이고 경로가 맞는지. query를 주면 쿼리도 그 검사로 본다 (주지 않으면 쿼리가 없어야 한다) */
export function uumaiPlain(
  url: string,
  paths: RegExp[],
  query?: (q: URLSearchParams) => boolean
): boolean {
  try {
    const u = new URL(url)
    return (
      u.origin === 'https://api.uumm.ai' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (query ? query(u.searchParams) : !u.search) &&
      paths.some((re) => re.test(u.pathname))
    )
  } catch {
    return false
  }
}

export async function uumaiJson(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  return res.json()
}

/** 작품 원본: 편집기가 여는 스냅샷 하나와 초안·발행본 번호 */
export interface UumaiRaw {
  id: string
  snapshotId: string
  draftSnapshotId: string | null
  publishedSnapshotId: string | null
  work: Obj
}
export function uumaiRaw(raw: unknown): UumaiRaw {
  if (!isObj(raw) || !strOrNull(raw.id) || !strOrNull(raw.snapshotId) || !isObj(raw.work))
    throw new Error('WORK_SHAPE')
  return raw as unknown as UumaiRaw
}

/**
 * 편집기 불러오기와 같은 순서로 읽는다. 초안이 있으면 초안(편집기가 여는 것), 없으면 발행본.
 * 초안과 발행본이 다르면 편집기는 사람에게 묻는다 — 여기서는 초안을 읽고 상태에 "발행 안 된 초안"을 적는다.
 */
export async function uumaiReadRaw(
  read: (url: string) => Promise<Response>,
  id: string
): Promise<UumaiRaw> {
  const wid = uumaiWorkId(id)
  const index = await uumaiJson(await read(UUMAI_API + '/creator/work/' + wid + '/snapshot'))
  if (!isObj(index)) throw new Error('WORK_SHAPE')
  const draft = strOrNull(index.draftSnapshotId)
  const published = strOrNull(index.publishedSnapshotId)
  const sid = draft ?? published
  if (!sid) throw new Error('WORK_NOT_FOUND')
  if (!UUID_RE.test(sid)) throw new Error('WORK_SHAPE snapshot id')
  const work = await uumaiJson(await read(UUMAI_API + '/creator/work/' + wid + '/snapshot/' + sid))
  if (!isObj(work)) throw new Error('WORK_SHAPE')
  return {
    id: wid,
    snapshotId: sid,
    draftSnapshotId: draft,
    publishedSnapshotId: published,
    work
  }
}

const VISIBILITY: Record<number, string> = { 1: 'public', 2: 'private', 3: 'link' }
export const PUBLISH_STATUS: Record<string, number> = { public: 1, private: 2, link: 3 }
export function uumaiVisibility(w: Obj): string | null {
  return typeof w.publishStatus === 'number' ? (VISIBILITY[w.publishStatus] ?? null) : null
}
/** 한 번이라도 발행했는지 */
export const uumaiStatus = (r: UumaiRaw): string => (r.publishedSnapshotId ? 'published' : 'draft')
/** 발행본과 다른 초안이 있는지 (사이트에서 '작품 등록'을 눌러야 반영된다) */
export const uumaiPendingDraft = (r: UumaiRaw): boolean =>
  !!r.publishedSnapshotId && !!r.draftSnapshotId && r.draftSnapshotId !== r.publishedSnapshotId

/** 25529 H(): 폴더 없는 로어북 먼저, 그다음 폴더 순서대로. order는 1부터 다시 매긴다 */
export function arrangeLorebooks(lorebooks: Obj[], folders: Obj[]): Obj[] {
  const ids = new Set(folders.map((f) => text(f.id)))
  const loose: Obj[] = []
  const byFolder = new Map<string, Obj[]>(folders.map((f) => [text(f.id), []]))
  for (const lore of lorebooks) {
    const folder = lore.folderId
    if (typeof folder === 'string' && ids.has(folder)) byFolder.get(folder)!.push(lore)
    else loose.push(folder === null || folder === undefined ? lore : { ...lore, folderId: null })
  }
  return [...loose, ...folders.flatMap((f) => byFolder.get(text(f.id)) ?? [])].map((l, i) =>
    l.order === i + 1 ? l : { ...l, order: i + 1 }
  )
}

// 원본에 값이 있으면 그대로 보낸다. 칸이 없거나 null일 때만 예전에 보내던 기본값을 쓴다(flagOr·missing).
// 값을 모를 때 공개로 보내게 되는 칸(이미지 isPublic)은 기본값 없이 생략한다(flag).
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const flagOr = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const missing = (v: unknown): boolean => v === undefined || v === null
const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)

/**
 * 스냅샷(읽은 모양) → 저장 본문. 편집기의 Bx(스냅샷→폼)와 NG(폼→본문)를 이어 붙인 것과 같다.
 * 폼에서만 쓰는 값(임시 번호·미리보기 상태)은 본문에 나가지 않으므로 옮기지 않았다.
 * jsx는 편집기가 저장할 때마다 브라우저에서 다시 컴파일한다. 여기서는 스냅샷에 든 compiledCode를 그대로 보낸다
 * (스냅샷 규격 CreatorWorkDraftItem에 compiledCode·components가 있다). 그 값이 없으면 저장하지 않는다.
 * 원본에 없거나 null인 칸에는 기본값을 채우지 않는다(없으면 보내지 않는다). 글·목록 칸만 빈 글·빈 목록으로 맞춘다.
 */
export function uumaiSaveBody(w: Obj, opts: { isPublish: boolean; workId?: string }): Obj {
  // 인트로가 하나도 없는 원본에 내용을 지어 넣지 않는다. 성인 여부도 모르면 거짓으로 보내지 않는다
  const intros = list(w.intros)
  if (!intros.length) throw new Error('WORK_SHAPE intros')
  if (typeof w.isAdult !== 'boolean') throw new Error('WORK_SHAPE isAdult')
  const allIntros = intros.map((_, i) => i)
  const folders = list(w.lorebookFolders)
  const lores = arrangeLorebooks(list(w.lorebooks), folders)
  const loreIds = new Set(lores.map((l) => text(l.id)).filter(Boolean))
  const jsx = list(w.jsx)
  for (const j of jsx)
    if (typeof j.compiledCode !== 'string' || !Array.isArray(j.components))
      throw new Error('JSX_UNSUPPORTED')
  const achievements = Array.isArray(w.achievements)
    ? list(w.achievements).map((a) => ({
        achievementId: a.achievementId,
        name: a.name,
        description: a.description,
        imageId: a.imageId,
        isHidden: a.isHidden,
        // 힌트가 없는 업적만 예전처럼 숨김이 아니면 null (있는 값은 그대로)
        hint: a.hint === undefined && a.isHidden !== true ? null : a.hint,
        rewardAmount: a.rewardAmount,
        conditionType: a.conditionType,
        threshold: a.threshold
      }))
    : undefined
  const thumb = isObj(w.thumbnail) ? text(w.thumbnail.imageId) : ''
  const cover = isObj(w.bgmCover) ? text(w.bgmCover.imageId) : ''
  return {
    isPublish: opts.isPublish,
    title: text(w.title),
    description: text(w.description),
    detailDescription: text(w.detailDescription),
    prompt: text(w.prompt),
    intros: intros.map((e) => ({
      name: text(e.name),
      content: text(e.content),
      prompt: text(e.prompt),
      // 칸이 없는 인트로만 편집기 기본값(5턴·BGM 없음)을 쓴다. 있는 값(null 포함)은 그대로
      promptMaxTurn: e.promptMaxTurn === undefined ? 5 : e.promptMaxTurn,
      bgmAudioId: e.bgmAudioId === undefined ? null : e.bgmAudioId,
      recommends: strings(e.recommends).filter((r) => r.trim() !== '')
    })),
    isAdult: w.isAdult,
    publishStatus: opt(w.publishStatus as number | null | undefined),
    genderTendency: opt(w.genderTendency as number | null | undefined),
    allowComment: flagOr(w.allowComment, true),
    imagePromptEnabled: flagOr(w.imagePromptEnabled, true),
    creatorStyleEnabled: flagOr(w.creatorStyleEnabled, false),
    playGuide: text(w.playGuide),
    recommendedLlmModelId: opt(w.recommendedLlmModelId as number | null | undefined),
    isDerivativeWork: flagOr(w.isDerivativeWork, false),
    hashtags: strings(w.hashtags),
    thumbnail: thumb ? { imageId: thumb } : undefined,
    bgmCover: cover ? { imageId: cover } : undefined,
    images: list(w.images).map((e) => ({
      imageId: e.imageId,
      isPublic: flag(e.isPublic),
      keyword: text(e.keyword),
      slug: text(e.slug)
    })),
    audios: list(w.audios).map((e) => ({ audioId: e.audioId })),
    lorebooks: lores.map((l) => {
      // Bx: introSequences가 없으면 전체 인트로, 있으면 실제 있는 인트로 번호만. NG: 빈 목록이면 보내지 않는다
      const given = Array.isArray(l.introSequences)
        ? (l.introSequences as unknown[]).filter(
            (n): n is number => typeof n === 'number' && n >= 0 && n < intros.length
          )
        : []
      const seq = Array.isArray(l.introSequences) && given.length ? given : allIntros
      return {
        id: l.id,
        name: text(l.name),
        introSequences: seq.length ? seq : undefined,
        keywords: strings(l.keywords).filter((k) => k.trim() !== ''),
        content: text(l.content),
        activateOnIntro: flagOr(l.activateOnIntro, false),
        isConstant: flagOr(l.isConstant, false),
        andKeywords: strings(l.andKeywords).filter((k) => k.trim() !== ''),
        notKeywords: strings(l.notKeywords).filter((k) => k.trim() !== ''),
        scanTurns: opt(l.scanTurns as number | null | undefined),
        dependsOnIds: strings(l.dependsOnIds).filter((d) => loreIds.has(d)),
        group: str(l.group) ?? '',
        priority: finite(l.priority) ?? 0,
        effect: opt(l.effect as number | null | undefined),
        bgmAudioId: opt(l.bgmAudioId as string | null | undefined),
        bgmStop: flag(l.bgmStop),
        folderId: l.folderId ?? null
      }
    }),
    lorebookFolders: folders.map((f) => ({ id: f.id, name: f.name, color: f.color })),
    skills: list(w.skills).map((s) => ({
      name: text(s.name),
      description: text(s.description),
      prompt: text(s.prompt)
    })),
    achievements,
    dice: list(w.dice).map((d) => ({
      id: d.id,
      name: missing(d.name) ? '' : d.name,
      count: missing(d.count) ? 1 : d.count,
      sides: missing(d.sides) ? 20 : d.sides,
      bands: list(d.bands).map((b) => ({
        min: b.min,
        max: b.max,
        name: b.name,
        outcome: text(b.outcome)
      }))
    })),
    jsx: jsx.map((j) => ({
      fileName: j.fileName,
      sourceCode: j.sourceCode,
      compiledCode: j.compiledCode,
      components: j.components
    })),
    notepad: text(w.notepad),
    ...(opts.workId ? { workId: opts.workId } : {})
  }
}

/** 편집기 저장 실패 문구에 쓰는 서버 오류 이름 (66173 z): 짧게만 남긴다 */
async function failure(res: Response, what: string): Promise<Error> {
  const reply: unknown = await res.json().catch(() => null)
  const code = isObj(reply) ? text(reply.error) || text(reply.code) : ''
  return new Error(what + ' ' + res.status + (code ? ' ' + code.slice(0, 60) : ''))
}

/** POST /creator/work/save. {workId, snapshotId}를 돌려준다 */
export async function uumaiSave(write: WorkWrite, body: Obj): Promise<{ workId: string }> {
  const res = await write('POST', UUMAI_API + '/creator/work/save', body)
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (!res.ok) throw await failure(res, 'SAVE_FAILED')
  const reply: unknown = await res.json().catch(() => null)
  const workId = isObj(reply) ? text(reply.workId) : ''
  if (!UUID_RE.test(workId)) throw new Error('SAVE_FAILED response')
  return { workId }
}
