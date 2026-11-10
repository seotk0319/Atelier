// 알플레이 캔버스 JSON 내보내기·가져오기. 2026-11-10 rplay.live 공개 스크립트에서 읽었다 (실제 호출 전).
// 근거 파일 (scratchpad workerC/rplay/rp):
//   js/DNLa6r8FjI.js  exportChatCompositionCanvas(e){return v.get(C+"/chat-canvas/export",{params:{canvasOid:e}})}
//                     importChatCompositionCanvas(e,t){return v.post(C+"/chat-canvas/import",{canvasOid:e,debugLog:t.debugLog||!1,
//                       languageMismatchAction:t.languageMismatchAction||void 0,settingsChoice:t.settingsChoice||void 0,
//                       settingsBase:t.settingsBase,sourceHash:t.sourceHash})}
//                     getUploadUrl(e,t){… _e.get(de,{params:{key,filetype,filename,numParts,access,context:t}})}  de="https://api.rplay.live/upload"
//                     upload(e,t,r){… nt.put(e,t,{headers:{"Content-Type":r},withCredentials:!1})}  (nt는 "platform-type" 헤더를 붙인다)
//                     subscribeToImportProgress: SSE C+"/import-progress/{canvasOid}", 끊기면 v.get(C+"/chat-canvas",{params:{canvasOid,includeMetadata:!1}})의 canvas.isImporting
//   js/DYgrp5b9Hb.js  캔버스 편집기 가져오기: 파일 글 i → c=prepareCanvasImport(JSON.parse(i).canvas?.canvasLanguage)
//                     → es(i)(SHA-256 16진수) → getUploadUrl({key:`story-chat/canvas-import/${대상 캔버스}.json`,filetype:"application/json",
//                       access:"private"},{uploadType:"story-chat",contentOid:작품}) → upload(주소, Blob([i]), "application/json")
//                     → importChatCompositionCanvas(대상 캔버스, {languageMismatchAction, sourceHash}) → 409 IMPORT_SETTINGS_CHOICE_REQUIRED면
//                       {settingsChoice:"imported"|"current", settingsBase: 응답 currentSettings}로 다시 → 응답 {isImporting:true, importRunId}
//                     내보내기: data를 JSON.stringify(data,null,2)로 `canvas-export-${캔버스}-${Date.now()}.json`에 저장
//   js/C4epbjDN3r.js  prepareCanvasImport: 파일 언어 = 지금 캔버스 언어면 그 캔버스, 다르면 "지금 캔버스 언어로"(use-target-language) 또는 파일 언어 캔버스
//   js/BAM_1RmlcH.js  안내 글: "This will replace the entire canvas with the imported data. This action cannot be undone."
//                     "Importing a canvas deletes the previous compiled data, so you must recompile …"
// 진행 구독(SSE)은 쓰지 않는다. 대신 편집기가 구독이 끊겼을 때 쓰는 상태 확인(canvas.isImporting)을 몇 초마다 본다.
// 주소는 코드에서 확인한 것이지만, 이것만으로 끝을 판단하는 방식과 간격은 이쪽이 정한 것이다 (추정).
// 실패 단계(failedSteps·warnings)는 SSE로만 오므로 받지 못한다. 대신 끝난 뒤 다시 내보내 파일과 견준다.
import { createHash } from 'node:crypto'
import {
  CANVAS_IMPORT_KEY_RE,
  RPLAY_API,
  RPLAY_CHAT,
  RPLAY_CHAT_ORIGIN,
  accountBody,
  accountParams,
  contentUrl,
  isObj,
  list,
  needAccount,
  oidOf,
  rplayAccount,
  rplayJson,
  rplayWorkId,
  shapeError,
  text,
  withQuery,
  type Obj,
  type RplayAccount
} from './rplay-core'
import type {
  CanvasCheck,
  CanvasCompareOptions,
  CanvasExport,
  CanvasFile,
  CanvasImportOptions,
  SendRule,
  WorkFetch,
  WorkIo
} from './types'

/** 이 연결부가 아는 내보내기 파일 판 (사람 메모·실제 내보내기 파일 모두 2) */
export const CANVAS_EXPORT_VERSION = 2

