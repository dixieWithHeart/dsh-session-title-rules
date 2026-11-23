/**
 * 插件的全部常量与静态表。
 *
 * 集中成文的原因：这些值是「配置契约」——设置页、HTTP 路由、工具三处都要读，
 * 放在一起改一处即可，避免在多个文件里各写一份而漂移。
 */

export const VERSION = '0.5.1'

/** 投影单元 key。改它等于放弃历史 cell，需同步 projection.js 的 stateVersion。 */
export const PROJECTION_KEY = 'titleAudit'

/** 用户设置的落盘文件名（在 $DSH_HOME 下）。 */
export const SETTINGS_FILENAME = 'dsh-session-title-rules.json'

/** POST 请求体上限，防手滑提交大对象。 */
export const MAX_BODY_BYTES = 16384

/** 工具入参里标题的长度上限（字符）；落盘前还会按字节再截一次。 */
export const MAX_INPUT_CHARS = 200

/**
 * 标题 UTF-8 字节上限的默认值与硬上限。
 * 宿主 `dsh-base` 给 session-title 行写的是 `maxTitleBytes: 80`，超过会被服务端拒绝或截断，
 * 所以这里不允许把插件上限设得比它更大。
 */
export const MAX_TITLE_BYTES = 80
export const MIN_TITLE_BYTES = 16

/** 每个会话在投影里保留多少条标题历史。 */
export const MAX_HISTORY = 50

/**
 * 质量检查阈值。这些是**给模型的提示**，不是硬校验：
 * 空标题、超字节这类确定性错误由 `prepareTitle()` 拒绝，不在这里重复。
 */
export const QUALITY_MIN_CHARS = 4
export const QUALITY_MAX_CHARS = 40

/** 投影里保留的首条用户消息长度，用于判断标题是不是在复读首条消息。 */
export const FIRST_MESSAGE_MAX_CHARS = 400

/** 自定义提示词的长度上限（工具描述 / 注入规范）。 */
export const MAX_PROMPT_CHARS = 2000

/**
 * 工具描述的内置默认值。
 * 模型靠它判断「什么时候该调这个工具」，所以单独成常量：用户可在设置页覆盖，
 * 覆盖为空串时回退到这里。
 */
export const DEFAULT_TOOL_DESCRIPTION = 'Read or change this session\'s title. Use set when the topic has drifted enough that the current title misleads; do not rename for small talk, thanks, or follow-up details. Titles are capped at 80 UTF-8 bytes and truncated at a character boundary. check evaluates a candidate title (byte cap, symbols only, too short or too long, path-like, or merely repeating the opening user message) without writing; set also returns those findings as warnings. history shows each title with its origin (agent / user / provider / fallback), so you can tell whether the user renamed it by hand or it was generated automatically.'

/** Agent 改名记录（持久化）保留多少条。 */
export const MAX_EDITS = 100

/** 来源标签：宿主只区分 fallback / provider / user，Agent 与人工靠插件记账区分。 */
export const SOURCE = {
  fallback: 'fallback',
  provider: 'provider',
  user: 'user',
  agent: 'agent',
}

/** 启动默认值。Host 行（cordis.patch.yml）里的 config 会覆盖它。 */
export const DEFAULTS = {
  enabled: true,
  maxBytes: MAX_TITLE_BYTES,
  /** 历史里是否显示官方自动生成的标题（provider / fallback） */
  showProviderTitles: true,
  /** 是否向模型注入「怎么用这个工具」的恒定规范 */
  injectGuidance: true,
  /** 界面语言：客户端上报，决定注入中文还是英文规范 */
  uiLocale: 'zh',
  /** 自定义工具描述（空 = 内置默认）；改它会让模型看到的工具说明变化，保存后立即重注册工具 */
  toolDescription: '',
  /** 自定义注入规范（按界面语言各一份，空 = 内置默认） */
  guidanceZh: '',
  guidanceEn: '',
  /** Agent 改名记录：{ sessionId, seq, title, previous, at, via } */
  agentEdits: [],
}

/** 注入载体的注册名与顺序：排在条件注入插件的约定段（121）/ 注入段（122）之前。 */
export const GUIDANCE_NAME = 'session-title-guidance'
export const GUIDANCE_ORDER = 120

/**
 * 恒定规范文本。
 *
 * 必须是**常量**：运行时上下文快照按整段比较、整段发送（踩坑 36），
 * 放进任何每轮都变的内容都会把整段快照拖着重发。
 * 这里只随界面语言切换，属于罕见的一次性变化。
 */
export const GUIDANCE_ZH = [
  '你有 session_title 工具，用来维护当前会话的标题。',
  '- 何时改：话题明显偏离原标题（换任务、换主题）时，用 set 给出 8–16 字、抓住主题实质的标题。',
  '- 何时不改：闲聊、致谢、追问细节、同一任务内的推进都不改；不要为了「更漂亮」而改名。',
  '- 先看再改：history 会给出每条标题的来源。label=user 表示用户手动改过，除非话题明显漂移不要覆盖；label=provider 是自动生成，可放心替换。',
  '- 约束：标题按 UTF-8 字节计，上限 80 字节（中文约 26 字）；改名会让官方自动命名停止更新，不要频繁改。',
].join('\n')

export const GUIDANCE_EN = [
  'You have the session_title tool for maintaining this session\'s title.',
  '- When to rename: the topic has clearly moved away from the current title (new task, new subject). Use set with an 8-16 word title that captures the substance.',
  '- When not to: small talk, thanks, follow-up details, or progress within the same task. Never rename just to make it prettier.',
  '- Look before you leap: history reports each title\'s origin. label=user means the user renamed it by hand, so leave it unless the topic clearly drifted; label=provider was auto-generated and can be replaced freely.',
  '- Limits: titles are measured in UTF-8 bytes, capped at 80 (~26 CJK characters); a rename stops the official auto-naming, so do not rename often.',
].join('\n')

/** 按界面语言取规范文本；用户自定义优先，空则回退内置默认。 */
export function guidanceFor (locale, settings) {
  const custom = locale === 'en'
    ? (settings && typeof settings.guidanceEn === 'string' ? settings.guidanceEn.trim() : '')
    : (settings && typeof settings.guidanceZh === 'string' ? settings.guidanceZh.trim() : '')
  if (custom) return custom
  return locale === 'en' ? GUIDANCE_EN : GUIDANCE_ZH
}

/** 实际生效的工具描述：自定义优先，空则回退内置默认。 */
export function toolDescriptionFor (settings) {
  const custom = settings && typeof settings.toolDescription === 'string' ? settings.toolDescription.trim() : ''
  return custom || DEFAULT_TOOL_DESCRIPTION
}
