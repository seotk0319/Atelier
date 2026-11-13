// 알플레이(rplay.live) 스토리챗 작품 읽기·저장. 주소와 필드는 2026-11-10 공개 스크립트에서 읽었다 (실제 호출 전).
// 근거 파일: js/DNLa6r8FjI.js(API 묶음), js/C4epbjDN3r.js(StorySetup 편집 화면),
//            js/COSH41BuGI.js(스토리 노드), js/C1EJcA8qQF2.js(인물 노드), js/CqMity2peX.js(매크로 노드),
//            js/C7PX244bvv.js(스튜디오 목록·삭제), js/B06qUxsbQd.js(이미지 해시), js/DSxj4IL6NJ2.js(토큰 한도)
//   GET  api.rplay.live/account/getuser?userOid&filter[]=work_in_progress_storyChat&filter[]=publishedStoryChat  내 작품 번호
//   GET  /story-chat/chat-content?contentOid&options={withIsCompiling,preferMainCanvas}&omitComments=true      작품 정보
//   GET  /story-chat/localization/{id}                                    제목·간단 소개·상세 설명의 언어 상태
//   GET  /story-chat/chat-canvas?canvasOid&includeMetadata=true            노드·연결·노드 내용(metadataSet)
//   POST /story-chat/chat-canvas/metadata {oid, schemaType, update{…, version}, canvasOid, needsCompilation}  노드 내용 저장·새 노드
//   POST /story-chat/chat-canvas {requestType:"update", canvasOid, updateData{nodes, connections, …}}         노드·연결 구조
//   POST /story-chat/localization/{id}/edit {revision, patches[{language, field, value}]}                    제목·소개
//   POST /story-chat/chat-content {requestType:"save"|"create"|"delete", …}                                 공개 여부·새 작품·삭제
// 알플레이에는 작품 전체의 메인 프롬프트가 없고 스토리 노드마다 중요 정보(coreContext)가 있다.
// 공통 모양: main = 첫 스토리의 coreContext, 시작 상황 = 스토리 노드, 캐릭터 = 인물 노드, 로어북 = 매크로 노드의 항목.
// 저장해도 스토리 컴파일은 하지 않는다 (편집기도 저장과 컴파일이 따로다. 컴파일 전에는 대화에 반영되지 않을 수 있다).
import { randomInt, randomUUID } from 'node:crypto'
import {
  LIST_FILTER,
  READ_ROUTES,
  RPLAY_API,
  RPLAY_CHAT,
  RPLAY_CHAT_ORIGIN,
  WRITE_PATHS,
  accountBody,
  accountParams,
  at,
  contentUrl,
  infoOf,
  isObj,
  list,
  metaOf,
  needAccount,
  nodesOf,
  oidOf,
  routeAllowed,
  rplayJson,
  rplayRaw,
  rplayReadRaw,
  rplayWorkId,
  rplayWritten,
  shapeError,
  strOrNull,
  strings,
  text,
  withQuery,
  type Obj,
  type RplayAccount,
  type RplayRaw
} from './rplay-core'
import {
  rplayCheckCanvas,
  rplayCompareCanvas,
  rplayExportCanvas,
  rplayImportCanvas,
  rplaySendRule
} from './rplay-canvas'
import { matchOld } from './match-old'
import type {
  ImageGroup,
  LoreEntry,
  StartScenarioDraft,
  WorkAdapter,
  WorkBody,
  WorkChanges,
  WorkDraft,
  WorkFetch,
  WorkIo,
  WorkListItem,
  WorkWrite
} from './types'
import { EXTRA_LIST_MAX, EXTRA_TEXT_MAX } from './shared'

const VISIBILITIES = ['public', 'private']
// 간단 소개 글자 한도 (편집 화면 Js 표, 언어별)
const SIMPLE_INTRO_MAX: Record<string, number> = {
  ko: 40,
  jp: 40,
  en: 100,
  zh: 80,
  'zh-Hant': 80,
  es: 80
}
const CREATOR_NOTICE_MAX = 500
// 토큰 블록을 쓰지 않는 스토리의 시작 메시지 글자 한도 (토큰 블록이면 1,000토큰, 서버가 센다)
const PROLOGUE_CHAR_MAX = 1000
const MACRO_PATTERNS_MAX = 5
const DURATION_MIN = 1
const DURATION_MAX = 5

// 노드 종류마다 편집기가 metadata로 저장하는 글 칸
const EDITABLE: Record<string, string[]> = {
  story: ['title', 'coreContext', 'text', 'prologue', 'prologueGuide', 'creatorNotice'],
  character: ['name', 'coreContext', 'text'],
  lorebook: ['title', 'entries']
}
// 새 노드 이름과 놓는 자리 (편집기 cu·du)
const NODE_NAME: Record<string, string> = {
  story: 'story-node',
  character: 'character-node',
  lorebook: 'macro-prompts-node'
}
const NODE_X: Record<string, number> = { story: 100, character: 700, lorebook: 1300 }
const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** 노드 해시 5자 (편집기 Fm) */
const nodeHash = (): string => Array.from({ length: 5 }, () => ALNUM[randomInt(62)]).join('')
const NEW = 'new:'
const isNew = (oid: string): boolean => oid.startsWith(NEW)

// ───────────── 원본 → 공통 모양 ─────────────

const ofType = (r: RplayRaw, type: string): Obj[] => nodesOf(r).filter((n) => n.type === type)
/** 스토리 노드: 표기 순서(sort) 오름차순, 같으면 캔버스 순서 (편집기 Ua) */
function storyNodes(r: RplayRaw): Obj[] {
  const sortOf = (n: Obj): number => {
    const s = metaOf(r, n).sort
    return typeof s === 'number' && Number.isFinite(s) ? s : 0
  }
  return ofType(r, 'story')
    .map((n, i) => ({ n, i }))
    .sort((a, b) => sortOf(a.n) - sortOf(b.n) || a.i - b.i)
    .map((x) => x.n)
}
/** 공개 여부: 업로드된(published) 작품이고 비공개가 아니어야 public */
function visibilityOf(content: Obj): string {
  return content.status === 'published' && content.isPrivate !== true ? 'public' : 'private'
}
function patternsOf(e: Obj): string[] {
  const p = strings(e.patterns)
  if (p.length) return p
  return text(e.key)
    .split('|')
    .map((k) => k.trim())
    .filter(Boolean)
}
/** 발동 단어 글("a, b") → 쪼갠 목록 */
const patternsFrom = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
/** 항목의 유지 턴을 읽을 때 쓰는 값 (없거나 0 이하면 1) */
const turnsOf = (e: Obj): number =>
  typeof e.durationTurns === 'number' && e.durationTurns > 0 ? e.durationTurns : 1
function loreOf(r: RplayRaw): LoreEntry[] {
  return ofType(r, 'lorebook').flatMap((n) => {
    const m = metaOf(r, n)
    return list(m.entries).map((e) => ({
      title: text(m.title),
      keys: patternsOf(e).join(', '),
      content: text(e.text),
      mode: e.activationMode === 'always' ? 'always' : 'keyword',
      offKeys: [],
      turnRange: turnsOf(e),
      offTurnRange: null
    }))
  })
}

// ───────────── 공통 칸에 안 드는 설정 (읽기 전용) ─────────────

/** 사이트에는 있는데 이 연결부가 읽지 못하는 것 (extras로 읽는 것은 넣지 않는다) */
const UNSUPPORTED = [
  '댓글',
  '통계(좋아요·대화 수)',
  '수정 시각',
  '컴파일 상태·시각',
  '사이트가 만든 해시태그 수',
  '언어별 제목·소개·설명 내용',
  '스토리별 고급 설정',
  '노드 연결(스토리별 인물·매크로)',
  '매크로 항목 우선순위',
  '유저 노드 본문',
  '인물 호버 설명·간단 소개·시작 대사 본문',
  '스토리 줄거리·업적·상태창·프리셋 노트 내용'
]

