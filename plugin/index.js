/**
 * dsh-cu-desktop —— 给 DSH 一组桌面操作工具（视觉优先）
 *
 * 为什么不用 dsh-computer-use / cua-driver：那套依赖 macOS 无障碍树（AX），
 * 而这台机器上第三方二进制拿不到 AXWindow（锁屏时尤其明显）。这里改走**视觉路线**：
 *
 *   看窗口  → CGWindowList（不需要任何权限）
 *   看内容  → screencapture（DSH 已有屏幕录制权限）
 *   操作    → CGEvent 投递给目标进程（不移动真实鼠标、不抢前台）
 *
 * 这正是 Codex 那种 computer use 的做法，也是目前这台机器上唯一确定能走通的路。
 *
 * 底层是 ~/Projects/dsh-cua-patched/tools/dsh-cu（Swift，源码同目录）。
 */

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const name = 'dsh-cu-desktop'
export const inject = ['tools']

const TRACE = '/tmp/dsh-cu-desktop.log'
function trace(line) {
  try { fs.appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`) } catch {}
}

// 找 dsh-cu 的位置：先看环境变量，再看待安装位置，最后是开发目录
const CANDIDATES = [
  process.env.DSH_CU_BIN,
  path.join(os.homedir(), '.dsh/bin/dsh-cu'),
  path.join(os.homedir(), 'Projects/dsh-cua-patched/tools/dsh-cu'),
].filter(Boolean)

function cuBin() {
  for (const p of CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  throw new Error('找不到 dsh-cu。跑一下仓库里的 install.sh，或设 DSH_CU_BIN 指向它')
}

// ── 系统级光标浮层 ─────────────────────────────────────────────────────────
// 用户想看得见操作时，屏幕上得有个光标在动。浮层是独立的 NSPanel 进程：
// 不抢前台、点击穿透、永远置顶。这里按需拉起 —— 第一次要动桌面时才起，
// 不需要开机常驻，用户零操作。

const OVERLAY = path.join(os.homedir(), '.dsh/bin/dsh-cursor-overlay')
let cursorChecked = false

function ensureCursor() {
  if (cursorChecked) return
  cursorChecked = true
  try {
    execFileSync('/usr/bin/pgrep', ['-f', 'dsh-cursor-overlay'], { stdio: 'ignore' })
    trace('光标浮层已在跑')
    return
  } catch { /* 没跑，起一个 */ }
  try {
    fs.accessSync(OVERLAY, fs.constants.X_OK)
    const child = spawn(OVERLAY, [], { detached: true, stdio: 'ignore' })
    child.unref()
    // 等浮层把 FIFO 读端打开，否则这一次的光标 ping 会落空
    try { execFileSync('/bin/sleep', ['0.7']) } catch {}
    trace('已拉起光标浮层')
  } catch (e) {
    trace(`光标浮层起不来: ${e && e.message}（不影响操作，只是看不见光标）`)
  }
}

function run(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cuBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; reject(new Error(`dsh-cu 超时（${timeoutMs}ms）`)) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`起不来 dsh-cu: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `dsh-cu 退出码 ${code}`))
    })
  })
}

// ── 工具外壳（不 import 任何 @deepseek-ai/*，形状按 dsh-tools 的产出手搓）──────

function specToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: { schema: options.output.schema, render: options.output.render },
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    execute: options.execute,
  }
}

const textOutput = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: { text: { type: 'string' } }, required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

const present = (title) => (args) => ({ card: 'generic', title, kind: 'other', rawInput: args })

/** render 是同步的，execute 里把附件引用存在这里，render 用 token 取回 */
const shotRefs = new Map()

/** OCR 找文字 → 屏幕坐标（dsh-cu find 的输出是 "序号\tx,y\t置信度\t文字"） */
async function findText(text, pid) {
  const a = ['find', text]
  if (pid) a.push('--pid', String(pid))
  let out
  try {
    out = await run(a, 60000)
  } catch (e) {
    throw new Error(`没在屏幕上找到「${text}」${pid ? `（窗口 pid=${pid}）` : ''}。先 desktop_screenshot 看一眼现在是什么界面`)
  }
  const line = out.split('\n')[0]
  const [idx, xy, conf, ...rest] = line.split('\t')
  const [x, y] = (xy || '').split(',').map(Number)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`OCR 结果解析不了: ${line}`)
  return { x, y, conf: conf || '?', text: rest.join('\t') || text }
}

function parseWindows(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const [pid, wid, app, title, bounds] = line.split('\t')
    const m = /(\d+),(\d+) (\d+)×(\d+)/.exec(bounds || '')
    return {
      pid: Number(pid), windowId: Number(wid), app, title,
      x: m ? Number(m[1]) : 0, y: m ? Number(m[2]) : 0,
      width: m ? Number(m[3]) : 0, height: m ? Number(m[4]) : 0,
    }
  })
}

