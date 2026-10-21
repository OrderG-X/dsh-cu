/**
 * DSH 设置卡（plugin/panel.js + setup.js）和「显示光标」开关的测试。
 *
 *   node tools/test-panel.mjs
 *
 * 用一个假的 dsh-cu（只把参数记下来）和临时配置文件，不碰真设置、不真去点屏幕、不拉起光标浮层。
 * 唯一的副作用：「关光标」会结束正在跑的光标浮层（下次操作它自己会起来）。
 * 权限那一项会真跑一次 osascript：查到的是跑这个脚本的应用的权限，只验格式。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cu-test-'))
const argLog = path.join(tmp, 'args.log')
const fakeBin = path.join(tmp, 'dsh-cu')
fs.writeFileSync(fakeBin, `#!/bin/sh
if [ "$1" = version ]; then echo 2; exit 0; fi
echo "$@" >> "${argLog}"
if [ "$1" = winlist ]; then printf '1\\t2\\tFinder\\t\\t0,0 100×100\\n3\\t4\\tNotes\\tx\\t10,10 200×200\\n'; fi
`, { mode: 0o755 })
process.env.DSH_CU_BIN = fakeBin
process.env.DSH_CU_CONFIG = path.join(tmp, 'config.json')
process.env.DSH_CU_OVERLAY = path.join(tmp, 'no-overlay')

const { panelHandler, PANEL_ROUTE } = await import('../plugin/panel.js')
const { readConfig } = await import('../plugin/setup.js')
const plugin = await import('../plugin/index.js')

// 插件 apply：假 ctx，把工具和路由收下来
const tools = {}
let route = null
plugin.apply({
  tools: { register: (t) => { tools[t.name] = t } },
  get: () => null,
  inject: (deps, cb) => cb({
    effect: (fn) => fn(),
    webServer: { register: (r) => { route = r }, getOrigin: () => `http://127.0.0.1:${port}` },
  }),
})

let port = 0
const server = http.createServer(panelHandler({ origin: () => `http://127.0.0.1:${port}` }))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
port = server.address().port

const req = (method, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const r = http.request({
    host: '127.0.0.1', port, path: PANEL_ROUTE, method,
    headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
  }, (res) => {
    let acc = ''
    res.on('data', (d) => { acc += d })
    res.on('end', () => resolve({ status: res.statusCode, body: acc ? JSON.parse(acc) : null }))
  })
  r.on('error', reject)
  if (data) r.write(data)
  r.end()
})

const lastArgs = () => fs.readFileSync(argLog, 'utf8').trim().split('\n').pop()

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`✓ ${name}`) } catch (e) { results.push(`❌ ${name}: ${e.message}`) }
}

try {
  await check('插件挂上了 11 个工具和设置页路由', async () => {
    assert.equal(Object.keys(tools).length, 11)
    assert.equal(route && route.path, PANEL_ROUTE)
    assert.equal(route.kind, 'exact')
  })

  await check('读状态：找到命令行、数出窗口、权限有格式、光标默认开', async () => {
    const { status, body } = await req('GET')
    assert.equal(status, 200)
    assert.equal(body.platform, 'darwin')
    assert.deepEqual(body.bin, { source: 'env' })
    assert.equal(body.windows, 2)
    assert.ok(['boolean', 'object'].includes(typeof body.perms.screen))
    assert.ok(['boolean', 'object'].includes(typeof body.perms.ax))
    assert.equal(typeof body.overlay.installed, 'boolean')
    assert.equal(body.showCursor, true)
    assert.match(body.installCmd, /install\.sh/)
  })

  await check('光标开着：点击不带 --no-cursor', async () => {
    await tools.desktop_click.execute({ pid: 1, x: 5, y: 6 })
    assert.match(lastArgs(), /^clickat 1 5 6$/)
  })

  await check('关光标：写进配置，点击带 --no-cursor', async () => {
    const r = await req('POST', { action: 'cursor', on: false })
    assert.equal(r.body.showCursor, false)
    assert.equal(readConfig().showCursor, false)
    await tools.desktop_click.execute({ pid: 1, x: 5, y: 6 })
    assert.match(lastArgs(), /--no-cursor/)
  })

  await check('再打开：不再带 --no-cursor', async () => {
    const r = await req('POST', { action: 'cursor', on: true })
    assert.equal(r.body.showCursor, true)
    await tools.desktop_click.execute({ pid: 1, x: 5, y: 6 })
    assert.doesNotMatch(lastArgs(), /--no-cursor/)
  })

  await check('openSettings 只认两个面板', async () => {
    assert.equal((await req('POST', { action: 'openSettings', pane: 'camera' })).status, 400)
  })

  await check('把门：跨站 Origin 拒', async () => {
    assert.equal((await req('GET', undefined, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await req('POST', { action: 'cursor', on: false }, { origin: 'https://evil.example' })).status, 403)
    assert.equal(readConfig().showCursor, true)
  })

  await check('把门：自己的 Origin 放行', async () => {
    assert.equal((await req('GET', undefined, { origin: `http://127.0.0.1:${port}` })).status, 200)
    assert.equal((await req('GET', undefined, { origin: `http://localhost:${port}` })).status, 200)
  })

  await check('把门：Host 不是本机（DNS 重绑定）拒', async () => {
    assert.equal((await req('GET', undefined, { host: 'evil.example' })).status, 403)
  })

  await check('把门：POST 不是 JSON 拒', async () => {
    const code = await new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, path: PANEL_ROUTE, method: 'POST', headers: { 'content-type': 'text/plain' } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      q.end('{"action":"cursor","on":false}')
    })
    assert.equal(code, 415)
  })

  await check('不认识的 action', async () => {
    assert.equal((await req('POST', { action: 'nuke' })).status, 400)
  })
} finally {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