const sumLengths = (nodes: Obj[], key: string): number | undefined => {
  const found = nodes.filter((m) => Array.isArray(m[key]))
  return found.length ? found.reduce((n, m) => n + (m[key] as unknown[]).length, 0) : undefined
}

/**
 * 원본에 실제 있는 칸만 싣는다. 짧은 값은 그대로, 긴 글은 글자 수, 목록은 개수.
 * 조회 수·대화 수 같은 통계는 읽을 때마다 달라져 계획이 낡은 것으로 판정되므로 싣지 않는다.
 */
function extrasOf(r: RplayRaw, stories: Obj[]): Record<string, unknown> {
  const c = r.content
  const out: Record<string, unknown> = {}
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value
  }
  const flag = (key: string, v: unknown): void => set(key, typeof v === 'boolean' ? v : undefined)
  const num = (key: string, v: unknown): void =>
    set(key, typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const str = (key: string, v: unknown): void =>
    set(key, typeof v === 'string' && v && v.length <= EXTRA_TEXT_MAX ? v : undefined)
  const count = (key: string, v: unknown): void => set(key, Array.isArray(v) ? v.length : undefined)
  const names = (key: string, v: unknown): void =>
    set(key, isObj(v) && Object.keys(v).length <= EXTRA_LIST_MAX ? Object.keys(v) : undefined)

  // 태그·성인 표시
  if (Array.isArray(c.hashtags)) {
    const tags = strings(c.hashtags)
    set('hashtag_count', tags.length)
    if (tags.length <= EXTRA_LIST_MAX && tags.every((t) => t.length <= EXTRA_TEXT_MAX))
      set('hashtags', tags)
  }
  flag('is_adult_content', c.isAdultContent)
  // 모델·프롬프트 설정 (작품 전체. 스토리마다 따로 둔 값은 못 읽는다)
  if (isObj(c.advancedSettings))
    set(
      'advanced_settings',
      Object.fromEntries(
        Object.entries(c.advancedSettings).filter(
          ([, v]) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
        )
      )
    )
  num('prompt_input_expansion_steps', c.promptInputExpansionSteps)
  num('canvas_compiler_version', r.canvas.compilerVersion)
  num('image_tagging_method', r.canvas.imageTaggingMethod)
  flag('use_kr_jp_guidelines', r.canvas.useKRJPGuidelines)
  str('embedding_model', r.canvas.embeddingModel)
  // 표지·소개 영상 (있는지만)
  if ('thumbnailAsset' in c)
    set('has_thumbnail', isObj(c.thumbnailAsset) && text(c.thumbnailAsset.s3Key) !== '')
  if ('introVideo' in c) set('has_intro_video', c.introVideo !== null && c.introVideo !== undefined)
  // 공개·열람 설정, 수익·독점
  flag('is_canvas_public', c.isCanvasPublic)
  flag('display_image_descriptions', c.displayImageDescriptions)
  flag('view_without_sub', c.viewableWithoutSub)
  flag('only_for_subscribers', c.onlyForSubscribers)
  flag('only_purchasable_with_coins', c.onlyPurchasableWithCoins)
  flag('is_paid_content', c.isPaidContent)
  flag('allow_bonus', c.allowBonus)
  flag('reward_enabled', c.rewardEnabled)
  num('price', c.price)
  num('credit', c.credit)
  flag('is_original_story', c.isOriginalStory)
  flag('is_original_story_locked', c.isOriginalStoryLocked)
  str('original_story_locked_until', c.originalStoryLockedUntil)
  if (isObj(c.collaborators)) set('collaborator_count', Object.keys(c.collaborators).length)
  flag('restrict_collaborator_editing', c.restrictCollaboratorEditing)
  if (isObj(c.blocked)) flag('is_blocked', c.blocked.isBlocked)
  count('achievement_count', c.achievements)
  // 컴파일 상태(needsCompilation·compiled·compiledDate)는 싣지 않는다: 사이트가 계획과 저장 사이에도 바꾸므로 PLAN_STALE이 된다
  str('published_at', c.publishedAt)
  // 언어별 설정 (언어 목록만)
  const loc = r.localization && isObj(r.localization.localization) ? r.localization.localization : null
  flag('localization_enabled', loc?.enabled ?? c.localizationEnabled)
  str('source_language', loc?.sourceLanguage)
  names('localization_languages', loc?.entries)
  names('canvas_languages', c.multiLangCanvases)
  str('main_canvas_language', c.mainCanvasLanguage)
  // 노드 안의 칸: 개수·글자 수만
  const storyMeta = stories.map((n) => metaOf(r, n))
  set('story_preset_note_count', sumLengths(storyMeta, 'presetNoteNodes'))
  set('story_status_view_count', sumLengths(storyMeta, 'statusViewNodes'))
  set('story_achievement_node_count', sumLengths(storyMeta, 'achievementNodes'))
  const plot = storyMeta.filter((m) => text(m.plotSummary) !== '').length
  if (storyMeta.some((m) => 'plotSummary' in m)) set('story_plot_summary_count', plot)
  if (storyMeta.some((m) => 'creatorNotice' in m))
    set(
      'later_story_creator_notice_count',
      storyMeta.slice(1).filter((m) => text(m.creatorNotice) !== '').length
    )
  const people = ofType(r, 'character').map((n) => metaOf(r, n))
  const filled = (key: string): number | undefined =>
    people.some((m) => key in m) ? people.filter((m) => text(m[key]) !== '').length : undefined
  set('character_simplified_intro_count', filled('simplifiedIntro'))
  set('character_hover_description_count', filled('hoverDescription'))
  set('character_starting_dialogue_count', filled('startingDialogue'))
  if (people.some((m) => 'hiddenInPreview' in m))
    set('character_hidden_in_preview_count', people.filter((m) => m.hiddenInPreview === true).length)
  const users = ofType(r, 'user').map((n) => metaOf(r, n))
  set('user_node_count', users.length)
  set('user_text_length', users.reduce((n, m) => n + text(m.text).length, 0))
  set('image_node_count', ofType(r, 'image').length)
  if (isObj(r.canvas.characterSpeechStyles))
    set('character_speech_style_count', Object.keys(r.canvas.characterSpeechStyles).length)
  return out
}

export function rplayNormalize(raw: unknown): WorkBody {
  const r = rplayRaw(raw)
  const info = infoOf(r)
  const stories = storyNodes(r)
  const main = stories[0] ? metaOf(r, stories[0]) : {}
  return {
    id: r.id,
    title: text(info.title),
    visibility: visibilityOf(r.content),
    status: strOrNull(r.content.status),
    updatedAt: strOrNull(r.content.modified) ?? strOrNull(r.content.updatedAt),
    fields: {
      title: text(info.title),
      subtitle: text(info.simpleIntro),
      description: text(info.description),
      main: text(main.coreContext),
      creator_comment: text(main.creatorNotice)
    },
    lorebook: loreOf(r),
    startScenarios: stories.map((n, i) => {
      const m = metaOf(r, n)
      return {
        id: strOrNull(n.uid),
        title: text(m.title),
        isDefault: i === 0,
        content: text(m.prologue),
        // 첫 스토리의 중요 정보는 fields.main으로 보인다
        subPrompt: i === 0 ? '' : text(m.coreContext),
        dialogue: '',
        situation: text(m.prologueGuide),
        description: text(m.text)
      }
    }),
    extras: extrasOf(r, stories),
    unsupported: [...UNSUPPORTED],
    characters: ofType(r, 'character').map((n) => {
      const m = metaOf(r, n)
      return {
        id: strOrNull(n.uid),
        name: text(m.name),
        isMain: false,
        order: null,
        details: text(m.text),
        info: text(m.coreContext),
        imageCount: text(m.imageUrl) ? 1 : 0
      }
    })
  }
}

