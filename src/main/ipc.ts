import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  shell
} from 'electron'
import type { IpcEventMap, IpcInvokeMap } from '../shared/types'
import type { ReturnedReservation } from './queue/generation-queue'
import {
  removeTranslateKey,
  saveTranslateKey,
  setTranslateEngine,
  translateStatus,
  translateText,
  translateUsage
} from './translate/service'
import { openRouterStatus, removeOpenRouterKey, saveOpenRouterKey } from './llm/service'
import { tagFromImage, tagFromText } from './tag-helper/service'
import {
  askAssistant,
  assistantStatus,
  importAssistantGuide,
  saveAssistantKey,
  setAssistantConfig
} from './assistant/service'
import {
  createCharacter,
  createFolder,
  deleteCharacter,
  duplicateCharacter,
  deleteFolder,
  listCharacters,
  pickCharacterThumbnail,
  clearCharacterThumbnail,
  renameFolder,
  reorderCharacters,
  setFolderCollapsed,
  setFolderColor,
  updateCharacter
} from './characters/repo'
import { getDbPath, getDb } from './db'
import * as gpt from './gpt/service'
import * as cover from './cover/repo'
import * as coverArchive from './cover/archive'
import { tagKnowledge } from './nai/tag-knowledge'
import { normalizeSceneSeed } from '../shared/scene-seed'
import { analyzeArtists } from './images/artists'
import { metadataFromPng, metadataFromPayloadJson } from './images/metadata'
import {
  createFragment,
  createFragmentFolder,
  deleteFragment,
  duplicateFragment,
  deleteFragmentFolder,
  exportTxtFragment,
  exportAllFragmentsZip,
  fragmentSource,
  importTxtFragments,
  listFragments,
  renameFragmentFolder,
  reorderFragments,
  setFragmentFolderCollapsed,
  setFragmentFolderColor,
  updateFragment
} from './fragments/repo'
import { processWildcards, resetSequentialCounters } from './fragments/processor'
import { removeComments } from '../shared/nai-presets'
import {
  addNaiAccount,
  deleteNaiAccount,
  deleteNaiToken,
  getNaiAccountInfos,
  getNaiAccountToken,
  getNaiAccounts,
  getNaiToken,
  getNaiTokenInfo,
  getSetting,
  setNaiToken,
  setAccountAccelerated,
  setNaiAccountMemo,
  setSetting
} from './db/settings'
import { anlasUsage, logBalance } from './nai/anlas-log'
import { getTodayGenerationUsage } from './nai/account-usage'
import { fetchAnlasBalance } from './nai/client'
import {
  getImagePayload,
  hasCensorBackup,
  listImages,
  overwriteCensoredImage,
  restoreCensoredImage,
  saveGeneratedImage
} from './images/storage'
import { augmentImage, upscaleImage } from './nai/client'
import {
  listPresets,
  manageScenePresets,
  createPreset,
  renamePreset,
  deletePreset,
  reorderPresets,
  listPresetFolders,
  createPresetFolder,
  setPresetFolderParent,
  renamePresetFolder,
  setPresetFolderCollapsed,
  deletePresetFolder,
  movePresetsToFolder,
  reorderPresetTree,
  setPresetCharacters,
  setPresetDefaultResolution,
  listScenes,
  createScene,
  getScene,
  getPresetName,
  updateScene,
  duplicateScene,
  deleteScene,
  reorderScenes,
  setReserveAll,
  clearAllReservations,
  adjustReserveAll,
  returnReservations,
  reservedTotal,
  bulkMove,
  bulkDelete,
  bulkSetResolution,
  bulkClearFavorites,
  bulkClearImages,
  clearCurationImages,
  bulkExportZip,
  sceneImages,
  deleteNonFavorites,
  setImageFavorite,
  deleteImage,
  clearAllImages,
  exportScenesJson,
  importScenesJson,
  exportZip
} from './scenes/repo'
import {
  listPromptPresets,
  managePromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
  reorderPromptPresets
} from './prompts/repo'
import { exportAll, importAll } from './backup/repo'
import { importNais2 } from './backup/nais2'
import { checkForUpdate, installUpdateNow, startUpdateDownload } from './updater'
import { countTokens } from './nai/tokenizer'
import {
  addRefImages,
  addRefImagePaths,
  collapseRefFolder,
  colorRefFolder,
  createRefFolder,
  deleteRefFolder,
  deleteRefImage,
  duplicateRefImage,
  listCharRefs,
  listVibes,
  renameRefFolder,
  reorderRefs,
  updateRefImage
} from './refs/repo'
import { searchTags } from './tags'
import { imagesRoot, libraryRoot, sceneDir, scenePresetDir, scenesRoot } from './images/storage'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readdir } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import sharp from 'sharp'
import { verifyToken } from './nai/client'
import { APP_TITLE, PROFILE } from './profile'
import { remotePort, viewClient } from './remote/source'
import { REMOTE_DOWN } from './remote/view-client'
import type { RemoteStamp } from '../shared/remote-view'
import type {
  InboxReplyResult,
  InboxReplyTarget,
  InboxResult,
  InboxWorksResult
} from '../shared/inbox'
import type { AiLogEntry, AiReplyStatus } from '../shared/ai-reply'
import type { McpActivity } from '../shared/types'
import type { GenerationQueue } from './queue/generation-queue'
import {
  assignLibraryEntries,
  collapseLibraryFolder,
  createLibraryFolder,
  deleteLibraryFolder,
  listLibraryDates,
  listLibraryFolders,
  moveLibraryFolder,
  renameLibraryFolder
} from './library/repo'
import { createSlowLog, watchStalls, type SlowLog } from './perf/slow-log'