/** 기다리는 간격·한도. 편집기는 진행 소식이 10분 없으면 "확인 못 함"으로 본다 (테스트가 바꾼다) */
export const canvasTiming = {
  interval: 3000,
  limit: 10 * 60_000,
  sleep: (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
}

// ───────────── 업로드 주소 ─────────────

// 가져오기 파일을 올릴 저장소 주소는 API가 그때그때 내준다(서명된 주소, 호스트는 코드에 없다).
// 그래서 이 연결부가 로그인한 API 응답으로 받은 주소만 30분 동안 PUT 하나로 허용하고, 로그인 정보는 붙이지 않는다
// (우마이 업로드와 같은 방식).
const issued = new Map<string, number>()
function sweep(): void {
  const now = Date.now()
  for (const [url, expires] of issued) if (expires < now) issued.delete(url)
}
export function rplaySendRule(method: string, url: string): SendRule | null {
  if (method !== 'PUT') return null
  sweep()
  // 편집기 upload()는 Content-Type과 nt가 붙이는 platform-type만 보낸다
  if (issued.has(url))
    return { auth: 'none', body: 'bytes', headers: ['content-type', 'platform-type'] }
  return null
}

async function uploadUrl(
  read: WorkFetch,
  a: RplayAccount,
  workId: string,
  canvasOid: string
): Promise<string> {
  const key = 'story-chat/canvas-import/' + canvasOid + '.json'
  if (!CANVAS_IMPORT_KEY_RE.test(key)) throw new Error('BAD_WORK_ID')
  const res = await read(
    withQuery(RPLAY_API + '/upload', [
      ['key', key],
      ['filetype', 'application/json'],
      ['access', 'private'],
      ['context', JSON.stringify({ uploadType: 'story-chat', contentOid: workId })],
      ...accountParams(a)
    ])
  )
  // 실패 응답은 읽기와 같은 규칙으로 던진다
  if (!res.ok) await rplayJson(res)
  const body = await res.text()
  // 편집기는 응답 data를 그대로 주소로 쓴다 (axios가 JSON 글이면 풀어 준다)
  let value: unknown = body.trim()
  try {
    value = JSON.parse(body)
  } catch {
    value = body.trim()
  }
  let target: URL | null = null
  try {
    target = typeof value === 'string' ? new URL(value) : null
  } catch {
    target = null
  }
  if (
    !target ||
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.hash ||
    // 플랫폼 API로 로그인 없이 PUT을 보내는 일은 없다
    target.origin === RPLAY_API ||
    target.origin === RPLAY_CHAT_ORIGIN
  )
    throw new Error(
      'CANVAS_UPLOAD_FAILED url ' + (typeof value === 'string' ? 'string' : typeof value)
    )
  issued.set(target.href, Date.now() + 30 * 60_000)
  return target.href
}

// ───────────── 내보내기 ─────────────

/** 매번 바뀌는 내보낸 시각을 뺀 모습 (계획 뒤 바뀌었는지 견줄 때) */
const stampOf = (data: Obj): string => canonical({ ...data, exportedAt: null })

async function canvasOidOf(read: WorkFetch, wid: string, a: RplayAccount | null): Promise<string> {
  const content = await rplayJson(await read(contentUrl(wid, a)))
  if (!isObj(content)) throw shapeError('WORK_SHAPE', content)
  if (content.deleted === true) throw new Error('WORK_NOT_FOUND')
  const canvasOid = oidOf(content.canvasOid)
  if (!canvasOid) throw shapeError('WORK_SHAPE canvasOid', content)
  return canvasOid
}

/** 편집기 "캔버스 내보내기": 작품의 기본 캔버스(preferMainCanvas)를 내보낸다 */
export async function rplayExportCanvas(read: WorkFetch, id: string): Promise<CanvasExport> {
  const wid = rplayWorkId(id)
  const a = await rplayAccount(read)
  const canvasOid = await canvasOidOf(read, wid, a)
  const data = await rplayJson(
    await read(
      withQuery(RPLAY_CHAT + '/chat-canvas/export', [['canvasOid', canvasOid], ...accountParams(a)])
    )
  )
  if (!isObj(data) || !Array.isArray(data.nodes)) throw shapeError('CANVAS_SHAPE', data)
  return { canvasId: canvasOid, data, stamp: stampOf(data) }
}

// ───────────── 규격 검사 ─────────────

const PROBLEMS_MAX = 30
const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

/** 내보내기 파일 모양으로 본다. 사람 메모(rplay.md 「캔버스 JSON」)와 실제 내보내기 파일의 키 */
export function rplayCheckCanvas(data: unknown): CanvasCheck {
  const problems: string[] = []
  const add = (p: string): void => {
    if (problems.length < PROBLEMS_MAX) problems.push(p)
  }
  const d: Obj = isObj(data) ? data : {}
  if (!isObj(data)) add('JSON 맨 위가 객체가 아님')
  const canvas = isObj(d.canvas) ? d.canvas : null
  const nodes = Array.isArray(d.nodes) ? d.nodes : null
  const connections = Array.isArray(d.connections) ? d.connections : null
  const meta = isObj(d.metadataSet) ? d.metadataSet : null
  const version = typeof d.exportVersion === 'number' ? d.exportVersion : null
  const language =
    canvas && typeof canvas.canvasLanguage === 'string' ? canvas.canvasLanguage.trim() : ''
  const story = isObj(d.storyChat) ? d.storyChat : null
  const settings = story && isObj(story.advancedSettings) ? story.advancedSettings : null

  if (isObj(data)) {
    if (version !== CANVAS_EXPORT_VERSION)
      add('exportVersion ' + String(d.exportVersion) + ' (아는 판은 ' + CANVAS_EXPORT_VERSION + ')')
    if (!canvas) add('canvas 없음')
    // 편집기는 파일에 캔버스 언어가 없으면 가져오지 않는다 (import-language-required)
    else if (!language) add('canvas.canvasLanguage 없음')
    if (!nodes) add('nodes 배열 없음')
    if (!connections) add('connections 배열 없음')
    if (!meta) add('metadataSet 객체 없음')
    if (d.annotations !== undefined && !Array.isArray(d.annotations))
      add('annotations가 배열이 아님')
    if (d.storyChat !== undefined && !story) add('storyChat이 객체가 아님')
  }

  const types: Record<string, number> = {}
  const typeOf = new Map<string, string>()
  for (const [i, n] of (nodes ?? []).entries()) {
    const where = 'nodes[' + i + ']'
    if (!isObj(n)) {
      add(where + ' 객체가 아님')
      continue
    }
    const uid = text(n.uid)
    if (!uid) add(where + '.uid 없음')
    else if (typeOf.has(uid)) add(where + '.uid 겹침 ' + uid)
    const type = text(n.type)
    if (!type) add(where + '.type 없음')
    if (typeof n.hash !== 'string' || !n.hash) add(where + '.hash 없음')
    if (typeof n.name !== 'string') add(where + '.name 없음')
    if (!isObj(n.coordinates) || !num(n.coordinates.x) || !num(n.coordinates.y))
      add(where + '.coordinates {x,y} 숫자 아님')
    if (uid && !typeOf.has(uid)) typeOf.set(uid, type)
    if (type) types[type] = (types[type] ?? 0) + 1
  }

  if (meta) {
    for (const [key, m] of Object.entries(meta)) {
      const where = 'metadataSet[' + key + ']'
      if (!typeOf.has(key)) {
        add(where + ' 맞는 노드 uid 없음')
        continue
      }
      if (!isObj(m)) {
        add(where + ' 객체가 아님')
        continue
      }
      if (text(m.type) !== typeOf.get(key)) add(where + '.type이 노드 type과 다름')
      if (m.nodeUid !== undefined && m.nodeUid !== key) add(where + '.nodeUid가 키와 다름')
    }
    for (const uid of typeOf.keys())
      if (!(uid in meta)) add('nodes uid ' + uid + ' 의 metadataSet 없음')
  }

  const seen = new Set<string>()
  for (const [i, c] of (connections ?? []).entries()) {
    const where = 'connections[' + i + ']'
    if (!isObj(c)) {
      add(where + ' 객체가 아님')
      continue
    }
    const uid = text(c.uid)
    if (!uid) add(where + '.uid 없음')
    else if (seen.has(uid)) add(where + '.uid 겹침 ' + uid)
    seen.add(uid)
    if (!typeOf.has(text(c.sourceNodeId))) add(where + '.sourceNodeId 노드 없음')
    if (!typeOf.has(text(c.targetNodeId))) add(where + '.targetNodeId 노드 없음')
  }

  return {
    summary: {
      version,
      language: language || null,
      nodes: nodes?.length ?? 0,
      nodeTypes: types,
      connections: connections?.length ?? 0,
      metadata: meta ? Object.keys(meta).length : 0,
      annotations: Array.isArray(d.annotations) ? d.annotations.length : 0,
      sourceWorkId: oidOf(d.sourceContentOid) || null,
      sourceCanvasId: oidOf(d.sourceCanvasOid) || null,
      settings,
      nodeIds: [...typeOf.keys()]
    },
    problems
  }
}

// ───────────── 대조 ─────────────

/** 키 순서와 상관없이 같은 값이면 같은 글 */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (isObj(v))
    return (
      '{' +
      Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(v) ?? 'null'
}

// 서버가 붙이거나 다시 매기는 값 (사람 메모: 가져온 뒤 createdAt·updatedAt·textTokenCount가 붙는다.
// _id·tokenCount·version·__v는 내보내기 파일과 저장 응답에서 서버가 관리하는 칸)
const VOLATILE = new Set(['createdAt', 'updatedAt', '_id', '__v', 'version', 'tokenCount'])
const volatile = (key: string): boolean => VOLATILE.has(key) || key.endsWith('TokenCount')
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip)
  if (isObj(v))
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !volatile(k))
        .map(([k, x]) => [k, strip(x)])
    )
  return v
}
const MISMATCH_MAX = 200