// ───────────── 바꾸기 ─────────────

/** 원본 언어 (편집 화면 Se 코드로) */
function sourceLanguage(r: RplayRaw): string | null {
  const loc =
    r.localization && isObj(r.localization.localization) ? r.localization.localization : {}
  const raw = text(loc.sourceLanguage).trim()
  if (!raw) return null
  const low = raw.toLowerCase()
  if (low === 'ja') return 'jp'
  if (low === 'zh-hant' || low === 'zh-tw') return 'zh-Hant'
  return Object.keys(SIMPLE_INTRO_MAX).find((k) => k.toLowerCase() === low) ?? null
}

type Entry = { owner: string; entry: Obj }

/**
 * 공통 로어북 항목 → 매크로 항목. 옛 항목(base)이 있으면 바뀐 칸만 덮는다:
 * 읽을 때 만든 값 그대로(또는 null=안 줌)면 옛 값을 건드리지 않고 검사도 하지 않는다.
 * 옛 항목이 없는 새 항목에서만 null이 알플레이 기본값(keyword, 1턴)이 된다.
 * whole: 전체 교체. given이 없으면 빈 발동 단어는 "안 줌"으로 보고 옛 발동 단어를 둔다. given에 keys가 있으면 빈 값은 "비움"이다.
 * 발동 단어는 쪼갠 목록으로 견주고, 바뀔 때도 항목 이름(key)은 파생값일 때만 따라 바꾼다.
 */
function entryFrom(
  e: Partial<LoreEntry>,
  base: Obj | undefined,
  where: string,
  whole = false
): Obj {
  if ((e.offKeys !== undefined && e.offKeys.length) || (e.offTurnRange ?? null) !== null)
    throw new Error('BAD_LOREBOOK ' + where + ' off_keys·off_turn_range 없음')
  // 전체 교체로 들어온 항목(given 있음)은 호출한 쪽이 적은 칸만 옛 항목을 덮는다. 적지 않은 칸은 옛 값 그대로.
  // given이 없는 옛 호출은 null을 "안 줌"으로 본다. 옛 항목이 없으면 null이 알플레이 기본값이 된다.
  const takes = (field: string, value: unknown): boolean =>
    e.given && base ? e.given.includes(field) : value !== null || !base
  const out: Obj = base
    ? { ...base }
    : {
        key: '',
        patterns: [],
        text: '',
        tokenCount: 0,
        priority: 1,
        durationTurns: 1,
        activationMode: 'keyword'
      }
  // 전체 교체에서 given이 없으면 빈 발동 단어는 "안 줌"이다. given에 keys가 있으면 빈 값도 "비움"이다
  const keysGiven = e.given ? e.given.includes('keys') : !(whole && e.keys === '')
  if (e.keys !== undefined && keysGiven) {
    const patterns = patternsFrom(e.keys)
    const was = base ? patternsOf(base) : []
    // 쪼갠 발동 단어가 옛 것과 같으면(쉼표 뒤 공백만 달라도) 옛 항목을 건드리지 않고 검사도 하지 않는다
    if (!base || patterns.length !== was.length || patterns.some((p, i) => p !== was[i])) {
      if (patterns.length > MACRO_PATTERNS_MAX || patterns.some((p) => p.includes('|')))
        throw new Error('BAD_LOREBOOK ' + where + '.keys 5개 이하, | 없이')
      // key는 사이트가 붙인 항목 이름일 수 있다. 옛 발동 단어를 이은 값(=파생값)일 때만 따라 바꾼다
      if (!base || text(base.key) === was.join('|')) out.key = patterns.join('|')
      out.patterns = patterns
    }
  }
  if (e.content !== undefined && !(base && e.content === text(base.text))) out.text = e.content
  if (e.mode !== undefined && takes('mode', e.mode)) {
    const mode = e.mode ?? 'keyword'
    if (mode !== 'keyword' && mode !== 'always')
      throw new Error('BAD_LOREBOOK ' + where + '.mode keyword/always')
    // 옛 항목의 발동 방식을 읽을 때와 같게 본 값(loreOf)과 같으면 옛 값을 그대로 둔다
    if (!base || mode !== (base.activationMode === 'always' ? 'always' : 'keyword'))
      out.activationMode = mode
  }
  if (e.turnRange !== undefined && takes('turnRange', e.turnRange)) {
    const turns = e.turnRange ?? 1
    if (!base || turns !== turnsOf(base)) {
      if (!Number.isInteger(turns) || turns < DURATION_MIN || turns > DURATION_MAX)
        throw new Error('BAD_LOREBOOK ' + where + '.turn_range 1~5')
      out.durationTurns = turns
    }
  }
  return out
}

/**
 * 시작 상황 칸 → 스토리 노드 칸. cur(고칠 노드의 지금 내용)를 주면 지금 값과 같은 칸은 뺀다
 * (읽은 값을 그대로 돌려줘도 없던 칸에 빈 글이 채워지거나 앞뒤 공백이 깎이지 않게).
 * 첫 스토리의 sub_prompt는 읽을 때 늘 ''이라 ''이면 "그대로"로 보고 넘긴다.
 */
function storyFields(s: StartScenarioDraft, allowSubPrompt: boolean, cur?: Obj): Obj {
  if (s.dialogue !== undefined && s.dialogue !== '') throw new Error('BAD_CHANGES dialogue 없음')
  if (s.subPrompt !== undefined && s.subPrompt !== '' && !allowSubPrompt)
    throw new Error('BAD_CHANGES 첫 스토리의 중요 정보는 fields.main')
  const out: Obj = {}
  const put = (key: string, given: string | undefined, value = given): void => {
    if (given !== undefined && !(cur && text(cur[key]) === given)) out[key] = value
  }
  put('title', s.title, s.title?.trim())
  put('prologue', s.content)
  put('coreContext', allowSubPrompt ? s.subPrompt : undefined)
  put('prologueGuide', s.situation)
  put('text', s.description)
  return out
}
/** 바뀐 칸만 편집기 규칙으로 본다 (old = 처음 읽은 노드 내용, 새 노드는 없음) */
function checkStory(m: Obj, old: Obj | undefined, where: string): void {
  const changed = (k: string): boolean => !old || JSON.stringify(m[k]) !== JSON.stringify(old[k])
  if (changed('title') && !text(m.title).trim())
    throw new Error('BAD_START ' + where + '.title 비어 있음')
  if (changed('prologue') && m.useTokenBlock !== true && text(m.prologue).length > PROLOGUE_CHAR_MAX)
    throw new Error('BAD_START ' + where + '.content 1000자')
  if (changed('creatorNotice') && text(m.creatorNotice).length > CREATOR_NOTICE_MAX)
    throw new Error('BAD_FIELD creator_comment 500자')
}
/** 지금 값과 같으면 쓰지 않는다 (없던 칸에 빈 글을 채우지 않는다) */
function putText(m: Obj, key: string, value: string): void {
  if (text(m[key]) !== value) m[key] = value
}

