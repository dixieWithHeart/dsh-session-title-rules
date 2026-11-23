/**
 * 插件装配层。本文件只做**接线**，具体实现分在 src/ 下，每文件一个职责：
 *
 *   constants.js   常量与默认值（配置契约的单一来源）
 *   normalize.js   标题归一、UTF-8 字节截断
 *   settings.js    配置读取 / 校验 / 持久化
 *   projection.js  会话投影（`session/title` → 当前标题 + 历史；首条用户消息）
 *   state.js       投影状态 → 带来源标注的视图
 *   quality.js     标题质量检查（纯函数）
 *   stats.js       轻量统计
 *   audit.js       改名审计存储
 *   tool.js        工具定义（session_title）
 *   routes.js      设置页 HTTP 路由
 *
 * 依赖方向单向：index → 各模块 → constants，模块之间不成环。
 *
 * 四条容易被踩到的装配规则：
 *   1. 可选服务必须判断存在性（`ctx.inject` / `ctx.sessionProjections` / `ctx.tools`）——
 *      缺一个就整段抛错，会把工具注册一起带走，表现为「插件 active 但什么都不工作」
 *   2. 所有注册都放进 `ctx.effect`，返回清理函数
 *   3. 工具注册要 try/catch：注册失败是静默的，不记日志就查不出来
 *   4. 不放「`enabled: false` 就 apply 早退」——那会让设置页也打不开，用户无法自行恢复
 *
 * @module dsh-session-title-rules
 */

import {
  VERSION,
  PROJECTION_KEY,
  GUIDANCE_NAME,
  GUIDANCE_ORDER,
  DEFAULT_TOOL_DESCRIPTION,
  GUIDANCE_EN,
  GUIDANCE_ZH,
  MAX_PROMPT_CHARS,
  guidanceFor,
  toolDescriptionFor,
} from './src/constants.js'
import {
  resolveOptions,
  loadSettings,
  saveSettings,
  settingsPath,
} from './src/settings.js'
import { appendAuditEdit, auditPath, loadAudit, migrateFromSettings } from './src/audit.js'
import { createProjection, initialState } from './src/projection.js'
import { readState, viewOf, currentTitleOf, markAgent, sourceLabel } from './src/state.js'
import { summarize } from './src/stats.js'
import { inspectTitle } from './src/quality.js'
import { createToolDefinition } from './src/tool.js'
import { createRoutes } from './src/routes.js'

/** Loader identity for this plugin entry. 与 patch 行 id 一致。 */
export const name = 'dsh-session-title-rules'

/** 依赖的服务：工具注册表 + 会话投影 + 宿主标题服务 + 会话存储 + 系统提示词装配。 */
export const inject = ['tools', 'sessionProjections', 'sessionTitle', 'sessions', 'systemPrompt']

