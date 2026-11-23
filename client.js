// dsh-session-title-rules — 浏览器半 / browser half
//
// 注册一个设置页（settings.section）。契约：
//   · window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名
//   · factory 里的 require 只认白名单模块（react 等），不能 import 项目内相对路径
//     → 所以本文件不拆，按「常量 / 纯函数 / store / 样式 / 设置页 / 注册」六个分区组织，
//       每区有 `═══ n. xxx ═══` 锚点，修改时按锚点定位，不要跨区大范围替换
//   · 通用控件与样式来自共享 UI 基座（`// @ui-kit v…` 段）；改基座后跑
//     `node tools/sync-ui-kit.mjs` 同步，`node tools/check-ui-kit.mjs` 校验
//   · 不 require 任何 @deepseek-ai/dsh-client-* 包
//   · 样式只用 --dsw-alias-* 主题 token，且都带 fallback
//
// 设置页上的每个样式键都必须真实存在：少一个（如 S.btn）会在渲染时抛
// `S.btn is not a function`，表现为「左侧导航出现、右边一片空白」。
// node --check 查不出这类问题，用 `node tools/test-client-render.mjs <client.js>` 自证。

window.__ModuleLoader__.load({
  id: 'dsh-session-title-rules',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // ═══ 1. 常量 ═══════════════════════════════════════════════════════
    const API = '/api/dsh-session-title-rules'
    const POLL_MS = 2000
    const LOG = '[dsh-session-title-rules]'

    // ═══ 2. 纯函数 ═════════════════════════════════════════════════════
    // ═══ 3. 文案（宿主 locale 服务；缺服务时退回中文）═══════════════════
    const NS = 'sessionTitleRules'
    const ZH = {
      nav: '会话标题',
      heading: '会话标题',
      statusLoading: '正在读取…',
      statusReady: '会话标题工具已就绪',
      statusNoSession: '没有活跃会话',
      statusError: '连接异常：{msg}',
      on: '已启用',
      off: '已停用',
      enablePlugin: '启用插件',
      currentTitle: '当前标题',
      noTitle: '这个会话还没有标题',
      noSessionPanel: '打开一个会话后，这里会显示它的标题',
      bytes: '{n} / {max} 字节',
      sourceAgent: 'Agent',
      sourceUser: '你',
      sourceProvider: '自动生成',
      sourceFallback: '首条消息回退',
      sourceUnknown: '未知来源',
      showProviderTitle: '工具 history 显示自动生成的标题',
      showProviderDesc: '关闭后 history 只保留 Agent 与你的改名记录，官方自动标题不列出。',
      maxBytesTitle: '标题字节上限',
      maxBytesDesc: '宿主上限 80 字节；中文一字 3 字节，超出会按字符边界截断。',
      guidanceTitle: '注入给模型的规范',
      guidanceOn: '已注入',
      guidanceOff: '已关闭',
      guidanceEmpty: '未注入：模型只看到工具描述。',
      guidanceToggle: '注入使用规范',
      guidanceToggleDesc: '开启：向模型注入一段固定的「何时该改标题」说明；关闭：只靠工具描述。',
      saved: '已保存',
      saving: '保存中…',
      saveFailed: '保存失败：{msg}',
      bytesInvalid: '标题字节上限需在 {min}–{max} 之间',
      settingsTitle: '设置',
      statsTitle: '当前会话统计',
      promptTitle: '模型提示词',
      customized: '已自定义',
      promptDesc: '工具描述决定模型何时调用 session_title；注入规范决定它何时改标题。留空使用内置默认。',
      toolDescLabel: '工具描述',
      toolDescHint: '模型看到的工具说明；保存后立即重新注册工具。',
      guidanceLabel: '注入规范',
      guidanceHint: '跟随界面语言：当前编辑的是{lang}版本；另一种语言留空时使用内置默认。',
      langZh: '中文',
      langEn: '英文',
      resetDefault: '恢复默认',
      promptSaved: '提示词已保存',
      promptPlaceholder: '留空使用内置默认',
      statEvents: '标题事件',
      statChanges: '改名次数',
      statAvg: '平均字节',
      expand: '展开',
      collapse: '收起',
      foot: '标题记录在会话日志的 session/title 事件里；设置保存在 {path}。',
    }
    const EN = {
      nav: 'Session title',
      heading: 'Session title',
      statusLoading: 'Loading…',
      statusReady: 'Title tool is ready',
      statusNoSession: 'No active session',
      statusError: 'Connection error: {msg}',
      on: 'Enabled',
      off: 'Disabled',
      enablePlugin: 'Enable plugin',
      currentTitle: 'Current title',
      noTitle: 'This session has no title yet',
      noSessionPanel: 'Open a session and its title shows up here',
      bytes: '{n} / {max} bytes',
      sourceAgent: 'Agent',
      sourceUser: 'You',
      sourceProvider: 'Auto-generated',
      sourceFallback: 'First-message fallback',
      sourceUnknown: 'Unknown origin',
      showProviderTitle: 'Show auto-generated titles in tool history',
      showProviderDesc: 'When off, history keeps only agent and manual renames.',
      maxBytesTitle: 'Title byte cap',
      maxBytesDesc: 'The host caps titles at 80 bytes; one CJK character takes 3 bytes, so longer titles are truncated at a character boundary.',
      guidanceTitle: 'Guidance injected to the model',
      guidanceOn: 'Injected',
      guidanceOff: 'Off',
      guidanceEmpty: 'Not injected: the model only sees the tool description.',
      guidanceToggle: 'Inject usage guidance',
      guidanceToggleDesc: 'On: inject a fixed "when to rename" note into the model context. Off: rely on the tool description only.',
      saved: 'Saved',
      saving: 'Saving…',
      saveFailed: 'Save failed: {msg}',
      bytesInvalid: 'Title byte cap must be between {min} and {max}',
      settingsTitle: 'Settings',
      statsTitle: 'Current-session stats',
      promptTitle: 'Model prompts',
      customized: 'Customized',
      promptDesc: 'The tool description tells the model when to call session_title; the guidance tells it when to rename. Leave empty to use the built-in default.',
      toolDescLabel: 'Tool description',
      toolDescHint: 'What the model sees as the tool description; saving re-registers the tool immediately.',
      guidanceLabel: 'Injected guidance',
      guidanceHint: 'Follows the UI language: editing the {lang} version. The other language falls back to the built-in default when empty.',
      langZh: 'Chinese',
      langEn: 'English',
      resetDefault: 'Reset to default',
      promptSaved: 'Prompts saved',
      promptPlaceholder: 'Leave empty to use the built-in default',
      statEvents: 'Title events',
      statChanges: 'Renames',
      statAvg: 'Avg bytes',
      expand: 'Expand',
      collapse: 'Collapse',
      foot: 'Titles live as session/title events in the session log; settings live in {path}.',
    }

    /** 当前翻译函数：宿主 locale 可用时由 apply() 换成按语言切换的版本。 */
    let translate = (key, params) => fill(ZH[key] !== undefined ? ZH[key] : key, params)

    function fill (template, params) {
      if (!params) return template
      return String(template).replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m))
    }

    /** 组件内统一的取词入口；每次渲染都读当前 translate，语言切换即时生效。 */
    function T (key, params) {
      return translate(key, params)
    }