/** IpcInvokeMap 계약을 강제하는 handle 등록 헬퍼 */
function handle<C extends keyof IpcInvokeMap>(
  channel: C,
  handler: (req: IpcInvokeMap[C]['req']) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']
): void {
  ipcMain.handle(channel, (_event, req) => slowLog().wrap(channel, () => handler(req)))
}

/** 본체를 50ms 넘게 붙잡은 요청과 멈춤을 <userData>/perf/slow.jsonl에 남긴다 (이름과 시간만) */
let slowLogInstance: SlowLog | null = null
function slowLog(): SlowLog {
  if (!slowLogInstance) {
    slowLogInstance = createSlowLog({ file: join(app.getPath('userData'), 'perf', 'slow.jsonl') })
    watchStalls(slowLogInstance)
  }
  return slowLogInstance
}

export function broadcast<C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpcHandlers(ctx: { dbVersion: number; queue: GenerationQueue }): void {
  if (PROFILE === 1) {
    // 알림·작품·AI 답글 화면은 맥미니(아틀리에MCP)에서 받아 보여 준다. 이 PC는 캐챗 사이트에 닿지 않는다.
    const view = viewClient()
    /** 맥미니에서 받은 답에 받은 시각을 붙인다 */
    const stamped = async <T extends object>(
      channel: string,
      req?: unknown,
      options?: { cacheAs?: unknown }
    ): Promise<T & { remote: RemoteStamp }> => {
      const { res, stamp } = await view.read<T>(channel, req, options)
      return { ...res, remote: stamp }
    }
    const failed = (error: unknown): { ok: false; message: string } => ({
      ok: false,
      message: error instanceof Error ? error.message : REMOTE_DOWN
    })
    handle('inbox:query', (query) => stamped<InboxResult>('inbox:query', query || {}))
    // 받은 것은 요청 모양과 상관없이 한 자리에 둔다 (끊겼을 때 작품 탭·알림 탭이 같은 것을 본다)
    handle('inbox:works', (req) =>
      stamped<InboxWorksResult>('inbox:works', req || {}, { cacheAs: { cached: true } })
    )
    handle('app:copyText', ({ text }) => {
      if (typeof text !== 'string' || !text || text.length > 50_000) return { ok: false }
      clipboard.writeText(text)
      return { ok: true }
    })
    handle('inbox:control', (req) => view.act('inbox:control', req))
    handle('inbox:setInterval', (req) => view.act('inbox:setInterval', req))
    handle('inbox:openSource', async ({ id }) => {
      const { url } = await view.act<{ url: string }>('inbox:sourceUrl', { id })
      if (!url.startsWith('https://')) throw new Error('원문 주소를 열 수 없어요.')
      await shell.openExternal(url)
    })
    handle('inbox:connect', () => ({
      state: 'error' as const,
      message: '로그인은 맥미니의 아틀리에에서 해요.'
    }))
    handle('inbox:reply', (req) => view.act<InboxReplyResult>('inbox:reply', req).catch(failed))
    handle('inbox:replyTarget', (req) =>
      view.act<InboxReplyTarget>('inbox:replyTarget', req).catch(failed)
    )
    handle('inbox:disconnect', () => {
      throw new Error('연결 끊기는 맥미니의 아틀리에에서 해요.')
    })
    handle('inbox:select', (req) => view.act('inbox:select', req))
    handle('translate:status', () => translateStatus())
    handle('translate:setEngine', ({ engine }) => setTranslateEngine(engine))
    handle('translate:usage', () => translateUsage())
    handle('translate:setKey', ({ key }) => saveTranslateKey(String(key || '')))
    handle('translate:deleteKey', () => removeTranslateKey())
    handle('translate:run', ({ text, target }) => translateText(String(text || ''), target))
    handle('aiReply:status', async () => (await view.read<AiReplyStatus>('aiReply:status')).res)
    handle('aiReply:setKey', () => ({
      ok: false,
      message: 'AI 답글 키는 맥미니의 아틀리에에서 넣어요.'
    }))
    handle('aiReply:deleteKey', () => {
      throw new Error('AI 답글 키는 맥미니의 아틀리에에서 지워요.')
    })
    handle('aiReply:setConfig', (patch) => view.act('aiReply:setConfig', patch || {}))
    handle('aiReply:setEngine', (req) => view.act('aiReply:setEngine', req))
    handle('aiReply:draft', (req) => view.act('aiReply:draft', req))
    handle(
      'aiReply:entry',
      async (req) => (await view.read<AiLogEntry | null>('aiReply:entry', req)).res
    )
    handle(
      'aiReply:log',
      async (req) => (await view.read<AiLogEntry[]>('aiReply:log', req || {})).res
    )
    handle('aiReply:backlogPreview', (req) => view.act('aiReply:backlogPreview', req))
    handle('aiReply:backlogStart', (request) => view.act('aiReply:backlogStart', request))
    handle('aiReply:backlogStop', () => view.act('aiReply:backlogStop'))
  }
  // 작품 MCP는 맥미니에서 돈다. 여기서는 통로 너머가 답하는지와 맥미니의 작업 기록만 보여 준다.
  // (본 프로필이 아니어도 화면이 "No handler"를 받지 않게 처리기는 늘 둔다)
  handle('mcp:status', async () => {
    if (PROFILE !== 1) return { running: false, port: 0, url: '', error: null }
    const up = await viewClient().reachable()
    return { running: false, port: remotePort(), url: '', error: null, remote: up ? 'up' : 'down' }
  })
  handle('mcp:activity', async (req) => {
    if (PROFILE !== 1) return { items: [] }
    try {
      const { res, stamp } = await viewClient().read<{ items: McpActivity[] }>(
        'mcp:activity',
        req || {}
      )
      return { items: res.items, remote: stamp }
    } catch {
      return { items: [] }
    }
  })
  const censorFolderFiles = new Set<string>()
  const censorPathKey = (filePath: string): string => resolve(filePath).toLowerCase()
  handle('db:status', () => ({ version: ctx.dbVersion, path: getDbPath() }))
  handle('assistant:status', () => assistantStatus())
  handle('assistant:setKey', ({ key }) => saveAssistantKey(String(key || '')))
  handle('assistant:setConfig', (patch) => setAssistantConfig(patch || {}))
  handle('assistant:importGuide', () => importAssistantGuide())
  handle('assistant:ask', (req) => askAssistant(req))
  handle('openrouter:status', () => openRouterStatus())
  handle('openrouter:setKey', ({ key }) => saveOpenRouterKey(String(key || '')))
  handle('openrouter:deleteKey', () => removeOpenRouterKey())
  handle('tagHelper:fromText', (req) => tagFromText(req))
  handle('tagHelper:fromImage', (req) => tagFromImage(req))
  handle('app:version', () => ({ version: app.getVersion() }))
  handle('app:profile', () => ({ profile: PROFILE, title: APP_TITLE }))

  handle('nai:verifyToken', ({ token }) => verifyToken(token))

  // 검증 성공 시에만 저장 — 잘못된 토큰이 조용히 저장되는 것 방지
  handle('nai:setToken', async ({ token }) => {
    const result = await verifyToken(token)
    if (result.valid) {
      setNaiToken(token)
      ctx.queue.refreshConfiguration()
    }
    return result
  })

  handle('nai:tokenStatus', () => getNaiTokenInfo())
  handle('nai:revealToken', () => ({ token: getNaiToken() }))
  handle('nai:deleteToken', () => {
    deleteNaiToken()
    ctx.queue.refreshConfiguration()
  })
  handle('nai:accounts', () => ({ accounts: getNaiAccountInfos() }))
  handle('nai:addAccount', async ({ token }) => {
    if (PROFILE !== 1) return { valid: false, error: '가속 계정은 Custom 1에서만 지원합니다' }
    const result = await verifyToken(token)
    if (!result.valid) return result
    const saved = addNaiAccount(token)
    if (!saved.added) return { valid: false, error: saved.error }
    ctx.queue.refreshConfiguration()
    return result
  })
  handle('nai:revealAccount', ({ id }) => ({ token: getNaiAccountToken(id) }))
  handle('nai:setAccountMemo', ({ id, memo }) =>
    setNaiAccountMemo(String(id || ''), typeof memo === 'string' ? memo : '')
  )
  handle('nai:deleteAccount', ({ id }) => {
    if (PROFILE !== 1) return { deleted: false, error: 'Custom 1에서만 변경할 수 있습니다' }
    if (ctx.queue.isAccountBusy(id)) {
      return { deleted: false, error: '이 계정이 생성 중이라 끝난 뒤 삭제할 수 있습니다' }
    }
    const deleted = deleteNaiAccount(id)
    if (!deleted) return { deleted: false, error: '계정을 찾지 못했습니다' }
    ctx.queue.refreshConfiguration()
    return { deleted: true }
  })
  handle('nai:balance', async () => {
    const token = getNaiToken()
    if (!token) return { anlas: null, tier: null, v5Usage: null }
    const { anlas, tier, v5Usage } = await fetchAnlasBalance(token)
    if (anlas !== null) logBalance(anlas)
    return { anlas, tier, v5Usage }
  })
  handle('nai:anlasUsage', () => anlasUsage())
  handle('nai:accountUsage', async () => {
    const accounts = getNaiAccounts()
    const items = await Promise.all(
      accounts.map(async (account) => {
        const { anlas, tier, v5Usage } = await fetchAnlasBalance(account.token)
        return {
          accountId: account.id,
          anlas,
          tier,
          v5Usage
        }
      })
    )
    // 네트워크 조회 중 자정이 지나거나 생성이 끝나도 최신 날짜/장수를 반환한다.
    const daily = getTodayGenerationUsage()
    return {
      date: daily.date,
      items: items.map((item) => ({
        ...item,
        today: daily.accounts[item.accountId] ?? { v45: 0, v5: 0 }
      }))
    }
  })

  handle('queue:enqueue', ({ request, count }) => ctx.queue.tryEnqueue(request, count))
  handle('queue:enqueueMany', ({ requests, reservation }) =>
    ctx.queue.tryEnqueueMany(requests, { reservation })
  )
  handle('queue:enqueueQuick', ({ request }) => ctx.queue.tryEnqueueQuick(request))
  handle('queue:cancel', ({ ids }) => ctx.queue.cancel(ids))
  handle('queue:reset', () => {
    ctx.queue.reset()
  })
  handle('queue:status', () => ctx.queue.status())

  // 그림체 월드컵
  handle('gpt:status', () => gpt.authStatus())
  handle('cover:list', async () => ({ items: await cover.listCoverProjects() }))
  handle('cover:create', async ({ name }) => ({ project: await cover.createCoverProject(name) }))
  handle('cover:load', async ({ id }) => ({ project: await cover.loadCoverProject(id) }))
  handle('cover:save', async ({ project }) => {
    try {
      return await cover.saveCoverProject(project)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('cover:delete', ({ id }) => cover.deleteCoverProject(id))
  handle('cover:archiveList', async () => ({ items: await cover.coverArchiveItems() }))
  handle('cover:archiveDelete', ({ id }) => coverArchive.deleteCoverArchive(id))
  handle('cover:putBlob', async ({ bytes }) => {
    try {
      return await cover.putCoverBlob(bytes)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('cover:importPaths', ({ paths }) => cover.importCoverPaths(paths))
  handle('cover:getBlob', async ({ key }) => ({ bytes: await cover.getCoverBlob(key) }))
  handle('cover:deleteBlobs', ({ keys }) => cover.deleteCoverBlobs(keys))
  handle('cover:outputDir', () => ({ dir: cover.coverOutputDir() }))
  handle('cover:pickOutputDir', async () => ({ dir: await cover.pickCoverOutputDir() }))
  handle('cover:writeOutput', async (req) => {
    try {
      return await cover.writeCoverOutput(req)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('cover:openOutput', async ({ folder }) => ({ ok: await cover.openCoverOutput(folder) }))
  handle('gpt:generate', ({ request, count }) => gpt.generate(request, count))
  handle('gpt:jobs', () => ({ jobs: gpt.listJobs() }))
  handle('gpt:cancel', ({ id }) => gpt.cancel(id))
  handle('gpt:clearFinished', () => gpt.clearFinished())
  handle('gpt:images', ({ limit, offset }) => gpt.listImages(limit, offset))
  handle('acceleration:set', ({ enabled }) => {
    if (PROFILE === 1) setSetting('acceleration_mode', enabled ? '1' : '0')
    ctx.queue.refreshConfiguration()
    return ctx.queue.status()
  })
  handle('acceleration:setAccount', ({ id, enabled }) => {
    if (PROFILE !== 1) return { ok: false, error: '가속 모드는 Custom 1에서만 쓸 수 있어요' }
    const result = setAccountAccelerated(String(id || ''), enabled === true)
    if (result.ok) ctx.queue.refreshConfiguration()
    return result
  })
  handle('anlasSpending:set', ({ enabled }) => {
    if (PROFILE === 1) setSetting('anlas_spending', enabled ? '1' : '0')
    ctx.queue.refreshConfiguration()
    return ctx.queue.status()
  })
  handle('presets:manage', ({ kind, action, ids }) => {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      !['prompt', 'scene'].includes(kind) ||
      !['duplicate', 'delete'].includes(action)
    )
      throw new Error('잘못된 프리셋 선택입니다')
    if (kind === 'scene' && action === 'delete') {
      const selectedScenes = new Set(ids.flatMap((id) => listScenes(id).map((s) => s.id)))
      if (
        ctx.queue
          .status()
          .items.some(
            (item) =>
              (item.state === 'pending' || item.state === 'generating') &&
              item.request.sceneId !== undefined &&
              selectedScenes.has(item.request.sceneId)
          )
      )
        throw new Error(
          '생성 중이거나 대기 중인 씬의 프리셋은 삭제할 수 없습니다. 큐를 먼저 완료하거나 취소하세요.'
        )
    }
    return {
      ids: kind === 'scene' ? manageScenePresets(ids, action) : managePromptPresets(ids, action)
    }
  })

  handle('images:list', ({ limit, offset, date, virtualFolderId, unfiledOnly, beforeId, since }) =>
    listImages(limit, offset, { date, virtualFolderId, unfiledOnly, beforeId, since })
  )
  handle('images:payload', ({ id }) => ({ payloadJson: getImagePayload(id) }))
  handle('library:dates', () => ({ items: listLibraryDates() }))
  handle('library:folders', () => listLibraryFolders())
  handle('library:folderCreate', ({ name, parentId }) => ({
    id: createLibraryFolder(name, parentId)
  }))
  handle('library:folderRename', ({ id, name }) => {
    renameLibraryFolder(id, name)
  })
  handle('library:folderCollapse', ({ id, collapsed }) => {
    collapseLibraryFolder(id, collapsed)
  })
  handle('library:folderMove', ({ id, parentId }) => ({
    moved: moveLibraryFolder(id, parentId)
  }))
  handle('library:folderDelete', ({ id }) => {
    deleteLibraryFolder(id)
  })
  handle('library:assign', (input) => {
    assignLibraryEntries(input)
  })
  handle('library:openStorageFolder', async () => {
    const dir = getSetting('auto_save') === '0' ? libraryRoot() : imagesRoot()
    mkdirSync(dir, { recursive: true })
    return { ok: (await shell.openPath(dir)) === '', dir }
  })

  handle('scenePresets:list', () => ({ items: listPresets(), folders: listPresetFolders() }))
  handle('scenePresets:create', ({ name, folderId }) => ({ id: createPreset(name, folderId) }))
  handle('scenePresets:rename', ({ id, name }) => {
    renamePreset(id, name)
  })
  handle('scenePresets:delete', ({ id }) => {
    // 마지막 프리셋은 지우지 않는다(deletePreset이 그냥 돌아간다) — 그때는 큐도 건드리지 않는다
    if (listPresets().length <= 1) return
    // 씬 하나 지울 때처럼 그 프리셋 씬의 대기·생성 중 항목을 취소한다 (주인 없는 그림에 Anlas를 쓰지 않게).
    // cancelScenes는 예약 출처도 잊는다 — 지워진 씬 번호를 다른 씬이 다시 받아도 예약이 붙지 않는다.
    ctx.queue.cancelScenes(
      getDb().prepare('SELECT id FROM gen_scenes WHERE preset_id = ?').pluck().all(id) as number[]
    )
    deletePreset(id)
  })
  handle('scenePresets:reorder', ({ ids }) => {
    reorderPresets(ids)
  })
  handle('scenePresets:reorderTree', ({ order }) => {
    reorderPresetTree(order)
  })
  handle('scenePresets:moveToFolder', ({ ids, folderId }) => {
    movePresetsToFolder(ids, folderId)
  })
  handle('scenePresetFolders:create', ({ name, parentId }) => ({
    id: createPresetFolder(name, parentId ?? null)
  }))
  handle('scenePresetFolders:setParent', ({ id, parentId }) =>
    setPresetFolderParent(Number(id), parentId == null ? null : Number(parentId))
  )
  handle('scenePresetFolders:rename', ({ id, name }) => {
    renamePresetFolder(id, name)
  })
  handle('scenePresetFolders:setCollapsed', ({ id, collapsed }) => {
    setPresetFolderCollapsed(id, collapsed)
  })
  handle('scenePresetFolders:delete', ({ id }) => {
    deletePresetFolder(id)
  })
  handle('scenePresets:setCharacters', ({ id, characterIds }) => {
    setPresetCharacters(id, characterIds)
  })
  handle('scenePresets:setDefaultResolution', ({ id, width, height }) => {
    setPresetDefaultResolution(id, width, height)
  })
  handle('scenePresets:openFolder', async ({ id }) => {
    const preset = listPresets().find((item) => item.id === id)
    if (!preset) return { ok: false }
    const dir = scenePresetDir(preset.name)
    mkdirSync(dir, { recursive: true })
    return { ok: (await shell.openPath(dir)) === '' }
  })
  handle('scenes:openFolder', ({ sceneId }) => {
    const scene = getScene(sceneId)
    if (!scene) return { ok: false }
    const dir = sceneDir(getPresetName(scene.presetId), scene.name, scene.id)
    if (!existsSync(dir)) return { ok: false }
    void shell.openPath(dir)
    return { ok: true }
  })
  handle('chars:duplicate', ({ id }) => ({ id: duplicateCharacter(id) }))
  handle('frags:duplicate', ({ id }) => ({ id: duplicateFragment(id) }))

  handle('promptPresets:list', () => ({ items: listPromptPresets() }))
  handle('promptPresets:create', ({ name, prompt, negativePrompt, params }) => ({
    id: createPromptPreset(name, prompt, negativePrompt, params)
  }))
  handle('promptPresets:update', ({ id, patch }) => {
    updatePromptPreset(id, patch)
  })
  handle('promptPresets:delete', ({ id }) => {
    deletePromptPreset(id)
  })
  handle('promptPresets:reorder', ({ ids }) => {
    reorderPromptPresets(ids)
  })

  handle('update:start', () => {
    startUpdateDownload()
  })
  handle('update:check', () => checkForUpdate())
  handle('update:install', () => installUpdateNow(() => ctx.queue.status()))

  handle('backup:export', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win, {
      title: '데이터 내보내기',
      defaultPath: `NAIS3-backup-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    writeFileSync(result.filePath, JSON.stringify(exportAll()))
    return { saved: true }
  })

  handle('backup:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '데이터 가져오기 (NAIS3 / NAIS2 백업)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const }
    try {
      const data = JSON.parse(readFileSync(result.filePaths[0], 'utf-8')) as Record<string, unknown>
      // 포맷 감지: NAIS3는 _app='NAIS3', NAIS2는 nais2-* 키
      if (data._app === 'NAIS3') {
        // 씬 표가 통째로 바뀐다 — 큐의 예약 출처가 엉뚱한 씬을 가리키지 않게 먼저 잊는다
        ctx.queue.forgetReservations()
        const { imported } = importAll(data)
        return { summary: `NAIS3 백업 복원 완료 (${imported}개 항목)`, needsPromptReload: true }
      }
      if (Object.keys(data).some((k) => k.startsWith('nais2-'))) {
        const r = importNais2(data)
        const parts = [
          r.characters ? `캐릭터 ${r.characters}` : '',
          r.presets ? `프리셋 ${r.presets}` : '',
          r.fragments ? `조각 ${r.fragments}` : '',
          r.scenes ? `씬 ${r.scenes}` : '',
          r.prompt ? '프롬프트' : ''
        ].filter(Boolean)
        return {
          summary: parts.length
            ? `NAIS2에서 ${parts.join(' · ')} 가져옴`
            : '가져올 항목이 없습니다',
          needsPromptReload: r.prompt
        }
      }
      return { error: '알 수 없는 백업 형식입니다' }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('scenes:list', ({ presetId }) => ({ items: listScenes(presetId) }))
  handle('scenes:create', ({ presetId, name }) => ({ id: createScene(presetId, name) }))
  handle('scenes:get', ({ id }) => ({ scene: getScene(id) }))
  handle('scenes:update', ({ id, patch }) => {
    updateScene(id, 'seed' in patch ? { ...patch, seed: normalizeSceneSeed(patch.seed) } : patch)
  })
  handle('scenes:duplicate', ({ id }) => ({ id: duplicateScene(id) }))
  handle('scenes:delete', ({ id }) => {
    ctx.queue.cancelScenes([id])
    deleteScene(id)
  })
  handle('scenes:reorder', ({ ids }) => {
    reorderScenes(ids)
  })
  handle('scenes:setReserveAll', ({ presetId, count, ids }) => {
    setReserveAll(presetId, count, ids)
  })
  handle('scenes:clearAllReservations', () => {
    clearAllReservations()
  })
  handle('scenes:adjustReserveAll', ({ presetId, delta, ids }) => {
    adjustReserveAll(presetId, delta, ids)
  })
  handle('scenes:reservedTotal', () => ({ total: reservedTotal() }))
  handle('scenes:bulkMove', ({ ids, presetId }) => {
    bulkMove(ids, presetId)
  })
  handle('scenes:bulkDelete', ({ ids }) => {
    ctx.queue.cancelScenes(ids)
    bulkDelete(ids)
  })
  handle('scenes:bulkSetResolution', ({ ids, width, height }) => {
    bulkSetResolution(ids, width, height)
  })
  handle('scenes:bulkClearFavorites', ({ ids }) => {
    bulkClearFavorites(ids)
  })
  handle('scenes:bulkClearImages', ({ ids }) => ({ deleted: bulkClearImages(ids) }))
  handle('scenes:clearCurationImages', ({ sceneId }) => {
    const active = ctx.queue
      .status()
      .items.some(
        (item) =>
          item.request.sceneId === sceneId &&
          (item.state === 'pending' || item.state === 'generating')
      )
    if (active) return { deleted: 0, error: '이 씬의 생성이 끝난 뒤 선별 없음으로 정리해주세요' }
    return clearCurationImages(sceneId)
  })
  handle('scenes:bulkExportZip', async ({ ids }) => ({ count: await bulkExportZip(ids) }))
  handle('scenes:images', ({ sceneId, limit, offset, favoritesOnly }) =>
    sceneImages(sceneId, limit, offset, favoritesOnly)
  )
  handle('scenes:deleteNonFavorites', ({ sceneId }) => ({
    deleted: deleteNonFavorites(sceneId)
  }))
  handle('images:setFavorite', ({ id, favorite }) => {
    setImageFavorite(id, favorite)
  })
  handle('images:delete', ({ id, deleteFile }) => {
    deleteImage(id, deleteFile)
  })
  handle('images:clearAll', ({ deleteFiles }) => ({ count: clearAllImages(deleteFiles) }))
  handle('scenes:exportJson', async ({ presetId }) => ({ saved: await exportScenesJson(presetId) }))
  handle('scenes:importJson', ({ presetId }) => importScenesJson(presetId))
  handle('scenes:exportZip', async ({ presetId }) => ({ count: await exportZip(presetId) }))

  handle('settings:get', ({ key }) => ({ value: getSetting(key) }))
  handle('settings:set', ({ key, value }) => {
    setSetting(key, value)
  })

  handle('chars:list', () => listCharacters())
  handle('chars:create', ({ name, folderId }) => ({ id: createCharacter(name, folderId) }))
  handle('chars:update', ({ id, patch }) => {
    updateCharacter(id, patch)
  })
  handle('chars:delete', ({ id }) => {
    deleteCharacter(id)
  })
  handle('chars:pickThumbnail', async ({ id }) => ({
    thumbnail: await pickCharacterThumbnail(id)
  }))
  handle('chars:clearThumbnail', ({ id }) => {
    clearCharacterThumbnail(id)
  })
  handle('chars:reorder', ({ order }) => {
    reorderCharacters(order)
  })
  handle('chars:folderCreate', ({ name }) => ({ id: createFolder(name) }))
  handle('chars:folderRename', ({ id, name }) => {
    renameFolder(id, name)
  })
  handle('chars:folderCollapse', ({ id, collapsed }) => {
    setFolderCollapsed(id, collapsed)
  })
  handle('chars:folderColor', ({ id, color }) => {
    setFolderColor(id, color)
  })
  handle('chars:folderDelete', ({ id }) => {
    deleteFolder(id)
  })

  handle('frags:list', () => listFragments())
  handle('frags:create', ({ name, folderId }) => ({ id: createFragment(name, folderId) }))
  handle('frags:update', ({ id, patch }) => {
    updateFragment(id, patch)
  })
  handle('frags:delete', ({ id }) => {
    deleteFragment(id)
  })
  handle('frags:importTxt', async () => ({ count: await importTxtFragments() }))
  handle('frags:exportTxt', async ({ id }) => ({ saved: await exportTxtFragment(id) }))
  handle('frags:exportAll', async () => ({ count: await exportAllFragmentsZip() }))
  handle('frags:resetSequential', () => {
    resetSequentialCounters()
  })
  handle('frags:reorder', ({ order }) => {
    reorderFragments(order)
  })
  handle('frags:folderCreate', ({ name }) => ({ id: createFragmentFolder(name) }))
  handle('frags:folderRename', ({ id, name }) => {
    renameFragmentFolder(id, name)
  })
  handle('frags:folderCollapse', ({ id, collapsed }) => {
    setFragmentFolderCollapsed(id, collapsed)
  })
  handle('frags:folderColor', ({ id, color }) => {
    setFragmentFolderColor(id, color)
  })
  handle('frags:folderDelete', ({ id }) => {
    deleteFragmentFolder(id)
  })

  handle('tags:search', ({ query, limit }) => ({ items: searchTags(query, limit) }))
  handle('tags:knowledge', ({ tags, model }) => tagKnowledge(tags, model))
  handle('tokens:count', ({ texts, model }) => {
    // 토큰 수는 실제 전송본 기준 — 조각(<이름>)·주석을 치환/제거한 결과로 센다.
    // rng 고정(항상 첫 줄)이라 결정적이고, peek이라 <*이름> 순차 카운터를 소모하지 않는다.
    const src = fragmentSource()
    return {
      counts: texts.map((t) =>
        countTokens(
          processWildcards(removeComments(t), src, () => 0, true),
          model
        )
      )
    }
  })

  handle('images:showInFolder', ({ filePath }) => {
    shell.showItemInFolder(filePath)
  })

  handle('images:saveAs', async ({ filePath }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(win, {
      title: '다른 이름으로 저장',
      defaultPath: basename(filePath),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    copyFileSync(filePath, result.filePath)
    return { saved: true }
  })

  handle('images:copy', async ({ filePath }) => {
    // nativeImage는 Windows에서 PNG·JPEG만 읽는다. webp 등은 sharp로 풀어서 넣는다.
    let img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) {
      try {
        img = nativeImage.createFromBuffer(await sharp(filePath).png().toBuffer())
      } catch {
        return { copied: false }
      }
    }
    if (img.isEmpty()) return { copied: false }
    clipboard.writeImage(img)
    return { copied: true }
  })

  // 진짜 파일을 싣는 OS 끌기. 끄는 동안 반환하지 않으므로 느린 곳 기록(handle)을 거치지 않는다.
  ipcMain.handle(
    'images:startDrag',
    async (event, { filePath }: IpcInvokeMap['images:startDrag']['req']) => {
      if (!existsSync(filePath)) return { started: false }
      try {
        const icon = nativeImage.createFromBuffer(
          await sharp(filePath).resize(128, 128, { fit: 'inside' }).png().toBuffer()
        )
        event.sender.startDrag({ file: filePath, icon })
        return { started: true }
      } catch {
        return { started: false }
      }
    }
  )

  const saveDirKey = (target?: 'main' | 'scene'): string =>
    target === 'scene' ? 'scene_save_dir' : 'save_dir'
  const saveDirOf = (target?: 'main' | 'scene'): string =>
    target === 'scene' ? scenesRoot() : imagesRoot()

  handle('settings:getSaveDir', (req) => {
    const target = req?.target
    return {
      dir: saveDirOf(target),
      isDefault: !getSetting(saveDirKey(target))?.trim()
    }
  })
  handle('settings:pickSaveDir', async (req) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: req?.target === 'scene' ? '씬 저장 폴더 선택' : '저장 폴더 선택',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { dir: null }
    setSetting(saveDirKey(req?.target), result.filePaths[0])
    return { dir: result.filePaths[0] }
  })
  handle('settings:resetSaveDir', (req) => {
    setSetting(saveDirKey(req?.target), '')
    return { dir: saveDirOf(req?.target) }
  })
  handle('gen:setDelay', ({ ms }) => {
    ctx.queue.setDelayMs(ms)
    setSetting('gen_delay_ms', String(ms))
  })

  handle('notify:done', ({ done, failed }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isFocused()) return // 보고 있는 중엔 토스트 불필요
    if (!Notification.isSupported()) return
    const body = failed > 0 ? `${done}장 완료 · ${failed}장 실패` : `${done}장 완료`
    // silent — 소리는 앱의 알림음 설정이 따로 담당 (이중 재생 방지)
    const n = new Notification({ title: 'NAIS3 생성 완료', body, silent: true })
    n.on('click', () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  })

  handle('images:saveLocal', async ({ base64, kind }) => {
    try {
      const png = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
      const saved = await saveGeneratedImage({
        png,
        sentPayload: JSON.stringify({ local: kind }),
        seed: 0,
        kind
      })
      return { filePath: saved.filePath }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:readMetadata', async ({ filePath, base64 }) => {
    try {
      if (base64) {
        const buf = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
        const meta = await metadataFromPng(buf)
        return meta ? { meta } : { error: '이 이미지에서 NAI 메타데이터를 찾지 못했습니다' }
      }
      if (filePath) {
        const row = getDb()
          .prepare(
            'SELECT b.payload_json FROM images i JOIN image_blobs b ON b.image_id = i.id WHERE i.file_path = ?'
          )
          .get(filePath) as { payload_json: string } | undefined
        const fromDb = row?.payload_json ? metadataFromPayloadJson(row.payload_json) : null
        // 1) PNG tEXt 우선. 단, 예전 저장본/포맷 변환본처럼 nais3-params 청크가 빠진 경우
        // DB payload_json의 NAIS3 로컬 메타데이터(promptParts)를 합쳐서 3분할을 복원한다.
        const buf = readFileSync(filePath)
        const fromPng = await metadataFromPng(buf)
        if (fromPng) {
          return {
            meta:
              !fromPng.promptParts && fromDb?.promptParts
                ? { ...fromPng, promptParts: fromDb.promptParts }
                : fromPng
          }
        }
        // 2) 폴백: DB payload_json (우리 스트리밍 이미지는 tEXt가 없을 수 있음)
        if (fromDb) return { meta: fromDb }
        return { error: '메타데이터를 찾지 못했습니다' }
      }
      return { error: '입력이 없습니다' }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:analyzeArtists', async ({ filePath, base64 }) => {
    try {
      let buf: Buffer | null = null
      if (base64) {
        buf = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
      } else if (filePath) {
        buf = readFileSync(filePath)
      }
      if (!buf) return { error: '입력이 없습니다' }
      const tags = await analyzeArtists(buf)
      if (tags.length === 0) return { error: '작가 태그를 찾지 못했습니다' }
      return { tags }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:upscale', async ({ imageBase64, scale }) => {
    const token = getNaiToken()
    if (!token) return { error: 'NAI 토큰이 설정되지 않았습니다' }
    try {
      const input = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
      const meta = await sharp(input).metadata()
      const png = await upscaleImage(token, {
        imageBase64: input.toString('base64'),
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        scale
      })
      const saved = await saveGeneratedImage({
        png,
        sentPayload: JSON.stringify({ upscale: scale }),
        seed: 0,
        kind: 'upscale'
      })
      void fetchAnlasBalance(token).then(({ anlas, v5Usage }) => {
        if (anlas !== null) {
          logBalance(anlas)
          broadcast('anlas:balance', { anlas, v5Usage })
        }
      })
      return { filePath: saved.filePath, base64: png.toString('base64') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('director:run', async ({ method, imageBase64, prompt, defry }) => {
    const token = getNaiToken()
    if (!token) return { error: 'NAI 토큰이 설정되지 않았습니다' }
    try {
      const input = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
      const meta = await sharp(input).metadata()
      const png = await augmentImage(token, {
        method,
        imageBase64: input.toString('base64'),
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        prompt,
        defry
      })
      const saved = await saveGeneratedImage({
        png,
        sentPayload: JSON.stringify({ director: method, prompt, defry }),
        seed: 0,
        kind: method // 툴별 kind (bg-removal 등) → 히스토리 뱃지 구분
      })
      // 잔액 갱신 (디렉터 툴도 Anlas 소모, Opus는 소형 무료)
      void fetchAnlasBalance(token).then(({ anlas, v5Usage }) => {
        if (anlas !== null) {
          logBalance(anlas)
          broadcast('anlas:balance', { anlas, v5Usage })
        }
      })
      return { filePath: saved.filePath, base64: png.toString('base64') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:readForSource', async ({ filePath }) => {
    try {
      const buf = readFileSync(filePath)
      const meta = await sharp(buf).metadata()
      return {
        base64: buf.toString('base64'),
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        censorBackupAvailable: hasCensorBackup(filePath)
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:overwriteCensor', async ({ filePath, base64 }) => {
    try {
      const result = await overwriteCensoredImage(
        filePath,
        Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64'),
        censorFolderFiles.has(censorPathKey(filePath))
      )
      broadcast('images:updated', {
        filePath,
        thumbnail: result.thumbnail,
        revision: result.revision
      })
      if (result.sceneId != null) {
        broadcast('scenes:changed', { sceneId: result.sceneId, filePath })
      }
      return {
        thumbnail: result.thumbnail,
        revision: result.revision,
        backupAvailable: result.backupAvailable
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:restoreCensor', async ({ filePath }) => {
    try {
      const result = await restoreCensoredImage(
        filePath,
        censorFolderFiles.has(censorPathKey(filePath))
      )
      broadcast('images:updated', {
        filePath,
        thumbnail: result.thumbnail,
        revision: result.revision
      })
      if (result.sceneId != null) {
        broadcast('scenes:changed', { sceneId: result.sceneId, filePath })
      }
      return { thumbnail: result.thumbnail, revision: result.revision }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('censor:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '검열할 이미지 폴더 선택',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const }
    const folderPath = result.filePaths[0]
    const supported = new Set(['.png', '.jpg', '.jpeg', '.webp'])
    const pending = [folderPath]
    const filePaths: string[] = []
    while (pending.length > 0) {
      const dir = pending.pop()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) pending.push(fullPath)
        else if (entry.isFile() && supported.has(extname(entry.name).toLowerCase())) {
          filePaths.push(fullPath)
        }
      }
    }
    filePaths.sort((a, b) => a.localeCompare(b, 'ko', { numeric: true, sensitivity: 'base' }))
    censorFolderFiles.clear()
    for (const filePath of filePaths) censorFolderFiles.add(censorPathKey(filePath))
    return { canceled: false as const, folderPath, filePaths }
  })

  // 바이브 / 캐릭터 레퍼런스 라이브러리 (공용 저장소, kind로 분기)
  handle('vibes:list', () => listVibes())
  handle('vibes:add', async ({ folderId }) => ({ count: await addRefImages('vibe', folderId) }))
  handle('vibes:addPaths', async ({ filePaths, folderId }) => ({
    count: await addRefImagePaths('vibe', filePaths, folderId)
  }))
  handle('vibes:update', ({ id, patch }) => {
    updateRefImage('vibe', id, patch)
  })
  handle('vibes:delete', ({ id }) => {
    deleteRefImage('vibe', id)
  })
  handle('vibes:duplicate', ({ id }) => ({ id: duplicateRefImage('vibe', id) }))
  handle('vibes:reorder', ({ order }) => {
    reorderRefs('vibe', order)
  })
  handle('vibes:folderCreate', ({ name }) => ({ id: createRefFolder('vibe', name) }))
  handle('vibes:folderRename', ({ id, name }) => {
    renameRefFolder('vibe', id, name)
  })
  handle('vibes:folderCollapse', ({ id, collapsed }) => {
    collapseRefFolder('vibe', id, collapsed)
  })
  handle('vibes:folderColor', ({ id, color }) => {
    colorRefFolder('vibe', id, color)
  })
  handle('vibes:folderDelete', ({ id }) => {
    deleteRefFolder('vibe', id)
  })

  handle('crefs:list', () => listCharRefs())
  handle('crefs:add', async ({ folderId }) => ({ count: await addRefImages('charref', folderId) }))
  handle('crefs:addPaths', async ({ filePaths, folderId }) => ({
    count: await addRefImagePaths('charref', filePaths, folderId)
  }))
  handle('crefs:update', ({ id, patch }) => {
    updateRefImage('charref', id, patch)
  })
  handle('crefs:delete', ({ id }) => {
    deleteRefImage('charref', id)
  })
  handle('crefs:duplicate', ({ id }) => ({ id: duplicateRefImage('charref', id) }))
  handle('crefs:reorder', ({ order }) => {
    reorderRefs('charref', order)
  })
  handle('crefs:folderCreate', ({ name }) => ({ id: createRefFolder('charref', name) }))
  handle('crefs:folderRename', ({ id, name }) => {
    renameRefFolder('charref', id, name)
  })
  handle('crefs:folderCollapse', ({ id, collapsed }) => {
    collapseRefFolder('charref', id, collapsed)
  })
  handle('crefs:folderColor', ({ id, color }) => {
    colorRefFolder('charref', id, color)
  })
  handle('crefs:folderDelete', ({ id }) => {
    deleteRefFolder('charref', id)
  })

  handle('window:control', ({ action }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else win.close()
  })

  handle('window:setBackground', ({ color }) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return
    for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(color)
  })

  ctx.queue.on('changed', (status) => broadcast('queue:changed', status))
  // 취소된 예약 생성은 씬 예약으로 돌려준다 (큐 emit 안에서 돌므로 DB 오류가 취소를 깨지 않게)
  ctx.queue.on('reservationsReturned', (returned: ReturnedReservation[]) => {
    try {
      returnReservations(returned)
      broadcast('scenes:reservesChanged', { sceneIds: returned.map((r) => r.sceneId) })
    } catch (error) {
      console.error('취소한 예약을 씬에 돌려주지 못함', error)
    }
  })
}
