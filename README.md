# dsh-session-title-rules

给 Agent 一个 `session_title` 工具，让它自己控制会话标题（改前可用 `check` 自查质量）；设置页是单页：当前标题、开关、模型提示词，外加一行轻量统计。

## 安装

```powershell
dsh plugin add dsh-session-title-rules
```

包自带 `cordis.patch.yml`，装完自动插入宿主行。刷新页面后在「设置 → 会话标题」里调。

## 工具：`session_title`

| action | 参数 | 作用 |
| --- | --- | --- |
| `get` | — | 当前标题 + 来源（agent / user / provider / fallback） |
| `set` | `title` | 改成给定标题；超过字节上限按字符边界截断；返回 `warnings` |
| `check` | `title` | 只检查不写入：字节、纯符号、过短/过长、像路径、复读首条消息 |
| `history` | `limit`（默认 10，最大 50） | 最近标题，最新在前，每条带来源与 seq |

工具描述里写明了使用时机：话题漂移、原标题误导时才改，闲聊/致谢/追问细节不改。

0.5.0 起没有 `restore`：历史只读，模型要改回去就用 `set` 写回旧标题。

## 质量检查

`check` 预演，`set` 也返回同一份 `warnings`——**都不阻断写入**：

| 规则码 | 判据 |
| --- | --- |
| `over-bytes` | 超过字节上限、已被截断 |
| `symbols-only` | 没有字母 / 数字 / 汉字 |
| `too-short` | 实义字符少于 4 |
| `too-long` | 字符数超过 40（且没被字节截断） |
| `looks-like-path` | 盘符、UNC、`~/`、文件名后缀，或两段以上斜杠 |
| `echoes-first-message` | 只是把首条用户消息复读一遍 |

阈值是**提示**不是硬校验：标题好坏是判断题，硬拒绝会让模型反复试错。空标题、超字节这类确定性错误仍由归一化层拒绝。

首条消息取自会话投影：`user/message` 里 `source.kind === 'user'` 的第一条，只保留前 400 字符。

## 来源怎么区分

宿主只把来源分成三类：`fallback`（首条消息回退）、`provider`（官方 LLM 生成）、`user`（显式改名）。
**Agent 调 `rename()` 与你在界面上改名，宿主都记成 `user`**——所以「Agent 改的」与「你改的」靠本插件自己记账，按 `eventSeq` 对齐：

- 记账写在审计文件 `~/.dsh/dsh-session-title-audit.json`（最多 100 条，`via` 区分 `tool` / `ui`），重启后不会把 Agent 改名错标成人工；
- 历史条目的 `label` 依次判定：`agent`（有 tool 记账）→ `provider` → `fallback` → `user`。

## 注入给模型的规范

工具描述只能写「这个工具是什么」，写不下「什么时候该用、什么时候不该用」。所以插件额外注入一段**恒定**规范：

- 载体：`ctx.systemPrompt.context()`（不是 `section()`——`complete: true` 的 persona 会把 section 整体裁掉；也不是 `agent.inject()`——那是每轮一条真消息）。
- 内容：何时改名 / 何时不改 / 先看 `history` 的来源再改 / 字节上限与改名副作用。
- 成本：恒定文本，内容不变就不重复发送，只在首次与切换语言时各付一次（约 300 token）。
- 语言：跟随界面语言（客户端把 `ctx.locale` 的当前语言上报到插件，中文环境注中文、英文环境注英文）。
- 开关：`injectGuidance`（默认开）。
- 自定义：设置页「模型提示词」可改本段与工具描述，留空用内置默认。

分工：本插件只放「工具自述」这类恒定规范；动态/用户自定义的注入交给 `dsh-conditional-rules`。

## 模型提示词

两段文本都可在设置页改，存在 `~/.dsh/dsh-session-title-rules.json`：

| 字段 | 作用 | 生效时机 |
| --- | --- | --- |
| `toolDescription` | 模型看到的工具描述（何时调 `session_title`） | 保存后立即重新注册工具 |
| `guidanceZh` / `guidanceEn` | 注入规范，按界面语言各一份 | 下一轮装配即生效（注入函数每次读设置） |

留空 = 内置默认；「恢复默认」清空当前语言那份与工具描述。切换界面语言后再编辑另一语言版本。两段文本上限均为 2000 字符。

## 设置页

单页，从上到下：

1. 标题、版本、状态、启用开关。
2. **当前标题**：来源徽章 + 已用字节 / 上限。
3. **设置行**：历史是否显示自动标题、标题字节上限、注入开关。
4. **模型提示词**（常驻）：工具描述与当前语言的注入规范，失焦保存、可恢复默认。
5. **一行统计**：标题事件数、改名次数（Agent + 你）、平均字节。

历史列表、回退按钮、审计导出与「Agent 记录」页已移除：历史只通过工具 `history` 给模型看，审计文件仍保留用于区分 Agent 与人工改名。

文案走 `ctx.locale`（命名空间 `sessionTitleRules`，中英齐全）。

## 审计

Agent 改名记录单独存在 `~/.dsh/dsh-session-title-audit.json`，**与设置文件分开**：设置是配置（可重置），审计是数据。

- 旧版把记录写在设置文件的 `agentEdits` 里；启动时若审计文件为空，会迁移一次并把设置里的旧字段清空，避免两份数据漂移。
- 记录结构：`{ sessionId, seq, title, previous, at, via }`，`via` 为 `tool`（Agent）或 `ui`（页面），最多 100 条。
- 审计只用于来源标注，**不再提供导出路由**；要看内容直接读文件。

## HTTP 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/dsh-session-title-rules/state` | 设置 + 当前标题 + 统计 + 提示词默认值 |
| POST | `/api/dsh-session-title-rules/set` | 保存设置（白名单） |
| POST | `/api/dsh-session-title-rules/rename` | 页面改名（`{ title }`） |
| POST | `/api/dsh-session-title-rules/locale` | 客户端上报界面语言 |

路由无鉴权（只接受本机进程访问；目标会话固定为宿主当前活跃会话，不接受外部传入 sessionId）。

## 硬约束

- `ctx.sessionTitle.rename()` 只接受**活跃会话**（宿主校验 `sessions.get(id) === session`），所以历史会话改不了。
- 改名来源固定为 `user`，会**钉住**会话：官方自动标题从此停止更新，`refresh()` 才解钉。要让官方标题继续工作，别频繁改。
- 标题按 UTF-8 字节校验，宿主上限 80 字节（中文约 26 字）。

## 测试

```powershell
node tools\test-core.mjs                            # 109 条：文本 / 折叠 / 来源 / 白名单 / 质量检查 / 提示词 / 工具 / lossless
node tools\smoke-test.mjs                           # 69 条：结构契约（含 /state 来源标注、提示词重注册）
node ..\..\tools\test-client-render.mjs client.js   # 26 条：单页渲染
node ..\..\tools\test-locale.mjs client.js          # 19 条：双语
```

## 已知限制

- 只覆盖当前活跃会话的历史；跨会话的标题历史不做。
- `agentEdits` 里 `seq` 为空时（极少数宿主路径）无法与历史对齐，该条显示为 `user`。
- 历史条数上限 50（投影状态），更早的标题需要看会话日志。
- `check` 的「复读首条消息」只比对投影里保留的前 400 字符。

## License

MIT
