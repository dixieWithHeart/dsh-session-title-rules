/**
 * 核心逻辑测试（不依赖宿主）：文本归一与截断、标题事件折叠、来源标注、设置白名单、工具契约。
 *
 * 跑法：node tools/test-core.mjs
 * 失败时退出码 1；异步用例一律 await（踩坑 28）。
 */

import { normalizeWhitespace, prepareTitle, truncateUtf8 } from '../src/normalize.js'
import { createProjection, entryOf, firstUserTextOf, initialState } from '../src/projection.js'
import { markAgent, sourceLabel, viewOf } from '../src/state.js'
import { appendEdit, sanitize, sanitizeEdits } from '../src/settings.js'
import { createToolDefinition } from '../src/tool.js'
import { summarize } from '../src/stats.js'
import {
  QUALITY_RULE,
  echoesFirstMessage,
  inspectTitle,
  isSymbolsOnly,
  looksLikePath,
  meaningfulLength,
} from '../src/quality.js'
import {
  AUDIT_FILENAME,
  appendAuditEdit,
  auditPath,
  loadAudit,
  migrateFromSettings,
} from '../src/audit.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 审计会写盘：重定向到临时 DSH_HOME，别碰真实配置
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'title-rules-core-'))
import {
  DEFAULTS,
  DEFAULT_TOOL_DESCRIPTION,
  GUIDANCE_EN,
  GUIDANCE_ZH,
  MAX_HISTORY,
  MAX_PROMPT_CHARS,
  MAX_TITLE_BYTES,
  guidanceFor,
  toolDescriptionFor,
} from '../src/constants.js'

let passed = 0
let failed = 0
const failures = []

