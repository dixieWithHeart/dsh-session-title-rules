/**
 * 结构契约冒烟测试。
 *
 * 目的不是证明业务算得对，而是证明**装配满足宿主契约**：
 *   · apply 在 mock ctx 上跑得通（缺服务时降级而不是抛错）
 *   · 投影单元：key / stateVersion / init 返回新对象 / 无关事件返回同一引用
 *   · 工具定义：output.render 是函数、parameters 是原生 JSON Schema、schema 在支持子集内
 *   · 路由：kind exact、路径以 /api/ 开头、GET 与 POST 分支都能出响应
 *   · 每轮注入：同一回合只投一条，换回合再投
 *   · 静态自洽：client.js 的模块 id 等于包名、样式对象里引用的每个键都真的定义了、locale 可解析
 *
 * 复制到新插件后，除了工具名与事件名，这些断言都仍然成立。
 * 用法：node tools/smoke-test.mjs [index.js 路径]
 *
 * 设计约束：被测对象损坏时本脚本必须给出 FAIL 明细，而不是自己崩掉。
 * 因此所有断言段都做了存在性守卫，主流程整体包在 try/catch 里，报告总在 finally 输出。
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 设置文件会写到 $DSH_HOME/<SETTINGS_FILENAME>，测试必须重定向到临时目录
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'plugin-smoke-'))

const ENTRY = process.argv[2] ?? fileURLToPath(new URL('../index.js', import.meta.url))
const ROOT = dirname(ENTRY)

const results = []
const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail || '' })

// ---- 受支持 JSON Schema 子集（复刻宿主 assertSupportedJsonSchema 的关键规则）------------
const ALLOWED_KEYS = new Set(['type', 'properties', 'additionalProperties', 'required', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples', 'oneOf'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function schemaViolations (node, path, isProperty, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} 必须是对象`)
    return out
  }
  for (const k of Object.keys(node)) if (!ALLOWED_KEYS.has(k)) out.push(`${path}.${k} 不在支持子集内`)
  if (node.type !== undefined && !TYPES.has(node.type)) out.push(`${path}.type 非法：${node.type}`)
  if (isProperty && Object.hasOwn(node, 'required')) out.push(`${path}.required 是 spec 语法，raw schema 不允许出现在属性上`)
  if (Object.hasOwn(node, 'oneOf') && Object.hasOwn(node, 'type')) out.push(`${path} 不能同时有 type 与 oneOf`)
  if (node.type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') out.push(`${path}.additionalProperties 必须是显式布尔`)
    for (const [k, v] of Object.entries(node.properties || {})) schemaViolations(v, `${path}.properties.${k}`, true, out)
  }
  if (node.type === 'array' && node.items !== undefined) schemaViolations(node.items, `${path}.items`, false, out)
  return out
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// ---- mock 宿主 ------------------------------------------------------------------------
const logs = { info: [], warn: [] }
const makeLogger = () => ({
  info: (m) => logs.info.push(String(m)),
  warn: (m) => logs.warn.push(String(m)),
  error: (m) => logs.warn.push(String(m)),
  debug: () => {},
})

const HTTP_REQ = (method, body) => ({
  method,
  [Symbol.asyncIterator]: async function * () {
    if (body !== undefined) yield Buffer.from(body)
  },
})
const HTTP_RES = () => {
  const out = { status: null, headers: null, body: '' }
  return {
    out,
    writeHead: (status, headers) => { out.status = status; out.headers = headers || null },
    end: (chunk) => { if (chunk !== undefined) out.body += String(chunk) },
  }
}

/**
 * 造一个 mock ctx。
 * @param {object} opts
 * @param {boolean} opts.withProjections - 是否提供 sessionProjections 服务
 * @param {boolean} opts.withWebServer - 是否提供 ctx.inject + webServer
 * @param {boolean} opts.withTools - 是否提供 ctx.tools
 */
