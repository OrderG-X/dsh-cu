/**
 * DSH 插件页里那张设置卡的后端：一条 HTTP 路由，挂在 DSH 自己的 webServer 上。
 *
 *   GET  /dsh-mac-computer-use/panel           → 状态（命令行工具、光标浮层、两项系统权限、看得到几个窗口、光标开关）
 *   POST /dsh-mac-computer-use/panel {action}  → cursor / copyInstall / copyUpdate / openSettings，回新状态
 *
 * 页面（client.js）跑在 DSH 的网页端，只能走 HTTP。webServer 本身不做鉴权，
 * 而浏览器里随便哪个网页都摸得到 127.0.0.1，所以自己把门：只收本机连接、Host 必须是本机名、
 * 跨站的 Origin 一律拒、POST 必须是 JSON（跨站发不出来，会先被预检挡住）。
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import {
  findBin, overlayState, stopOverlay, permissions, readConfig, writeConfig, INSTALL_CMD, UPDATE_CMD, ENGINE_FEATURES, SETTINGS_PANES,
} from './setup.js'

export const PANEL_ROUTE = '/dsh-mac-computer-use/panel'

const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version } catch { return '' }
})()

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/** 能看到几个窗口：证明命令行工具真的跑得起来。跑不起来回 null。 */
function countWindows(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['winlist'], { timeout: 5000 }, (err, out) => {
      resolve(err ? null : String(out).split('\n').filter(Boolean).length)
    })
  })
}

/** 引擎支持的增强（dsh-cu features，一行一个）。旧引擎没这个命令，回空集合 */
function engineFeatures(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['features'], { timeout: 5000 }, (err, out) => {
      resolve(new Set(err ? [] : String(out).split('\n').map((l) => l.trim()).filter(Boolean)))
    })
  })
}

export async function panelState() {
  const base = { plugin: PKG_VERSION, platform: process.platform, showCursor: readConfig().showCursor !== false, installCmd: INSTALL_CMD, updateCmd: UPDATE_CMD }
  if (process.platform !== 'darwin') return base
  const bin = findBin()
  const [perms, windows, features] = await Promise.all([
    permissions(), bin ? countWindows(bin.path) : null, bin ? engineFeatures(bin.path) : new Set(),
  ])
  const outdated = ENGINE_FEATURES.some((f) => !features.has(f))
  return { ...base, bin: bin && { source: bin.source, outdated }, overlay: overlayState(), perms, windows }
}

/** 跨站请求一律拒：没带 Origin（同源 GET、curl）放行；带了就必须是 DSH 自己。 */
function allowed(req, origin) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false
  if (!LOOPBACK_HOST.test(req.headers.host || '')) return false
  const from = req.headers.origin
  if (!from) return true
  if (from === 'null') return false
  let own
  try { own = origin() } catch { own = '' }
  if (from === own) return true
  try {
    const a = new URL(from), b = new URL(own)
    return LOOPBACK_HOST.test(a.host) && a.port === b.port && a.protocol === b.protocol
  } catch {
    return false
  }
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求太大')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('不是 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * @param deps.origin - DSH 网页端自己的 origin（webServer.getOrigin）
 * @param deps.trace - 日志
 */
export function panelHandler({ origin, trace = () => {} }) {
  return async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!allowed(req, origin)) {
      trace(`设置页路由拒绝了一个请求：${req.socket.remoteAddress} host=${req.headers.host} origin=${req.headers.origin}`)
      return send(403, { error: 'forbidden' })
    }
    if (req.method === 'GET') return send(200, await panelState())
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415, { error: 'expect application/json' })

    let body
    try { body = await readJson(req) } catch (e) { return send(400, { error: e.message }) }
    const extra = {}
    try {
      switch (body.action) {
        case 'cursor':
          writeConfig({ showCursor: !!body.on })
          if (!body.on) stopOverlay()
          trace(`设置页：桌面光标 ${body.on ? '开' : '关'}`)
          break
        case 'copyInstall':
          execFileSync('/usr/bin/pbcopy', [], { input: INSTALL_CMD })
          extra.copied = true
          break
        case 'copyUpdate':
          execFileSync('/usr/bin/pbcopy', [], { input: UPDATE_CMD })
          extra.copied = true
          break
        case 'openSettings': {
          const url = SETTINGS_PANES[body.pane]
          if (!url) return send(400, { error: `不认识的 pane: ${body.pane}` })
          execFileSync('/usr/bin/open', [url], { stdio: 'ignore' })
          extra.opened = body.pane
          break
        }
        default:
          return send(400, { error: `不认识的 action: ${body.action}` })
      }
    } catch (e) {
      return send(200, { ...(await panelState()), actionError: String((e && e.message) || e) })
    }
    return send(200, { ...(await panelState()), ...extra })
  }
}
