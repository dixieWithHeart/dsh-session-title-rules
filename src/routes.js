/**
 * 设置页用的 HTTP 路由。
 *
 * 四条：读状态、写设置、改名、上报界面语言。与本机既有插件（dsh-auto-continue /
 * dsh-context-usage）同款，**无鉴权**：DSH 的 Web 入口本身要 token，但这些自注册路由
 * 不带校验，任何本机进程都能读写。只放低敏感数据（标题文本、规则开关）；
 * 目标会话始终是宿主当前活跃会话，不接受外部传入 sessionId。
 *
 * 响应统一带 `cache-control: no-store`，避免设置页轮询拿到陈旧值。
 */

import { VERSION, MAX_BODY_BYTES } from './constants.js'
import { sanitize } from './settings.js'

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

/** 读满请求体；超限返回 null（上层回 413）。 */
async function readBody (req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY_BYTES) return null
  }
  return body
}

function sendJson (res, status, payload) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

async function readJson (req, res) {
  const body = await readBody(req)
  if (body === null) {
    res.writeHead(413); res.end()
    return null
  }
  try {
    return JSON.parse(body || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    return null
  }
}

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings - 当前生效设置
 * @param {(next: object) => void} deps.setSettings - 就地更新
 * @param {(settings: object) => boolean} deps.persist - 落盘
 * @param {() => object} deps.payload - 状态载荷
 * @param {(title: string) => object} deps.renameFromUi - 页面手动改名
 * @param {(locale: string) => object} deps.setLocale - 客户端上报界面语言
 * @param {object} deps.log
 */
export function createRoutes ({ getSettings, setSettings, persist, payload, renameFromUi, setLocale, log }) {
  const statePayload = typeof payload === 'function' ? payload : () => ({})

  return [
    {
      kind: 'exact',
      path: '/api/dsh-session-title-rules/state',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
        sendJson(res, 200, { version: VERSION, settings: getSettings(), preview: statePayload() })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-session-title-rules/set',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const patch = await readJson(req, res)
        if (patch === null) return

        const current = getSettings()
        const next = sanitize(patch, current)
        const changed = JSON.stringify(next) !== JSON.stringify(current)
        if (changed) {
          setSettings(next)
          if (!persist(next)) {
            sendJson(res, 500, { ok: false, error: '设置写入失败，见 DSH 日志', settings: getSettings() })
            return
          }
          log.info(`settings updated: enabled=${next.enabled} maxBytes=${next.maxBytes}`)
        }
        sendJson(res, 200, { ok: true, changed, settings: getSettings(), preview: statePayload() })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-session-title-rules/rename',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const args = await readJson(req, res)
        if (args === null) return
        const title = args && typeof args.title === 'string' ? args.title : ''
        const result = renameFromUi(title)
        sendJson(res, 200, { ok: true, result, preview: statePayload() })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-session-title-rules/locale',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const args = await readJson(req, res)
        if (args === null) return
        const locale = args && typeof args.locale === 'string' ? args.locale : ''
        const result = setLocale(locale)
        sendJson(res, 200, { ok: true, result })
      },
    },
  ]
}