/** 다음 원본을 고치는 도구 묶음 */
class Draft {
  readonly next: RplayRaw
  private n = 0
  constructor(raw: RplayRaw) {
    this.next = structuredClone(raw)
    // 처음 읽은 모습만 남긴다 (여러 번 바꿔도 저장은 처음 모습과 견준다)
    this.next.base = raw.base
      ? structuredClone(raw.base)
      : {
          info: structuredClone(infoOf(raw)),
          content: structuredClone(raw.content),
          nodes: structuredClone(list(raw.canvas.nodes)),
          connections: structuredClone(list(raw.canvas.connections)),
          metadataSet: structuredClone(raw.metadataSet)
        }
    for (const k of Object.keys(this.next.metadataSet))
      if (isNew(k)) this.n = Math.max(this.n, Number(k.slice(NEW.length)) || 0)
  }
  get nodes(): Obj[] {
    return list(this.next.canvas.nodes)
  }
  get connections(): Obj[] {
    return list(this.next.canvas.connections)
  }
  meta(node: Obj): Obj {
    const key = text(node.metadataOid)
    const m = this.next.metadataSet[key] ?? {}
    this.next.metadataSet[key] = m
    return m
  }
  /** 새 노드 (metadataOid는 저장할 때 서버 번호로 바뀐다) */
  add(type: string, fields: Obj): Obj {
    const temp = NEW + ++this.n
    this.next.metadataSet[temp] = {
      _id: temp,
      type,
      useTokenBlock: true,
      ...(type === 'story' ? { isStart: true } : {}),
      ...fields
    }
    const same = this.nodes.filter((n) => n.type === type && n.deleted !== true)
    const ys = same.map((n) => (isObj(n.coordinates) ? Number(n.coordinates.y) || 0 : 0))
    const taken = new Set(this.nodes.map((n) => text(n.hash)))
    let hash = nodeHash()
    while (taken.has(hash)) hash = nodeHash()
    const node: Obj = {
      uid: randomUUID(),
      coordinates: { x: NODE_X[type] ?? 100, y: same.length ? Math.max(...ys) + 200 : 100 },
      hash,
      name: NODE_NAME[type] ?? type + '-node',
      type,
      metadataOid: temp,
      incoming: [],
      outgoing: []
    }
    this.next.canvas.nodes = [...this.nodes, node]
    return node
  }
  remove(node: Obj): void {
    const uid = text(node.uid)
    this.next.canvas.nodes = this.nodes.filter((n) => n.uid !== uid)
    this.next.canvas.connections = this.connections.filter(
      (c) => c.sourceNodeId !== uid && c.targetNodeId !== uid
    )
  }
  /** 인물·매크로 노드 → 스토리 노드 연결 (편집기 mu의 연결 모양) */
  connect(source: Obj, target: Obj): void {
    const s = text(source.uid)
    const t = text(target.uid)
    if (this.connections.some((c) => c.sourceNodeId === s && c.targetNodeId === t)) return
    const lore = source.type === 'lorebook'
    this.next.canvas.connections = [
      ...this.connections,
      {
        uid: randomUUID(),
        sourceNodeId: s,
        sourceOutputPortName: lore ? 'lorebook' : 'character',
        sourceOutputIndex: 0,
        sourceOutputLabel: lore ? 'macro-prompts-data' : 'character-port',
        sourceOutputRelation: lore ? '매크로 프롬프트 항목.' : '캐릭터의 정보.',
        targetNodeId: t,
        targetInputPortName: lore ? 'lorebook' : 'characters',
        targetInputIndex: lore ? 3 : 1,
        targetInputLabel: lore ? 'macro-prompts' : 'characters',
        targetInputRelation: lore ? '매크로 프롬프트 항목.' : '이야기의 등장 인물.',
        connectionType: lore ? 'lorebook' : 'character'
      }
    ]
  }
  /** 새 스토리는 기본 스토리에 들어오던 연결을 그대로 받는다 (편집기에서 하나씩 잇는 것과 같은 결과) */
  copyIncoming(from: Obj | undefined, to: Obj): void {
    if (!from) {
      for (const n of this.nodes)
        if (n.deleted !== true && (n.type === 'character' || n.type === 'lorebook'))
          this.connect(n, to)
      return
    }
    const added = this.connections
      .filter((c) => c.targetNodeId === from.uid)
      .map((c) => ({ ...c, uid: randomUUID(), targetNodeId: to.uid }))
    this.next.canvas.connections = [...this.connections, ...added]
  }
  /** 제목만 고친 항목이 옮겨 간 새 매크로 노드는 옛 매크로 노드가 이어져 있던 스토리에만 잇는다 */
  copyOutgoing(from: Obj, to: Obj): void {
    const added = this.connections
      .filter((c) => c.sourceNodeId === from.uid)
      .map((c) => ({ ...c, uid: randomUUID(), sourceNodeId: to.uid }))
    this.next.canvas.connections = [...this.connections, ...added]
  }
}

export function rplayApplyChanges(raw: unknown, changes: WorkChanges): RplayRaw {
  const d = new Draft(rplayRaw(raw))
  const next = d.next

  // 읽을 때 보인 공개 여부를 그대로 돌려주면 바꾸지 않는다 (작업 중 작품은 isPrivate와 상관없이 private으로 보인다)
  if (changes.visibility !== undefined && !VISIBILITIES.includes(changes.visibility))
    throw new Error('BAD_VISIBILITY')
  if (changes.visibility !== undefined && changes.visibility !== visibilityOf(next.content)) {
    const c = next.content
    if (changes.visibility === 'public' && c.status !== 'published')
      // 처음 공개는 업로드(스토리 컴파일·썸네일 필요)라 여기서 하지 않는다
      throw new Error('NOT_PUBLISHED')
    if (changes.visibility === 'private' && c.isOriginalStory === true && c.isPrivate !== true)
      throw new Error('ORIGINAL_STORY_LOCK')
    c.isPrivate = changes.visibility === 'private'
  }

  // 시작 상황 (스토리 노드)
  const before = storyNodes(next)
  // 바꾼 스토리만 편집기 규칙으로 다시 본다 (있던 값이 규칙 밖이어도 손대지 않은 노드는 막지 않는다)
  const touched = new Set<Obj>()
  for (const patch of changes.startScenarios ?? []) {
    const i = at(patch.index, before.length)
    const m = d.meta(before[i])
    Object.assign(m, storyFields(patch, i !== 0, m))
    touched.add(before[i])
  }
  let storiesChanged = false
  if (changes.startScenariosRemove?.length) {
    const gone = new Set(changes.startScenariosRemove.map((i) => at(i, before.length)))
    if (gone.has(0)) throw new Error('KEEP_DEFAULT')
    for (const i of gone) d.remove(before[i])
    storiesChanged = true
  }
  for (const add of changes.startScenariosAdd ?? []) {
    const count = storyNodes(next).length
    const fields = storyFields(add, true)
    if (!text(fields.title)) fields.title = '스토리 ' + (count + 1)
    const node = d.add('story', fields)
    touched.add(node)
    d.copyIncoming(
      before.find((n) => nodesOf(next).includes(n)),
      node
    )
    storiesChanged = true
  }
  if (storiesChanged) {
    // 표기 순서를 지금 순서대로 다시 매긴다 (새 스토리는 끝)
    const order = [
      ...before.filter((n) => nodesOf(next).includes(n)),
      ...storyNodes(next).filter((n) => !before.includes(n))
    ]
    order.forEach((n, i) => (d.meta(n).sort = i))
  }

  // 글 칸
  const stories = storyNodes(next)
  for (const [name, value] of Object.entries(changes.fields ?? {})) {
    if (typeof value !== 'string') throw new Error('BAD_FIELD')
    if (name === 'title' || name === 'subtitle' || name === 'description') {
      const key = name === 'subtitle' ? 'simpleIntro' : name
      const was = text(infoOf(next)[key])
      infoOf(next)[key] = value
      // 지금 값 그대로면 검사하지 않는다 (사이트가 받아 주던 옛 값)
      if (value !== was) {
        if (name === 'title' && !value.trim()) throw new Error('BAD_FIELD title 비어 있음')
        if (name === 'subtitle') {
          const max = SIMPLE_INTRO_MAX[sourceLanguage(next) ?? 'ko'] ?? 40
          if (value.length > max) throw new Error('BAD_FIELD subtitle ~' + max + '자')
        }
      }
    } else if (name === 'main' || name === 'creator_comment') {
      if (!stories[0]) throw new Error('NO_STORY')
      putText(d.meta(stories[0]), name === 'main' ? 'coreContext' : 'creatorNotice', value)
      touched.add(stories[0])
    } else throw new Error('BAD_FIELD')
  }
  const old = next.base?.metadataSet ?? {}
  stories.forEach((n, i) => {
    if (touched.has(n))
      checkStory(metaOf(next, n), old[text(n.metadataOid)], 'start_scenarios[' + i + ']')
  })

  // 캐릭터 (인물 노드)
  const chars = ofType(next, 'character')
  for (const patch of changes.characters ?? []) {
    const m = d.meta(chars[at(patch.index, chars.length)])
    if (patch.name !== undefined && patch.name !== text(m.name)) {
      if (!patch.name.trim()) throw new Error('EMPTY_FIELD')
      putText(m, 'name', patch.name.trim())
    }
    if (patch.details !== undefined) putText(m, 'text', patch.details)
    if (patch.info !== undefined) putText(m, 'coreContext', patch.info)
  }
  if (changes.charactersRemove?.length) {
    const gone = new Set(changes.charactersRemove.map((i) => at(i, chars.length)))
    for (const i of gone) d.remove(chars[i])
  }
  for (const add of changes.charactersAdd ?? []) {
    if (!add.name.trim()) throw new Error('EMPTY_FIELD')
    const node = d.add('character', {
      name: add.name.trim(),
      text: add.details ?? '',
      coreContext: add.info ?? ''
    })
    for (const s of storyNodes(next)) d.connect(node, s)
  }

  // 로어북 (매크로 노드 항목을 한 줄로 펼친 번호)
  applyLore(d, changes)
  return next
}

