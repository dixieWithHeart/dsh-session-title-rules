/**
 * 标题文本的归一与截断。
 *
 * 宿主按 UTF-8 字节校验标题（`maxTitleBytes: 80`），而中文一个字 3 字节，
 * 所以「80 字」会超限、「80 字节」才是真实上限。截断必须逐码点进行，不能切断字符。
 */

import { MAX_INPUT_CHARS } from './constants.js'

/** 空白归一：去掉控制字符，把连续空白压成一个空格。 */
export function normalizeWhitespace (text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 按 UTF-8 字节上限截断字符串，返回 `{ text, bytes, truncated }`。
 * @param {string} text
 * @param {number} maxBytes
 */
export function truncateUtf8 (text, maxBytes) {
  const source = String(text == null ? '' : text)
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 80
  const encoder = new TextEncoder()
  let bytes = 0
  let out = ''
  for (const ch of source) {
    const size = encoder.encode(ch).length
    if (bytes + size > limit) return { text: out, bytes, truncated: true }
    out += ch
    bytes += size
  }
  return { text: out, bytes, truncated: false }
}

/**
 * 把工具/页面进来的标题整理成可落盘的形式。
 * @returns {{ ok: boolean, title: string, bytes: number, truncated: boolean, reason?: string }}
 */
export function prepareTitle (raw, maxBytes) {
  if (typeof raw !== 'string') return { ok: false, title: '', bytes: 0, truncated: false, reason: 'title-must-be-a-string' }
  const trimmed = normalizeWhitespace(raw.slice(0, MAX_INPUT_CHARS))
  if (!trimmed) return { ok: false, title: '', bytes: 0, truncated: false, reason: 'title-is-empty' }
  const cut = truncateUtf8(trimmed, maxBytes)
  if (!cut.text) return { ok: false, title: '', bytes: 0, truncated: false, reason: 'title-too-long-for-bytes' }
  return { ok: true, title: cut.text, bytes: cut.bytes, truncated: cut.truncated }
}
