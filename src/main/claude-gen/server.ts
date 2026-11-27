import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { GenerationQueue } from '../queue/generation-queue'
import { getSetting } from '../db/settings'
import { createPreset, createScene, listPresets, listScenes, updateScene } from '../scenes/repo'
import { buildClaudeRequest, checkJobs, parseMainParams, randomSeed } from './build'

/**
 * 클로 생성 창구: 집 PC의 클로 세션이 NAI 생성을 앱 대기열에 넣는 로컬 주소.
 * - 127.0.0.1에서만 듣는다. 비밀값은 %USERPROFILE%\.atelier\claude-gen*.json
 *   (Claude 앱 셸에서 %APPDATA%가 다른 폴더로 돌려지는 일을 피해 홈 폴더에 둔다).
 * - 설정 claude_gen_enabled='0'이면 모든 요청을 거절한다 (기본 켜짐).
 * - 받은 건마다 프리셋(기본 「클로 생성」) 아래 같은 이름의 씬을 만들거나 고치고, 바로 뽑기 줄에 넣는다.
 */

export const CLAUDE_GEN_ENABLED_KEY = 'claude_gen_enabled'
const PORT_KEY = 'claude_gen_port'
const DEFAULT_PRESET = '클로 생성'
const BODY_LIMIT = 1024 * 1024

export function claudeGenDefaultPort(profile: number): number {
  return profile === 1 ? 39218 : 39218 + profile
}

export function claudeGenSecretPath(profile: number): string {
  return join(
    homedir(),
    '.atelier',
    profile === 1 ? 'claude-gen.json' : `claude-gen-${profile}.json`
  )
}

interface Secret {
  url: string
  token: string
}

/** 있던 비밀값을 이어 쓴다 (앱을 다시 켜도 스킬 쪽이 바뀌지 않게). 주소만 지금 포트로 맞춘다. */
function ensureSecret(path: string, url: string): Secret {
  let token = ''
  try {
    const old = JSON.parse(readFileSync(path, 'utf8')) as Partial<Secret>
    if (typeof old.token === 'string' && /^[0-9a-f]{64}$/.test(old.token)) token = old.token
  } catch {
    // 없거나 깨졌으면 새로 만든다
  }
  if (!token) token = randomBytes(32).toString('hex')
  const secret = { url, token }
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(secret, null, 2), { encoding: 'utf8', mode: 0o600 })
  return secret
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('본문이 너무 커요'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('JSON을 읽지 못했어요'))
      }
    })
    req.on('error', reject)
  })
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface ClaudeGenDeps {
  queue: GenerationQueue
  profile: number
  onScenesChanged: (presetId: number) => void
}

function presetIdByName(name: string): { id: number; created: boolean } {
  const found = listPresets().find((p) => p.name === name)
  if (found) return { id: found.id, created: false }
  return { id: createPreset(name), created: true }
}

function handleGenerate(deps: ClaudeGenDeps, body: Record<string, unknown>): [number, unknown] {
  const checked = checkJobs(body.jobs)
  if (!checked.ok) return [400, { ok: false, error: checked.error }]
  // 레퍼 파일이 없으면 대기열에 넣기 전에 돌려보낸다 (생성 중에 실패하면 무료 확인까지 헛돈다).
  for (const job of checked.jobs)
    for (const ref of job.charRefs ?? [])
      if (!existsSync(ref.filePath))
        return [400, { ok: false, error: `${job.name}: 레퍼 파일이 없어요: ${ref.filePath}` }]
  const presetName =
    typeof body.preset === 'string' && body.preset.trim()
      ? body.preset.trim().slice(0, 60)
      : DEFAULT_PRESET
  const allowAnlas = body.allowAnlas === true
  const base = parseMainParams(getSetting('main_params'))
  const splitEnabled = getSetting('prompt_split_enabled') === '1'
  const preset = presetIdByName(presetName)
  const jobs: { name: string; sceneId: number; ids: string[]; error?: string }[] = []
  for (const job of checked.jobs) {
    const existing = listScenes(preset.id).find((s) => s.name === job.name)
    const sceneId = existing ? existing.id : createScene(preset.id, job.name)
    const scene = existing ?? listScenes(preset.id).find((s) => s.id === sceneId)
    const width = job.width ?? scene?.width ?? 832
    const height = job.height ?? scene?.height ?? 1216
    // 씬 칸에도 받은 글을 그대로 남겨, 아빠가 화면에서 같은 씬을 다시 뽑을 수 있게 한다.
    updateScene(sceneId, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? '',
      width,
      height
    })
    const ids: string[] = []
    let error: string | undefined
    for (let i = 0; i < (job.count ?? 1); i++) {
      const request = buildClaudeRequest(
        base,
        splitEnabled,
        job,
        sceneId,
        { width, height },
        {
          allowAnlas,
          seed: randomSeed()
        }
      )
      const result = deps.queue.tryEnqueueQuick(request)
      if (result.blockedReason) {
        error =
          result.blockedReason === 'no-account'
            ? '앱에 NAI 계정이 없어요'
            : `대기열이 받지 않았어요 (${result.blockedReason})`
        break
      }
      ids.push(...result.ids)
    }
    jobs.push({ name: job.name, sceneId, ids, ...(error ? { error } : {}) })
  }
  deps.onScenesChanged(preset.id)
  return [200, { ok: true, preset: { id: preset.id, name: presetName }, allowAnlas, jobs }]
}

