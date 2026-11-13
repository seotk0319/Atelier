// 크랙(뤼튼 crack.wrtn.ai) 스토리 작품 읽기·저장. 주소와 필드는 2026-11-10 크랙 웹 공개 스크립트에서 읽었다 (실제 호출 전).
//   GET    /crack-api/stories/me?cursor=                  내 스토리 목록 {data:{stories, nextCursor}} (알림 쪽 my-works에서 실제 확인)
//   GET    /crack-api/stories/me/{id}                     편집 데이터 {data}
//   PATCH  /crack-api/stories/{id}/v2                     수정 등록(편집기 상단 「수정」→「등록」). send 통로(JSON PATCH)
//   POST   /crack-api/temp-stories                        새 작품 번호 받기 (내 작품 「만들기」) {data: storyId}
//   POST   /crack-api/stories/v2                          새 작품 등록 (본문에 storyId)
//   DELETE /crack-api/temp-stories/{id}                   새 작품 등록이 실패했을 때 받은 번호 정리
//   GET    /crack-api/content/me?limit=20&type=story      내 작품 관리 목록 (삭제에 쓰는 콘텐츠 번호 _id를 찾는다)
//   DELETE /crack-api/content/{contentId}                 작품 삭제 (내 작품 「삭제하기」)
// 캐릭터는 따로 없다(작품 하나 = 스토리 하나). 시작 설정이 시작 상황이고, 키워드북은 시작 설정마다 따로 저장된다.
// 글 칸: title=name, subtitle=simpleDescription(한 줄 소개), description=detailDescription(상세 설명),
//        main=customPrompt(프롬프트 템플릿 custom) 또는 storyDetails(그 밖의 템플릿).
import {
  CRACK_API,
  CRACK_IMAGE_RULES,
  OID,
  OID_RE,
  at,
  crackCreateBody,
  crackData,
  crackError,
  crackExtras,
  crackForm,
  crackJson,
  crackPatchBody,
  crackPlain,
  crackRaw,
  crackReadRaw,
  crackShapeCheck,
  crackWorkId,
  fromCommon,
  hasSituationImages,
  isObj,
  list,
  nanoid,
  publishDeclaration,
  sendStartingSets,
  strOrNull,
  text,
  toCommon,
  type CrackForm,
  type CrackRaw,
  type FormKeyword,
  type FormStartingSet,
  type Obj
} from './crack-core'
import {
  crackApplyImages,
  crackImageGroups,
  crackPlanImages,
  crackSendRule,
  crackUploadCover,
  crackUploadImage
} from './crack-media'
import { matchOld } from './match-old'
import type {
  LoreEntry,
  StartScenarioDraft,
  WorkAdapter,
  WorkBody,
  WorkDraft,
  WorkFetch,
  WorkIo,
  WorkListItem,
  WorkWrite
} from './types'

const MAX_PAGES = 30
const VISIBILITIES = ['public', 'link', 'private']

const CONTENT_ME = [/^\/crack-api\/content\/me$/]

// 편집기 입력 규칙 (화면 maxLength, 상황 이미지 v2 기준)
const LIMITS = {
  name: 30,
  simpleDescription: 30,
  detailDescription: 1000,
  customPrompt: { v2: 7000, v1: 5000 },
  storyDetails: { v2: 5000, v1: 3000 },
  setName: 12,
  initialMessage: 1000,
  situationPrompt: 1000,
  playGuide: 500,
  keywordName: 20,
  keywordPrompt: 400,
  keywords: 5,
  keyword: 10,
  keywordBooksPerSet: 20,
  keywordBooks: 60,
  tags: 10
}

/** main 칸이 가리키는 서버 칸 (프롬프트 템플릿에 따라 다르다) */
function mainKey(form: Pick<CrackForm, 'promptTemplate'>): 'customPrompt' | 'storyDetails' {
  return form.promptTemplate === 'custom' ? 'customPrompt' : 'storyDetails'
}

// ───────────── 원본 고치기 (원본 모양 그대로: 키워드북은 시작 설정마다) ─────────────