function check (name, condition, detail) {
  if (condition) {
    passed++
    console.log('  ok  ' + name)
  } else {
    failed++
    failures.push(name + (detail ? ' — ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''))
  }
}

// ── 文本 ────────────────────────────────────────────────────────────────
console.log('\n[文本]')
check('空白归一', normalizeWhitespace('  a \n b\t c  ') === 'a b c')
check('控制字符清掉', normalizeWhitespace('a\u0000b\u0007c') === 'a b c')
const cn = truncateUtf8('一二三四五六七八九十'.repeat(4), 80)
check('中文按字节截断（80B ≤ 26 字）', cn.text.length === 26 && cn.truncated === true, cn.text.length + ' 字')
check('截断不切码点', cn.text.length === [...cn.text].length)
check('恰好等于上限不标截断', truncateUtf8('abcdefghij', 10).truncated === false)

const ok = prepareTitle('  myDSH · 插件  ', 80)
check('prepareTitle 归一并保留', ok.ok === true && ok.title === 'myDSH · 插件', ok.title)
check('prepareTitle 空串拒绝', prepareTitle('   ', 80).ok === false)
check('prepareTitle 非字符串拒绝', prepareTitle(42, 80).reason === 'title-must-be-a-string')
const long = prepareTitle('一'.repeat(60), 30)
check('超字节被截断且标 truncated', long.ok === true && long.truncated === true && long.bytes <= 30, String(long.bytes))

// ── 事件折叠 ────────────────────────────────────────────────────────────
console.log('\n[事件折叠]')
const evt = (seq, title, kind, extra = {}) => ({
  type: 'session/title',
  seq,
  time: 1700000000000 + seq,
  data: { title, messageSeqs: [], source: { kind, ...extra } },
})
check('entryOf 解析 provider 来源', entryOf(evt(2, 'T', 'provider', { provider: 'p', model: { provider: 'p', model: 'm' } })).model === 'm')
check('entryOf 拒绝非标题事件', entryOf({ type: 'turn/start', seq: 1 }) === null)
check('entryOf 拒绝空标题', entryOf({ type: 'session/title', seq: 1, data: { title: '' } }) === null)

const projection = createProjection(() => initialState())
let st = projection.init()
check('init 每次返回新对象', projection.init() !== projection.init())
const noise = { type: 'noise/event', data: {} }
check('无关事件返回同一引用', projection.apply(st, noise) === st)
st = projection.apply(st, evt(18, '回退标题', 'fallback'))
check('fallback 进入历史', st.history.length === 1 && st.kind === 'fallback')
st = projection.apply(st, evt(20, 'LLM 标题', 'provider'))
check('最新标题与来源被更新', st.title === 'LLM 标题' && st.kind === 'provider')
check('历史最新在前', st.history[0].seq === 20 && st.history[1].seq === 18)
st = projection.apply(st, evt(876, 'myDSH · LLM 标题', 'user'))
check('user 改名追加历史', st.history.length === 3 && st.history[0].seq === 876)

let capped = projection.init()
for (let i = 0; i < MAX_HISTORY + 5; i++) capped = projection.apply(capped, evt(i, 't' + i, 'user'))
check('历史条数有上限', capped.history.length === MAX_HISTORY, String(capped.history.length))

// ── 首条用户消息 ────────────────────────────────────────────────────────
console.log('\n[首条消息]')
const userMsg = (seq, text, kind = 'user') => ({
  type: 'user/message',
  seq,
  time: 1,
  data: { source: { kind }, content: [{ type: 'text', text }] },
})
check('firstUserTextOf 取 text 块', firstUserTextOf(userMsg(1, '继续开发 DSH 插件')) === '继续开发 DSH 插件')
check('firstUserTextOf 忽略非 user 来源', firstUserTextOf(userMsg(1, 'x', 'subagent')) === null)
check('firstUserTextOf 忽略非消息事件', firstUserTextOf({ type: 'assistant/message', data: {} }) === null)
check('firstUserTextOf 空白返回 null', firstUserTextOf(userMsg(1, '  \n ')) === null)

let first = projection.init()
first = projection.apply(first, userMsg(1, '第一条'))
check('投影记录首条用户消息', first.firstUserText === '第一条')
check('重复 user/message 返回同一引用', projection.apply(first, userMsg(2, '第二条')) === first)
check('首条消息不被后续覆盖', projection.apply(first, userMsg(3, '第三条')).firstUserText === '第一条')

// ── 来源标注 ────────────────────────────────────────────────────────────
console.log('\n[来源标注]')
const edits = [{ sessionId: 's1', seq: 876, title: 'myDSH · LLM 标题', previous: 'LLM 标题', at: '2026-11-17T00:00:00Z', via: 'tool' }]
const marked = markAgent(st.history, edits, 's1')
check('Agent 记录能让 user 标题显示为 agent', marked[0].byAgent === true && marked[0].label === undefined)
check('via=ui 的记录不标 agent',
  markAgent([entryOf(evt(901, 'x', 'user'))], [{ sessionId: 's1', seq: 901, title: 'x', via: 'ui' }], 's1')[0].byAgent === false)
check('未记录的 user 标题仍是 user', markAgent([evt(900, 'x', 'user')].map(entryOf), edits, 's1')[0].byAgent === false)
check('provider 标题不会被误标', markAgent(st.history, edits, 's1').find((e) => e.seq === 20).byAgent === false)
check('sourceLabel 优先 agent', sourceLabel({ kind: 'user', byAgent: true }) === 'agent')
check('sourceLabel 回退 unknown', sourceLabel({ kind: 'weird' }) === 'unknown')

const view = viewOf({ state: st, settings: { showProviderTitles: true }, edits, sessionId: 's1' })
check('view 的 current 是最新一条', view.current.seq === 876 && view.current.label === 'agent')
check('view 的历史含全部来源', view.history.length === 3)
const filtered = viewOf({ state: st, settings: { showProviderTitles: false }, edits, sessionId: 's1' })
check('关闭 provider 后历史只剩改名', filtered.history.every((e) => e.kind === 'user') && filtered.history.length === 1)
check('关闭 provider 不影响 current', filtered.current.seq === 876)
check('total 记录未过滤条数', filtered.total === 3)

// ── 设置白名单 ──────────────────────────────────────────────────────────
console.log('\n[设置白名单]')
const base = { ...DEFAULTS, agentEdits: [] }
const s1 = sanitize({ enabled: false, showProviderTitles: false, unknownKey: 1 }, base)
check('合法布尔被接受', s1.enabled === false && s1.showProviderTitles === false)
check('未知键被丢弃', !Object.hasOwn(s1, 'unknownKey'))
check('maxBytes 上限夹到 80', sanitize({ maxBytes: 999 }, base).maxBytes === MAX_TITLE_BYTES)
check('maxBytes 下限夹到 16', sanitize({ maxBytes: 1 }, base).maxBytes === 16)
const editsOk = sanitize({ agentEdits: [{ sessionId: 's', seq: 1, title: 't', previous: '', at: 'x', via: 'tool' }] }, base)
check('合法记账被接受', editsOk.agentEdits.length === 1 && editsOk.agentEdits[0].via === 'tool')
const editsBad = sanitize({ agentEdits: [{ sessionId: '', seq: 1, title: 't' }, { sessionId: 's', seq: 'x', title: 't' }] }, base)
check('坏记账整条丢弃', editsBad.agentEdits.length === 0)
check('客户端不带 agentEdits 时保留旧账', sanitize({ maxBytes: 40 }, editsOk).agentEdits.length === 1)
check('appendEdit 最新在前并截断', appendEdit([{ seq: 1 }], { seq: 2 })[0].seq === 2)
check('sanitizeEdits 非数组返回 null', sanitizeEdits('nope') === null)

// ── 注入规范 ────────────────────────────────────────────────────────────
console.log('\n[注入规范]')
check('中文规范按语言取到', guidanceFor('zh') === GUIDANCE_ZH)
check('英文规范按语言取到', guidanceFor('en') === GUIDANCE_EN)
check('未知语言回退中文', guidanceFor('fr') === GUIDANCE_ZH)
check('规范写明字节上限', GUIDANCE_ZH.includes('80 字节') && GUIDANCE_EN.includes('80'))
check('规范写明来源语义', GUIDANCE_ZH.includes('label=user') && GUIDANCE_EN.includes('label=user'))
check('规范是常量（两次调用同一引用）', guidanceFor('zh') === guidanceFor('zh'))
check('sanitize 接受 uiLocale', sanitize({ uiLocale: 'en' }, base).uiLocale === 'en')
check('sanitize 拒绝未知语言', sanitize({ uiLocale: 'fr' }, base).uiLocale === 'zh')
check('injectGuidance 默认开', base.injectGuidance === true)
check('sanitize 接受关闭', sanitize({ injectGuidance: false }, base).injectGuidance === false)

// ── 提示词自定义 ────────────────────────────────────────────────────────
console.log('\n[提示词自定义]')
check('自定义规范优先（中文）', guidanceFor('zh', { guidanceZh: '自定义规范' }) === '自定义规范')
check('自定义规范优先（英文）', guidanceFor('en', { guidanceEn: 'custom rule' }) === 'custom rule')
check('自定义空白回退默认', guidanceFor('zh', { guidanceZh: '   ' }) === GUIDANCE_ZH)
check('未设置时用默认规范', guidanceFor('en', {}) === GUIDANCE_EN)
check('工具描述默认值', toolDescriptionFor({}) === DEFAULT_TOOL_DESCRIPTION)
check('工具描述自定义优先', toolDescriptionFor({ toolDescription: 'Mine' }) === 'Mine')
check('工具描述空白回退默认', toolDescriptionFor({ toolDescription: ' ' }) === DEFAULT_TOOL_DESCRIPTION)
check('sanitize 接受自定义提示词',
  sanitize({ toolDescription: 'T', guidanceZh: 'Z', guidanceEn: 'E' }, base).toolDescription === 'T')
check('sanitize 忽略非字符串提示词', sanitize({ toolDescription: 42 }, base).toolDescription === '')
check('sanitize 截断超长提示词',
  sanitize({ toolDescription: 'x'.repeat(MAX_PROMPT_CHARS + 10) }, base).toolDescription.length === MAX_PROMPT_CHARS)

// ── 质量检查 ────────────────────────────────────────────────────────────
console.log('\n[质量检查]')
const codes = (result) => result.findings.map((f) => f.code)
const firstText = '继续开发 DSH 对话标题插件，本轮做质量检查'

const clean = inspectTitle('插件开发与标题治理', { maxBytes: 80 })
check('干净标题无告警', clean.ok === true && clean.findings.length === 0 && clean.acceptable === true)
check('纯符号被标记', codes(inspectTitle('✦✧★☆', { maxBytes: 80 })).includes(QUALITY_RULE.symbolsOnly))
check('过短被标记', codes(inspectTitle('改一下', { maxBytes: 80 })).includes(QUALITY_RULE.tooShort))
check('过长被标记', codes(inspectTitle('a'.repeat(41), { maxBytes: 80 })).includes(QUALITY_RULE.tooLong))
const cut = inspectTitle('一'.repeat(40), { maxBytes: 30 })
check('超字节被标记且不重复报过长',
  codes(cut).includes(QUALITY_RULE.overBytes) && !codes(cut).includes(QUALITY_RULE.tooLong))
check('盘符被认成路径', looksLikePath('C:\\code\\myDSH') === true)
check('多段斜杠被认成路径', looksLikePath('plugins/dsh-foo/src') === true)
check('文件名后缀被认成路径', codes(inspectTitle('README.md', { maxBytes: 80 })).includes(QUALITY_RULE.looksLikePath))
check('A/B 这种单斜杠不误判', looksLikePath('A/B 测试') === false)
check('普通标题不误判路径', looksLikePath('插件质量检查') === false)
check('复读首条消息被标记',
  codes(inspectTitle('继续开发DSH对话标题插件', { maxBytes: 80, firstUserText: firstText })).includes(QUALITY_RULE.echoesFirstMessage))
check('重新概括不误报',
  !codes(inspectTitle('标题插件质量检查', { maxBytes: 80, firstUserText: firstText })).includes(QUALITY_RULE.echoesFirstMessage))
check('没有首条消息时不判复读', echoesFirstMessage('继续开发DSH对话标题插件', null) === false)
check('实义字符计数忽略标点', meaningfulLength('a1!?✦') === 2 && isSymbolsOnly('插件') === false)
check('空标题不产生 findings', inspectTitle('   ', { maxBytes: 80 }).findings.length === 0)

// ── 工具契约 ────────────────────────────────────────────────────────────
console.log('\n[工具]')
const renames = []
const tool = createToolDefinition({
  view: () => ({
    current: { seq: 3, title: 'now', kind: 'user', byAgent: true, label: 'agent' },
    history: [
      { seq: 3, title: 'now', kind: 'user', label: 'agent', byAgent: true },
      { seq: 2, title: 'old', kind: 'provider', label: 'provider', byAgent: false },
    ],
    total: 2,
  }),
  inspect: (_session, title) => inspectTitle(title, { maxBytes: 80, firstUserText: firstText }),
  setTitle: (session, title, via) => {
    renames.push({ sessionId: session.id, title, via })
    const inspected = inspectTitle(title, { maxBytes: 80, firstUserText: firstText })
    return { ok: true, title, previous: 'now', eventSeq: 4, label: 'agent', warnings: inspected.findings }
  },
  onSession: () => {},
})
const agent = { session: { id: 's1' } }

const got = await tool.execute({ action: 'get' }, { agent })
check('get 返回当前标题与来源', got.ok === true && got.current.title === 'now' && got.current.byAgent === true)
const hist = await tool.execute({ action: 'history', limit: 1 }, { agent })
check('history 遵守 limit', hist.items.length === 1 && hist.total === 2)
const set = await tool.execute({ action: 'set', title: '新标题' }, { agent })
check('set 调用 rename 并标记 via=tool', set.ok === true && renames.length === 1 && renames[0].via === 'tool')
check('set 透传质量 warnings', Array.isArray(set.warnings) && set.warnings.some((f) => f.code === QUALITY_RULE.tooShort))
const legacyRestore = await tool.execute({ action: 'restore', eventSeq: 2 }, { agent })
check('restore 已移除并提示用 set 替代',
  legacyRestore.ok === false && String(legacyRestore.reason).includes('removed'))

const beforeCheck = renames.length
const checked = await tool.execute({ action: 'check', title: '✦✦✦✦' }, { agent })
check('check 返回规则码且不写入',
  checked.ok === true && checked.findings.some((f) => f.code === QUALITY_RULE.symbolsOnly) && renames.length === beforeCheck)
const emptyCheck = await tool.execute({ action: 'check', title: '   ' }, { agent })
check('check 空标题判为不可写入（valid=false）', emptyCheck.ok === true && emptyCheck.valid === false)
const noSession = await tool.execute({ action: 'get' }, {})
check('无会话返回 ok:false', noSession.ok === false && noSession.reason.includes('No active session'))
const unknown = await tool.execute({ action: 'wat' }, { agent })
check('未知 action 被拒绝', unknown.ok === false)

/**
 * 宿主要求 execute 的返回值是 lossless JSON：带 undefined / 函数 / 非有限数会直接报
 * `value is not lossless JSON`，工具在真实环境里就完全不可用（mock 测试不会经过这层校验）。
 */
function isLossless (value) {
  if (value === undefined) return false
  const t = typeof value
  if (t === 'function' || t === 'symbol' || t === 'bigint') return false
  if (t === 'number') return Number.isFinite(value)
  if (value === null || t !== 'object') return true
  if (Array.isArray(value)) return value.every(isLossless)
  return Object.values(value).every(isLossless)
}
const allResults = { got, hist, set, legacyRestore, checked, emptyCheck, noSession, unknown }
const dirty = Object.entries(allResults).filter(([, value]) => !isLossless(value)).map(([name]) => name)
check('所有工具返回值都是 lossless JSON', dirty.length === 0, '含非法值：' + dirty.join(', '))
check('check 成功时不带 reason 键', !Object.hasOwn(checked, 'reason'))
check('工具名与 output 契约', tool.name === 'session_title' && typeof tool.output.render === 'function')
const customTool = createToolDefinition({
  view: () => ({ current: null, history: [], total: 0 }),
  inspect: () => ({ ok: true, findings: [] }),
  setTitle: () => ({ ok: true }),
  onSession: () => {},
  description: '自定义工具描述',
})
check('工具描述可自定义', customTool.description === '自定义工具描述')
check('未传描述时用内置默认', tool.description === DEFAULT_TOOL_DESCRIPTION)
check('parameters 显式 additionalProperties', tool.parameters.additionalProperties === false)

// ── 统计 ────────────────────────────────────────────────────────────────
console.log('\n[统计]')
const historyEntries = [
  { seq: 4, time: 400, title: 'abcd', label: 'agent' },
  { seq: 3, time: 300, title: '标题三字', label: 'user' },
  { seq: 2, time: 200, title: 'LLM 标题', label: 'provider' },
  { seq: 1, time: 100, title: '回退', label: 'fallback' },
]
const sum = summarize(historyEntries)
const expectedAvg = Math.round(historyEntries.reduce((n, e) => n + Buffer.byteLength(e.title, 'utf8'), 0) / 4)
check('统计总数', sum.total === 4)
check('来源分布', sum.byLabel.agent === 1 && sum.byLabel.user === 1 && sum.byLabel.provider === 1 && sum.byLabel.fallback === 1)
check('改名次数 = agent + user', sum.changes === 2)
check('自动产生 = provider + fallback', sum.automatic === 2)
check('平均字节', sum.avgBytes === expectedAvg, String(sum.avgBytes) + ' vs ' + expectedAvg)
check('最近改名时间取最新改名', sum.lastChangeAt === 400)
check('空历史不崩', summarize([]).total === 0 && summarize(null).avgBytes === 0)
check('未知 label 归入 unknown', summarize([{ title: 'x', label: 'weird' }]).byLabel.unknown === 1)

// ── 审计存储 ────────────────────────────────────────────────────────────
console.log('\n[审计存储]')
const auditLog = { info () {}, warn () {} }
check('审计文件在 DSH_HOME 下', auditPath().endsWith(AUDIT_FILENAME))
let auditState = loadAudit(auditLog)
check('空审计', auditState.edits.length === 0)
auditState = appendAuditEdit(auditLog, auditState, {
  sessionId: 's1', seq: 1, title: 't', previous: '', at: '2026-11-17T00:00:00Z', via: 'tool',
})
check('追加并落盘', auditState.edits.length === 1 && loadAudit(auditLog).edits.length === 1)

const migrated = migrateFromSettings(auditLog, {
  agentEdits: [{ sessionId: 's2', seq: 2, title: 'u', previous: '', at: '2026-11-17T01:00:00Z', via: 'tool' }],
}, { version: 1, edits: [] })
check('空审计时迁移旧账', migrated.migrated === 1 && migrated.audit.edits.length === 1)
check('已有审计不再迁移', migrateFromSettings(auditLog, { agentEdits: [{ sessionId: 's3', seq: 3, title: 'v', at: 'x', via: 'tool' }] }, migrated.audit).migrated === 0)

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
