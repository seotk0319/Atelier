import { app, shell, BrowserWindow, dialog, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import sharp from 'sharp'
import icon from '../../resources/icon.png?asset'
import iconInverted from '../../resources/icon-inverted.png?asset'
import { closeDb, getDb, initDb } from './db'
import { offerRecovery } from './backup/recovery-prompt'
import { getAccelerationExcluded, getNaiAccounts, getSetting } from './db/settings'
import { processWildcards } from './fragments/processor'
import { removeComments } from '../shared/nai-presets'
import { applyCharSections } from '../shared/char-sections'
import { composeWeakened, GENERAL_WEIGHT_KEY, parseGeneralWeight } from '../shared/general-weight'
import { isV5Model, maxCharactersForModel, supportsVibes } from '../shared/nai-models'
import { effortForRefs, refsForModel, sentRefCount } from '../shared/char-refs'
import type { CharRefType } from '../shared/types'
import { withFixedSettings } from '../shared/nai-models'
import { fragmentSource } from './fragments/repo'
import { saveGeneratedImage } from './images/storage'
import { serveImageFile } from './images/serve'
import { createPreviewGate } from './nai/preview-gate'
import { broadcast, registerIpcHandlers } from './ipc'
import { logBalance } from './nai/anlas-log'
import { logGeneratedImage } from './nai/account-usage'
import { fetchAnlasBalance, generateImageStream, generateImageZip } from './nai/client'
import { checkFreeGeneration } from './nai/spending-policy'
import { enabledCharRefRows, enabledVibeRows } from './refs/repo'
import { snapNaiResolution } from './nai/resolution'
import { prepareCharRefs, prepareExtraCharRefs, prepareVibes } from './refs/prepare'
import {
  APP_NAME,
  APP_TITLE,
  APP_USER_MODEL_ID,
  PROFILE,
  SHOULD_INVERT_ICON,
  initProfilePaths
} from './profile'
import { GenerationQueue } from './queue/generation-queue'
import { startClaudeGenServer } from './claude-gen/server'
import { getPresetName, getScene } from './scenes/repo'
import { viewClient } from './remote/source'
import { initGpt } from './gpt/service'

// Custom 프로필이면 userData를 먼저 분리 (단일 인스턴스 잠금·DB보다 앞서야 함)
initProfilePaths()
// 프로필별 창/작업표시줄 아이콘 — 짝수 프로필(Custom 2 등)은 색반전 아이콘으로 구분
const appIcon = SHOULD_INVERT_ICON ? iconInverted : icon
// 내부 앱 이름 'NAIS3 Custom N' — 기본 저장 폴더 이름이 이 값을 따르므로 표시용 제목과 분리한다.
app.setName(APP_NAME)

// 중복 실행 방지 (특히 Windows) — 두 번째 실행은 기존 창을 앞으로
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// 생성 이미지 폴더만 렌더러에 노출하는 전용 프로토콜 (CSP/webSecurity 우회 없이 로컬 파일 표시)
protocol.registerSchemesAsPrivileged([
  { scheme: 'nais-image', privileges: { secure: true, supportFetchAPI: true, stream: true } },
  // 알림 작품 썸네일: 베이비챗 응답에 나온 이미지 호스트만 본체가 대신 받아 준다
  { scheme: 'nais-thumb', privileges: { secure: true, supportFetchAPI: true, stream: true } }
])

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: 1600,
    height: 900,
    minWidth: 1080,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    // 리사이즈 시 노출되는 네이티브 배경 — 기본 다크. 테마 전환 시 렌더러가 갱신
    backgroundColor: '#0f0f10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // 신호등을 큰 타이틀바(h-14=56px) 중앙에 세로 정렬
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 21 } } : {}),
    ...(process.platform !== 'darwin' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 최소화 중에도 큐/진행 이벤트를 즉시 소비해 복원 시 업데이트가 한꺼번에 몰리지 않게 한다.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const previewGate = createPreviewGate()

app.whenReady().then(async () => {
  // app.quit()은 비동기라 두 번째 실행도 ready까지 온다 — 여기서 멈추지 않으면 첫 실행이 쓰는
  // DB를 같이 열어 백업·마이그레이션을 중복 실행한다. 기존 창은 첫 실행의 second-instance가 앞으로 가져온다.
  if (!hasSingleInstanceLock) return
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)

  // 작품 썸네일은 맥미니가 대신 받아 준다 (이 PC는 플랫폼 이미지 서버에 닿지 않는다)
  protocol.handle('nais-thumb', async (request) => {
    try {
      const image = new URL(request.url).searchParams.get('u') ?? ''
      const got = image.startsWith('https://') ? await viewClient().thumb(image) : null
      if (!got) return new Response(null, { status: 404 })
      return new Response(Buffer.from(got.bytes), {
        headers: { 'Content-Type': got.type, 'Cache-Control': 'private, max-age=86400' }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  protocol.handle('nais-image', async (request) => {
    try {
      const url = new URL(request.url)
      // searchParams.get이 이미 한 번 풀어 준다 — 한 번 더 풀면 폴더 이름의 %가 깨진다 ("100% 완성")
      const filePath = url.searchParams.get('path') ?? ''
      if (filePath && url.searchParams.get('thumbnail') === '1') {
        const row = getDb()
          .prepare(
            'SELECT b.thumbnail FROM images i JOIN image_blobs b ON b.image_id = i.id WHERE i.file_path = ?'
          )
          .get(filePath) as { thumbnail: Buffer | null } | undefined
        if (row?.thumbnail?.length) {
          return new Response(new Uint8Array(row.thumbnail), {
            headers: {
              'Content-Type': 'image/webp',
              'Cache-Control': 'private, max-age=3600'
            }
          })
        }
      }
      if (!filePath) return new Response(null, { status: 404 })
      return serveImageFile(filePath)
    } catch {
      // 파일이 이동·삭제되어도 썸네일 요청 실패가 메인 프로세스 예외로 번지지 않게 한다.
      return new Response(null, { status: 404 })
    }
  })

  let dbVersion: number
  try {
    dbVersion = initDb().version
  } catch (e) {
    // DB를 못 열면 조용히 빈 상태로 시작하지 않는다 — 세이브 유실로 오인되는 최악의 UX
    dialog.showErrorBox('Atelier 데이터베이스 오류', e instanceof Error ? e.message : String(e))
    app.quit()
    return
  }
  // 작업 공간이 비었는데 앱이 남긴 백업에는 데이터가 있으면 창을 띄우기 전에 되돌릴지 묻는다
  // (upstream NAIS3 56299a5). 되돌리면 앱이 다시 시작된다.
  if (await offerRecovery()) return

  // 생성 파이프라인: 큐 → 조각/와일드카드 치환 → 바이브/캐릭레퍼 준비 → 스트리밍 생성 → 저장
  const queue = new GenerationQueue(
    async (queuedRequest, id, signal, account) => {
      // V5 Medium은 레퍼런스를 못 쓴다 — 레퍼런스가 켜져 있으면 High로 보낸다 (NAI 웹과 같음).
      // 실제로 보내는 수로 센다 — V4.5는 의상 레퍼런스를 빼고 보낸다 (무료 확인이 빠지는 레퍼로 거절하지 않게).
      // V5 인페인트는 레퍼를 빼고 보내니 0으로 센다 — 절약 인페인트(…-medium-inpainting, 2026-11-25 실측으로
      // 있음 확인)를 쓸데없이 일반으로 올려 보내지 않게.
      // 클로 생성 창구에서 온 요청은 화면에서 켜 둔 레퍼·바이브를 싣지 않는다 (받은 프롬프트만 보낸다).
      const fromClaude = queuedRequest.origin === 'claude'
      const crefCount =
        queuedRequest.source?.maskBase64 && isV5Model(queuedRequest.model)
          ? 0
          : sentRefCount(
              [
                ...(fromClaude ? [] : enabledCharRefRows().map((r) => r.refType as CharRefType)),
                ...(queuedRequest.extraCharRefs ?? []).map((r) => r.refType)
              ],
              queuedRequest.model
            )
      // V5 Full Medium은 스텝·샘플러·네거티브가 고정이다. 무료 확인·저장 기록도 실제로 보낸 값으로 맞춘다.
      const rawRequest = withFixedSettings({
        ...queuedRequest,
        model: effortForRefs(queuedRequest.model, crefCount)
      })
      const token = account.token
      // 클로 생성 창구는 앱 스위치와 상관없이 allowAnlas(아빠가 말했을 때만)가 있어야 Anlas를 쓴다.
      const maySpend = (): boolean =>
        fromClaude
          ? rawRequest.allowAnlas === true
          : PROFILE !== 1 || getSetting('anlas_spending') !== '0'
      const ensureFree = async (): Promise<void> => {
        if (maySpend()) return
        const rows = supportsVibes(rawRequest.model) && !fromClaude ? enabledVibeRows() : []
        await checkFreeGeneration(token, rawRequest, {
          characterCount: crefCount,
          vibeCount: rows.length,
          unencodedVibes: rows.filter((r) => !r.encoded || r.encodedIe !== r.infoExtracted).length
        })
        signal.throwIfAborted()
      }
      await ensureFree()
      signal.throwIfAborted()

      // 배치 항목마다 여기서 치환 — 매 장 다른 와일드카드 결과가 나온다.
      // 일반 생성은 주석 제거가 반드시 먼저 — 주석 줄이 조각을 소모하거나(순차 카운터),
      // 와일드카드 처리의 재조립이 개행을 지워 주석 범위가 전체로 번지는 것 방지 (NAIS2와 동일 순서).
      // skipWildcards는 메타데이터 원문 복구용이므로 이 전처리 묶음을 건너뛴다.
      const fragSource = fragmentSource()
      const sub = (text: string): string =>
        rawRequest.skipWildcards ? text : processWildcards(removeComments(text), fragSource)
      // "# == char1 ==" 같은 구간 표시를 캐릭터 프롬프트로 옮긴다 (주석 제거보다 먼저).
      const sectioned = rawRequest.skipWildcards
        ? rawRequest
        : applyCharSections(rawRequest, maxCharactersForModel(rawRequest.model))
      // 3분할이면 각 조각을 개별 치환 후 병합 — 전송 프롬프트와 메타데이터(promptParts)가
      // 같은 치환 결과를 공유한다 (병합본만 치환하면 메타데이터에 <조각> 원문이 남는 버그)
      const subbedParts = sectioned.promptParts
        ? {
            base: sub(sectioned.promptParts.base),
            additional: sub(sectioned.promptParts.additional),
            detail: sub(sectioned.promptParts.detail)
          }
        : undefined
      let request = {
        ...rawRequest,
        // 구간 표시에 위치(# == char1 C3 ==)를 적었으면 위치 지정 모드로 바뀐다
        useCoords: sectioned.useCoords,
        // 일반 태그 약화: 고정 칸은 그대로, 가변·디테일(씬 포함)을 설정의 가중치로 감싼다.
        // 주석 제거·조각 치환 뒤에 감싸야 닫는 ::가 주석에 먹히지 않는다. 3분할일 때만.
        prompt: subbedParts
          ? rawRequest.weakenGeneral
            ? composeWeakened(
                subbedParts.base,
                [subbedParts.additional, subbedParts.detail],
                parseGeneralWeight(getSetting(GENERAL_WEIGHT_KEY))
              )
            : [subbedParts.base, subbedParts.additional, subbedParts.detail]
                .filter((p) => p.trim())
                .join(', ')
          : sub(sectioned.prompt),
        negativePrompt: sub(sectioned.negativePrompt),
        promptParts: subbedParts,
        characterPrompts: sectioned.characterPrompts.map((c) => ({
          ...c,
          prompt: sub(c.prompt),
          negativePrompt: sub(c.negativePrompt)
        }))
      }

      // 바이브/캐릭레퍼는 DB의 enabled 항목에서 준비 (바이브는 필요 시 인코딩 — 2 Anlas, 캐시됨).
      // V5는 바이브를 받지 않는다 — 싣지도, 4.5용으로 인코딩(과금)하지도 않는다.
      // 캐릭터 레퍼런스는 V5도 받는다. 종류·충실도는 아래에서 보낼 모델에 맞춘다 (shared/char-refs.ts).
      const { vibes, newlyEncoded } =
        supportsVibes(rawRequest.model) && !fromClaude
          ? await prepareVibes(token, maySpend)
        : { vibes: [], newlyEncoded: [] }
      if (newlyEncoded.length) broadcast('vibes:encoded', {}) // 카드 인코딩 표시 갱신
      const extraCharacterReferences = rawRequest.extraCharRefs?.length
        ? await prepareExtraCharRefs(rawRequest.extraCharRefs, rawRequest.model)
        : []
      // 그림 모양(V4.5 캔버스 / V5 버킷)은 보낼 모델로 정한다. 인페인트로 바뀌어도 V4.5/V5는 그대로다.
      const preparedCharRefs = [
        ...extraCharacterReferences,
        ...(fromClaude ? [] : await prepareCharRefs(rawRequest.model))
      ]

      let source = request.source
      // i2i/인페인트: 소스 해상도를 유효 NAI 해상도(64 배수·픽셀 상한)로 스냅하고 이미지를 맞춰 리사이즈.
      // NAI는 width/height가 64 배수가 아니면 400을 낸다 (임의 크기 업로드 이미지 → i2i 실패 원인).
      if (source) {
        const snapped = snapNaiResolution(request.width, request.height)
        if (snapped.width !== request.width || snapped.height !== request.height) {
          const resized = await sharp(Buffer.from(source.imageBase64, 'base64'))
            .resize(snapped.width, snapped.height, { fit: 'fill' })
            .png()
            .toBuffer()
          source = { ...source, imageBase64: resized.toString('base64') }
          request = { ...request, width: snapped.width, height: snapped.height }
        }
      }
      const normalizedMaskBase64 = source?.maskBase64
        ? await normalizeInpaintMask(source.maskBase64, request.width, request.height)
        : undefined
      if (source?.maskBase64 && !request.model.includes('inpainting')) {
        // TODO(fixture): 인페인트 실캡처로 모델 스위칭 여부 확정 필요 (웹 enum에 -inpainting 존재)
        request = { ...request, model: `${request.model}-inpainting` }
      }
      // V5 인페인트는 레퍼런스를 지원하지 않는다 (NAI 웹도 빼고 보낸다).
      const characterReferences =
        source?.maskBase64 && isV5Model(request.model)
          ? []
          : refsForModel(preparedCharRefs, request.model)

      const imageFormat: 'png' | 'webp' = getSetting('image_format') === 'webp' ? 'webp' : 'png'
      const buildOpts = {
        vibes: vibes.length > 0 ? vibes : undefined,
        characterReferences: characterReferences.length > 0 ? characterReferences : undefined,
        imageFormat,
        i2i: source
          ? {
              strength: source.strength,
              noise: source.noise,
              // TODO(fixture): 캡처 1건에서 seed-1이었음 — 규칙 미확정이라 캡처값 방식 채택
              extraNoiseSeed: Math.max(0, request.seed - 1),
              colorCorrect: false,
              imageBase64: source.imageBase64,
              maskBase64: normalizedMaskBase64
            }
          : undefined
      }

      // t2i·i2i·인페인트 모두 스트리밍으로 진행 미리보기 (인페인트는 서버가 스트림에서도 합성 확인됨,
      // i2i는 합성 단계가 없어 최종 프레임이 곧 결과). 스트리밍 설정 off면 전부 zip.
      const streamingOn = getSetting('gen_streaming') !== '0'
      const useZip = !streamingOn
      // 준비 중 토글/레퍼런스가 바뀌어도 실제 전송 구성으로 재검사한다. 이미 보낸 요청은 소급 취소하지 않는다.
      if (!maySpend()) {
        await checkFreeGeneration(
          token,
          { ...request, source },
          {
            characterCount: characterReferences.length,
            vibeCount: vibes.length,
            unencodedVibes: 0
          }
        )
      }
      signal.throwIfAborted()
      const { png, sentPayload } = useZip
        ? await generateImageZip(token, request, buildOpts, signal)
        : await generateImageStream(
            token,
            request,
            buildOpts,
            (stepIx, preview) => {
              // Step numbers always flow; the preview image only when someone can see it.
              const visible = BrowserWindow.getAllWindows().some(
                (w) => w.isVisible() && !w.isMinimized()
              )
              broadcast('generation:progress', {
                id,
                stepIx,
                totalSteps: request.steps,
                previewPng:
                  preview && previewGate.allow(visible) ? preview.toString('base64') : undefined
              })
            },
            signal
          )

      // 자동 저장 off여도 히스토리엔 남긴다 — 저장 폴더 대신 앱 내부 라이브러리로 가는 판정은
      // saveGeneratedImage가 auto_save 설정을 읽어 처리한다 (씬 포함).
      // 씬 생성은 씬루트/<프리셋>/<씬 이름>/에 모아 저장 (NAIS2와 동일 계층)
      const scene = request.sceneId ? getScene(request.sceneId) : null
      const saved = await saveGeneratedImage({
        png,
        sentPayload,
        seed: request.seed,
        kind: request.sceneId ? 'scene' : source ? (source.maskBase64 ? 'inpaint' : 'i2i') : 't2i',
        sceneId: request.sceneId,
        format: imageFormat,
        sceneName: scene?.name,
        scenePresetName: scene ? (getPresetName(scene.presetId) ?? undefined) : undefined,
        localMetadata: request.promptParts
          ? {
              promptParts: {
                ...request.promptParts,
                negative: request.negativePrompt
              }
            }
          : undefined
      })

      // 실제 이미지 저장까지 성공한 건만 PC 현지 자정 기준 계정·모델별 장수에 포함한다.
      try {
        logGeneratedImage(account.id, request.model)
      } catch {
        // 집계 실패가 이미 저장된 이미지를 재생성(과금)하게 해서는 안 된다.
        console.error('계정별 생성 장수 저장 실패')
      }

      broadcast('images:added', saved)

      // 씬 생성이면 해당 씬 갱신 알림 (목록 썸네일/개수, 상세 이미지 갱신용)
      if (request.sceneId)
        broadcast('scenes:changed', { sceneId: request.sceneId, filePath: saved.filePath })

      // 생성 후 잔액 갱신 (실사용량 추적의 진실 공급원) — 실패해도 생성 흐름엔 영향 없음
      void fetchAnlasBalance(token).then(({ anlas, v5Usage }) => {
        // 기존 상단 잔액과 Anlas 사용 로그는 대표 계정(계정 1)의 값만 유지한다.
        // 계정 2 이상 잔액을 섞으면 계정 전환이 사용량으로 잘못 계산된다.
        const primaryId = getNaiAccounts()[0]?.id
        if (account.id === primaryId && anlas !== null) {
          logBalance(anlas)
          broadcast('anlas:balance', { anlas, v5Usage })
        }
      })

      return saved.filePath
    },
    {
      getAccounts: () => getNaiAccounts(),
      accelerationAvailable: PROFILE === 1,
      isAccelerationEnabled: () => getSetting('acceleration_mode') === '1',
      getAccelerationExcluded: () => getAccelerationExcluded(),
      isAnlasSpendingEnabled: () => PROFILE !== 1 || getSetting('anlas_spending') !== '0'
    }
  )

  // 저장해둔 생성 지연 시간 적용 (기본 600ms)
  const savedDelay = Number(getSetting('gen_delay_ms'))
  if (Number.isFinite(savedDelay) && savedDelay >= 0) queue.setDelayMs(savedDelay)

  registerIpcHandlers({ dbVersion, queue })
  // 클로 세션이 NAI 생성을 이 대기열에 넣는 로컬 주소 (127.0.0.1 전용, 설정으로 끔)
  startClaudeGenServer({
    queue,
    profile: PROFILE,
    onScenesChanged: (presetId) => broadcast('scenePresets:changed', { presetId })
  })
  initGpt(
    (jobs) => broadcast('gpt:changed', { jobs }),
    (item) => broadcast('images:added', item)
  )
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // mac dock 아이콘 (dev 미리보기용 — 패키징 앱은 icns 사용)
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(appIcon)

  createWindow()
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('quit', () => {
  closeDb()
})

/**
 * NAI 인페인트 마스크 정규화 (NAIS2 검증):
 * 원본(소스 이미지) 해상도로 순수 이진화(흰=재생성). 서버가 이 마스크로 깨끗이 합성한다.
 * 클라이언트 합성/erode/blur 불필요 — 오히려 경계 심을 만든다.
 */
async function normalizeInpaintMask(
  maskBase64: string,
  width: number,
  height: number
): Promise<string> {
  // 마스크를 1/8로 축소 후 8배 확대(nearest) → 8×8 잠재 블록에 정렬.
  // 1px 경계는 latent 다운스케일 시 애매한 픽셀을 만들어 seam/노이즈를 유발하므로 8px로 스냅한다.
  const mw = Math.max(1, Math.round(width / 8))
  const mh = Math.max(1, Math.round(height / 8))

  // 원본 마스크를 이진화 → 1/8 축소 (블록에 흰색이 조금이라도 있으면 흰색으로: 평균 후 낮은 threshold)
  const small = await sharp(Buffer.from(stripDataUrl(maskBase64), 'base64'))
    .flatten({ background: '#000000' })
    .greyscale()
    .resize(mw, mh, { fit: 'fill' }) // 평균 다운스케일
    .raw()
    .toBuffer()

  // 8배 확대 + RGB 흑백 (NAI는 RGB 마스크 기대). 블록 평균 > 25면 흰색
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(mh - 1, Math.floor(y / 8))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(mw - 1, Math.floor(x / 8))
      const v = small[sy * mw + sx] > 25 ? 255 : 0
      const dst = (y * width + x) * 3
      rgb[dst] = v
      rgb[dst + 1] = v
      rgb[dst + 2] = v
    }
  }

  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer()
  return png.toString('base64')
}

function stripDataUrl(base64: string): string {
  return base64.replace(/^data:[^,]+,/, '')
}