/** 폼의 시작 설정·키워드북을 원본 시작 설정 모양으로 되돌린다 (있던 시작 설정의 다른 값은 그대로 둔다) */
function setsFromForm(story: Obj, form: CrackForm): Obj[] {
  const old = list(story.startingSets)
  const sent = sendStartingSets(form, true)
  return form.startingSets.map((set, i) => {
    const base = set.origin !== undefined ? old[set.origin] : undefined
    const s = sent[i]
    const out: Obj = base ? { ...base } : {}
    out.name = set.name
    out.initialMessages = set.initialMessages
    out.situationPrompt = set.situationPrompt
    out.playGuide = set.playGuide
    out.replySuggestions = set.replySuggestions
    out.keywordBook = s.keywordBook
    if (!base) {
      out.situationImages = []
    }
    return out
  })
}

function keyList(keys: string): string[] {
  return keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
}
/** 공통 로어북 항목 → 키워드 노트. 크랙에는 발동 방식·턴 값·제외 키워드가 없다 */
function noteFrom(
  entry: Partial<LoreEntry>,
  base: FormKeyword | undefined,
  sets: string[]
): FormKeyword {
  if (
    (entry.mode !== undefined && entry.mode !== null) ||
    (entry.turnRange !== undefined && entry.turnRange !== null) ||
    (entry.offTurnRange !== undefined && entry.offTurnRange !== null) ||
    (entry.offKeys !== undefined && entry.offKeys.length > 0)
  )
    throw new Error('BAD_CHANGES')
  const out: FormKeyword = base
    ? { ...base, keywords: [...base.keywords], startingSetId: [...base.startingSetId] }
    : { id: nanoid(), name: '', prompt: '', keywords: [], startingSetId: sets }
  if (entry.title !== undefined) out.name = entry.title
  if (entry.content !== undefined) out.prompt = entry.content
  // 읽을 때 `, `로 이은 글을 그대로 돌려주면 원래 키워드를 그대로 둔다 (쉼표가 든 키워드가 쪼개지지 않게)
  // 전체 교체에서 호출한 쪽이 키워드를 적지 않았으면(given에 keys 없음) 짝지은 옛 노트의 키워드를 그대로 둔다
  const keysGiven = entry.given === undefined || entry.given.includes('keys')
  if (keysGiven && entry.keys !== undefined && !(base && entry.keys === base.keywords.join(', ')))
    out.keywords = keyList(entry.keys)
  return out
}
type StartExtras = { subPrompt?: string; dialogue?: string }
/** 크랙 시작 설정에는 따로 된 보조 프롬프트·대사 칸이 없다 */
function noStartExtras(s: StartExtras): void {
  for (const key of ['subPrompt', 'dialogue'] as const)
    if (s[key] !== undefined && s[key] !== '') throw new Error('BAD_CHANGES')
}

/**
 * 입력 규칙 검사. old(손대기 전 모습)를 주면 바뀌었거나 새로 더한 칸만 본다:
 * 사이트가 받아 주던 옛 값(한도가 지금과 달랐던 글, 빈 칸 등)은 그대로 보내므로 막지 않는다.
 */