export function apply (ctx, config) {
  const log = ctx.logger('dsh-session-title-rules')
  const options = resolveOptions(config)

  /** 生效设置：启动时读文件覆盖 patch 默认值，之后由设置页改写。 */
  let settings = loadSettings(log, options)
  if (!settings.enabled) log.info('disabled by saved settings')

  /**
   * 审计（Agent 改名记录）与设置分开存：
   * 设置是配置（可被重置），审计是数据。旧版的 `settings.agentEdits` 启动时迁移过来。
   */
  let audit = loadAudit(log)
  const migration = migrateFromSettings(log, settings, audit)
  audit = migration.audit
  if (migration.migrated > 0) {
    settings = { ...settings, agentEdits: [] }
    saveSettings(log, settings)
  }

  // `export const inject` 已声明依赖，这里再做一次运行时检查：服务缺席时降级而不是抛错。
  const projections = ctx.sessionProjections
  if (!projections) log.warn('sessionProjections unavailable: title history stays empty')
  const sessionTitle = ctx.sessionTitle
  if (!sessionTitle) log.warn('sessionTitle unavailable: renaming is disabled, reading may still work')

  /** 会话存储：用来给「设置页打开时还没有工具调用」的场景找活跃会话。 */
  const sessions = ctx.sessions

  /** 宿主最近一次交给我们的活跃会话（工具 / 事件 / 路由都会更新它）。 */
  let lastSession = null

  /**
   * 当前活跃会话。
   * 优先用最近一次交互记录下来的；没有就取会话存储里最新创建的一个。
   * 只记录引用、不重扫事件，所以挂在 `session/event` 上也是 O(1)。
   */
  const activeSession = () => {
    if (lastSession) return lastSession
    if (!sessions || typeof sessions.list !== 'function') return null
    try {
      const list = sessions.list()
      return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null
    } catch (e) {
      log.warn(`sessions.list failed: ${e && e.message ? e.message : e}`)
      return null
    }
  }

  // 记录活跃会话引用（不做任何扫描）；普通事件不是 waterfall，有 next 才交回。
  ctx.on('session/event', (session, _event, next) => {
    if (session) lastSession = session
    if (typeof next === 'function') return next()
  })

  // ── 投影 ──────────────────────────────────────────────────────────────
  const projection = createProjection(() => initialState())
  ctx.effect(() => {
    if (!projections) return () => {}
    return projections.register(projection)
  })

  // ── 给模型注入「怎么用这个工具」的恒定规范 ───────────────────────────────
  // 用 context() 而不是 section()：本机 persona 是 complete 形态，section 会被整体裁掉（踩坑 32）。
  // 文本必须恒定：运行时上下文快照整段比较、整段发送（踩坑 36），易变内容会拖着重发。
  const systemPrompt = ctx.systemPrompt
  if (!systemPrompt) {
    log.warn('systemPrompt unavailable: guidance not injected')
  } else {
    ctx.effect(() => systemPrompt.context({
      name: GUIDANCE_NAME,
      order: GUIDANCE_ORDER,
      // 文本里没有 {{var}} 插值，关掉以免框架把花括号当变量处理
      interpolate: false,
      text: () => (settings.injectGuidance ? guidanceFor(settings.uiLocale, settings) : ''),
    }))
  }

  const sessionIdOf = (session) => (session && typeof session.id === 'string' && session.id ? session.id : 'unknown')

  /** 当前会话的视图：当前标题 + 历史（已按来源标注）。 */
  const viewFor = (session) => {
    const state = readState({ projections, log, session })
    return viewOf({ state, settings, edits: audit.edits, sessionId: sessionIdOf(session) })
  }

  /**
   * 质量检查（纯函数）：`check` action 与 `set` 前的提示共用同一次判定。
   * 需要会话投影里的首条用户消息，用来识别「标题只是复读首条消息」。
   */
  const inspect = (session, rawTitle) => {
    const state = readState({ projections, log, session })
    return inspectTitle(rawTitle, {
      maxBytes: settings.maxBytes,
      firstUserText: state.firstUserText,
    })
  }

  /**
   * 改名（工具与页面共用）。
   * @param {object|null} session
   * @param {string} rawTitle
   * @param {'tool'|'ui'} via
   */
  const doRename = (session, rawTitle, via) => {
    if (!settings.enabled) return { ok: false, reason: 'disabled' }
    if (!session) return { ok: false, reason: 'no-session' }
    if (!sessionTitle || typeof sessionTitle.rename !== 'function') {
      return { ok: false, reason: 'title-service-unavailable' }
    }

    const state = readState({ projections, log, session })
    const inspected = inspectTitle(rawTitle, {
      maxBytes: settings.maxBytes,
      firstUserText: state.firstUserText,
    })
    if (!inspected.ok) return { ok: false, reason: inspected.reason }

    const before = currentTitleOf(state)
    const label = via === 'ui' ? 'user' : 'agent'
    // 质量检查不阻断写入：只把问题作为 warnings 交给调用方（模型 / 页面）
    const quality = {
      bytes: inspected.bytes,
      truncated: inspected.truncated,
      acceptable: inspected.acceptable,
      warnings: inspected.findings,
    }

    if (before === inspected.title) {
      return { ok: true, unchanged: true, title: inspected.title, previous: before, ...quality, label }
    }

    let snapshot
    try {
      snapshot = sessionTitle.rename(session, inspected.title)
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      log.warn(`rename failed: ${message}`)
      return { ok: false, reason: 'rename-failed', error: message }
    }

    const seq = snapshot && Number.isInteger(snapshot.eventSeq) ? snapshot.eventSeq : null
    const edit = {
      sessionId: sessionIdOf(session),
      seq,
      title: inspected.title,
      previous: before || '',
      at: new Date().toISOString(),
      via: via === 'ui' ? 'ui' : 'tool',
    }
    audit = appendAuditEdit(log, audit, edit)

    return {
      ok: true,
      title: inspected.title,
      previous: before,
      eventSeq: seq,
      ...quality,
      label,
    }
  }

  // ── 设置页展示载荷 ────────────────────────────────────────────────────
  const statePayload = () => {
    const session = activeSession()
    const sessionId = sessionIdOf(session)
    let view = { current: null, history: [], total: 0 }
    let marked = []
    try {
      if (session) {
        const state = readState({ projections, log, session })
        marked = markAgent(state.history, audit.edits, sessionId)
          .map((entry) => ({ ...entry, label: sourceLabel(entry) }))
        view = viewOf({ state, settings, edits: audit.edits, sessionId })
      }
    } catch (e) {
      log.warn(`view failed: ${e && e.message ? e.message : e}`)
    }

    return {
      version: VERSION,
      hasSession: Boolean(session),
      sessionId: session ? sessionId : '',
      current: view.current,
      total: view.total,
      // 统计用全量（不受「显示自动标题」开关影响），否则关掉开关统计会失真
      stats: summarize(marked),
      maxBytes: settings.maxBytes,
      maxPromptChars: MAX_PROMPT_CHARS,
      settingsPath: settingsPath(),
      auditPath: auditPath(),
      auditVersion: audit.version,
      injectGuidance: settings.injectGuidance,
      uiLocale: settings.uiLocale,
      guidance: settings.injectGuidance ? guidanceFor(settings.uiLocale, settings) : '',
      // 提示词自定义：生效值 + 自定义值（空 = 用默认）+ 内置默认值
      toolDescription: toolDescriptionFor(settings),
      custom: {
        toolDescription: settings.toolDescription || '',
        guidanceZh: settings.guidanceZh || '',
        guidanceEn: settings.guidanceEn || '',
      },
      defaults: {
        toolDescription: DEFAULT_TOOL_DESCRIPTION,
        guidanceZh: GUIDANCE_ZH,
        guidanceEn: GUIDANCE_EN,
      },
    }
  }

  // ── 工具 ──────────────────────────────────────────────────────────────
  // 工具描述可在设置页自定义：改了描述必须重新注册，模型才会看到新文案。
  let disposeTool = null
  const registerTool = () => {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') return
    if (typeof disposeTool === 'function') {
      try { disposeTool() } catch (e) { log.warn(`tool dispose failed: ${e && e.message ? e.message : e}`) }
      disposeTool = null
    }
    const definition = createToolDefinition({
      view: (session) => viewFor(session),
      inspect: (session, title) => inspect(session, title),
      setTitle: (session, title, via) => doRename(session, title, via || 'tool'),
      onSession: (session) => { if (session) lastSession = session },
      description: toolDescriptionFor(settings),
    })
    try {
      disposeTool = ctx.tools.register(definition)
      log.info('session_title tool registered')
    } catch (e) {
      disposeTool = null
      log.warn(`tool registration failed: ${e && e.message ? e.message : e}`)
    }
  }

  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    log.warn('tools 服务不可用：工具未注册')
  } else {
    ctx.effect(() => {
      registerTool()
      return () => {
        if (typeof disposeTool === 'function') {
          try { disposeTool() } catch { /* 已释放 */ }
          disposeTool = null
        }
      }
    })
  }

  // ── 设置页路由（宿主没 webServer 时不能崩：否则工具一起失效）──────────────────
  if (typeof ctx.inject !== 'function') {
    log.warn('webServer 不可用：设置页路由未注册')
  } else {
    ctx.inject(['webServer'], (wctx) => {
      if (!wctx || !wctx.webServer) {
        log.warn('webServer 服务未就绪：设置页路由未注册')
        return
      }
      wctx.effect(() => {
        const routes = createRoutes({
          getSettings: () => settings,
          setSettings: (next) => {
            const before = toolDescriptionFor(settings)
            settings = next
            // 工具描述变了就重注册；其它字段下一轮读 settings 即可
            if (toolDescriptionFor(next) !== before) registerTool()
          },
          persist: (next) => saveSettings(log, next),
          payload: statePayload,
          renameFromUi: (title) => doRename(activeSession(), title, 'ui'),
          setLocale: (locale) => {
            if (locale !== 'zh' && locale !== 'en') return { ok: false, reason: 'unsupported-locale' }
            if (settings.uiLocale === locale) return { ok: true, unchanged: true, locale }
            settings = { ...settings, uiLocale: locale }
            saveSettings(log, settings)
            return { ok: true, locale }
          },
          log,
        })
        // 路由兜底：未捕获异常转 500，既不让请求挂起，也不冒泡到宿主进程
        const guard = (handler) => async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            log.warn(`route failed: ${error instanceof Error ? error.message : String(error)}`)
            try {
              if (res.headersSent) {
                res.end()
              } else {
                res.writeHead(500, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: 'plugin internal error' }))
              }
            } catch { /* 连接已断，忽略 */ }
          }
        }
        const disposers = routes.map((route) => {
          try {
            return wctx.webServer.register({ ...route, handler: guard(route.handler) })
          } catch (error) {
            // 单条路由注册失败不该连累其它路由
            log.warn(`route register failed: ${route.path}: ${error instanceof Error ? error.message : String(error)}`)
            return () => {}
          }
        })
        return () => disposers.forEach((d) => d())
      })
    })
  }

  // ── 工具 ──────────────────────────────────────────────────────────────
  // 工具定义与注册已上移到路由段之前：设置页改描述时需要就地重注册。

  log.info(`ready v${VERSION} (projection ${PROJECTION_KEY}, maxBytes=${settings.maxBytes}, settings=${settingsPath()})`)
}
