/**
 * 配置的读取、校验与持久化。
 *
 * 两个来源，优先级从低到高：
 *   1. Host 行（cordis.patch.yml）的 `config`
 *   2. `$DSH_HOME/<SETTINGS_FILENAME>`（设置页写入 + 插件的改名记账）
 * 全部经 `sanitize()` 过滤：只接受已知字段、类型不对就忽略，不抛错。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SETTINGS_FILENAME, DEFAULTS, MAX_EDITS, MAX_PROMPT_CHARS, MAX_TITLE_BYTES, MIN_TITLE_BYTES } from './constants.js'

export function settingsPath () {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, SETTINGS_FILENAME)
}

function clampBytes (value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(MIN_TITLE_BYTES, Math.min(MAX_TITLE_BYTES, Math.floor(n)))
}

/** 改名记账条目：只接受结构完整的，坏条目整条丢弃（空数组合法）。 */
export function sanitizeEdits (raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const item of raw.slice(0, MAX_EDITS)) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.sessionId !== 'string' || item.sessionId.length === 0) continue
    if (item.seq !== null && !Number.isInteger(item.seq)) continue
    if (typeof item.title !== 'string' || item.title.length === 0) continue
    out.push({
      sessionId: item.sessionId,
      seq: Number.isInteger(item.seq) ? item.seq : null,
      title: item.title.slice(0, 200),
      previous: typeof item.previous === 'string' ? item.previous.slice(0, 200) : '',
      at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
      via: item.via === 'ui' ? 'ui' : 'tool',
    })
  }
  return out
}

/** 用 base 兜底，只覆盖 raw 里合法且已知的字段。新增设置项时在这里加一行。 */
export function sanitize (raw, base) {
  const o = {
    ...base,
    agentEdits: Array.isArray(base && base.agentEdits) ? base.agentEdits : DEFAULTS.agentEdits,
  }
  if (!raw || typeof raw !== 'object') return o

  if (typeof raw.enabled === 'boolean') o.enabled = raw.enabled
  if (typeof raw.showProviderTitles === 'boolean') o.showProviderTitles = raw.showProviderTitles
  if (typeof raw.injectGuidance === 'boolean') o.injectGuidance = raw.injectGuidance
  if (raw.uiLocale === 'zh' || raw.uiLocale === 'en') o.uiLocale = raw.uiLocale

  const bytes = clampBytes(raw.maxBytes)
  if (bytes !== null) o.maxBytes = bytes

  // 自定义提示词：空串是合法值（= 恢复默认），所以只校验类型并截断，不判空
  for (const key of ['toolDescription', 'guidanceZh', 'guidanceEn']) {
    if (typeof raw[key] === 'string') o[key] = raw[key].slice(0, MAX_PROMPT_CHARS)
  }

  // 记账只由服务端写；客户端提交时若带了也接受，但必须整条合法
  const edits = sanitizeEdits(raw.agentEdits)
  if (edits !== null) o.agentEdits = edits
  return o
}

export function loadSettings (log, defaults) {
  try {
    const file = settingsPath()
    if (!fs.existsSync(file)) return { ...defaults, agentEdits: [] }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return sanitize(parsed, defaults)
  } catch (e) {
    log.warn(`settings load failed: ${e && e.message ? e.message : e}`)
    return { ...defaults, agentEdits: [] }
  }
}

export function saveSettings (log, settings) {
  try {
    const file = settingsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(settings, null, 2))
    return true
  } catch (e) {
    log.warn(`settings save failed: ${e && e.message ? e.message : e}`)
    return false
  }
}

/** 追加一条改名记录（最新在前），返回新的数组；调用方负责落盘。 */
export function appendEdit (edits, edit) {
  const next = [edit, ...(Array.isArray(edits) ? edits : [])]
  return next.slice(0, MAX_EDITS)
}

/**
 * 合并默认值 + 对明显的配置错误 fail-loud。
 *
 * 这里**故意抛错**：patch 里把类型写错属于开发者失误，静默兜底会让人以为配置生效了。
 */
export function resolveOptions (raw) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError('dsh-session-title-rules: config must be a mapping')
  }
  const o = { ...DEFAULTS, ...(raw || {}) }
  if (typeof o.enabled !== 'boolean') {
    throw new TypeError('dsh-session-title-rules: enabled must be a boolean')
  }
  const bytes = clampBytes(o.maxBytes)
  return {
    ...o,
    maxBytes: bytes === null ? MAX_TITLE_BYTES : bytes,
    agentEdits: sanitizeEdits(o.agentEdits) || [],
  }
}