function checkForm(form: CrackForm, old?: CrackForm): void {
  const v2 = form.situationImageVersion === 'v2'
  const field = (
    name: string,
    value: string,
    max: number,
    required: boolean,
    before?: string
  ): void => {
    if (before !== undefined && value === before) return
    if ((required && !value.trim()) || value.length > max)
      throw new Error('BAD_FIELD ' + name + (required ? ' 1~' : ' ~') + max + '자')
  }
  field('title', form.name, LIMITS.name, true, old?.name)
  field('subtitle', form.simpleDescription, LIMITS.simpleDescription, true, old?.simpleDescription)
  field('description', form.detailDescription, LIMITS.detailDescription, false, old?.detailDescription)
  const key = mainKey(form)
  const main = key === 'customPrompt' ? text(form.customPrompt) : form.storyDetails
  field(
    'main',
    main,
    LIMITS[key][v2 ? 'v2' : 'v1'],
    true,
    old && (key === 'customPrompt' ? text(old.customPrompt) : old.storyDetails)
  )

  // 옛 작품에 시작 설정이 하나도 없었으면 그대로 둔다 (지우기로는 0개가 되지 않는다: 0번 삭제 막힘)
  if (!form.startingSets.length && (!old || old.startingSets.length))
    throw new Error('BAD_START start_scenarios 1개 이상')
  form.startingSets.forEach((s, i) => {
    const where = 'start_scenarios[' + i + ']'
    const was = old?.startingSets.find((x) => x.id === s.id)
    if (!was || s.name !== was.name)
      if (!s.name.trim() || s.name.length > LIMITS.setName)
        throw new Error('BAD_START ' + where + '.title 1~' + LIMITS.setName + '자')
    const first = s.initialMessages[0] ?? ''
    if (!was || first !== (was.initialMessages[0] ?? ''))
      if (!first.trim() || first.length > LIMITS.initialMessage)
        throw new Error('BAD_START ' + where + '.content 1~' + LIMITS.initialMessage + '자')
    if (!was || s.situationPrompt !== was.situationPrompt)
      if (s.situationPrompt.length > LIMITS.situationPrompt)
        throw new Error('BAD_START ' + where + '.situation ~' + LIMITS.situationPrompt + '자')
    if (!was || s.playGuide !== was.playGuide)
      if (s.playGuide.length > LIMITS.playGuide)
        throw new Error('BAD_START ' + where + '.description ~' + LIMITS.playGuide + '자')
  })

  // 개수는 옛 작품보다 늘어난 때만 막는다
  if (
    form._keywordBook.length > LIMITS.keywordBooks &&
    form._keywordBook.length > (old?._keywordBook.length ?? 0)
  )
    throw new Error('LOREBOOK_LIMIT')
  form._keywordBook.forEach((k, i) => {
    const where = 'lorebook[' + i + ']'
    const was = old?._keywordBook.find((x) => x.id === k.id)
    if (!was || k.name !== was.name)
      if (!k.name.trim() || k.name.length > LIMITS.keywordName)
        throw new Error('BAD_LOREBOOK ' + where + '.title 1~' + LIMITS.keywordName + '자')
    if (!was || k.prompt !== was.prompt)
      if (!k.prompt.trim() || k.prompt.length > LIMITS.keywordPrompt)
        throw new Error('BAD_LOREBOOK ' + where + '.content 1~' + LIMITS.keywordPrompt + '자')
    if (!was || JSON.stringify(k.keywords) !== JSON.stringify(was.keywords))
      if (
        !k.keywords.length ||
        k.keywords.length > LIMITS.keywords ||
        k.keywords.some((w) => w.length > LIMITS.keyword)
      )
        throw new Error('BAD_LOREBOOK ' + where + '.keys 1~5개, 각 10자')
    if (!was || JSON.stringify(k.startingSetId) !== JSON.stringify(was.startingSetId))
      if (!k.startingSetId.length)
        throw new Error('BAD_LOREBOOK ' + where + ' 적용할 시작 설정 없음')
  })
  for (const s of form.startingSets) {
    const count = form._keywordBook.filter((k) => k.startingSetId.includes(s.id)).length
    const before = old?._keywordBook.filter((k) => k.startingSetId.includes(s.id)).length ?? 0
    if (count > LIMITS.keywordBooksPerSet && count > before)
      throw new Error('LOREBOOK_LIMIT 시작 설정마다 20개')
  }
}

/** 편집기 「키워드 노트 추가」: 노트가 20개 찬 시작 설정을 뺀 모든 시작 설정에 적용한다 */
function openSets(form: CrackForm): string[] {
  return form.startingSets
    .filter(
      (s) =>
        form._keywordBook.filter((k) => k.startingSetId.includes(s.id)).length <
        LIMITS.keywordBooksPerSet
    )
    .map((s) => s.id)
}

// 내부 표시: 공개 상태만 바뀐 저장인지 (save가 편집기의 「공개로 변경」 요청 모양을 쓴다)
interface CrackNext extends CrackRaw {
  visibilityOnly?: boolean
}

