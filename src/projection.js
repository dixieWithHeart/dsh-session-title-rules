/**
 * 会话投影：把 `session/title` 事件折成「当前标题 + 历史」。
 *
 * 依据官方 practices：由日志派生的每会话状态放 `ctx.sessionProjections`，
 * 不要订阅 `session/event` 再重扫 `session.events`。
 *
 * 宿主强制的契约（破坏任一条都会让投影静默失效）：
 *   · `apply` 必须同步
 *   · 与本单位无关的事件**返回同一引用**
 *   · `stateSchema.parse` 用来校验检查点里恢复出来的状态
 */

import { FIRST_MESSAGE_MAX_CHARS, MAX_HISTORY, PROJECTION_KEY } from './constants.js'
import { normalizeWhitespace } from './normalize.js'

/**
 * 状态 schema。
 * 宿主只调用 `.parse()`（schemastery 风格）；为一次形状校验引入 schemastery 依赖不值得，
 * 故手写最小实现。
 */
export const stateSchema = {
  parse (value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('dsh-session-title-rules: projection state must be a plain object')
    }
    return value
  },
}

/** 空状态。`firstUserText` 供质量检查判断「标题是不是复读首条消息」。 */
export function initialState () {
  return { title: null, kind: null, time: null, history: [], firstUserText: null }
}

/**
 * 从 `user/message` 事件里取首条真人消息的文本。
 *
 * 字段依据宿主源码（`dsh-session-title/src/index.ts` 的 `sessionTitleUserMessageOf`）：
 * `data.source.kind === 'user'` 才是人发的；文本在 `data.content` 的 text 块里。
 * 子 agent、系统消息都不算「首条用户消息」。
 */
export function firstUserTextOf (event) {
  if (!event || event.type !== 'user/message') return null
  const data = event.data
  if (!data || !data.source || data.source.kind !== 'user') return null
  const content = Array.isArray(data.content) ? data.content : []
  const text = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  const clean = normalizeWhitespace(text).slice(0, FIRST_MESSAGE_MAX_CHARS)
  return clean || null
}

/** 从一个 `session/title` 事件里抽出一条历史记录。 */
export function entryOf (event) {
  if (!event || event.type !== 'session/title') return null
  const data = event.data
  if (!data || typeof data.title !== 'string' || data.title.length === 0) return null
  const source = data.source && typeof data.source === 'object' ? data.source : null
  return {
    seq: typeof event.seq === 'number' ? event.seq : null,
    time: typeof event.time === 'number' ? event.time : null,
    title: data.title,
    kind: source && typeof source.kind === 'string' ? source.kind : 'unknown',
    provider: source && typeof source.provider === 'string' ? source.provider : null,
    model: source && source.model && typeof source.model.model === 'string' ? source.model.model : null,
  }
}

export function createProjection (initial) {
  return {
    key: PROJECTION_KEY,
    // 3：新增 firstUserText（首条用户消息），折叠输入变了必须升版，旧检查点会被丢弃重放
    stateVersion: 3,
    stateSchema,
    init: () => initial(),
    apply: (state, event) => {
      if (event && event.type === 'user/message') {
        // 只记首条；已有记录后所有 user/message 都返回同一引用
        if (typeof state.firstUserText === 'string' && state.firstUserText.length > 0) return state
        const first = firstUserTextOf(event)
        if (!first) return state
        return { ...state, firstUserText: first }
      }
      const entry = entryOf(event)
      if (!entry) return state
      const history = [entry, ...(Array.isArray(state.history) ? state.history : [])].slice(0, MAX_HISTORY)
      return { title: entry.title, kind: entry.kind, time: entry.time, firstUserText: state.firstUserText ?? null, history }
    },
  }
}
