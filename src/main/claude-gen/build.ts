import type { CharRefType, ExtraCharRef, GenerationRequest } from '../../shared/types'
import { joinPromptSections } from '../../shared/char-sections'
import { NAI_MODEL_V45_FULL } from '../../shared/nai-models'

/**
 * 클로 생성 창구(로컬 주소)에서 받은 한 건. 씬 하나에 대응한다.
 * prompt는 씬 프롬프트 칸에 들어가는 글 그대로다 (주석·charN 구간 포함).
 */
export interface ClaudeGenJob {
  name: string
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  count?: number
  model?: string
  /** 이 건에만 싣는 캐릭터 레퍼런스. 화면에서 켜 둔 레퍼는 여전히 싣지 않는다. */
  charRefs?: ClaudeGenCharRef[]
}

/** 창구로 받는 레퍼런스 한 장. filePath는 이 PC의 절대 경로(png·webp·jpg). */
export interface ClaudeGenCharRef {
  filePath: string
  refType: CharRefType
  strength: number
}

/** 화면의 DEFAULT_REQUEST와 같은 값. main_params가 비었거나 깨졌을 때만 쓴다. */
const DEFAULT_PARAMS: GenerationRequest = {
  prompt: '',
  negativePrompt: '',
  model: NAI_MODEL_V45_FULL,
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: -1,
  variety: false,
  qualityToggle: true,
  transparentBackground: false,
  ucPreset: 0,
  characterPrompts: [],
  useCoords: false
}

export function parseMainParams(raw: string | null | undefined): GenerationRequest {
  if (!raw) return { ...DEFAULT_PARAMS }
  try {
    const parsed = JSON.parse(raw) as Partial<GenerationRequest>
    return { ...DEFAULT_PARAMS, ...parsed }
  } catch {
    return { ...DEFAULT_PARAMS }
  }
}

function mergeParts(parts: { base: string; additional: string; detail: string }): string {
  return [parts.base, parts.additional, parts.detail].filter((p) => p.trim()).join(', ')
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 4294967295)
}

/**
 * 메인 파라미터(네거티브, 샘플러·스텝 등)를 쓰되, 프롬프트는 고정 칸(작가·품질)만 가져오고 받은 글을 붙인다.
 * 가변·디테일 칸은 아빠가 그때 뽑던 인물이 들어 있어 섞이면 안 된다 (2026-11-25 첫 실측에서 섞임).
 * 3분할이 꺼져 있으면 칸 경계를 몰라 메인 프롬프트 전체를 앞에 둔다.
 * 사이드바 캐릭터 카드·i2i 소스는 싣지 않는다. 화면에서 켜 둔 레퍼·바이브는 생성 함수가 origin을 보고 뺀다.
 * 건에 charRefs가 있으면 그것만 extraCharRefs로 싣는다.
 */
export function buildClaudeRequest(
  base: GenerationRequest,
  splitEnabled: boolean,
  job: ClaudeGenJob,
  sceneId: number,
  size: { width: number; height: number },
  options: { allowAnlas: boolean; seed: number }
): GenerationRequest {
  const rest: GenerationRequest = { ...base }
  delete rest.source
  delete rest.extraCharRefs
  delete rest.skipWildcards
  // 받은 레퍼만 싣는다. fidelity는 V5가 1로 고정하고, V4.5로 가면 1(최대)로 둔다.
  const extraCharRefs: ExtraCharRef[] | undefined = job.charRefs?.length
    ? job.charRefs.map((r) => ({
        filePath: r.filePath,
        refType: r.refType,
        strength: r.strength,
        fidelity: 1
      }))
    : undefined
  const promptParts =
    splitEnabled && rest.promptParts
      ? { base: rest.promptParts.base, additional: '', detail: joinPromptSections(job.prompt, '') }
      : undefined
  const request: GenerationRequest = {
    ...rest,
    prompt: promptParts ? mergeParts(promptParts) : joinPromptSections(rest.prompt, job.prompt),
    promptParts,
    negativePrompt: joinPromptSections(rest.negativePrompt, job.negativePrompt ?? ''),
    model: job.model?.trim() || rest.model,
    width: size.width,
    height: size.height,
    seed: options.seed,
    characterPrompts: [],
    sceneId,
    origin: 'claude',
    allowAnlas: options.allowAnlas,
    ...(extraCharRefs ? { extraCharRefs } : {})
  }
  if (!promptParts) delete request.promptParts
  return request
}