/** 넣은 파일(expected)과 다시 내보낸 JSON(actual)의 노드·연결·metadata·공통 설정을 견준다 */
export function rplayCompareCanvas(
  expected: unknown,
  actual: unknown,
  options: CanvasCompareOptions = {}
): string[] {
  const out: string[] = []
  const add = (s: string): void => {
    if (out.length < MISMATCH_MAX) out.push(s)
  }
  const e: Obj = isObj(expected) ? expected : {}
  const a: Obj = isObj(actual) ? actual : {}

  // 노드: uid로 짝짓는다
  const byUid = (v: unknown): Map<string, Obj> =>
    new Map(list(v).map((n) => [text(n.uid), n] as [string, Obj]))
  const en = byUid(e.nodes)
  const an = byUid(a.nodes)
  for (const [uid, n] of en) {
    const got = an.get(uid)
    if (!got) {
      add('nodes ' + uid + ' 없음')
      continue
    }
    for (const k of new Set([...Object.keys(n), ...Object.keys(got)]))
      if (!volatile(k) && canonical(strip(n[k])) !== canonical(strip(got[k])))
        add('nodes ' + uid + ' .' + k)
  }
  for (const uid of an.keys()) if (!en.has(uid)) add('nodes ' + uid + ' 더 있음')

  // 연결: 번호(uid)는 빼고 양 끝·포트가 같은 것끼리 개수로 견준다
  const sig = (c: Obj): string => canonical(strip({ ...c, uid: undefined }))
  const count = (v: unknown): Map<string, number> => {
    const m = new Map<string, number>()
    for (const c of list(v)) m.set(sig(c), (m.get(sig(c)) ?? 0) + 1)
    return m
  }
  const ec = count(e.connections)
  const ac = count(a.connections)
  let onlyFile = 0
  let onlySite = 0
  for (const [k, n] of ec) onlyFile += Math.max(0, n - (ac.get(k) ?? 0))
  for (const [k, n] of ac) onlySite += Math.max(0, n - (ec.get(k) ?? 0))
  if (onlyFile) add('connections 파일에만 ' + onlyFile + '개')
  if (onlySite) add('connections 플랫폼에만 ' + onlySite + '개')

  // 노드 내용: metadataSet 키(= 노드 uid)로 짝짓고 칸마다 견준다
  const em = isObj(e.metadataSet) ? e.metadataSet : {}
  const am = isObj(a.metadataSet) ? a.metadataSet : {}
  for (const [uid, m] of Object.entries(em)) {
    const got = am[uid]
    if (!isObj(got) || !isObj(m)) {
      add('metadataSet ' + uid + ' 없음')
      continue
    }
    for (const k of new Set([...Object.keys(m), ...Object.keys(got)]))
      if (!volatile(k) && canonical(strip(m[k])) !== canonical(strip(got[k])))
        add('metadataSet ' + uid + ' .' + k)
  }
  for (const uid of Object.keys(am)) if (!(uid in em)) add('metadataSet ' + uid + ' 더 있음')

  // 캔버스 언어·공통 설정·메모
  const ecv = isObj(e.canvas) ? e.canvas : {}
  const acv = isObj(a.canvas) ? a.canvas : {}
  if (!options.keepCurrentLanguage && text(ecv.canvasLanguage) !== text(acv.canvasLanguage))
    add('canvas.canvasLanguage')
  if (!options.keepCurrentSettings) {
    const es =
      isObj(e.storyChat) && isObj(e.storyChat.advancedSettings)
        ? e.storyChat.advancedSettings
        : null
    const as =
      isObj(a.storyChat) && isObj(a.storyChat.advancedSettings) ? a.storyChat.advancedSettings : {}
    if (es)
      for (const k of Object.keys(es))
        if (canonical(es[k]) !== canonical(as[k])) add('storyChat.advancedSettings.' + k)
  }
  if (canonical(strip(list(e.annotations))) !== canonical(strip(list(a.annotations))))
    add('annotations')
  return out
}

