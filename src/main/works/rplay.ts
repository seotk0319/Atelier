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
function loreOf(r: RplayRaw): LoreEntry[] {
  return ofType(r, 'lorebook').flatMap((n) => {
    const m = metaOf(r, n)
    return list(m.entries).map((e) => ({
      title: text(m.title),
      keys: patternsOf(e).join(', '),
      content: text(e.text),
      mode: e.activationMode === 'always' ? 'always' : 'keyword',
      offKeys: [],
      turnRange: typeof e.durationTurns === 'number' && e.durationTurns > 0 ? e.durationTurns : 1,
      offTurnRange: null
    }))
  })
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

/** 공통 로어북 항목 → 매크로 항목. null은 알플레이 기본값(keyword, 1턴) */
function entryFrom(e: Partial<LoreEntry>, base: Obj | undefined, where: string): Obj {
  if ((e.offKeys !== undefined && e.offKeys.length) || (e.offTurnRange ?? null) !== null)
    throw new Error('BAD_LOREBOOK ' + where + ' off_keys·off_turn_range 없음')
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
  if (e.keys !== undefined) {
    const patterns = e.keys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    if (patterns.length > MACRO_PATTERNS_MAX || patterns.some((p) => p.includes('|')))
      throw new Error('BAD_LOREBOOK ' + where + '.keys 5개 이하, | 없이')
    out.patterns = patterns
    out.key = patterns.join('|')
  }
  if (e.content !== undefined) out.text = e.content
  if (e.mode !== undefined) {
    const mode = e.mode ?? 'keyword'
    if (mode !== 'keyword' && mode !== 'always')
      throw new Error('BAD_LOREBOOK ' + where + '.mode keyword/always')
    out.activationMode = mode
  }
  if (e.turnRange !== undefined) {
    const turns = e.turnRange ?? 1
    if (!Number.isInteger(turns) || turns < DURATION_MIN || turns > DURATION_MAX)
      throw new Error('BAD_LOREBOOK ' + where + '.turn_range 1~5')
    out.durationTurns = turns
  }
  return out
}

/** 시작 상황 칸 → 스토리 노드 칸 */
function storyFields(s: StartScenarioDraft, allowSubPrompt: boolean): Obj {
  if (s.dialogue !== undefined && s.dialogue !== '') throw new Error('BAD_CHANGES dialogue 없음')
  if (s.subPrompt !== undefined && !allowSubPrompt)
    throw new Error('BAD_CHANGES 첫 스토리의 중요 정보는 fields.main')
  const out: Obj = {}
  if (s.title !== undefined) out.title = s.title.trim()
  if (s.content !== undefined) out.prologue = s.content
  if (s.subPrompt !== undefined) out.coreContext = s.subPrompt
  if (s.situation !== undefined) out.prologueGuide = s.situation
  if (s.description !== undefined) out.text = s.description
  return out
}
function checkStory(m: Obj, where: string): void {
  if (!text(m.title).trim()) throw new Error('BAD_START ' + where + '.title 비어 있음')
  if (m.useTokenBlock !== true && text(m.prologue).length > PROLOGUE_CHAR_MAX)
    throw new Error('BAD_START ' + where + '.content 1000자')
  if (text(m.creatorNotice).length > CREATOR_NOTICE_MAX)
    throw new Error('BAD_FIELD creator_comment 500자')
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
}

export function rplayApplyChanges(raw: unknown, changes: WorkChanges): RplayRaw {
  const d = new Draft(rplayRaw(raw))
  const next = d.next

  if (changes.visibility !== undefined) {
    if (!VISIBILITIES.includes(changes.visibility)) throw new Error('BAD_VISIBILITY')
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
    Object.assign(d.meta(before[i]), storyFields(patch, i !== 0))
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
      infoOf(next)[key] = value
      if (name === 'title' && !value.trim()) throw new Error('BAD_FIELD title 비어 있음')
      if (name === 'subtitle') {
        const max = SIMPLE_INTRO_MAX[sourceLanguage(next) ?? 'ko'] ?? 40
        if (value.length > max) throw new Error('BAD_FIELD subtitle ~' + max + '자')
      }
    } else if (name === 'main' || name === 'creator_comment') {
      if (!stories[0]) throw new Error('NO_STORY')
      d.meta(stories[0])[name === 'main' ? 'coreContext' : 'creatorNotice'] = value
      touched.add(stories[0])
    } else throw new Error('BAD_FIELD')
  }
  stories.forEach((n, i) => {
    if (touched.has(n)) checkStory(metaOf(next, n), 'start_scenarios[' + i + ']')
  })

  // 캐릭터 (인물 노드)
  const chars = ofType(next, 'character')
  for (const patch of changes.characters ?? []) {
    const m = d.meta(chars[at(patch.index, chars.length)])
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error('EMPTY_FIELD')
      m.name = patch.name.trim()
    }
    if (patch.details !== undefined) m.text = patch.details
    if (patch.info !== undefined) m.coreContext = patch.info
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

function applyLore(d: Draft, changes: WorkChanges): void {
  const next = d.next
  const owners = ofType(next, 'lorebook')
  let items: Entry[] = owners.flatMap((n) =>
    list(metaOf(next, n).entries).map((entry) => ({ owner: text(n.metadataOid), entry }))
  )
  const titleOf = (owner: string): string => text(next.metadataSet[owner]?.title)
  const before = JSON.stringify(items)

  let patches = changes.lorebookPatch ?? []
  let removes = changes.lorebookRemove ?? []
  let adds = changes.lorebookAdd ?? []
  if (changes.lorebook) {
    // 전체 교체 = 앞에서부터 고치기 + 남는 것 지우기 + 모자란 것 더하기
    const whole = changes.lorebook
    patches = whole.slice(0, items.length).map((e, index) => ({ ...e, index }))
    removes = items.map((_, i) => i).slice(whole.length)
    adds = whole.slice(items.length)
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
    let owner = ofType(next, 'lorebook').find((n) => text(metaOf(next, n).title) === e.title)
    if (!owner) {
      owner = d.add('lorebook', { title: e.title, entries: [] })
      for (const s of storyNodes(next)) d.connect(owner, s)
    }
    items.push({ owner: text(owner.metadataOid), entry: entryFrom(e, undefined, where) })
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
  if (!base) return
  const wid = rplayWorkId(id)
  if (wid !== r.id) throw new Error('BAD_WORK_ID')
  const a = await needAccount(write, io?.read)
  // 가져오기·컴파일 중인 캔버스는 편집기도 고치지 않는다
  if (r.canvas.isImporting === true || r.canvas.isCompiling === true) throw new Error('CANVAS_BUSY')
  const canvasOid = r.canvasOid
  const nodes = list(r.canvas.nodes)
  const fresh = nodes.filter((n) => isNew(text(n.metadataOid)))

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
  if (patches.length) {
    const language = sourceLanguage(r)
    const loc =
      r.localization && isObj(r.localization.localization) ? r.localization.localization : null
    if (!language || !loc) throw new Error('LOCALIZATION_MISSING')
    const res = await write('POST', RPLAY_CHAT + '/localization/' + wid + '/edit', {
      revision: typeof loc.revision === 'number' ? loc.revision : 0,
      patches: patches.map((p) => ({ language, ...p })),
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
  label: '알플레이',
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
