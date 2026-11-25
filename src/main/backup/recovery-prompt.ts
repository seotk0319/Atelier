import { app, dialog } from 'electron'
import { backupBeforeRestore, closeDb, getDb, initDb, recoveryPaths } from '../db'
import { getSetting, setSetting } from '../db/settings'
import { COUNT_LABELS, findRecoveryNotice, KIND_LABELS, restoreBackup } from './recovery'
import type { WorkspaceCounts } from './recovery'

/** 「그대로 쓰기」를 고른 백업 (경로·크기·수정 시각) — 같은 파일이면 다시 묻지 않는다 */
const DISMISSED_KEY = 'recovery_notice_dismissed'

/**
 * 시작할 때 작업 공간이 비었는데 앱이 남긴 백업에는 데이터가 있으면, 창을 띄우기 전에 묻는다.
 * 되돌리기를 고르면 지금 DB를 backups\pre-restore\에 남기고 백업으로 바꾼 뒤 앱을 다시 시작한다.
 * 다시 시작하면 true — 호출한 쪽은 이어서 아무것도 하지 않는다.
 */
export async function offerRecovery(): Promise<boolean> {
  let notice: ReturnType<typeof findRecoveryNotice>
  try {
    notice = findRecoveryNotice(getDb(), recoveryPaths(), getSetting(DISMISSED_KEY))
  } catch {
    return false
  }
  if (!notice) return false

  const counts = (Object.entries(notice.counts) as [keyof WorkspaceCounts, number][])
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${COUNT_LABELS[key]} ${n.toLocaleString('ko-KR')}`)
    .join(' · ')
  const date = new Date(notice.createdAt).toLocaleString('ko-KR')
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: app.getName(),
    message: '작업 데이터가 비어 있어요',
    detail:
      `앱이 남겨 둔 백업에는 데이터가 있어요.\n\n${KIND_LABELS[notice.kind]} · ${date}\n${counts}\n\n` +
      '되돌리면 지금 상태도 따로 백업해 두고 앱을 다시 시작해요.',
    buttons: ['이 백업으로 되돌리기', '그대로 쓰기'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (response !== 0) {
    setSetting(DISMISSED_KEY, notice.key)
    return false
  }
  try {
    restoreBackup(notice, recoveryPaths(), {
      current: getDb,
      snapshotCurrent: () => void backupBeforeRestore(),
      close: closeDb,
      reopen: () => void initDb()
    })
  } catch (e) {
    dialog.showErrorBox('되돌리지 못했어요', e instanceof Error ? e.message : String(e))
    return false
  }
  app.relaunch()
  app.exit(0)
  return true
}
