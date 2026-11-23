/**
 * 状态读取层：投影裸状态 → 设置页与工具能直接用的视图。
 *
 * 来源标注是这里的核心：
 * 宿主只把标题来源分成 `fallback`（首条消息回退）、`provider`（官方 LLM 生成）、`user`（显式改名），
 * 而**Agent 调工具改名也是 `user`**——`rename()` 不接受自定义来源。
 * 所以「Agent 改的」与「人改的」只能靠插件自己的记账、按 `eventSeq` 对齐来区分。
 */

import { PROJECTION_KEY, SOURCE } from './constants.js'
import { initialState } from './projection.js'

/** 读某个会话的实时投影状态；投影缺席时退回初始状态而不是抛错。 */
export function readState ({ projections, log, session }) {
  if (!projections || !session) return initialState()
  try {
    const state = projections.stateOf(session, PROJECTION_KEY)
    return state || initialState()
  } catch (e) {
    log.warn(`projection read failed: ${e && e.message ? e.message : e}`)
    return initialState()
  }
}

function editKey (sessionId, seq) {
  return String(sessionId) + ':' + String(seq)
}

/**
 * 给历史条目打上「这次是 Agent 改的」标记。
 * @param {Array<object>} entries - 最新在前
 * @param {Array<object>} edits - 插件记账（含 sessionId / seq / via）
 * @param {string} sessionId
 */
export function markAgent (entries, edits, sessionId) {
  const keys = new Set(
    (Array.isArray(edits) ? edits : [])
      // 只有工具调用（via=tool）算「Agent 改的」；页面手动改名（via=ui）仍归用户
      .filter((edit) => edit && edit.via === 'tool' && edit.sessionId === sessionId && edit.seq !== null && edit.seq !== undefined)
      .map((edit) => editKey(sessionId, edit.seq)),
  )
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    byAgent: entry.kind === SOURCE.user && keys.has(editKey(sessionId, entry.seq)),
  }))
}

/** 来源的展示标签（工具与设置页共用同一套文案键）。 */
export function sourceLabel (entry) {
  if (!entry) return 'unknown'
  if (entry.byAgent) return SOURCE.agent
  if (entry.kind === SOURCE.provider) return SOURCE.provider
  if (entry.kind === SOURCE.fallback) return SOURCE.fallback
  if (entry.kind === SOURCE.user) return SOURCE.user
  return 'unknown'
}

/**
 * 组装视图。
 * @param {object} deps
 * @param {object} deps.state - 投影状态
 * @param {object} deps.settings - 生效设置
 * @param {Array<object>} deps.edits - Agent 改名记录
 * @param {string} deps.sessionId
 */
export function viewOf ({ state, settings, edits, sessionId }) {
  const s = state || initialState()
  const marked = markAgent(s.history, edits, sessionId)
  const current = marked.length > 0 ? marked[0] : null
  const history = settings && settings.showProviderTitles === false
    ? marked.filter((entry) => entry.kind === SOURCE.user)
    : marked
  return {
    current: current ? { ...current, label: sourceLabel(current) } : null,
    history: history.map((entry) => ({ ...entry, label: sourceLabel(entry) })),
    total: marked.length,
  }
}

/** 当前标题的简短文本，供工具输出与页面标题位使用。 */
export function currentTitleOf (state) {
  const s = state || initialState()
  return typeof s.title === 'string' ? s.title : null
}