// ───────────── 가져오기 ─────────────

async function canvasState(read: WorkFetch, canvasOid: string, a: RplayAccount): Promise<Obj> {
  const got = await rplayJson(
    await read(
      withQuery(RPLAY_CHAT + '/chat-canvas', [
        ['canvasOid', canvasOid],
        ['includeMetadata', 'false'],
        ...accountParams(a)
      ])
    )
  )
  if (!isObj(got) || !isObj(got.canvas)) throw shapeError('CANVAS_SHAPE', got)
  return got.canvas
}

async function replyOf(res: Response): Promise<Obj> {
  const raw = await res.text().catch(() => '')
  try {
    const j: unknown = JSON.parse(raw)
    return isObj(j) ? j : {}
  } catch {
    return {}
  }
}
const codeOf = (j: Obj): string =>
  (text(j.error) || text(j.code)).replace(/[^A-Za-z0-9_. -]/g, '').slice(0, 60)

/** 가져오기가 끝날 때까지 상태를 본다. 끝나면 true, 한도를 넘기면 false */
async function waitImport(read: WorkFetch, canvasOid: string, a: RplayAccount): Promise<boolean> {
  const until = Date.now() + canvasTiming.limit
  for (;;) {
    const c = await canvasState(read, canvasOid, a)
    if (c.isImporting !== true) return true
    if (Date.now() >= until) return false
    await canvasTiming.sleep(canvasTiming.interval)
  }
}