export function apply(ctx, config) {
  trace('apply 被调用')

  const tools = [
    defineTool({
      name: 'desktop_windows',
      description:
        '列出当前屏幕上所有可见窗口，含 pid、窗口 id、应用名、标题和**屏幕坐标**（左上角 x,y 和宽高）。' +
        '桌面操作前先用它拿到目标和坐标。不依赖无障碍权限，始终可用。',
      parameters: {
        filter: { type: 'string', description: '可选：按应用名或标题过滤（不区分大小写）' },
      },
      output: textOutput,
      presentCall: present('Desktop windows'),
      async execute(args) {
        const wins = parseWindows(await run(['winlist']))
        const f = (args.filter || '').toLowerCase()
        const list = f ? wins.filter((w) => w.app.toLowerCase().includes(f) || w.title.toLowerCase().includes(f)) : wins
        if (!list.length) return { text: '(没有匹配的窗口)' }
        return {
          text: list.map((w) =>
            `pid=${w.pid} win=${w.windowId} ${w.app}${w.title ? ` «${w.title.slice(0, 40)}»` : ''} @(${w.x},${w.y}) ${w.width}×${w.height}`
          ).join('\n'),
        }
      },
    }),

    defineTool({
      name: 'desktop_screenshot',
      description:
        '给屏幕或某个窗口截图，图片直接返回给你看。给了 pid 就只截那个应用最前面的窗口，' +
        '否则截全屏。**先截图、看清按钮位置，再用 desktop_click 按坐标点** —— 这是推荐的工作方式。',
      parameters: {
        pid: { type: 'integer', description: '可选：只截这个进程的窗口' },
        maxWidth: { type: 'integer', description: '可选：缩小到多少像素宽（默认原图）' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, token: { type: 'string' } },
          required: ['text', 'token'],
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.text }]
          const ref = shotRefs.get(value.token)
          if (ref) { shotRefs.delete(value.token); blocks.push({ type: 'image', attachment: ref }) }
          return blocks
        },
      },
      presentCall: present('Desktop screenshot'),
      async execute(args) {
        const file = path.join(os.tmpdir(), `dsh-cu-${Date.now()}.png`)
        let target = ''
        if (args.pid) {
          const wins = parseWindows(await run(['winlist'])).filter((w) => w.pid === Number(args.pid))
          if (!wins.length) throw new Error(`pid ${args.pid} 没有可见窗口`)
          const w = wins[0]
          target = `${w.app} «${w.title}» @(${w.x},${w.y}) ${w.width}×${w.height}`
          // 全屏截完再裁 —— 锁屏/无窗口时 -R 会失败，全屏更稳
          const full = path.join(os.tmpdir(), `dsh-cu-full-${Date.now()}.png`)
          await run(['shot', '--out', full], 60000)
          execFileSync('/usr/bin/sips', ['-c', String(w.height), String(w.width), '--cropOffset', String(w.y), String(w.x), full, '--out', file], { stdio: 'ignore' })
        } else {
          await run(['shot', '--out', file], 60000)
          target = '全屏'
        }
        let buf = fs.readFileSync(file)
        if (args.maxWidth && buf.length > 200_000) {
          execFileSync('/usr/bin/sips', ['--resampleWidth', String(args.maxWidth), file, '--out', file], { stdio: 'ignore' })
          buf = fs.readFileSync(file)
        }
        const note = `截图（${target}，${Math.round(buf.length / 1024)}KB）`
        const attachments = ctx.get('attachments')
        if (attachments) {
          try {
            const [ref] = await attachments.saveImages([{ data: buf, mediaType: 'image/png', name: `desktop-${Date.now()}.png` }])
            const token = crypto.randomUUID()
            shotRefs.set(token, ref)
            if (shotRefs.size > 20) shotRefs.delete(shotRefs.keys().next().value)
            return { text: note, token }
          } catch { /* 落文件兜底 */ }
        }
        return { text: `${note}\n（附件库不可用，已存到 ${file}）`, token: '' }
      },
    }),

    defineTool({
      name: 'desktop_click',
      description:
        '点击。**优先用 text**（OCR 找屏幕上的文字再点，最稳、不怕界面挪位置）；' +
        '找不到文字再用 x/y 坐标（来自 desktop_screenshot 或 desktop_windows）。' +
        '默认**投递给目标进程**（不移动你的真实鼠标、不抢前台）；某些应用不响应时加 global=true 走系统事件。',
      parameters: {
        pid: { type: 'integer', required: true, description: '目标进程 pid（来自 desktop_windows）' },
        index: { type: 'integer', description: 'desktop_observe 给的编号 —— **最推荐**，比坐标稳' },
        text: { type: 'string', description: '要点的文字（OCR 找它，例如「登录」「Continue」）' },
        x: { type: 'integer', description: '屏幕坐标 X（左上原点），没给 text 时必填' },
        y: { type: 'integer', description: '屏幕坐标 Y（左上原点），没给 text 时必填' },
        global: { type: 'boolean', description: 'true = 走系统事件并移动真实鼠标（默认 false）' },
      },
      output: textOutput,
      presentCall: present('Desktop click'),
      async execute(args) {
        if (args.index) {
          ensureCursor()
          return { text: await run(['click-index', String(args.pid), String(args.index)]) }
        }
        let x = args.x, y = args.y, how = '坐标'
        if (args.text) {
          const hit = await findText(args.text, args.pid)
          x = hit.x; y = hit.y; how = `文字「${hit.text}」`
        }
        if (x === undefined || y === undefined) throw new Error('要么给 text，要么给 x 和 y')
        ensureCursor()
        const a = ['clickat', String(args.pid), String(Math.round(x)), String(Math.round(y))]
        if (args.global) a.push('--global')
        await run(a)
        return { text: `已点击 ${how} → (${Math.round(x)}, ${Math.round(y)})` }
      },
    }),

    defineTool({
      name: 'desktop_observe',
      description:
        '**桌面操作的首选第一步**：截取目标窗口，并把所有可点元素（按钮/输入框/链接/勾选框…）在图上用蓝色编号标出来，' +
        '同时返回编号清单（编号 / 类型 / 文字 / 坐标）。' +
        '看完直接 `desktop_click(pid, index=N)` 点第 N 个 —— 比猜坐标可靠得多。' +
        '（原理：走 macOS 无障碍树枚举元素；锁屏时拿不到，那种情况请改用 desktop_screenshot + desktop_find_text。）',
      parameters: {
        pid: { type: 'integer', required: true, description: '目标进程 pid（来自 desktop_windows）' },
        limit: { type: 'integer', description: '最多标多少个元素，默认 60' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, token: { type: 'string' } },
          required: ['text', 'token'],
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.text }]
          const ref = shotRefs.get(value.token)
          if (ref) { shotRefs.delete(value.token); blocks.push({ type: 'image', attachment: ref }) }
          return blocks
        },
      },
      presentCall: present('Desktop observe'),
      async execute(args) {
        const out = path.join(os.tmpdir(), `dsh-cu-observe-${args.pid}-${Date.now()}.png`)
        const a = ['observe', String(args.pid), '--out', out]
        if (args.limit) a.push('--limit', String(args.limit))
        ensureCursor()
        let raw
        try {
          raw = await run(a, 60000)
        } catch (e) {
          throw new Error(`${e.message}\n（如果应用没有窗口，或屏幕锁着，就用 desktop_screenshot + desktop_find_text）`)
        }
        const lines = raw.split('\n')
        const file = lines[0]
        const win = (lines.find((l) => l.startsWith('window\t')) || '').split('\t')[1] || ''
        const items = lines.filter((l) => /^\d+\t/.test(l))
        const text = `窗口 ${win}，共 ${items.length} 个可点元素：\n` +
          items.map((l) => { const [i, role, label, xy] = l.split('\t'); return `  [${i}] ${role.replace('AX', '')} «${label}» @${xy}` }).join('\n')

        const buf = fs.readFileSync(file)
        const attachments = ctx.get('attachments')
        if (attachments) {
          try {
            const [ref] = await attachments.saveImages([{ data: buf, mediaType: 'image/png', name: `observe-${args.pid}.png` }])
            const token = crypto.randomUUID()
            shotRefs.set(token, ref)
            if (shotRefs.size > 20) shotRefs.delete(shotRefs.keys().next().value)
            return { text, token }
          } catch {}
        }
        return { text: `${text}\n（附件库不可用，标注图在 ${file}）`, token: '' }
      },
    }),

    defineTool({
      name: 'desktop_find_text',
      description:
        'OCR 找屏幕上的文字，返回它的屏幕坐标（可以直接喂给 desktop_click）。' +
        '界面里找不到元素、又不想靠猜坐标时用它。可以指定 pid 只在那个窗口里找。',
      parameters: {
        text: { type: 'string', required: true, description: '要找的文字（支持中英文）' },
        pid: { type: 'integer', description: '可选：只在这个进程的窗口里找' },
      },
      output: textOutput,
      presentCall: present('Desktop find text'),
      async execute(args) {
        const hit = await findText(args.text, args.pid)
        return { text: `找到「${hit.text}」@ (${Math.round(hit.x)}, ${Math.round(hit.y)})  置信度 ${hit.conf}` }
      },
    }),

    defineTool({
      name: 'desktop_type',
      description: '往目标进程输入文字（支持中文）。输入前通常要先用 desktop_click 点一下输入框。',
      parameters: {
        pid: { type: 'integer', required: true, description: '目标进程 pid' },
        text: { type: 'string', required: true, description: '要输入的文字' },
      },
      output: textOutput,
      presentCall: present('Desktop type'),
      async execute(args) {
        return { text: await run(['type', String(args.pid), args.text]) }
      },
    }),

    defineTool({
      name: 'desktop_apps',
      description: '列出正在运行的应用（pid + 名字 + bundleId，* = 当前前台）。想操作某个应用先用它拿 pid。',
      parameters: {},
      output: textOutput,
      presentCall: present('Desktop apps'),
      async execute() {
        const out = await run(['apps'])
        const list = out.split('\n').filter(Boolean)
        return { text: list.length ? list.join('\n') : '(没有运行中的应用)' }
      },
    }),

    defineTool({
      name: 'desktop_launch',
      description: '在**后台**启动一个应用（不会抢前台、不打断用户）。参数可以是应用名（如 "TextEdit"、"计算器"）或 bundleId（如 "com.apple.TextEdit"）。',
      parameters: {
        target: { type: 'string', required: true, description: '应用名或 bundleId' },
      },
      output: textOutput,
      presentCall: present('Desktop launch'),
      async execute(args) {
        return { text: await run(['launch', args.target], 30000) }
      },
    }),

    defineTool({
      name: 'desktop_scroll',
      description: '在目标窗口的 (x, y) 处滚动。dy 为正向下滚、为负向上滚；dx 横向（默认 0）。',
      parameters: {
        pid: { type: 'integer', required: true, description: '目标进程 pid' },
        x: { type: 'integer', required: true, description: '滚轮所在屏幕坐标 X' },
        y: { type: 'integer', required: true, description: '滚轮所在屏幕坐标 Y' },
        dy: { type: 'integer', required: true, description: '纵向滚动量（正=向下）' },
        dx: { type: 'integer', description: '横向滚动量，默认 0' },
      },
      output: textOutput,
      presentCall: present('Desktop scroll'),
      async execute(args) {
        ensureCursor()
        const a = ['scroll', String(args.pid), String(args.x), String(args.y), String(args.dy)]
        if (args.dx) a.push(String(args.dx))
        return { text: await run(a) }
      },
    }),

    defineTool({
      name: 'desktop_drag',
      description: '从 (x1,y1) 拖到 (x2,y2)。用于拖文件、拖滑块、选中文本。',
      parameters: {
        pid: { type: 'integer', required: true, description: '目标进程 pid' },
        x1: { type: 'integer', required: true, description: '起点 X' },
        y1: { type: 'integer', required: true, description: '起点 Y' },
        x2: { type: 'integer', required: true, description: '终点 X' },
        y2: { type: 'integer', required: true, description: '终点 Y' },
      },
      output: textOutput,
      presentCall: present('Desktop drag'),
      async execute(args) {
        ensureCursor()
        return { text: await run(['drag', String(args.pid), String(args.x1), String(args.y1), String(args.x2), String(args.y2)]) }
      },
    }),

    defineTool({
      name: 'desktop_key',
      description:
        '给目标进程发按键。keycode 用 macOS 虚拟键码（回车 36、Tab 48、Esc 53、空格 49、' +
        '方向键 123-126、删除 51）。可加修饰键：cmd / shift / alt / ctrl，例如 cmd+shift 就是 ["cmd","shift"]。',
      parameters: {
        pid: { type: 'integer', required: true, description: '目标进程 pid' },
        keycode: { type: 'integer', required: true, description: 'macOS 虚拟键码，例如回车 36' },
        flags: { type: 'array', items: { type: 'string' }, description: '修饰键：cmd / shift / alt / ctrl' },
      },
      output: textOutput,
      presentCall: present('Desktop key'),
      async execute(args) {
        const a = ['key', String(args.pid), String(args.keycode), ...(args.flags || [])]
        return { text: await run(a) }
      },
    }),
  ]

  for (const tool of tools) {
    try { ctx.tools.register(tool) } catch (e) { trace(`注册 ${tool.name} 失败: ${e && e.message}`); throw e }
  }
  trace(`已注册 ${tools.length} 个工具: ${tools.map((t) => t.name).join(', ')}`)
}

trace('模块已加载')
