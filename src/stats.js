/**
 * 统计（纯函数）。
 *
 * 页面只用一行数字：事件数 / 改名次数（Agent + 人）/ 平均字节。
 * 来源分布与按会话分组已随 0.5.0 的轻量化去掉。
 */

import { SOURCE } from './constants.js'

/**
 * 当前会话的标题统计。
 * @param {Array<object>} entries - 已标注 label 的历史条目（最新在前）
 */
export function summarize (entries) {
  const list = Array.isArray(entries) ? entries : []
  const byLabel = {
    [SOURCE.agent]: 0,
    [SOURCE.user]: 0,
    [SOURCE.provider]: 0,
    [SOURCE.fallback]: 0,
    unknown: 0,
  }
  let bytes = 0
  let lastChangeAt = null

  for (const entry of list) {
    const label = entry && typeof entry.label === 'string' && Object.hasOwn(byLabel, entry.label)
      ? entry.label
      : 'unknown'
    byLabel[label]++
    if (entry && typeof entry.title === 'string') bytes += Buffer.byteLength(entry.title, 'utf8')
    if (entry && (label === SOURCE.agent || label === SOURCE.user) && lastChangeAt === null) {
      lastChangeAt = typeof entry.time === 'number' ? entry.time : null
    }
  }

  const total = list.length
  return {
    total,
    byLabel,
    /** 人机改名合计（Agent + 用户手动） */
    changes: byLabel[SOURCE.agent] + byLabel[SOURCE.user],
    /** 自动产生（官方 provider + 首条回退） */
    automatic: byLabel[SOURCE.provider] + byLabel[SOURCE.fallback],
    avgBytes: total > 0 ? Math.round(bytes / total) : 0,
    lastChangeAt,
  }
}
