/**
 * 改名审计的独立存储。
 *
 * 为什么不放设置文件：设置页的 `/set` 是「整份白名单合并」的语义，用户重置设置、
 * 或将来加「恢复默认」按钮时，会把审计记录一起冲掉。审计是**数据**，不是配置，
 * 单独一个文件（`dsh-session-title-audit.json`）并与设置解耦。
 *
 * 这里只做读写与迁移，条目校验复用 settings.js 的 `sanitizeEdits`（同一套白名单）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MAX_EDITS } from './constants.js'
import { appendEdit, sanitizeEdits } from './settings.js'

export const AUDIT_FILENAME = 'dsh-session-title-audit.json'
export const AUDIT_VERSION = 1

export function auditPath () {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, AUDIT_FILENAME)
}

function emptyAudit () {
  return { version: AUDIT_VERSION, edits: [] }
}

export function loadAudit (log) {
  try {
    const file = auditPath()
    if (!fs.existsSync(file)) return emptyAudit()
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const edits = sanitizeEdits(parsed && parsed.edits) || []
    return { version: AUDIT_VERSION, edits }
  } catch (e) {
    log.warn(`audit load failed: ${e && e.message ? e.message : e}`)
    return emptyAudit()
  }
}

export function saveAudit (log, audit) {
  try {
    const file = auditPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: AUDIT_VERSION, edits: audit.edits }, null, 2))
    return true
  } catch (e) {
    log.warn(`audit save failed: ${e && e.message ? e.message : e}`)
    return false
  }
}

/** 追加一条记录并落盘，返回新的审计对象。 */
export function appendAuditEdit (log, audit, edit) {
  const next = { version: AUDIT_VERSION, edits: appendEdit(audit.edits, edit) }
  saveAudit(log, next)
  return next
}
/**
 * 0.2.x 的旧账存在设置文件的 `agentEdits` 里；审计文件为空时把它们迁过来。
 * 迁移成功后调用方应把设置里的旧账清空，避免两份数据继续漂移。
 * @returns {{ audit: object, migrated: number }}
 */
export function migrateFromSettings (log, settings, audit) {
  if (audit.edits.length > 0) return { audit, migrated: 0 }
  const legacy = sanitizeEdits(settings && settings.agentEdits) || []
  if (legacy.length === 0) return { audit, migrated: 0 }
  const next = { version: AUDIT_VERSION, edits: legacy.slice(0, MAX_EDITS) }
  saveAudit(log, next)
  log.info(`migrated ${legacy.length} audit entries from settings to ${AUDIT_FILENAME}`)
  return { audit: next, migrated: legacy.length }
}