/**
 * 전체 교체의 새 항목마다 물려받을 옛 항목. matchOld(제목·내용·자리)의 짝 가운데
 *  - 제목과 내용이 모두 같은 짝은 그대로 쓰고,
 *  - 나머지는 같은 노드 안에서 발동 단어가 같은 옛 항목을 먼저 짝지은 뒤(내용을 고치면서 항목을 끼워도 숨은 값이 밀리지 않게),
 *  - 그래도 짝이 없으면 matchOld의 자리 짝을 쓴다. 단 제목이 다른 자리 짝은 발동 단어나 내용이 겹칠 때만 인정한다
 *    (지우고 새로 넣은 항목이 옛 항목의 발동 방식·턴·우선순위를 물려받지 않게).
 */
function pairOld(
  whole: LoreEntry[],
  items: Entry[],
  titleOf: (owner: string) => string
): (Entry | undefined)[] {
  const guess = matchOld(
    whole.map((e) => e.title),
    items,
    (x) => titleOf(x.owner),
    // 알플레이는 매크로 노드 하나에 항목이 여럿이라 제목(노드 이름)이 대부분 겹친다. 내용까지 견줘 짝짓는다
    { contents: whole.map((e) => e.content), contentOf: (x) => text(x.entry.text) }
  )
  const sameList = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i])
  // 발동 단어를 안 준 항목(빈 글)은 발동 단어로 견주지 않는다
  const wanted = whole.map((e) => patternsFrom(e.keys))
  const out: (Entry | undefined)[] = guess.map((x, k) =>
    x && titleOf(x.owner) === whole[k].title && text(x.entry.text) === whole[k].content
      ? x
      : undefined
  )
  const claimed = new Set<Entry>(out.filter((x): x is Entry => !!x))
  whole.forEach((e, k) => {
    if (out[k] || !wanted[k].length) return
    const x = items.find(
      (it) =>
        !claimed.has(it) &&
        titleOf(it.owner) === e.title &&
        sameList(patternsOf(it.entry), wanted[k])
    )
    if (x) {
      out[k] = x
      claimed.add(x)
    }
  })
  whole.forEach((e, k) => {
    const x = guess[k]
    if (out[k] || !x || claimed.has(x)) return
    if (titleOf(x.owner) !== e.title) {
      const sharesContent = e.content !== '' && text(x.entry.text) === e.content
      const sharesKeys = wanted[k].length > 0 && sameList(patternsOf(x.entry), wanted[k])
      if (!sharesContent && !sharesKeys) return
    }
    out[k] = x
    claimed.add(x)
  })
  return out
}

function applyLore(d: Draft, changes: WorkChanges): void {
  const next = d.next
  const owners = ofType(next, 'lorebook')
  let items: Entry[] = owners.flatMap((n) =>
    list(metaOf(next, n).entries).map((entry) => ({ owner: text(n.metadataOid), entry }))
  )
  const titleOf = (owner: string): string => text(next.metadataSet[owner]?.title)
  const before = JSON.stringify(items)

  /**
   * 제목이 같은 매크로 노드. 없으면 새 노드를 만든다. 새 항목이면(from 없음) 모든 스토리에 잇고,
   * 제목만 고친 항목이면(from = 옛 노드 번호) 옛 노드가 이어져 있던 곳에만 잇는다
   */
  const ownerOf = (title: string, from?: string): string => {
    let owner = ofType(next, 'lorebook').find((n) => text(metaOf(next, n).title) === title)
    if (!owner) {
      owner = d.add('lorebook', { title, entries: [] })
      const old = from ? ofType(next, 'lorebook').find((n) => text(n.metadataOid) === from) : undefined
      if (old) d.copyOutgoing(old, owner)
      else for (const s of storyNodes(next)) d.connect(owner, s)
    }
    return text(owner.metadataOid)
  }

  let patches = changes.lorebookPatch ?? []
  let removes = changes.lorebookRemove ?? []
  let adds = changes.lorebookAdd ?? []
  if (changes.lorebook) {
    // 전체 교체: 제목으로 옛 항목과 짝지어(match-old) 짝 있는 항목만 옛 항목의 숨은 값을 물려받고,
    // 짝 없는 새 항목은 새 항목이다. 짝 없는 옛 항목은 지워진다.
    const whole = changes.lorebook
    const pairs = pairOld(whole, items, titleOf)
    items = whole.map((e, k) => {
      const old = pairs[k]
      const where = 'lorebook[' + k + ']'
      // 제목은 매크로 노드 이름이다. 제목만 고친 짝은 그 이름의 노드로 옮기되, 옛 노드의 연결을 이어받는다
      const owner = old && titleOf(old.owner) === e.title ? old.owner : ownerOf(e.title, old?.owner)
      return { owner, entry: entryFrom(e, old?.entry, where, true) }
    })
    patches = []
    removes = []
    adds = []
  }
  for (const patch of patches) {
    const i = at(patch.index, items.length)
    const where = 'lorebook[' + i + ']'
    // 제목은 매크로 노드 이름이다. 다른 노드로 옮기려면 지우고 더한다
    if (patch.title !== undefined && patch.title !== titleOf(items[i].owner))
      throw new Error(
        'BAD_LOREBOOK ' + where + '.title 은 매크로 노드 이름 (옮기려면 지우고 더하기)'
      )
    items[i] = { ...items[i], entry: entryFrom(patch, items[i].entry, where) }
  }
  if (removes.length) {
    const gone = new Set(removes.map((i) => at(i, items.length)))
    items = items.filter((_, i) => !gone.has(i))
  }
  for (const [k, e] of adds.entries()) {
    const where = 'lorebook_add[' + k + ']'
    items.push({ owner: ownerOf(e.title), entry: entryFrom(e, undefined, where) })
  }
  if (JSON.stringify(items) === before) return
  for (const n of ofType(next, 'lorebook')) {
    const key = text(n.metadataOid)
    const mine = items.filter((x) => x.owner === key).map((x) => x.entry)
    const m = d.meta(n)
    if (JSON.stringify(list(m.entries)) !== JSON.stringify(mine)) m.entries = mine
  }
}