const MAX_JOBS = 8
const MAX_COUNT = 8
const MAX_TOTAL = 32
const MAX_REFS = 4
/** delta(예전 방식)는 파일 경로만으로 만들 수 없어 받지 않는다. */
const REF_TYPES: readonly CharRefType[] = [
  'character',
  'style',
  'character&style',
  'costume',
  'character_mainoutfit',
  'character&style_anyoutfit'
]
const REF_EXT = /\.(png|webp|jpe?g)$/i
/** 윈도 드라이브 경로(D:\ 또는 D:/)나 / 로 시작하는 절대 경로 */
const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\/)/

function checkRefs(name: string, input: unknown): { refs?: ClaudeGenCharRef[]; error?: string } {
  if (input === undefined) return {}
  if (!Array.isArray(input) || input.length > MAX_REFS)
    return { error: `${name}: charRefs는 ${MAX_REFS}장까지의 배열이에요` }
  const refs: ClaudeGenCharRef[] = []
  for (const raw of input as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return { error: `${name}: 잘못된 레퍼 항목` }
    const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : ''
    if (!filePath || !ABS_PATH.test(filePath) || !REF_EXT.test(filePath))
      return { error: `${name}: 레퍼 filePath는 png·webp·jpg 절대 경로예요` }
    const refType = raw.refType === undefined ? 'character' : raw.refType
    if (typeof refType !== 'string' || !REF_TYPES.includes(refType as CharRefType))
      return { error: `${name}: 레퍼 refType은 ${REF_TYPES.join('|')} 중 하나예요` }
    const strength = raw.strength === undefined ? 1 : raw.strength
    if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 5)
      return { error: `${name}: 레퍼 strength는 0~5예요` }
    refs.push({ filePath, refType: refType as CharRefType, strength })
  }
  return { refs }
}

export type JobCheck = { ok: true; jobs: ClaudeGenJob[] } | { ok: false; error: string }

function validSide(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 64 && v <= 2048 && v % 64 === 0
}

/** 받은 글을 고치지 않고, 모양만 확인한다. */
export function checkJobs(input: unknown): JobCheck {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: 'jobs가 비었어요' }
  if (input.length > MAX_JOBS) return { ok: false, error: `한 번에 ${MAX_JOBS}건까지예요` }
  const jobs: ClaudeGenJob[] = []
  const names = new Set<string>()
  let total = 0
  for (const raw of input as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '잘못된 항목' }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name || name.length > 60) return { ok: false, error: 'name은 1~60자예요' }
    if (names.has(name)) return { ok: false, error: `같은 이름이 두 번 있어요: ${name}` }
    names.add(name)
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 20000)
      return { ok: false, error: `${name}: prompt가 비었거나 너무 길어요` }
    if (raw.negativePrompt !== undefined && typeof raw.negativePrompt !== 'string')
      return { ok: false, error: `${name}: negativePrompt는 글이어야 해요` }
    if (raw.width !== undefined && !validSide(raw.width))
      return { ok: false, error: `${name}: width는 64 배수(64~2048)예요` }
    if (raw.height !== undefined && !validSide(raw.height))
      return { ok: false, error: `${name}: height는 64 배수(64~2048)예요` }
    const count = raw.count === undefined ? 1 : raw.count
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_COUNT)
      return { ok: false, error: `${name}: count는 1~${MAX_COUNT}이에요` }
    if (
      raw.model !== undefined &&
      (typeof raw.model !== 'string' || !/^nai-diffusion-[\w.-]+$/.test(raw.model))
    )
      return { ok: false, error: `${name}: model 이름이 이상해요` }
    const refCheck = checkRefs(name, raw.charRefs)
    if (refCheck.error) return { ok: false, error: refCheck.error }
    total += count
    jobs.push({
      name,
      prompt: raw.prompt,
      negativePrompt: raw.negativePrompt as string | undefined,
      width: raw.width as number | undefined,
      height: raw.height as number | undefined,
      count,
      model: raw.model as string | undefined,
      ...(refCheck.refs?.length ? { charRefs: refCheck.refs } : {})
    })
  }
  if (total > MAX_TOTAL) return { ok: false, error: `한 번에 ${MAX_TOTAL}장까지예요` }
  return { ok: true, jobs }
}