/**
 * 편집기 가져오기와 같은 순서: 업로드 주소 받기 → 파일 올리기(PUT) → 가져오기 요청 → 끝날 때까지 상태 확인.
 * 가져오기는 캔버스 전체를 이 파일로 바꾸고 컴파일된 데이터를 지운다 (편집기 안내 글). 다시 컴파일은 하지 않는다.
 */
export async function rplayImportCanvas(
  io: WorkIo,
  id: string,
  file: CanvasFile,
  options: CanvasImportOptions
): Promise<{ runId: string | null }> {
  const wid = rplayWorkId(id)
  const a = await needAccount(io.read, io.write, io.send)
  let parsed: unknown
  try {
    parsed = JSON.parse(file.text)
  } catch {
    throw new Error('BAD_CANVAS_FILE JSON 아님')
  }
  const check = rplayCheckCanvas(parsed)
  if (check.problems.length) throw new Error('BAD_CANVAS_FILE ' + check.problems[0])

  // 대상 캔버스가 계획 때 그 캔버스인지, 다른 작업(가져오기·컴파일)이 돌고 있지 않은지
  const canvasOid = await canvasOidOf(io.read, wid, a)
  if (canvasOid !== options.canvasId) throw new Error('PLAN_STALE canvas')
  const now = await canvasState(io.read, canvasOid, a)
  if (now.isImporting === true || now.isCompiling === true) throw new Error('CANVAS_BUSY')

  // 파일 언어가 지금 캔버스 언어와 같으면 비워 보내고, 다르면 "지금 캔버스 언어로"만 받는다
  // (파일 언어의 다른 캔버스를 새로 만드는 쪽은 열지 않았다)
  const fileLanguage = (check.summary.language ?? '').toLowerCase()
  const current = text(now.canvasLanguage).toLowerCase()
  let languageMismatchAction: string | undefined
  if (current && fileLanguage !== current) {
    if (!options.useCurrentLanguage)
      throw new Error('IMPORT_LANGUAGE_MISMATCH ' + fileLanguage + '→' + current)
    languageMismatchAction = 'use-target-language'
  }

  // 편집기 es(i): 올리는 글 그대로의 SHA-256 16진수. 서버는 이 값으로 올린 파일이 바뀌지 않았는지 본다
  const sourceHash = createHash('sha256').update(file.data).digest('hex')
  const target = await uploadUrl(io.read, a, wid, canvasOid)
  const put = await io.send({
    method: 'PUT',
    url: target,
    bytes: { data: file.data, contentType: 'application/json' },
    // 서명된 주소가 Content-Type까지 서명했을 수 있어 편집기처럼 글자 그대로 붙인다
    headers: { 'content-type': 'application/json', 'platform-type': 'rplay' }
  })
  if (!put.ok) throw new Error('CANVAS_UPLOAD_FAILED ' + put.status)

  let body: Obj = {
    canvasOid,
    debugLog: false,
    ...(languageMismatchAction ? { languageMismatchAction } : {}),
    sourceHash,
    ...accountBody(a)
  }
  let asked = false
  for (;;) {
    let res: Response | null = null
    try {
      res = await io.write('POST', RPLAY_CHAT + '/chat-canvas/import', body)
    } catch (error) {
      // 허용 검사·로그인 문제는 요청 전에 난 것이라 그대로 던진다
      if (error instanceof Error && /UNAPPROVED|LOGIN_REQUIRED/.test(error.message)) throw error
      res = null
    }
    if (res && res.ok) {
      const reply = await replyOf(res)
      if (reply.isImporting !== true) throw new Error('IMPORT_FAILED ack')
      if (!(await waitImport(io.read, canvasOid, a))) throw new Error('IMPORT_TIMEOUT')
      return { runId: text(reply.importRunId) || null }
    }
    const reply = res ? await replyOf(res) : {}
    const code = codeOf(reply)
    if (res?.status === 401 || /jwt expired/i.test(code)) throw new Error('LOGIN_REQUIRED')
    if (res?.status === 409 && code === 'IMPORT_SETTINGS_CHOICE_REQUIRED') {
      // 공통 설정이 다르면 고른 쪽과 서버가 준 지금 설정을 붙여 한 번만 다시 보낸다
      const keys = Array.isArray(reply.changedKeys)
        ? reply.changedKeys.filter((k): k is string => typeof k === 'string').slice(0, 12)
        : []
      if (!options.settingsChoice || asked)
        throw new Error('IMPORT_SETTINGS_CHOICE_REQUIRED ' + keys.join(','))
      asked = true
      body = {
        ...body,
        settingsChoice: options.settingsChoice,
        settingsBase: reply.currentSettings
      }
      continue
    }
    if (code === 'IMPORT_FILE_CHANGED') throw new Error('IMPORT_FILE_CHANGED')
    if (code === 'CANVAS_MUTATION_UNAVAILABLE') throw new Error('CANVAS_BUSY ' + code)
    // 응답이 없거나 5xx면 편집기처럼 가져오기가 시작됐는지 상태로 확인한다
    if (!res || res.status >= 500) {
      const c = await canvasState(io.read, canvasOid, a).catch(() => null)
      if (c?.isImporting === true) {
        if (!(await waitImport(io.read, canvasOid, a))) throw new Error('IMPORT_TIMEOUT')
        return { runId: null }
      }
      throw new Error('IMPORT_UNCONFIRMED ' + (res ? res.status + ' ' + code : 'no response'))
    }
    if (res.status === 403) throw new Error('FORBIDDEN ' + code)
    throw new Error('IMPORT_FAILED ' + res.status + ' ' + code)
  }
}