export const crackWorks: WorkAdapter = {
  id: 'crack',
  // 서버가 저장마다 시작 설정을 새 번호로 다시 만든다 (2026-11-13 실제 저장에서 확인)
  rawIgnore: [/^story\.startingSets\[_id=[^\]]*\]/, /^visibilityOnly$/, /^story\.storyDetails$/],
  label: '크랙',
  features: {
    title: { site: 'yes', read: 'yes', write: 'yes', verified: 'yes', note: '이름 1~30자' },
    description: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '상세 설명 1000자'
    },
    main_prompt: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'yes',
      note: '커스텀7000·스토리5000(상황 이미지 있으면 5000·3000)'
    },
    first_message: {
      site: 'yes',
      read: 'partial',
      write: 'yes',
      verified: 'yes',
      note: '프롤로그 1000자, 첫 메시지만 읽음'
    },
    start_scenarios: {
      site: 'yes',
      read: 'partial',
      write: 'partial',
      verified: 'partial',
      note: '스탯·엔딩·추천 답변은 개수만, 0번 삭제 불가'
    },
    lorebook: {
      site: 'yes',
      read: 'partial',
      write: 'partial',
      verified: 'yes',
      note: '노트 20자·본문 400자·키 5개, 적용 범위 안 보임'
    },
    characters: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'yes',
      note: '캐릭터 개념 없음'
    },
    example_dialogue: {
      site: 'unknown',
      read: 'partial',
      write: 'no',
      verified: 'no',
      note: '개수만 보이고 저장 때 되돌려 보냄'
    },
    user_persona: {
      site: 'unknown',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '제작 화면에서 칸을 못 찾음'
    },
    output_rules: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '전용 칸 없음, 메인에 포함'
    },
    situation_images: {
      site: 'yes',
      read: 'yes',
      write: 'blocked',
      verified: 'partial',
      note: '올리기·지우기는 사이트에서 직접'
    },
    cover: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '2:3 비율만, 5MB'
    },
    tags: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'partial',
      note: '읽기는 extras, 쓰기는 새 작품 때만(10개)'
    },
    visibility: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'partial',
      note: 'public 전환은 확인 못 함'
    },
    create_work: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '비공개로만 생성, 대표 이미지 필수'
    },
    delete_work: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '콘텐츠 번호로 삭제'
    },
    versioning_review: {
      site: 'yes',
      read: 'partial',
      write: 'no',
      verified: 'partial',
      note: '저장마다 버전+1, 공개작은 검수'
    },
    language_editions: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'yes',
      note: '언어 판본 없음'
    },
    bgm_voice: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '편집 탭에 없음'
    },
    jsx_html: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '편집 탭에 없음'
    },
    model_settings: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'partial',
      note: '읽기는 extras, 쓰기는 새 작품 options만'
    },
    comments_stats: {
      site: 'yes',
      read: 'partial',
      write: 'no',
      verified: 'partial',
      note: '댓글 닫기 여부만 extras, 통계는 안 줌'
    }
  },
  guide: {
    save: '저장은 편집기의 「수정 → 등록」과 같아서 저장할 때마다 게시본 버전이 오른다(되돌릴 수 없다). 공개 작품은 검수를 거친다.',
    manual: ['상황 이미지 올리기·지우기·순서', '2차 창작 템플릿의 메인'],
    unverified: [
      '공개작 저장과 검수 흐름',
      '손대지 않는 칸(스탯·엔딩·단축어·애드온·추천 답변)이 공개작 저장 뒤 그대로인지'
    ]
  },
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'save', 'images'],

  readAllowed: (url) =>
    // 목록: 쿼리 없음 또는 cursor 하나
    crackPlain(url, [/^\/crack-api\/stories\/me$/], (q) => {
      const keys = [...q.keys()]
      return keys.length === 0 || (keys.length === 1 && keys[0] === 'cursor' && !!q.get('cursor'))
    }) ||
    // 편집 데이터: 쿼리 없음
    crackPlain(url, [new RegExp('^/crack-api/stories/me/' + OID + '$')]) ||
    // 삭제할 콘텐츠 번호 찾기: limit=20&type=story (+cursor)
    crackPlain(url, CONTENT_ME, (q) => {
      const keys = [...q.keys()].sort().join(',')
      return (
        q.get('limit') === '20' &&
        q.get('type') === 'story' &&
        (keys === 'limit,type' || (keys === 'cursor,limit,type' && !!q.get('cursor')))
      )
    }),
  writeAllowed(method, url) {
    if (method === 'POST')
      return crackPlain(url, [
        /^\/crack-api\/stories\/v2$/,
        /^\/crack-api\/temp-stories$/,
        /^\/crack-api\/stories\/profile-image$/
      ])
    if (method === 'DELETE')
      return crackPlain(url, [
        new RegExp('^/crack-api/content/' + OID + '$'),
        new RegExp('^/crack-api/temp-stories/' + OID + '$')
      ])
    return false
  },

  async list(read: WorkFetch): Promise<WorkListItem[]> {
    const out: WorkListItem[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    // 서버가 정한 순서(커서)대로 끝까지 읽고 번호가 겹치면 처음 것만 남긴다
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = crackData(
        await crackJson(
          await read(
            CRACK_API + '/stories/me' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')
          )
        )
      )
      if (!isObj(body) || !Array.isArray(body.stories)) throw new Error('WORK_LIST_SHAPE')
      for (const w of list(body.stories)) {
        const id = text(w._id)
        if (!OID_RE.test(id) || seen.has(id) || w.status === 'deleted') continue
        seen.add(id)
        out.push({
          id,
          title: text(w.name),
          visibility: toCommon(w.visibility),
          status: strOrNull(w.status),
          updatedAt: strOrNull(w.updatedAt) ?? strOrNull(w.createdAt),
          characters: null
        })
      }
      const next = strOrNull(body.nextCursor)
      if (!next || next === cursor) break
      cursor = next
    }
    return out
  },

  readRaw: (read, id) => crackReadRaw(read, id),

  normalize(raw): WorkBody {
    const { id, story } = crackRaw(raw)
    const form = crackForm(story)
    const key = mainKey(form)
    const version = isObj(story.updateInfo) ? story.updateInfo.version : null
    const updated = strOrNull(story.updatedAt)
    const { extras, unsupported } = crackExtras(story, form)
    return {
      id,
      title: form.name,
      visibility: toCommon(form.visibility),
      status: strOrNull(story.status),
      updatedAt:
        typeof version === 'number' ? 'v' + version + (updated ? ' ' + updated : '') : updated,
      fields: {
        title: form.name,
        subtitle: form.simpleDescription,
        description: form.detailDescription,
        main: key === 'customPrompt' ? text(form.customPrompt) : form.storyDetails
      },
      lorebook: form._keywordBook.map((k) => ({
        title: k.name,
        keys: k.keywords.join(', '),
        content: k.prompt,
        mode: null,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      })),
      startScenarios: form.startingSets.map((s, i) => ({
        id: s.baseSetId ?? null,
        title: s.name,
        isDefault: i === 0,
        content: s.initialMessages[0] ?? '',
        subPrompt: '',
        dialogue: '',
        situation: s.situationPrompt,
        description: s.playGuide
      })),
      characters: [],
      extras,
      unsupported
    }
  },

  applyChanges(raw, changes) {
    const base = crackRaw(raw)
    const next = structuredClone(base) as CrackNext
    const story = next.story
    const form = crackForm(story)
    // 손대기 전 모습 (저장 때 바뀌었거나 새로 더한 항목만 검사하려고 같은 번호로 복사해 둔다)
    const original = structuredClone(form)
    const empty = (v: unknown): boolean =>
      v === undefined || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length)
    const onlyVisibility =
      changes.visibility !== undefined &&
      Object.entries(changes).every(([k, v]) => k === 'visibility' || empty(v))

    if (changes.visibility !== undefined) {
      if (!VISIBILITIES.includes(changes.visibility)) throw new Error('BAD_VISIBILITY')
      story.visibility = fromCommon(changes.visibility)
      form.visibility = story.visibility as string
    }

    // 크랙은 작품 하나 = 스토리 하나다
    if (
      changes.characters?.length ||
      changes.charactersAdd?.length ||
      changes.charactersRemove?.length
    )
      throw new Error('NO_CHARACTERS')

    let touched = false
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      if (typeof value !== 'string') throw new Error('BAD_FIELD')
      if (name === 'title') story.name = form.name = value
      else if (name === 'subtitle') story.simpleDescription = form.simpleDescription = value
      else if (name === 'description') {
        story.detailDescription = form.detailDescription = value
        form.description = value
      } else if (name === 'main') {
        if (form.promptTemplate === 'fanfic') throw new Error('NOT_SUPPORTED fanfic main')
        const key = mainKey(form)
        story[key] = value
        if (key === 'customPrompt') form.customPrompt = value
        else form.storyDetails = value
      } else throw new Error('BAD_FIELD')
      touched = true
    }

    // 로어북 = 키워드 노트 (모아 본 목록 기준 번호)
    let notes = form._keywordBook
    const notesBefore = JSON.stringify(notes)
    if (changes.lorebook) {
      const old = notes
      const all = form.startingSets.map((s) => s.id)
      // 제목(과 본문)으로 짝지어 옛 노트의 번호·적용 시작 설정을 물려준다 (짝이 없으면 새 노트: 모든 시작 설정에 적용)
      // 이름만 바꾼 노트는 새 제목이 옛 노트 어디에도 없고 본문이 같은 옛 노트로 짝짓는다 (엉뚱한 자리의 적용 범위를 물려받지 않게)
      const oldNames = new Set(old.map((k) => k.name))
      const newTitles = new Set(changes.lorebook.map((e) => e.title ?? ''))
      const claimed = new Set<number>()
      const titles = changes.lorebook.map((e) => {
        const title = e.title ?? ''
        if (oldNames.has(title) || !e.content) return title
        const j = old.findIndex(
          (k, n) => !claimed.has(n) && !newTitles.has(k.name) && k.prompt === e.content
        )
        if (j < 0) return title
        claimed.add(j)
        return old[j].name
      })
      const paired = matchOld(titles, old, (k) => k.name, {
        contents: changes.lorebook.map((e) => e.content),
        contentOf: (k) => k.prompt
      })
      notes = changes.lorebook.map((e, i) => noteFrom(e, paired[i], all))
    }
    for (const patch of changes.lorebookPatch ?? []) {
      const i = at(patch.index, notes.length)
      notes[i] = noteFrom(patch, notes[i], [])
    }
    if (changes.lorebookRemove?.length) {
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, notes.length)))
      notes = notes.filter((_, i) => !gone.has(i))
    }
    for (const entry of changes.lorebookAdd ?? []) {
      form._keywordBook = notes
      const sets = openSets(form)
      if (!sets.length) throw new Error('LOREBOOK_LIMIT 시작 설정마다 20개')
      notes.push(noteFrom(entry, undefined, sets))
    }
    form._keywordBook = notes
    if (JSON.stringify(notes) !== notesBefore) touched = true

    // 시작 상황 = 시작 설정 (0번이 기본 설정)
    let sets: FormStartingSet[] = form.startingSets
    const setsBefore = JSON.stringify(sets)
    for (const patch of changes.startScenarios ?? []) {
      const i = at(patch.index, sets.length)
      noStartExtras(patch)
      const s = { ...sets[i] }
      if (patch.title !== undefined) s.name = patch.title
      // 첫 메시지만 바꾸고 두 번째 이후 프롤로그는 원본 그대로 둔다 (읽기에 안 보이는 값이 저장으로 지워지지 않게)
      if (patch.content !== undefined && patch.content !== (s.initialMessages[0] ?? ''))
        s.initialMessages = [patch.content, ...s.initialMessages.slice(1)]
      if (patch.situation !== undefined) s.situationPrompt = patch.situation
      if (patch.description !== undefined) s.playGuide = patch.description
      sets[i] = s
    }
    if (changes.startScenariosRemove?.length) {
      const gone = new Set(changes.startScenariosRemove.map((i) => at(i, sets.length)))
      if (gone.has(0)) throw new Error('KEEP_DEFAULT')
      const removed = sets.filter((_, i) => gone.has(i)).map((s) => s.id)
      sets = sets.filter((_, i) => !gone.has(i))
      // 편집기 cleanupRelatedData: 지운 시작 설정을 키워드 노트·상황 이미지의 적용 대상에서 뺀다
      // (적용 대상이 없어진 노트는 저장 모양에 실리지 않아 사라진다)
      form._keywordBook = form._keywordBook
        .map((k) => ({ ...k, startingSetId: k.startingSetId.filter((x) => !removed.includes(x)) }))
        .filter((k) => k.startingSetId.length)
    }
    for (const draft of changes.startScenariosAdd ?? []) {
      noStartExtras(draft)
      sets.push(newSet(draft))
    }
    form.startingSets = sets
    if (JSON.stringify(sets) !== setsBefore) touched = true

    if (touched) {
      // 저장 본문(crackPatchBody)을 지을 수 없는 원본이면 계획 단계에서 멈춘다 (계획이 소비된 뒤에 걸리지 않게)
      crackShapeCheck(story)
      checkForm(form, original)
      story.startingSets = setsFromForm(story, form)
    }
    if (changes.visibility !== undefined && onlyVisibility) next.visibilityOnly = true
    return next
  },

  async save(write, id, next, io?: WorkIo) {
    const r = crackRaw(next) as CrackNext
    const wid = crackWorkId(id)
    if (!io?.send) throw new Error('SAVE_NEEDS_SEND')
    const story = r.story
    // 공개 상태만 바꿀 때는 편집기 내 작품 메뉴(「공개로 변경」 등)와 같은 짧은 본문을 보낸다
    const body = r.visibilityOnly
      ? {
          visibility: story.visibility,
          publishDeclaration: publishDeclaration(
            text(story.visibility),
            hasSituationImages(crackForm(story)),
            story.publishDeclaration
          )
        }
      : crackPatchBody(story)
    const res = await io.send({
      method: 'PATCH',
      url: CRACK_API + '/stories/' + wid + '/v2',
      json: body
    })
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    const reply: unknown = await res.json().catch(() => null)
    // 다른 곳(사이트 편집기)에서 먼저 등록돼 기준 판이 달라졌다
    if (res.status === 422 && isObj(reply) && reply.code === 'STALE_BASE_SNAPSHOT')
      throw new Error('PLAN_STALE')
    if (!res.ok) throw new Error('SAVE_FAILED ' + res.status + ' ' + crackError(reply))
    void write
  },

  visibilities: VISIBILITIES,

  /** 내 작품 관리 목록에서 이 스토리의 콘텐츠 번호를 찾아 지운다 (편집기 「삭제하기」) */
  async remove(write, id, io?: WorkIo) {
    const wid = crackWorkId(id)
    if (!io?.read) throw new Error('REMOVE_NEEDS_READ')
    let cursor: string | null = null
    let contentId: string | null = null
    for (let page = 0; page < MAX_PAGES && !contentId; page++) {
      const body = crackData(
        await crackJson(
          await io.read(
            CRACK_API +
              '/content/me?limit=20&type=story' +
              (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
          )
        )
      )
      if (!isObj(body) || !Array.isArray(body.contents)) throw new Error('WORK_LIST_SHAPE')
      const hit = list(body.contents).find((c) => c.sourceId === wid && c.type === 'story')
      if (hit) contentId = text(hit._id)
      const next = strOrNull(body.nextCursor)
      if (!next || next === cursor || !list(body.contents).length) break
      cursor = next
    }
    if (!contentId) throw new Error('WORK_NOT_FOUND')
    if (!OID_RE.test(contentId)) throw new Error('WORK_LIST_SHAPE content _id')
    const res = await write('DELETE', CRACK_API + '/content/' + contentId)
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    if (!res.ok) throw new Error('DELETE_FAILED ' + res.status)
  },

  async create(write: WorkWrite, draft: WorkDraft): Promise<string> {
    const form = crackDraftForm(draft)
    // 내 작품 「만들기」: 번호를 먼저 받고 그 번호로 등록한다
    const made = await write('POST', CRACK_API + '/temp-stories')
    if (made.status === 401 || made.status === 403) throw new Error('LOGIN_REQUIRED')
    const got: unknown = await made.json().catch(() => null)
    if (!made.ok) throw new Error('CREATE_FAILED ' + made.status + ' ' + crackError(got))
    const storyId = isObj(got) ? text(got.data) : ''
    if (!OID_RE.test(storyId))
      throw new Error(
        'CREATE_FAILED temp-stories ' +
          (isObj(got) ? Object.keys(got).slice(0, 6).join(',') : typeof got)
      )
    const res = await write('POST', CRACK_API + '/stories/v2', crackCreateBody(form, storyId))
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      // 받은 번호(미등록 작품)는 지워 둔다. 지우기 실패는 등록 실패를 가리지 않는다
      await write('DELETE', CRACK_API + '/temp-stories/' + storyId).catch(() => undefined)
      if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
      throw new Error('CREATE_FAILED ' + res.status + ' ' + crackError(reply))
    }
    const data = isObj(reply) && isObj(reply.data) ? reply.data : {}
    const id = text(data._id)
    return OID_RE.test(id) ? id : storyId
  },

  checkDraft(draft) {
    crackDraftForm({ ...draft, coverUrl: draft.coverUrl ?? PLACEHOLDER_COVER })
  },

  sendRule: crackSendRule,
  imageRules: CRACK_IMAGE_RULES,
  imageGroups: crackImageGroups,
  planImages: crackPlanImages,
  applyImages: crackApplyImages,
  uploadImage: crackUploadImage,
  coverRules: CRACK_IMAGE_RULES,
  coverUrl: (raw) => strOrNull(crackForm(crackRaw(raw).story).portraitImageUrl),
  uploadCover: crackUploadCover
}