// ───────────── 저장 ─────────────

const changedKeys = (type: string, a: Obj, b: Obj): string[] =>
  (EDITABLE[type] ?? []).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
/** 서버에 보내는 노드 모양 비교용 (새 노드에 붙인 metadata는 빼고 본다) */
const shape = (nodes: Obj[]): string =>
  JSON.stringify(
    nodes.map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'metadata')))
  )

async function postMeta(
  write: WorkWrite,
  a: RplayAccount,
  canvasOid: string,
  oid: string | null,
  schemaType: string | null,
  update: Obj,
  extra: Obj = {}
): Promise<Obj> {
  const res = await write('POST', RPLAY_CHAT + '/chat-canvas/metadata', {
    oid,
    schemaType,
    update,
    canvasOid,
    needsCompilation: true,
    ...extra,
    ...accountBody(a)
  })
  return rplayWritten(res, 'SAVE')
}
async function saveStoryChat(write: WorkWrite, a: RplayAccount, data: Obj): Promise<Obj> {
  const res = await write('POST', RPLAY_CHAT + '/chat-content', {
    requestType: 'save',
    data,
    ...accountBody(a)
  })
  return rplayWritten(res, 'SAVE')
}

/**
 * 바뀐 것만 편집기 순서대로 보낸다:
 *   노드 내용 → 새 노드(만들기 → 내용) → 노드·연결 구조 → 스토리 표기 순서 → 제목·소개 → 공개 여부
 */
export async function rplaySave(
  write: WorkWrite,
  id: string,
  nextRaw: unknown,
  io?: WorkIo
): Promise<void> {
  const r = structuredClone(rplayRaw(nextRaw))
  const base = r.base
  // applyChanges를 거치지 않은 원본이면 무엇이 바뀌었는지 모른다. 성공으로 돌려주면 저장된 줄 안다
  if (!base) throw new Error('NO_BASE')
  const wid = rplayWorkId(id)
  if (wid !== r.id) throw new Error('BAD_WORK_ID')
  const a = await needAccount(write, io?.read)
  // 가져오기·컴파일 중인 캔버스는 편집기도 고치지 않는다
  if (r.canvas.isImporting === true || r.canvas.isCompiling === true) throw new Error('CANVAS_BUSY')
  const canvasOid = r.canvasOid
  const nodes = list(r.canvas.nodes)
  const fresh = nodes.filter((n) => isNew(text(n.metadataOid)))

  // 제목·소개를 보낼 수 있는지 노드 내용을 쓰기 전에 본다 (나중에 막히면 일부만 저장되고 멈춘다)
  const info = infoOf(r)
  const patches = (
    [
      ['title', 'title'],
      ['simpleIntro', 'simpleIntro'],
      ['description', 'description']
    ] as const
  ).flatMap(([key, field]) =>
    text(info[key]) !== text(base.info[key]) ? [{ field, value: text(info[key]) }] : []
  )
  let lang: { language: string; revision: number } | null = null
  if (patches.length) {
    const language = sourceLanguage(r)
    const loc =
      r.localization && isObj(r.localization.localization) ? r.localization.localization : null
    // 읽은 revision을 그대로 보낸다 (모르면 0으로 짐작하지 않고 멈춘다)
    if (!language || !loc || typeof loc.revision !== 'number') throw new Error('LOCALIZATION_MISSING')
    lang = { language, revision: loc.revision }
  }

  // 새 인물 노드 해시가 이미지 해시와 겹치지 않는지 먼저 본다 (편집기 fr/mr)
  if (fresh.some((n) => n.type === 'character')) {
    if (!io) throw new Error('NO_IO')
    const got = await rplayJson(
      await io.read(
        withQuery(RPLAY_CHAT + '/image-hashes', [['contentOid', wid], ...accountParams(a)])
      )
    )
    const used = new Set(isObj(got) ? strings(got.hashes) : [])
    for (const n of nodes) if (!fresh.includes(n)) used.add(text(n.hash))
    if (fresh.some((n) => used.has(text(n.hash)))) throw new Error('HASH_COLLISION')
  }

  const dirty: string[] = []
  // 1) 있던 노드의 내용
  for (const n of nodes) {
    const oid = text(n.metadataOid)
    if (isNew(oid) || !base.metadataSet[oid]) continue
    const type = text(n.type)
    const after = r.metadataSet[oid] ?? {}
    const keys = changedKeys(type, base.metadataSet[oid], after)
    if (!keys.length) continue
    const update: Obj = Object.fromEntries(keys.map((k) => [k, after[k]]))
    update.version = Date.now()
    await postMeta(write, a, canvasOid, oid, type, update, { imageCountDelta: 0 })
    dirty.push(oid)
  }
  // 2) 새 노드: 편집기처럼 빈 노드를 만들고 내용을 채운다
  const fills: { oid: string; type: string; fill: Obj }[] = []
  for (const n of fresh) {
    const temp = text(n.metadataOid)
    const type = text(n.type)
    const want = r.metadataSet[temp] ?? {}
    const made = await postMeta(write, a, canvasOid, null, null, {
      type,
      useTokenBlock: true,
      ...(type === 'story' ? { isStart: true } : {}),
      ...(type === 'lorebook'
        ? {
            entries: [
              {
                key: '',
                patterns: [],
                text: '',
                priority: 1,
                durationTurns: 1,
                activationMode: 'keyword'
              }
            ]
          }
        : {})
    })
    const oid = oidOf(made._id)
    if (!oid) throw shapeError('SAVE_FAILED metadata', made)
    n.metadataOid = oid
    n.metadata = made
    const fill: Obj = {}
    for (const k of EDITABLE[type] ?? []) if (want[k] !== undefined) fill[k] = want[k]
    // 내용은 노드가 캔버스에 들어간 뒤에 채운다. 그 전에 보내면 서버가
    // 403 CANVAS_METADATA_NOT_IN_CANVAS로 거절한다 (2026-11-10 실제 저장으로 확인).
    fills.push({ oid, type, fill })
    dirty.push(oid)
    r.metadataSet[oid] = { ...want, _id: oid }
    delete r.metadataSet[temp]
  }
  // 3) 노드·연결 구조
  const connections = list(r.canvas.connections)
  if (
    shape(nodes) !== shape(base.nodes) ||
    JSON.stringify(connections) !== JSON.stringify(base.connections)
  ) {
    // 지운 노드의 이미지 수 (편집기 vu)
    let imageCountDelta = 0
    const kept = new Set(nodes.map((n) => text(n.uid)))
    for (const n of base.nodes) {
      if (kept.has(text(n.uid))) continue
      const m = base.metadataSet[text(n.metadataOid)]
      if (m && Array.isArray(m.images))
        imageCountDelta += m.image ? -1 : -list(m.images).filter((x) => x.use === true).length
    }
    const res = await write('POST', RPLAY_CHAT + '/chat-canvas', {
      requestType: 'update',
      canvasOid,
      updateData: {
        nodes,
        connections,
        needsCompilation: true,
        dirtyMetadataIds: dirty,
        ...(imageCountDelta ? { imageCountDelta } : {})
      },
      loadMetadata: false,
      returnNewCanvas: false,
      ...accountBody(a)
    })
    await rplayWritten(res, 'SAVE')
  }
  // 3-1) 새 노드의 내용 (캔버스에 들어간 뒤)
  for (const f of fills) {
    f.fill.version = Date.now()
    await postMeta(write, a, canvasOid, f.oid, f.type, f.fill, { imageCountDelta: 0 })
  }
  // 4) 스토리 표기 순서 (편집기 au: story-sort)
  const sorted = nodes.filter((n) => n.type === 'story' && n.deleted !== true)
  const sortChanged = sorted.some((n) => {
    const oid = text(n.metadataOid)
    const old = base.metadataSet[oid]
    return !old || old.sort !== r.metadataSet[oid]?.sort
  })
  if (sortChanged && sorted.length) {
    const updates = sorted
      .map((n) => ({
        metadataOid: text(n.metadataOid),
        sort: Number(r.metadataSet[text(n.metadataOid)]?.sort) || 0
      }))
      .sort((x, y) => x.sort - y.sort)
    await postMeta(write, a, canvasOid, null, 'story-sort', { sortUpdates: updates })
  }
  // 5) 제목·간단 소개·상세 설명 (언어 상태의 원본 언어 칸)
  if (patches.length && lang) {
    const res = await write('POST', RPLAY_CHAT + '/localization/' + wid + '/edit', {
      revision: lang.revision,
      patches: patches.map((p) => ({ language: lang.language, ...p })),
      ...accountBody(a)
    })
    await rplayWritten(res, 'LOCALIZATION')
  }
  // 6) 공개 여부 (마지막)
  if ((r.content.isPrivate === true) !== (base.content.isPrivate === true))
    await saveStoryChat(write, a, { _id: wid, isPrivate: r.content.isPrivate === true })
}