function makeCtx ({ withProjections = true, withWebServer = true, withTools = true, withSessions = true, withSystemPrompt = true } = {}) {
  const captured = { projection: null, tool: null, toolRegistrations: [], routes: [], listeners: {}, effects: 0, cells: new Map(), renames: [], contexts: [] }
  const ctx = {
    logger: makeLogger,
    effect: (fn) => { captured.effects++; const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (event, handler) => { captured.listeners[event] = handler; return () => {} },
    // 宿主标题服务：rename 是唯一写入口，测试只记录调用
    sessionTitle: {
      rename: (session, title) => {
        captured.renames.push({ sessionId: session && session.id, title })
        return { eventSeq: captured.nextSeq ?? captured.renames.length, title }
      },
      get: () => undefined,
      refresh: () => undefined,
      register: () => () => {},
    },
    // 会话存储：设置页在还没收到工具调用时用它找活跃会话
  }
  if (withSessions) {
    ctx.sessions = {
      list: () => [{ id: 's-list', header: {} }],
      get: () => null,
    }
  }
  if (withSystemPrompt) {
    ctx.systemPrompt = {
      context: (definition) => { captured.contexts.push(definition); return () => {} },
    }
  }
  if (withWebServer) {
    ctx.inject = (names, cb) => {
      cb({
        effect: ctx.effect,
        webServer: { register: (route) => { captured.routes.push(route); return () => {} } },
      })
    }
  }
  if (withTools) {
    ctx.tools = {
      register: (def) => {
        captured.tool = def
        captured.toolRegistrations.push(def)
        return () => {}
      },
    }
  }
  if (withProjections) {
    ctx.sessionProjections = {
      register: (unit) => { captured.projection = unit; return () => {} },
      stateOf: (session, key) => {
        if (!captured.projection || key !== captured.projection.key) return null
        if (!captured.cells.has(session)) captured.cells.set(session, captured.projection.init())
        return captured.cells.get(session)
      },
      /** 测试辅助：把事件喂给投影单元（首次先建 cell） */
      feed: (session, event) => {
        if (!captured.cells.has(session)) captured.cells.set(session, captured.projection.init())
        captured.cells.set(session, captured.projection.apply(captured.cells.get(session), event))
      },
    }
  }
  return { ctx, captured }
}

const makeAgent = () => {
  const notices = []
  return {
    session: {},
    status: 'running',
    notices,
    steer: (m) => notices.push(m),
    inject: (m) => notices.push(m),
  }
}

// ---- 静态自洽检查（不依赖宿主）---------------------------------------------------------
function staticChecks () {
  // 1. package.json 可解析，且 client.js 的模块 id 必须等于包名
  let pkg = null
  try { pkg = readJson(join(ROOT, 'package.json')) } catch (e) {
    check('package.json 可解析', false, String(e.message))
  }
  if (pkg) {
    check('package.json 可解析', true, pkg.name)

    let clientSrc = null
    try { clientSrc = readFileSync(join(ROOT, 'client.js'), 'utf8') } catch { /* 没有 client.js 的纯宿主插件也算合法 */ }
    if (clientSrc) {
      const idMatch = clientSrc.match(/id:\s*'([^']+)'/)
      check('client.js 的模块 id 等于包名', Boolean(idMatch) && idMatch[1] === pkg.name,
        idMatch ? `${idMatch[1]} vs ${pkg.name}` : '未找到 id')

      // S / C 对象：引用的每个 S.xxx / C.xxx 都必须在字面量里有定义。
      // 缺一个会在渲染时抛 `S.btn is not a function`，右侧面板整片空白，而 node --check 查不出来。
      // 接入共享 UI 基座后，S 的键有一部分来自 `const S_BASE = {…}`，两块合并才算完整。
      const styleBlocks = {
        S: [clientSrc.match(/const S = \{([\s\S]*?)\n {4}\}\n/), clientSrc.match(/const S_BASE = \{([\s\S]*?)\n {4}\}\n/)],
        C: [clientSrc.match(/const C = \{([\s\S]*?)\n {4}\}\n/)],
      }
      for (const [label, candidates] of Object.entries(styleBlocks)) {
        const blocks = candidates.filter(Boolean)
        if (blocks.length === 0) { check(`${label} 样式对象可被定位`, false, '正则未命中，若改了缩进需同步本检查'); continue }
        const defined = new Set(blocks.flatMap((b) => [...b[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:/g)].map((m) => m[1])))
        const used = new Set([...clientSrc.matchAll(new RegExp(`\\b${label}\\.([A-Za-z][A-Za-z0-9]*)`, 'g'))].map((m) => m[1]))
        const missing = [...used].filter((k) => !defined.has(k))
        check(`${label} 的引用键都有定义`, missing.length === 0, missing.join(', '))
      }
    }

    // 2. locale 可解析
    for (const lang of ['zh', 'en']) {
      try {
        const j = readJson(join(ROOT, 'locale', `${lang}.json`))
        check(`locale/${lang}.json 可解析且有 meta.title`, Boolean(j.meta && j.meta.title), '')
      } catch (e) {
        check(`locale/${lang}.json 可解析且有 meta.title`, false, String(e.message))
      }
    }

    // 3. patch 存在且能被当作文本读到（YAML 结构校验交给 python / 安装器）
    try {
      const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
      check('cordis.patch.yml 存在且含 insert 段', /\binsert:/.test(patch))
    } catch (e) {
      check('cordis.patch.yml 存在且含 insert 段', false, String(e.message))
    }
  }
}