// ───────────── 새 작품 ─────────────

const PLACEHOLDER_COVER = 'https://placeholder.invalid/cover'

function newSet(draft: StartScenarioDraft): FormStartingSet {
  return {
    id: nanoid(),
    name: draft.title ?? '',
    initialMessages: draft.content !== undefined ? [draft.content] : [],
    playGuide: draft.description ?? '',
    situationPrompt: draft.situation ?? '',
    replySuggestions: [],
    ending: { endings: [] },
    imageMatrix: { categories: [], situations: [] }
  }
}

const OPTION_KEYS = ['genre_id', 'target', 'chat_type', 'chat_model_id', 'default_cracker_model']
/**
 * 새 작품 폼 (항상 비공개). 편집기 새 폼 기본값에 내용을 얹고 입력 규칙을 먼저 확인한다.
 * options(필수): genre_id, target, chat_type, chat_model_id, default_cracker_model — 기존 작품 원본(스냅샷)의
 *   genreId·target·chatType·chatModelId·defaultCrackerModel 값을 그대로 쓴다 (목록을 읽는 도구가 없다).
 * options(선택): prompt_template (custom 기본 → main이 커스텀 프롬프트 / default → 스토리 설정)
 */
export function crackDraftForm(draft: WorkDraft): CrackForm {
  const o = draft.options ?? {}
  const bad = (what: string): never => {
    throw new Error('BAD_DRAFT ' + what)
  }
  if (draft.characters.length) throw new Error('NO_CHARACTERS')
  if (!draft.coverUrl) throw new Error('COVER_REQUIRED')
  for (const key of OPTION_KEYS)
    if (o[key] === undefined || o[key] === null || o[key] === '') bad('options.' + key)
  const template = o.prompt_template ?? 'custom'
  if (template !== 'custom' && template !== 'default') bad('options.prompt_template custom/default')
  const tags = draft.hashtags ?? []
  if (tags.length > LIMITS.tags || tags.some((t) => !t.trim())) bad('hashtags 10개 이하')
  if (draft.categories?.length) bad('categories (크랙은 options.genre_id 하나)')
  const starts = draft.startScenarios ?? []
  if (!starts.length) bad('start_scenarios 1개 이상')
  const sets = starts.map((s, i) => {
    noStartExtras(s)
    const set = newSet(s)
    // 첫 시작 설정은 편집기 기본 이름
    if (i === 0 && !set.name) set.name = '기본 설정'
    return set
  })
  const all = sets.map((s) => s.id)
  const form: CrackForm = {
    portraitImageUrl: draft.coverUrl,
    name: draft.title,
    description: draft.description ?? '',
    detailDescription: draft.description ?? '',
    simpleDescription: draft.subtitle ?? '',
    promptTemplate: template as string,
    storyDetails: template === 'default' ? draft.main : '',
    customPrompt: template === 'custom' ? draft.main : undefined,
    chatExamples: [{ user: '', character: '' }],
    startingSets: sets,
    _situationImages: [],
    _keywordBook: (draft.lorebook ?? []).map((e) => noteFrom(e, undefined, all)),
    shortcutCommands: [],
    visibility: 'private',
    isAdult: draft.adult,
    genreId: o.genre_id,
    target: o.target,
    chatType: o.chat_type,
    defaultCrackerModel: o.default_cracker_model,
    chatModelId: o.chat_model_id,
    tags,
    isCommentBlocked: false,
    originContentTitle: undefined,
    fanficAgreement: undefined,
    creatorRecommendedMaxOutput: {
      type: 'TOTAL',
      totalMultiplier: 'default',
      modelMultipliers: []
    },
    addonCategories: undefined,
    fanfic: undefined,
    isMovingPortraitImage: /\.gif(\?.*)?$/i.test(draft.coverUrl),
    situationImageVersion: 'v2'
  }
  checkForm(form)
  return form
}