// ───────────── 새 작품 ─────────────

const EMPTY_ID = '0'.repeat(24)
const emptyRaw = (): RplayRaw => ({
  id: EMPTY_ID,
  content: { _id: EMPTY_ID, canvasOid: EMPTY_ID, isPrivate: true },
  localization: { _id: EMPTY_ID, localization: { sourceLanguage: 'ko', revision: 0 } },
  canvasOid: EMPTY_ID,
  canvas: { nodes: [], connections: [] },
  metadataSet: {}
})

/** 새 작품 내용 → 만든 직후 작품에 얹을 바꾸기 */
function draftChanges(raw: RplayRaw, draft: WorkDraft): WorkChanges {
  const starts = draft.startScenarios ?? []
  const hasStory = storyNodes(raw).length > 0
  const fields: Record<string, string> = {
    title: draft.title,
    ...(draft.subtitle !== undefined ? { subtitle: draft.subtitle } : {}),
    ...(draft.description !== undefined ? { description: draft.description } : {})
  }
  const changes: WorkChanges = { fields }
  if (hasStory) {
    if (draft.main) fields.main = draft.main
    if (starts[0]) changes.startScenarios = [{ index: 0, ...starts[0] }]
    if (starts.length > 1) changes.startScenariosAdd = starts.slice(1)
  } else if (draft.main || starts.length) {
    // 스토리 노드가 없으면 첫 시작 상황을 만들면서 main을 그 중요 정보로 넣는다
    changes.startScenariosAdd = [
      { ...(starts[0] ?? {}), ...(draft.main ? { subPrompt: draft.main } : {}) },
      ...starts.slice(1)
    ]
  }
  if (draft.characters.length) changes.charactersAdd = draft.characters
  if (draft.lorebook?.length) changes.lorebookAdd = draft.lorebook
  return changes
}
function draftHashtags(draft: WorkDraft): string[] {
  return [
    ...new Set((draft.hashtags ?? []).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean))
  ]
}
export function rplayCheckDraft(draft: WorkDraft): void {
  if (!draft.title.trim()) throw new Error('BAD_DRAFT title')
  if (draft.categories?.length) throw new Error('BAD_DRAFT categories 없음 (hashtags를 쓴다)')
  if (draft.options && Object.keys(draft.options).length) throw new Error('BAD_DRAFT options 없음')
  rplayApplyChanges(emptyRaw(), draftChanges(emptyRaw(), draft))
}

// ───────────── 목록 ─────────────

const timeOf = (oid: string): number => parseInt(oid.slice(0, 8), 16)

async function rplayList(read: WorkFetch): Promise<WorkListItem[]> {
  const a = await needAccount(read)
  const me = await rplayJson(
    await read(
      withQuery(RPLAY_API + '/account/getuser', [
        ['userOid', a.oid],
        ...LIST_FILTER.map((f): [string, string] => ['filter[]', f]),
        ...accountParams(a)
      ])
    )
  )
  if (!isObj(me)) throw shapeError('WORK_LIST_SHAPE', me)
  // 스튜디오와 같은 두 묶음: 작업 중 + 업로드됨. 만든 순서(번호 앞 8자리 시각) 최신 먼저, 같으면 번호순
  const ids = [
    ...new Set(
      LIST_FILTER.flatMap((k) => (Array.isArray(me[k]) ? me[k] : []))
        .map(oidOf)
        .filter(Boolean)
    )
  ]
    .sort((x, y) => timeOf(y) - timeOf(x) || x.localeCompare(y))
    .slice(0, 300)
  const out: WorkListItem[] = []
  for (let i = 0; i < ids.length; i += 4) {
    const part = await Promise.all(
      ids.slice(i, i + 4).map(async (id): Promise<WorkListItem | null> => {
        let c: unknown
        try {
          c = await rplayJson(await read(contentUrl(id, a)))
        } catch (error) {
          if (error instanceof Error && /^(WORK_NOT_FOUND|FORBIDDEN)/.test(error.message))
            return null
          throw error
        }
        if (!isObj(c) || c.deleted === true) return null
        return {
          id,
          title: text(c.title),
          visibility: visibilityOf(c),
          status: strOrNull(c.status),
          updatedAt: strOrNull(c.modified) ?? strOrNull(c.updatedAt),
          characters: null
        }
      })
    )
    for (const w of part) if (w) out.push(w)
  }
  return out
}

// ───────────── 이미지 (읽기만) ─────────────

/** 인물 노드 프로필 이미지와 이미지 노드의 이미지. 올리기·지우기는 서명된 저장소 주소를 거쳐 막아 둔다 */
function rplayImageGroups(raw: unknown): ImageGroup[] {
  const r = rplayRaw(raw)
  const people = ofType(r, 'character').map((n, i) => {
    const m = metaOf(r, n)
    const url = text(m.imageUrl)
    return {
      character: i,
      name: text(m.name),
      images: url
        ? [
            {
              id: strOrNull(m.image),
              url,
              label: '프로필',
              description: '',
              visibility: null,
              isDefault: true
            }
          ]
        : []
    }
  })
  const pools = ofType(r, 'image').map((n) => {
    const m = metaOf(r, n)
    return {
      character: null,
      name: text(m.title) || 'image-node',
      images: list(m.images).map((im) => ({
        id: strOrNull(im.hash),
        url: text(im.imageUrl),
        label: text(im.hash),
        description: strings(im.tags).join(', '),
        visibility: im.use === false ? 'hidden' : 'public',
        isDefault: false
      }))
    }
  })
  return [...people, ...pools]
}

// ───────────── 연결부 ─────────────

