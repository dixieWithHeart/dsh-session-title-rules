/**
 * 标题质量检查（纯函数）。
 *
 * 检查结果**不阻断**写入：`set` 把 findings 作为 `warnings` 回给模型，`check` 只是预演。
 * 理由：标题好不好是判断题，硬拒绝会让模型反复试错；而空标题、不可编码这类确定性错误
 * 已由 `prepareTitle()` 拒绝。
 *
 * 六条规则（也是输出顺序）：
 *   over-bytes           超过字节上限，已被截断
 *   symbols-only         没有任何字母 / 数字 / 汉字
 *   too-short            实义字符少于 QUALITY_MIN_CHARS
 *   too-long             字符数超过 QUALITY_MAX_CHARS（且未被字节截断）
 *   looks-like-path      像文件路径或文件名
 *   echoes-first-message 只是把首条用户消息复读一遍
 */

import { FIRST_MESSAGE_MAX_CHARS, QUALITY_MAX_CHARS, QUALITY_MIN_CHARS } from './constants.js'
import { normalizeWhitespace, prepareTitle } from './normalize.js'

/** 规则码：给模型与测试的稳定标识，不随提示文案变化。 */
export const QUALITY_RULE = {
  overBytes: 'over-bytes',
  symbolsOnly: 'symbols-only',
  tooShort: 'too-short',
  tooLong: 'too-long',
  looksLikePath: 'looks-like-path',
  echoesFirstMessage: 'echoes-first-message',
}

/** 有意义字符：字母（含 CJK）、数字。标点、符号、emoji 不算。 */
const MEANINGFUL = /[\p{L}\p{N}]/u

/** 比较时忽略的字符：标点、符号、空白。 */
const IGNORED = /[\p{P}\p{S}\s]/gu

/**
 * 路径形态。刻意保守，宁可漏判也不把正常标题当路径：
 *   · 盘符 / UNC 必须以开头或空白为界
 *   · 文件后缀单独成词
 *   · 斜杠至少两段（`a/b` 不算，`plugins/x/src` 算）
 */
const PATH_PATTERNS = [
  /(?:^|[\s(（[【"'“])(?:[A-Za-z]:[\\/]|\\\\)/,
  /(?:^|[\s(（[【"'“])~\.[\\/]/,
  /(?:^|[\s(（[【"'“])\/[\w.-]+\//,
  /\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|rs|go|java|yml|yaml|toml|ini|log|txt|png|jpe?g|gif|svg|zip|exe|dsh)\b/i,
  /[\w.-]+[\\/][\w.-]+[\\/][\w.-]+/,
]

/** 有意义的字符数。 */
export function meaningfulLength (text) {
  let count = 0
  for (const ch of String(text == null ? '' : text)) if (MEANINGFUL.test(ch)) count++
  return count
}

/** 纯符号：没有字母 / 数字 / 汉字。 */
export function isSymbolsOnly (text) {
  return meaningfulLength(text) === 0
}

/** 像文件路径或文件名。 */
export function looksLikePath (text) {
  const value = String(text == null ? '' : text)
  return PATH_PATTERNS.some((pattern) => pattern.test(value))
}

/** 归一化到可比较内核：小写、去空白与标点。 */
function coreOf (text) {
  return normalizeWhitespace(text).toLowerCase().replace(IGNORED, '')
}

/**
 * 标题是否只是首条用户消息的复读。
 * 只认「标题是首条的开头」或「标题把整条首条包住」两种，避免把摘要误判成复读。
 */
export function echoesFirstMessage (title, firstUserText) {
  if (typeof firstUserText !== 'string') return false
  const head = coreOf(firstUserText).slice(0, FIRST_MESSAGE_MAX_CHARS)
  const candidate = coreOf(title)
  if (candidate.length < QUALITY_MIN_CHARS || head.length < QUALITY_MIN_CHARS) return false
  if (head.startsWith(candidate)) return true
  return candidate.length > head.length && candidate.includes(head) && head.length >= QUALITY_MIN_CHARS * 2
}

function finding (code, message) {
  return { code, severity: 'warn', message }
}

/**
 * 检查已经过 `prepareTitle()` 的标题。
 * @param {{ ok: boolean, title: string, bytes: number, truncated: boolean }} prepared
 * @param {{ firstUserText?: string|null, maxBytes?: number }} [options]
 * @returns {{ findings: Array<object>, acceptable: boolean }}
 */
export function inspectPrepared (prepared, options = {}) {
  if (!prepared || prepared.ok !== true) return { findings: [], acceptable: false }
  const title = prepared.title
  const findings = []
  const bytes = prepared.bytes
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : bytes

  if (prepared.truncated) {
    findings.push(finding(
      QUALITY_RULE.overBytes,
      `Title exceeds the ${maxBytes}-byte cap and was truncated to ${bytes} bytes; shorten it.`,
    ))
  }

  if (isSymbolsOnly(title)) {
    findings.push(finding(
      QUALITY_RULE.symbolsOnly,
      'Title has no letters, digits or CJK characters; use words instead of symbols.',
    ))
  } else if (meaningfulLength(title) < QUALITY_MIN_CHARS) {
    findings.push(finding(
      QUALITY_RULE.tooShort,
      `Title has fewer than ${QUALITY_MIN_CHARS} meaningful characters; make it descriptive.`,
    ))
  }

  if (!prepared.truncated && [...title].length > QUALITY_MAX_CHARS) {
    findings.push(finding(
      QUALITY_RULE.tooLong,
      `Title is longer than ${QUALITY_MAX_CHARS} characters; shorten it.`,
    ))
  }

  if (looksLikePath(title)) {
    findings.push(finding(
      QUALITY_RULE.looksLikePath,
      'Title looks like a file path or file name; describe the topic instead.',
    ))
  }

  if (echoesFirstMessage(title, options.firstUserText)) {
    findings.push(finding(
      QUALITY_RULE.echoesFirstMessage,
      'Title repeats the opening user message; summarize the topic instead.',
    ))
  }

  return { findings, acceptable: findings.length === 0 }
}

/**
 * 从原始输入开始检查：先归一截断，再跑规则。
 * @param {string} raw
 * @param {{ maxBytes?: number, firstUserText?: string|null }} [options]
 */
export function inspectTitle (raw, options = {}) {
  const prepared = prepareTitle(raw, options.maxBytes)
  if (!prepared.ok) return { ...prepared, findings: [], acceptable: false }
  return { ...prepared, ...inspectPrepared(prepared, options) }
}