// ═══ 4. store：轮询与状态 ══════════════════════════════════════════
    let state = {
      loading: true,
      error: null,
      version: '',
      settings: { enabled: true, maxBytes: 80, showProviderTitles: true },
      preview: {
        hasSession: false,
        current: null,
        total: 0,
        maxBytes: 80,
        settingsPath: '',
        injectGuidance: true,
        uiLocale: 'zh',
        guidance: '',
      },
    }
    const listeners = new Set()
    const emit = () => { for (const fn of listeners) fn(state) }

    async function refresh () {
      try {
        const r = await fetch(API + '/state', { headers: { accept: 'application/json' } })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        state = {
          ...state,
          loading: false,
          error: null,
          version: j.version || '',
          settings: j.settings || state.settings,
          preview: j.preview || state.preview,
        }
      } catch (e) {
        state = { ...state, loading: false, error: (e && e.message) || '无法连接宿主路由' }
      }
      emit()
    }

    async function save (patch) {
      const r = await fetch(API + '/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      let j = null
      try { j = await r.json() } catch { /* 非 JSON 响应按失败处理 */ }
      if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status))
      state = { ...state, settings: j.settings || state.settings, preview: j.preview || state.preview, error: null }
      emit()
      return j
    }

    function useStore () {
      const [snap, setSnap] = useState(state)
      useEffect(() => {
        listeners.add(setSnap)
        setSnap(state)
        return () => { listeners.delete(setSnap) }
      }, [])
      return snap
    }

    // ═══ 5. 样式（只用主题 token，全部带 fallback）══════════════════════
    // @ui-kit v1.3.0  共享 UI 基座（源：plugins/_shared/ui-kit.js；改源后重新复制本段）
    // ═════════════════════════════ [C] 颜色 token ═════════════════════════
    const C = {
      border: 'var(--dsw-alias-border-subtle, rgba(130,130,140,0.28))',
      text: 'var(--dsw-alias-text-primary, inherit)',
      dim: 'var(--dsw-alias-text-secondary, rgba(140,140,150,1))',
      accent: 'var(--dsw-alias-accent, #4f7cff)',
      surface: 'var(--dsw-alias-surface-raised, rgba(130,130,140,0.06))',
      ok: 'var(--dsw-alias-success, #2f9e6b)',
      warn: 'var(--dsw-alias-warning, #c8862a)',
      danger: 'var(--dsw-alias-danger, #e5534b)',
      radius: 'var(--dsw-radius-lg, 12px)',
      radiusSm: 'var(--dsw-radius-sm, 8px)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    // ═════════════════════════ [S_BASE] 通用样式 ═════════════════════════
    // 插件用 `{ ...S_BASE, ...特有键 }` 组装自己的 S，特有键不要回填本文件。
    const S_BASE = {
      card: { border: '1px solid ' + C.border, borderRadius: C.radius, padding: '16px 18px', display: 'grid', gap: '14px', color: C.text },
      head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      badge: { fontSize: '12px', color: C.dim, border: '1px solid ' + C.border, borderRadius: '999px', padding: '1px 8px' },
      status: { marginLeft: 'auto', fontSize: '12px', color: C.dim },
      desc: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: C.dim },
      /* 行布局自适应：空间不够时控件整体换到下一行，而不是把标题挤成一字一列 */
      row: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
      rowText: { display: 'grid', gap: '2px', flex: '1 1 200px', minWidth: '180px' },
      rowTitle: { fontSize: '13px', fontWeight: 550 },
      rowDesc: { fontSize: '12px', color: C.dim, lineHeight: 1.5 },
      field: { display: 'grid', gap: '4px' },
      label: { fontSize: '12px', color: C.dim },
      hint: { fontSize: '12px', color: C.dim, lineHeight: 1.5 },
      inline: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 1 auto', flexWrap: 'wrap', justifyContent: 'flex-end' },
      toggle: (on) => ({
        width: '38px', height: '22px', borderRadius: '999px', border: '1px solid ' + C.border,
        background: on ? C.accent : 'rgba(130,130,140,0.25)', position: 'relative', cursor: 'pointer',
        flex: 'none', marginTop: '2px', transition: 'background 160ms ease',
      }),
      knob: (on) => ({
        position: 'absolute', top: '2px', left: on ? '18px' : '2px', width: '16px', height: '16px',
        borderRadius: '50%', background: '#fff', transition: 'left 160ms ease',
      }),
      chip: (on) => ({
        padding: '3px 10px', fontSize: '12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid ' + (on ? C.accent : C.border),
        background: on ? C.accent : 'transparent',
        color: on ? '#fff' : C.dim,
      }),
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap', minWidth: 0 },
      panel: { background: C.surface, borderRadius: C.radiusSm, padding: '12px 14px', display: 'grid', gap: '10px' },
      input: {
        width: '110px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm, background: 'transparent', color: C.text,
      },
      textarea: {
        fontFamily: C.mono, fontSize: '12.5px', lineHeight: 1.6, padding: '8px 10px',
        resize: 'vertical', border: '1px solid ' + C.border, borderRadius: '6px',
        background: 'transparent', color: C.text, minHeight: '56px', width: '100%', boxSizing: 'border-box',
      },
      /* 文本输入：与 textarea 同族的全宽、等宽、左对齐；行内需要伸缩时在使用处加 flex */
      textInput: {
        width: '100%', boxSizing: 'border-box',
        fontFamily: C.mono, fontSize: '12.5px', lineHeight: 1.6, padding: '7px 9px',
        border: '1px solid ' + C.border, borderRadius: '6px',
        background: 'transparent', color: C.text,
      },
      btn: (disabled) => ({
        padding: '5px 12px', fontSize: '13px', borderRadius: C.radiusSm,
        border: '1px solid ' + C.border, background: 'transparent', color: C.text,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, flex: 'none',
      }),
      link: { fontSize: '13px', padding: '5px 12px', borderRadius: C.radiusSm, border: '1px solid ' + C.border, background: 'transparent', color: C.text, cursor: 'pointer' },
      line: {
        fontFamily: C.mono, fontSize: '12.5px', lineHeight: 1.6, wordBreak: 'break-all',
        background: 'rgba(130,130,140,0.12)', borderRadius: '6px', padding: '8px 10px', color: C.text,
      },
      empty: { fontSize: '12.5px', color: C.dim, fontStyle: 'italic' },
      msg: (bad) => ({ fontSize: '12px', color: bad ? C.danger : C.dim }),
      foot: { fontSize: '12px', color: C.dim, lineHeight: 1.6, margin: 0 },
      mono: { fontFamily: C.mono, wordBreak: 'break-all' },
      statItem: { display: 'grid', gap: '2px' },
      statValue: { fontSize: '18px', fontWeight: 600 },
      statKey: { fontSize: '12px', color: C.dim },
      range: { width: '100%', accentColor: C.accent, cursor: 'pointer' },
      sliderHead: { display: 'flex', alignItems: 'baseline', gap: '8px', justifyContent: 'space-between' },
      sliderValue: { fontSize: '13px', fontWeight: 600, fontFamily: C.mono },
    }

    // ═════════════════════════ [组件] 通用控件 ═════════════════════════
    /** 开关按钮。 */
    function Toggle ({ on, label, onChange }) {
      return h('button', {
        type: 'button',
        'aria-label': label,
        'aria-pressed': on ? 'true' : 'false',
        style: S.toggle(on),
        onClick: () => onChange(!on),
      }, h('span', { style: S.knob(on) }))
    }

    /** 一行设置：左标题与说明，右控件。 */
    function Row ({ title, desc, control }) {
      return h('div', { style: S.row },
        h('div', { style: S.rowText },
          h('div', { style: S.rowTitle }, title),
          desc ? h('div', { style: S.rowDesc }, desc) : null,
        ),
        control,
      )
    }

    /** 数据卡片：一个数值 + 一句说明。 */
    function Stat ({ value, label }) {
      return h('div', { style: S.statItem },
        h('div', { style: S.statValue }, value),
        h('div', { style: S.statKey }, label),
      )
    }

    // 模板优先：通用键全部来自 S_BASE，这里只放本插件特有的结构样式。
    const S = {
      ...S_BASE,
      // 头部总开关
      headToggle: { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '14px' },
      headToggleLabel: { fontSize: '12px', color: C.dim },
      // 当前标题
      currentPanel: {
        display: 'grid', gap: '6px', padding: '12px 14px',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm, background: C.surface,
      },
      currentRow: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      currentTitle: { fontSize: '15px', fontWeight: 600, lineHeight: 1.5, wordBreak: 'break-word' },
      dim: { fontSize: '12px', color: C.dim },
      badgeAgent: { fontSize: '12px', color: C.accent, border: '1px solid ' + C.accent, borderRadius: '999px', padding: '1px 8px' },
      // 提示词面板与统计行
      linkBtn: {
        marginLeft: 'auto', fontSize: '12px', border: 'none', background: 'transparent',
        color: C.accent, cursor: 'pointer', padding: 0,
      },
      pre: {
        fontFamily: C.mono, fontSize: '11.5px', lineHeight: 1.65, whiteSpace: 'pre-wrap',
        margin: 0, color: C.dim, maxHeight: '220px', overflow: 'auto',
      },
      actionBtn: {
        padding: '2px 10px', fontSize: '12px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid ' + C.border, background: 'transparent', color: C.text,
      },
      // 统计（一行三个数字）
      statGrid: { display: 'flex', gap: '18px', flexWrap: 'wrap' },
    }

    // ═══ 6. 设置页（slot: settings.section）═════════════════════════════
    /** UTF-8 字节数，用来展示「80 字节还剩多少」。 */
    function byteLength (text) {
      try { return new TextEncoder().encode(String(text || '')).length } catch { return String(text || '').length }
    }

    /** 来源 → 徽章文案。 */
    function sourceText (label) {
      switch (label) {
        case 'agent': return T('sourceAgent')
        case 'user': return T('sourceUser')
        case 'provider': return T('sourceProvider')
        case 'fallback': return T('sourceFallback')
        default: return T('sourceUnknown')
      }
    }

    /** 来源徽章。 */
    function SourceBadge ({ label }) {
      return h('span', { style: label === 'agent' ? S.badgeAgent : S.badge }, sourceText(label))
    }

    function SettingsCard () {
      const s = useStore()
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const [bytesDraft, setBytesDraft] = useState(null)
      const [bytesDirty, setBytesDirty] = useState(false)
      // 提示词草稿：null = 未编辑，显示服务端值；编辑后失焦保存，成功后回到 null
      const [toolDraft, setToolDraft] = useState(null)
      const [guidanceDraft, setGuidanceDraft] = useState(null)
      const [promptOpen, setPromptOpen] = useState(false)

      const msgTimer = useRef(null)
      const flash = (text, bad) => {
        setMsg({ text, bad })
        if (msgTimer.current) window.clearTimeout(msgTimer.current)
        msgTimer.current = window.setTimeout(() => setMsg(null), 3000)
      }
      // 组件卸载后不再 setState（轮询仍在跑，切页时常见）
      useEffect(() => () => {
        if (msgTimer.current) window.clearTimeout(msgTimer.current)
      }, [])

      // 每次保存一个序号：连续改两处时，先发的响应回来不能盖掉后一次的结果
      const saveSeq = useRef(0)
      const apply = useCallback(async (patch, okText) => {
        const seq = ++saveSeq.current
        setBusy(true)
        try {
          await save(patch)
          if (seq !== saveSeq.current) return false
          if (okText) flash(okText, false)
          return true
        } catch (e) {
          if (seq === saveSeq.current) flash(T('saveFailed', { msg: (e && e.message) || '' }), true)
          return false
        } finally {
          if (seq === saveSeq.current) setBusy(false)
        }
      }, [])

      const p = s.preview || {}
      const current = p.current || null
      const stats = p.stats || { total: 0, changes: 0, avgBytes: 0 }
      const maxBytes = p.maxBytes || s.settings.maxBytes || 80
      const maxPromptChars = p.maxPromptChars || 2000
      const showProvider = s.settings.showProviderTitles !== false
      const statusText = s.error
        ? T('statusError', { msg: s.error })
        : s.loading ? T('statusLoading')
          : p.hasSession ? T('statusReady') : T('statusNoSession')

      const bytesValue = bytesDirty ? (bytesDraft ?? '') : maxBytes

      // 语言切换后编辑的是另一份规范：清空草稿，避免把旧语言内容写进新语言字段
      useEffect(() => { setGuidanceDraft(null) }, [p.uiLocale])

      // 常驻设置行：显示自动标题、字节上限、注入开关
      const panelSettingsRow = h('div', { style: S.panel },
        h('div', { style: S.head }, h('div', { style: S.label }, T('settingsTitle'))),
        h(Row, {
          title: T('showProviderTitle'),
          desc: T('showProviderDesc'),
          control: h(Toggle, {
            on: showProvider,
            label: T('showProviderTitle'),
            onChange: (v) => apply({ showProviderTitles: v }, T('saved')),
          }),
        }),
        h(Row, {
          title: T('maxBytesTitle'),
          desc: T('maxBytesDesc'),
          control: h('input', {
            type: 'number',
            min: 16,
            max: 80,
            step: 1,
            inputMode: 'numeric',
            style: S.input,
            value: bytesValue,
            'aria-label': T('maxBytesTitle'),
            onChange: (e) => { setBytesDraft(Number(e.target.value)); setBytesDirty(true) },
            onBlur: () => {
              if (!bytesDirty) return
              setBytesDirty(false)
              const next = Number(bytesDraft)
              const valid = Number.isFinite(next) && next >= 16 && next <= 80
              if (!valid) {
                setBytesDraft(null)
                flash(T('bytesInvalid', { min: 16, max: 80 }), true)
                return
              }
              if (next !== maxBytes) apply({ maxBytes: next }, T('saved'))
            },
          }),
        }),
        h(Row, {
          title: T('guidanceToggle'),
          desc: T('guidanceToggleDesc'),
          control: h(Toggle, {
            on: p.injectGuidance !== false,
            label: T('guidanceToggle'),
            onChange: (v) => apply({ injectGuidance: v }, T('saved')),
          }),
        }),
      )

      // 模型提示词：工具描述 + 当前界面语言的注入规范；失焦保存，可恢复默认
      const promptLocaleField = p.uiLocale === 'en' ? 'guidanceEn' : 'guidanceZh'
      const promptLocaleLabel = p.uiLocale === 'en' ? T('langEn') : T('langZh')
      const customPrompt = p.custom || {}
      const hasCustomPrompt = Boolean(
        (customPrompt.toolDescription && customPrompt.toolDescription.trim()) ||
        (customPrompt[promptLocaleField] && String(customPrompt[promptLocaleField]).trim()),
      )
      const toolValue = toolDraft === null ? (customPrompt.toolDescription || '') : toolDraft
      const guidanceValue = guidanceDraft === null ? (customPrompt[promptLocaleField] || '') : guidanceDraft

      const saveToolDraft = () => {
        if (toolDraft === null) return
        const next = toolDraft
        apply({ toolDescription: next }, T('promptSaved')).then((ok) => { if (ok) setToolDraft(null) })
      }
      const saveGuidanceDraft = () => {
        if (guidanceDraft === null) return
        const next = guidanceDraft
        apply({ [promptLocaleField]: next }, T('promptSaved')).then((ok) => { if (ok) setGuidanceDraft(null) })
      }
      const resetPrompts = () => {
        // 保存成功后再清空草稿：失败时保留用户刚写的内容
        apply({ toolDescription: '', [promptLocaleField]: '' }, T('promptSaved')).then((ok) => {
          if (!ok) return
          setToolDraft(null)
          setGuidanceDraft(null)
        })
      }

      const panelPrompt = h('div', { style: S.panel },
        h('div', { style: S.head },
          h('div', { style: S.label }, T('promptTitle')),
          hasCustomPrompt ? h('span', { style: S.badge }, T('customized')) : null,
          h('button', {
            type: 'button',
            style: S.linkBtn,
            'aria-expanded': promptOpen ? 'true' : 'false',
            'aria-controls': 'dsh-session-title-prompts',
            onClick: () => setPromptOpen(!promptOpen),
          }, promptOpen ? T('collapse') : T('expand')),
        ),
        h('p', { style: S.desc }, T('promptDesc')),
        promptOpen
          ? h('div', { style: S.field, id: 'dsh-session-title-prompts' },
            h('div', { style: S.field },
              h('span', { style: S.rowTitle }, T('toolDescLabel')),
              h('span', { style: S.hint }, T('toolDescHint')),
              h('textarea', {
                style: S.textarea,
                value: toolValue,
                maxLength: maxPromptChars,
                placeholder: T('promptPlaceholder'),
                'aria-label': T('toolDescLabel'),
                onChange: (e) => setToolDraft(e.target.value),
                onBlur: saveToolDraft,
              }),
            ),
            h('div', { style: S.field },
              h('span', { style: S.rowTitle }, T('guidanceLabel')),
              h('span', { style: S.hint }, T('guidanceHint', { lang: promptLocaleLabel })),
              h('textarea', {
                style: S.textarea,
                value: guidanceValue,
                maxLength: maxPromptChars,
                placeholder: T('promptPlaceholder'),
                'aria-label': T('guidanceLabel'),
                onChange: (e) => setGuidanceDraft(e.target.value),
                onBlur: saveGuidanceDraft,
              }),
            ),
            h('div', { style: S.head },
              h('div', { style: S.label }, T('guidanceTitle')),
              h('span', { style: S.status }, p.injectGuidance !== false ? T('guidanceOn') : T('guidanceOff')),
            ),
            h('pre', { style: S.pre }, p.guidance || T('guidanceEmpty')),
            h('div', { style: S.inline },
              h('button', { type: 'button', style: S.actionBtn, onClick: resetPrompts }, T('resetDefault')),
            ),
          )
          : null,
      )

      return h('div', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, T('heading')),
          s.version ? h('span', { style: S.badge }, 'v' + s.version) : null,
          h('div', { style: S.headToggle },
            h('span', { style: S.headToggleLabel }, s.settings.enabled ? T('on') : T('off')),
            h(Toggle, {
              on: Boolean(s.settings.enabled),
              label: T('enablePlugin'),
              onChange: (v) => apply({ enabled: v }, v ? T('saved') : T('off')),
            }),
          ),
        ),

        busy ? h('div', { style: S.hint, role: 'status' }, T('saving')) : null,
        msg ? h('div', { style: S.msg(msg.bad), role: msg.bad ? 'alert' : 'status' }, msg.text) : null,

        h('div', { style: S.currentPanel },
          h('div', { style: S.head },
            h('div', { style: S.label }, T('currentTitle')),
            h('span', { style: S.status }, statusText),
          ),
          current
            ? h('div', { style: S.currentRow },
              h(SourceBadge, { label: current.label }),
              h('span', { style: S.currentTitle }, current.title),
              h('span', { style: S.dim }, T('bytes', { n: byteLength(current.title), max: maxBytes })),
            )
            : h('div', { style: S.empty }, p.hasSession ? T('noTitle') : T('noSessionPanel')),
        ),

        panelSettingsRow,
        panelPrompt,

        // 轻量统计：一行三个数字，带小标题，避免裸数字
        h('div', { style: S.field },
          h('div', { style: S.label }, T('statsTitle')),
          h('div', { style: S.statGrid },
            h(Stat, { value: String(stats.total), label: T('statEvents') }),
            h(Stat, { value: String(stats.changes), label: T('statChanges') }),
            h(Stat, { value: String(stats.avgBytes) + ' B', label: T('statAvg') }),
          ),
        ),

        h('p', { style: S.foot }, T('foot', { path: p.settingsPath || '~/.dsh/dsh-session-title-rules.json' })),
      )
    }

