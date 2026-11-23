/**
 * 工具定义：给模型一个直接控制会话标题的入口。
 *
 * 宿主 `ctx.tools.register()` 的硬契约（缺一样就注册失败，表现为「插件 active 但工具不存在」）：
 *   · `output` 必须存在，且 `output.render` 是函数
 *   · `parameters` 是原生 JSON Schema 本体，不是 defineTool 的 spec 简写
 *   · `output.schema` 走受支持子集：object 必须显式写 `additionalProperties`，
 *     属性上不能出现 `required: true`（那是父级 `required` 数组）
 *   · `execute` 的返回值按 `output.schema` 校验并做 lossless JSON 快照
 */

import { DEFAULT_TOOL_DESCRIPTION } from './constants.js'

/**
 * @param {object} deps
 * @param {(session: object) => object} deps.view - 当前标题与历史
 * @param {(session: object, title: string) => object} deps.inspect - 候选标题的质量检查（不写入）
 * @param {(session: object, title: string, via: string) => object} deps.setTitle - 改名
 * @param {(session: object) => void} deps.onSession - 记录当前活跃会话
 * @param {string} [deps.description] - 模型看到的工具描述（设置页可自定义）
 */
export function createToolDefinition ({ view, inspect, setTitle, onSession, description }) {
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'check', 'history'],
        description: 'get = current title and where it came from; set = rename to the given title; check = evaluate a candidate title without writing anything; history = previous titles with their origin.',
      },
      title: {
        type: 'string',
        description: 'For set and check: the title text. Over the byte cap it is truncated at a character boundary.',
      },
      limit: {
        type: 'integer',
        description: 'For history: how many entries to return (default 10, max 50).',
      },
    },
    required: ['action'],
  }

  const execute = async (args, exec) => {
    const session = exec && exec.agent ? exec.agent.session : null
    if (session && onSession) onSession(session)
    if (!session) return { ok: false, reason: 'No active session in this call.' }

    const action = args && typeof args.action === 'string' ? args.action : 'get'

    if (action === 'get') {
      const v = view(session)
      return {
        ok: true,
        action,
        current: v.current,
        historySize: v.history.length,
      }
    }

    if (action === 'history') {
      const limit = Number.isInteger(args && args.limit) ? Math.max(1, Math.min(50, args.limit)) : 10
      const v = view(session)
      return {
        ok: true,
        action,
        current: v.current,
        items: v.history.slice(0, limit),
        total: v.total,
      }
    }

    if (action === 'check') {
      const title = args && typeof args.title === 'string' ? args.title : ''
      const result = typeof inspect === 'function'
        ? inspect(session, title)
        : { ok: false, reason: 'inspect-unavailable' }
      // ok 只表示「检查这个动作完成了」；valid 才是「标题可以写入」，避免与 set 的 ok 混淆。
      // 注意：返回值会做 lossless JSON 快照，不能带 undefined 键（成功时没有 reason）。
      const checked = {
        ok: true,
        action,
        valid: result.ok === true,
        title: typeof result.title === 'string' ? result.title : '',
        bytes: Number.isFinite(result.bytes) ? result.bytes : 0,
        truncated: result.truncated === true,
        acceptable: result.acceptable === true,
        findings: Array.isArray(result.findings) ? result.findings : [],
      }
      if (typeof result.reason === 'string') checked.reason = result.reason
      return checked
    }

    if (action === 'set') {
      const title = args && typeof args.title === 'string' ? args.title : ''
      return { ok: true, action, ...setTitle(session, title, 'tool') }
    }

    if (action === 'restore') {
      return { ok: false, reason: 'restore was removed; call history first, then set the title you want back.' }
    }

    return { ok: false, reason: `Unknown action "${action}". Use get / set / check / history.` }
  }

  return {
    name: 'session_title',
    description: typeof description === 'string' && description.trim() ? description.trim() : DEFAULT_TOOL_DESCRIPTION,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute,
  }
}