// ---- 主流程 ----------------------------------------------------------------------------
async function main () {
  staticChecks()

  const mod = await import(pathToFileURL(ENTRY).href)
  check('模块导出 name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
  check('模块导出 apply 函数', typeof mod.apply === 'function')
  check('模块导出 inject 声明（可选服务）', mod.inject === undefined || Array.isArray(mod.inject), JSON.stringify(mod.inject))

  const { ctx, captured } = makeCtx()
  let applyError = null
  try {
    mod.apply(ctx, { enabled: true })
  } catch (e) {
    applyError = e
  }
  check('apply 在完整 ctx 上不抛错', applyError === null, applyError ? String(applyError.message) : '')
  check('注册了 ctx.effect', captured.effects > 0, String(captured.effects))

  // ---- 注入规范（systemPrompt.context）--------------------------------------------------
  const guidance = captured.contexts.find((item) => item && typeof item.name === 'string')
  check('注册了注入规范 context', Boolean(guidance), guidance ? guidance.name : '无')
  if (guidance) {
    check('context 有有限 order 且 text 是函数',
      Number.isFinite(guidance.order) && typeof guidance.text === 'function')
    check('context 文本非空', typeof guidance.text() === 'string' && guidance.text().length > 20,
      String(guidance.text()).slice(0, 40))
    check('context 关闭插值', guidance.interpolate === false)
  }

  // ---- 投影契约 -----------------------------------------------------------------------
  const p = captured.projection
  check('注册了投影单元', Boolean(p), p ? p.key : '无')
  if (p && typeof p.init === 'function' && typeof p.apply === 'function') {
    check('投影有 key / stateVersion / init / apply',
      typeof p.key === 'string' && typeof p.stateVersion === 'number')
    check('投影 stateSchema.parse 可用', Boolean(p.stateSchema) && typeof p.stateSchema.parse === 'function')
    const a = p.init()
    const b = p.init()
    check('init 每次返回新对象', a !== b)
    check('无关事件返回同一引用', p.apply(a, { type: 'noise/event', data: {} }) === a)
    check('session/title 后历史可见',
      p.apply(p.init(), { type: 'session/title', seq: 1, time: 1, data: { title: 'T', source: { kind: 'provider' } } }).history.length === 1)
  }

  // ---- 工具契约 -----------------------------------------------------------------------
  const t = captured.tool
  check('注册了工具', Boolean(t), t ? t.name : '无')
  if (t) {
    check('工具 name / description / parameters 齐备',
      typeof t.name === 'string' && typeof t.description === 'string' && t.parameters && typeof t.parameters === 'object')
    check('工具声明 output.schema 与 output.render',
      Boolean(t.output) && Boolean(t.output.schema) && typeof t.output.render === 'function')
    if (t.parameters && t.parameters.type === 'object') {
      check('parameters 是原生 JSON Schema（object + additionalProperties 布尔）',
        typeof t.parameters.additionalProperties === 'boolean')
      const v1 = schemaViolations(t.parameters, 'parameters', false, [])
      check('parameters 在支持子集内', v1.length === 0, v1.join('; '))
    }
    if (t.output && t.output.schema) {
      const v2 = schemaViolations(t.output.schema, 'output.schema', false, [])
      check('output.schema 在支持子集内', v2.length === 0, v2.join('; '))
    }
  }

  // ---- 工具：读取 / 改名 / 历史 / 恢复 ---------------------------------------------------
  const agent = makeAgent()
  agent.session = { id: 's-smoke', header: { cwd: 'D:\\work\\demo' } }
  if (t && p) {
    ctx.sessionProjections.feed(agent.session, {
      type: 'user/message', seq: 1, time: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续开发 DSH 对话标题插件' }] },
    })
    ctx.sessionProjections.feed(agent.session, {
      type: 'session/title', seq: 2, time: 1700000000000,
      data: { title: 'LLM 标题', source: { kind: 'provider' } },
    })

    const got = await t.execute({ action: 'get' }, { agent })
    check('工具 get 读到投影标题', got.ok === true && got.current && got.current.title === 'LLM 标题', JSON.stringify(got.current))

    const beforeCheck = captured.renames.length
    const checked = await t.execute({ action: 'check', title: '✦✧★☆' }, { agent })
    check('工具 check 返回规则码且不写入',
      checked.ok === true && checked.findings.some((f) => f.code === 'symbols-only') && captured.renames.length === beforeCheck,
      JSON.stringify(checked))
    const echoed = await t.execute({ action: 'check', title: '继续开发DSH对话标题插件' }, { agent })
    check('工具 check 识别复读首条消息',
      echoed.findings.some((f) => f.code === 'echoes-first-message'), JSON.stringify(echoed.findings))

    // 让 rename 返回与下一条标题事件相同的 seq，才能验「/state 把 Agent 改名标成 agent」
    captured.nextSeq = 3
    const set = await t.execute({ action: 'set', title: '新标题' }, { agent })
    check('工具 set 调用 rename', set.ok === true && captured.renames.length === 1 && captured.renames[0].title === '新标题', JSON.stringify(set))
    check('工具 set 返回质量 warnings',
      Array.isArray(set.warnings) && set.warnings.some((f) => f.code === 'too-short'), JSON.stringify(set.warnings))

    ctx.sessionProjections.feed(agent.session, {
      type: 'session/title', seq: 3, time: 1700000001000,
      data: { title: '新标题', source: { kind: 'user' } },
    })
    const hist = await t.execute({ action: 'history' }, { agent })
    check('工具 history 含两条', hist.items.length === 2, String(hist.items.length))

    const legacy = await t.execute({ action: 'restore', eventSeq: 2 }, { agent })
    check('工具 restore 已移除并提示用 set 替代',
      legacy.ok === false && String(legacy.reason).includes('removed'), JSON.stringify(legacy))

    if (typeof t.output.render === 'function') {
      const rendered = t.output.render({}, set)
      check('output.render 返回 content 数组',
        Array.isArray(rendered) && rendered.length > 0 && typeof rendered[0].text === 'string')
    }
  }

  // ---- 路由 ---------------------------------------------------------------------------
  check('注册了至少两条路由', captured.routes.length >= 2, String(captured.routes.length))
  check('路由 path 以 /api/ 开头且 kind 为 exact',
    captured.routes.every((r) => r.kind === 'exact' && r.path.startsWith('/api/')))
  const stateRoute = captured.routes.find((r) => /\/state$/.test(r.path))
  const setRoute = captured.routes.find((r) => /\/set$/.test(r.path))
  if (stateRoute) {
    const res = HTTP_RES()
    await stateRoute.handler(HTTP_REQ('GET'), res)
    let parsed = null
    try { parsed = JSON.parse(res.out.body) } catch { /* 留给断言 */ }
    check('GET /state 返回 200 + JSON', res.out.status === 200 && parsed !== null, String(res.out.status))
    check('GET /state 带 no-store 缓存头', Boolean(res.out.headers && res.out.headers['cache-control'] === 'no-store'))
    check('/state 载荷含 version 与 settings', Boolean(parsed && parsed.version && parsed.settings))
    check('/state 返回提示词默认值与自定义值',
      Boolean(parsed && parsed.preview && parsed.preview.defaults && parsed.preview.custom) &&
      parsed.preview.defaults.toolDescription.length > 0 &&
      typeof parsed.preview.custom.toolDescription === 'string')
    const currentRow = parsed && parsed.preview ? parsed.preview.current : null
    check('/state 把 Agent 改名标注为 agent',
      Boolean(currentRow) && currentRow.seq === 3 && currentRow.label === 'agent', JSON.stringify(currentRow))
  }
  if (setRoute) {
    const res = HTTP_RES()
    await setRoute.handler(HTTP_REQ('POST', JSON.stringify({ maxBytes: 32, showProviderTitles: false, unknownKey: 1 })), res)
    let parsed = null
    try { parsed = JSON.parse(res.out.body) } catch { /* 同上 */ }
    check('POST /set 返回 200 且 ok:true', res.out.status === 200 && Boolean(parsed && parsed.ok === true), String(res.out.status))
    check('POST /set 过滤白名单外的键', Boolean(parsed && parsed.settings && !Object.hasOwn(parsed.settings, 'unknownKey')))
    check('POST /set 应用合法改动',
      Boolean(parsed && parsed.settings && parsed.settings.maxBytes === 32 && parsed.settings.showProviderTitles === false),
      parsed ? JSON.stringify(parsed.settings) : '')
    const bad = HTTP_RES()
    await setRoute.handler(HTTP_REQ('POST', '{not json'), bad)
    check('POST /set 遇到坏 JSON 返回 400', bad.out.status === 400, String(bad.out.status))

    // 工具描述变化必须重注册，否则模型看到的还是旧文案
    const beforeRegister = captured.toolRegistrations.length
    const customRes = HTTP_RES()
    await setRoute.handler(HTTP_REQ('POST', JSON.stringify({ toolDescription: 'Custom tool description' })), customRes)
    check('POST /set 改工具描述后重注册',
      captured.toolRegistrations.length === beforeRegister + 1 &&
      captured.tool.description === 'Custom tool description',
      String(captured.toolRegistrations.length))

    const stable = captured.toolRegistrations.length
    const otherRes = HTTP_RES()
    await setRoute.handler(HTTP_REQ('POST', JSON.stringify({ maxBytes: 40 })), otherRes)
    check('POST /set 改其它设置不重注册',
      captured.toolRegistrations.length === stable, String(captured.toolRegistrations.length))
  }

  // ---- 恢复路由 -------------------------------------------------------------------------
  // ---- 语言上报路由 ---------------------------------------------------------------------
  const localeRoute = captured.routes.find((r) => /\/locale$/.test(r.path))
  if (localeRoute) {
    const res = HTTP_RES()
    await localeRoute.handler(HTTP_REQ('POST', JSON.stringify({ locale: 'en' })), res)
    let parsed = null
    try { parsed = JSON.parse(res.out.body) } catch { /* 留给断言 */ }
    check('POST /locale 接受 en', res.out.status === 200 && Boolean(parsed && parsed.result && parsed.result.ok === true), res.out.status + ' ' + JSON.stringify(parsed && parsed.result))

    const badLocale = HTTP_RES()
    await localeRoute.handler(HTTP_REQ('POST', JSON.stringify({ locale: 'fr' })), badLocale)
    let parsedBad = null
    try { parsedBad = JSON.parse(badLocale.out.body) } catch { /* 同上 */ }
    check('POST /locale 拒绝不支持的语言', Boolean(parsedBad && parsedBad.result && parsedBad.result.ok === false))
  }

  // ---- 审计写入独立文件（导出路由已在 0.5.0 移除）------------------------------------------
  try {
    const raw = readFileSync(join(process.env.DSH_HOME, 'dsh-session-title-audit.json'), 'utf8')
    const parsed = JSON.parse(raw)
    check('审计写进独立文件', Array.isArray(parsed.edits) && parsed.edits.length >= 1)
  } catch (e) {
    check('审计写进独立文件', false, String(e && e.message))
  }
  check('不再注册审计导出路由',
    !captured.routes.some((r) => /\/audit/.test(r.path)))

  // ---- 异常隔离：插件不能成为宿主的卡死来源 -----------------------------------------------
  // 路由里任何未捕获异常都要变成 500，既不能让请求挂起，也不能冒泡到宿主进程。
  if (setRoute) {
    const brokenReq = {
      method: 'POST',
      headers: {},
      async *[Symbol.asyncIterator] () { throw new Error('stream boom') },
    }
    const guardRes = HTTP_RES()
    let guardThrew = null
    try { await setRoute.handler(brokenReq, guardRes) } catch (e) { guardThrew = e }
    check('路由内部抛错被 guard 吞掉', guardThrew === null, guardThrew ? String(guardThrew.message) : '')
    check('路由抛错时返回 500', guardRes.out.status === 500, String(guardRes.out.status))
    if (stateRoute) {
      const afterAbuse = HTTP_RES()
      await stateRoute.handler(HTTP_REQ('GET'), afterAbuse)
      check('一次异常之后路由仍可用', afterAbuse.out.status === 200, String(afterAbuse.out.status))
    }
  }

  // ---- 降级：缺服务时不能崩 -------------------------------------------------------------
  for (const scenario of [
    { label: '缺少 sessionProjections', opts: { withProjections: false } },
    { label: '缺少 webServer', opts: { withWebServer: false } },
    { label: '缺少 tools', opts: { withTools: false } },
    { label: '缺少 sessions', opts: { withSessions: false } },
    { label: '缺少 systemPrompt', opts: { withSystemPrompt: false } },
  ]) {
    const m = makeCtx(scenario.opts)
    let err = null
    try { mod.apply(m.ctx, { enabled: true }) } catch (e) { err = e }
    check(`${scenario.label} 时 apply 不抛错`, err === null, err ? String(err.message) : '')
  }

  // ---- 设置页：无感保存（复制模板后防止被改回「保存按钮」模式）------------------------------
  let clientText = ''
  try { clientText = readFileSync(join(ROOT, 'client.js'), 'utf8') } catch { /* 纯宿主插件没有 client.js */ }
  if (clientText) {
    check('设置页文本输入失焦即保存', clientText.includes('onBlur:'), '输入框缺少 onBlur 保存')
    check('保存带并发序号（过期响应会被丢弃）', clientText.includes('saveSeq'), '缺少 saveSeq 防护')
    check('设置页不再渲染保存按钮', !clientText.includes("'保存')"), '仍有「保存」按钮，应改为无感保存')
    // 单页轻量（0.5.0）：不再有页签、统计区块与恢复流程，防止结构回潮
    check('设置页是单页（无页签）',
      !clientText.includes('TABS') && !clientText.includes('tabBar') && !clientText.includes('StatsCard'))
    check('统计内联为一行',
      clientText.includes('h(Inline, { gap:') && clientText.includes("T('statEvents')"))
    check('页面使用共享骨架（Page / Card）',
      clientText.includes('return h(Page,') && clientText.includes('h(Card, {'))
    check('设置项常驻（不在页签里）',
      clientText.includes('panelSettingsRow') && clientText.includes('panelPrompt'))
    check('提示词可编辑且能恢复默认',
      clientText.includes('toolDescription') && clientText.includes('resetDefault'))
    check('恢复与导出已移除',
      !clientText.includes('/restore') && !clientText.includes('/audit'))
  }
}

function report () {
  const failed = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  -> ' + r.detail}`)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

try {
  await main()
} catch (e) {
  // 被测对象损坏时也要出报告，而不是静默崩溃
  check('冒烟脚本自身执行完成', false, String(e && e.stack ? e.stack : e))
} finally {
  report()
}