// ═══ 7. 注册 ═══════════════════════════════════════════════════════
    function contribute (ctx, key, options, Component, what) {
      const fail = (e) => console.error(LOG, 'could not register ' + what + ':', e)
      try {
        return ctx.slots.inject(key, () => {
          try {
            return ctx.slots.register(options, Component)
          } catch (e) {
            fail(e)
            return () => {}
          }
        })
      } catch (e) {
        fail(e)
        return () => {}
      }
    }

    const inject = ['slots', 'locale']

    function apply (ctx) {
      // 文案：宿主 locale 齐全就接上（zh + en），否则退回中文
      if (ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
        try {
          ctx.locale.register(NS, { zh: ZH, en: EN })
          translate = ctx.locale.bind(NS)
        } catch (e) {
          console.error(LOG, 'locale register failed:', e)
        }
      }

      // 把界面语言上报给宿主：决定注入的是中文还是英文规范
      const reportLocale = () => {
        try {
          const snap = ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
          const active = snap && typeof snap.active === 'string' ? snap.active : null
          if (!active) return
          const locale = active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
          fetch(API + '/locale', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locale }),
          }).catch(() => {})
        } catch { /* 上报失败不影响界面 */ }
      }

      ctx.effect(() => {
        reportLocale()
        const off = ctx.locale && typeof ctx.locale.subscribe === 'function' ? ctx.locale.subscribe(reportLocale) : null
        return () => { if (typeof off === 'function') off() }
      }, 'dsh-session-title-rules-locale')

      // 轮询：只在前台刷新，页面隐藏时停手
      ctx.effect(() => {
        refresh()
        const timer = setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
        const onVisible = () => { if (!document.hidden) refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, 'dsh-session-title-rules-poll')

      // 自研插件一律用 kind: 'list' 的槽位；single 槽位第二个注册会连带杀掉核心插件。
      // order 决定它在设置页左侧导航里的位置，取同类页面之间即可。
      ctx.effect(
        () => contribute(
          ctx,
          'settings.section',
          { name: 'settings.section', id: 'dsh-session-title-rules', order: 240, locale: NS, label: () => T('nav') },
          SettingsCard,
          'settings.section',
        ),
        'dsh-session-title-rules-settings-section',
      )
    }

    return { inject, apply }
  },
})