function handleJobs(deps: ClaudeGenDeps, idsParam: string | null): [number, unknown] {
  const ids = (idsParam ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0 || ids.length > 64) return [400, { ok: false, error: 'ids는 1~64개예요' }]
  const byId = new Map(deps.queue.status().items.map((item) => [item.id, item]))
  return [
    200,
    {
      ok: true,
      items: ids.map((id) => {
        const item = byId.get(id)
        if (!item) return { id, state: 'unknown' }
        return {
          id,
          state: item.state,
          sceneId: item.request?.sceneId,
          filePath: item.filePath,
          error: item.error,
          retrying: item.retrying
        }
      })
    }
  ]
}

function handleStatus(deps: ClaudeGenDeps): [number, unknown] {
  const s = deps.queue.status()
  return [
    200,
    {
      ok: true,
      accounts: s.accountCount,
      acceleration: s.accelerationEnabled,
      appAnlasSpending: s.anlasSpendingEnabled,
      pending: s.counts.pending,
      generating: s.counts.generating,
      // 옛 판은 모르는 칸(charRefs)을 말없이 버린다 — 스크립트가 이걸 보고 레퍼를 보낼지 정한다.
      features: ['charRefs']
    }
  ]
}

export function startClaudeGenServer(deps: ClaudeGenDeps): Server | null {
  const savedPort = Number(getSetting(PORT_KEY))
  const port =
    Number.isInteger(savedPort) && savedPort > 1024 && savedPort < 65536
      ? savedPort
      : claudeGenDefaultPort(deps.profile)
  const url = `http://127.0.0.1:${port}`
  let secret: Secret
  try {
    secret = ensureSecret(claudeGenSecretPath(deps.profile), url)
  } catch (e) {
    console.error('클로 생성 창구: 비밀값 파일을 쓰지 못했어요', e instanceof Error ? e.message : e)
    return null
  }
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  const server = createServer((req, res) => {
    void (async () => {
      // 브라우저에서 오는 요청(Origin 있음)과 다른 Host는 받지 않는다 (DNS 리바인딩 방지).
      if (req.headers.origin || !allowedHosts.has(req.headers.host ?? '')) {
        send(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const auth = req.headers.authorization ?? ''
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), secret.token)) {
        send(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      if (getSetting(CLAUDE_GEN_ENABLED_KEY) === '0') {
        send(res, 403, { ok: false, error: '설정 › 생성에서 「클로 생성 창구」가 꺼져 있어요' })
        return
      }
      const parsed = new URL(req.url ?? '/', url)
      try {
        let result: [number, unknown]
        if (req.method === 'GET' && parsed.pathname === '/status') result = handleStatus(deps)
        else if (req.method === 'GET' && parsed.pathname === '/jobs')
          result = handleJobs(deps, parsed.searchParams.get('ids'))
        else if (req.method === 'POST' && parsed.pathname === '/generate') {
          const body = await readBody(req)
          result =
            body && typeof body === 'object'
              ? handleGenerate(deps, body as Record<string, unknown>)
              : [400, { ok: false, error: '본문은 객체여야 해요' }]
        } else if (req.method === 'POST' && parsed.pathname === '/cancel') {
          const body = (await readBody(req)) as { ids?: unknown }
          const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : []
          deps.queue.cancel(ids as string[])
          result = [200, { ok: true, cancelled: ids.length }]
        } else result = [404, { ok: false, error: 'not found' }]
        send(res, result[0], result[1])
      } catch (e) {
        send(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })
  server.on('error', (e) => {
    console.error('클로 생성 창구를 열지 못했어요', e instanceof Error ? e.message : e)
  })
  server.listen(port, '127.0.0.1')
  return server
}