export const rplayWorks: WorkAdapter = {
  id: 'rplay',
  // 저장 뒤 사라지는 작업용 값과 서버가 만드는 언어별 사본 (2026-11-13 실제 저장에서 확인)
  rawIgnore: [/^base$/, /^canvas\.dirtyMetadataIds\b/, /^metadataSet\.new:/, /^localization\.multiLang/, /^content\.multiLang/],
  label: '알플레이',
  features: {
    title: { site: 'yes', read: 'yes', write: 'yes', verified: 'partial', note: '빈 값 거부, 쓰기 실계정 미확인' },
    description: { site: 'yes', read: 'yes', write: 'yes', verified: 'partial', note: '글자 한도 검사 없음, 쓰기 미확인' },
    main_prompt: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '첫 스토리 중요 정보, 공개작 저장 미확인'
    },
    first_message: { site: 'yes', read: 'yes', write: 'yes', verified: 'yes', note: '스토리마다 하나, 1,000토큰' },
    start_scenarios: { site: 'yes', read: 'yes', write: 'yes', verified: 'yes', note: '스토리 노드, 추가·삭제만(순서 변경 불가)' },
    lorebook: { site: 'yes', read: 'yes', write: 'yes', verified: 'yes', note: '매크로 노드, 제목 고정, 발동 단어 5개 이하' },
    characters: { site: 'yes', read: 'yes', write: 'yes', verified: 'yes', note: '이름·중요 정보·상세 3칸만 다룸' },
    example_dialogue: { site: 'unknown', read: 'partial', write: 'no', verified: 'no', note: '인물 시작 대사는 개수만 읽음' },
    user_persona: { site: 'yes', read: 'partial', write: 'partial', verified: 'no', note: '유저 노드는 캔버스 JSON으로만' },
    output_rules: { site: 'no', read: 'no', write: 'no', verified: 'no', note: '별도 칸 없음' },
    situation_images: { site: 'yes', read: 'partial', write: 'blocked', verified: 'partial', note: '읽기만, 올리기 막음' },
    cover: { site: 'yes', read: 'partial', write: 'blocked', verified: 'no', note: '있는지만 읽음, 올리기 막음' },
    tags: { site: 'yes', read: 'yes', write: 'partial', verified: 'no', note: '읽기는 extras, 쓰기는 새 작품 때만' },
    visibility: { site: 'yes', read: 'yes', write: 'partial', verified: 'partial', note: '첫 공개는 사이트에서 직접' },
    create_work: { site: 'yes', read: 'no', write: 'yes', verified: 'yes', note: '항상 비공개로 생성' },
    delete_work: { site: 'yes', read: 'no', write: 'yes', verified: 'yes', note: '삭제 때 OTP 요구 가능' },
    versioning_review: { site: 'unknown', read: 'no', write: 'blocked', verified: 'no', note: '컴파일은 사이트에서, 상태는 안 읽음' },
    language_editions: { site: 'yes', read: 'partial', write: 'no', verified: 'no', note: '언어 목록만 읽음, 판본 도구 없음' },
    bgm_voice: { site: 'no', read: 'no', write: 'no', verified: 'no', note: '사이트에 그런 칸 없음' },
    jsx_html: { site: 'no', read: 'no', write: 'no', verified: 'no', note: 'JSX 칸 없음' },
    model_settings: { site: 'yes', read: 'partial', write: 'partial', verified: 'partial', note: '작품 단위만 읽음, 쓰기는 캔버스 JSON' },
    comments_stats: { site: 'yes', read: 'no', write: 'no', verified: 'no', note: '읽을 때 댓글을 일부러 뺌' }
  },
  guide: {
    save: '저장만 하고 스토리 컴파일은 하지 않는다. 컴파일은 사이트에서 한다.',
    manual: [
      '스토리 컴파일',
      '처음 공개(업로드)',
      '썸네일·이미지',
      'storyengine.live 쪽 작품(로그인이 따로다)'
    ],
    unverified: [
      '노드가 많은 실제 작품의 캔버스 가져오기(시험은 노드 3개짜리 새 작품으로 했다)',
      '가져올 때 언어·공통 설정이 다른 경우의 선택(settings_choice, language)',
      '공개 작품 저장 뒤 컴파일 없이 반영되는지',
      '로어북 전체 교체의 짝짓기·제목 바꾸기(가짜 사이트로만 시험했다)'
    ]
  },
  capabilities: [
    'works_list',
    'work_read',
    'lorebook',
    'start_scenarios',
    'characters',
    'save',
    'canvas'
  ],

  readAllowed: (url) => routeAllowed(url, READ_ROUTES),
  writeAllowed(method, url) {
    if (method !== 'POST') return false
    try {
      const u = new URL(url)
      return (
        u.origin === RPLAY_CHAT_ORIGIN &&
        !u.search &&
        !u.hash &&
        !u.username &&
        !u.password &&
        WRITE_PATHS.some((re) => re.test(u.pathname))
      )
    } catch {
      return false
    }
  },

  list: rplayList,
  readRaw: (read, id) => rplayReadRaw(read, id),
  normalize: rplayNormalize,
  applyChanges: rplayApplyChanges,
  save: rplaySave,
  visibilities: VISIBILITIES,

  /** 스튜디오의 삭제 (deleteStoryChat(userOid, contentOid)). 계정에 따라 OTP를 요구할 수 있다 */
  async remove(write, id, io) {
    const wid = rplayWorkId(id)
    const a = await needAccount(write, io?.read)
    const res = await write('POST', RPLAY_CHAT + '/chat-content', {
      requestType: 'delete',
      userOid: a.oid,
      contentOid: wid,
      ...accountBody(a)
    })
    try {
      await rplayWritten(res, 'DELETE')
    } catch (error) {
      if (error instanceof Error && /OTP_(REQUIRED|INVALID)/.test(error.message))
        throw new Error('OTP_REQUIRED')
      throw error
    }
  },

  /**
   * 새 작품 (항상 비공개 작업 중 상태). 편집기처럼 빈 스토리챗을 만들고(requestType:"create"),
   * 비공개·성인 여부를 먼저 저장한 뒤 내용을 노드로 채운다. 업로드(공개)는 하지 않는다.
   */
  async create(write, draft, read, io) {
    const reader = read ?? io?.read
    if (!reader) throw new Error('NO_IO')
    const a = await needAccount(write, reader)
    rplayCheckDraft(draft)
    const res = await write('POST', RPLAY_CHAT + '/chat-content', {
      requestType: 'create',
      isLiteMode: false,
      ...accountBody(a)
    })
    const body = await rplayWritten(res, 'CREATE')
    const made = isObj(body.storyChat) ? oidOf(body.storyChat._id) : ''
    if (!made) throw shapeError('CREATED_ID_UNKNOWN', body)
    try {
      const tags = draftHashtags(draft)
      await saveStoryChat(write, a, {
        _id: made,
        isPrivate: true,
        isAdultContent: draft.adult,
        ...(tags.length ? { hashtags: tags, manualHashtags: tags } : {})
      })
      const raw = await rplayReadRaw(reader, made)
      await rplaySave(write, made, rplayApplyChanges(raw, draftChanges(raw, draft)), io)
    } catch (error) {
      // 작품은 이미 생겼다. 번호를 알려 이어서 고치거나 지울 수 있게 한다
      throw new Error(
        'CREATE_PARTIAL ' + made + ' ' + (error instanceof Error ? error.message : String(error)),
        { cause: error }
      )
    }
    return made
  },
  checkDraft: rplayCheckDraft,

  imageGroups: rplayImageGroups,

  // 캔버스 JSON 내보내기·가져오기 (rplay-canvas.ts). 저장소 PUT은 API가 이번에 내준 주소만 열린다
  sendRule: rplaySendRule,
  exportCanvas: rplayExportCanvas,
  checkCanvas: rplayCheckCanvas,
  importCanvas: rplayImportCanvas,
  compareCanvas: rplayCompareCanvas
}
