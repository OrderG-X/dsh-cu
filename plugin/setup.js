/**
 * 本机环境：命令行引擎 dsh-cu 在哪、光标浮层在不在、DSH 有没有系统权限、用户设置。
 * 工具（index.js）和 DSH 设置页（panel.js）共用。
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 找 dsh-cu 的位置：先看环境变量，再看待安装位置，最后是开发目录（本机调试用）
const CANDIDATES = [
  ['env', process.env.DSH_CU_BIN],
  ['installed', path.join(os.homedir(), '.dsh/bin/dsh-cu')],
  ['dev', path.join(os.homedir(), 'Projects/dsh-cua-patched/tools/dsh-cu')],
].filter(([, p]) => p)

export const INSTALL_CMD = 'git clone https://github.com/OrderG-X/dsh-mac-computer-use.git && cd dsh-mac-computer-use && ./install.sh'

/** 找不到二进制时的报错：必须自带公开安装步骤，不能只有本机才看得懂的路径提示。 */
export const INSTALL_HINT = [
  'dsh-cu 还没装（一次性前置，装完不用再管）：',
  '1. 装 Xcode 命令行工具（提供 swiftc）：xcode-select --install',
  '2. 拉源码并编译：',
  `     ${INSTALL_CMD}`,
  '   它会用 swiftc 编译 dsh-cu 与光标浮层，装到 ~/.dsh/bin/',
  '3. 回到这里重试即可（想看装没装好：ls ~/.dsh/bin/dsh-cu）',
  '二进制在别处的话，用 DSH_CU_BIN=/path/to/dsh-cu 指过去。',
].join('\n')

/** @returns {{ path: string, source: 'env'|'installed'|'dev' } | null} */
export function findBin() {
  for (const [source, p] of CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return { path: p, source } } catch {}
  }
  return null
}

export const OVERLAY = process.env.DSH_CU_OVERLAY || path.join(os.homedir(), '.dsh/bin/dsh-cursor-overlay')

export function overlayState() {
  let installed = false, running = false
  try { fs.accessSync(OVERLAY, fs.constants.X_OK); installed = true } catch {}
  try { execFileSync('/usr/bin/pgrep', ['-f', 'dsh-cursor-overlay'], { stdio: 'ignore' }); running = true } catch {}
  return { installed, running }
}

export function stopOverlay() {
  try { execFileSync('/usr/bin/pkill', ['-f', 'dsh-cursor-overlay'], { stdio: 'ignore' }) } catch { /* 本来就没跑 */ }
}

// ── 系统权限 ────────────────────────────────────────────────────────────────
// osascript 是 DSH 派生出来的，系统按「负责的应用」算权限，所以这里查到的就是 DSH 自己有没有。
// CGPreflightScreenCaptureAccess 不在 JXA 的默认桥里，得手动 bind。

const PERM_JXA = [
  'ObjC.import("ApplicationServices")',
  'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []])',
  'JSON.stringify({ screen: $.CGPreflightScreenCaptureAccess(), ax: $.AXIsProcessTrusted() })',
].join(';')

let permCache = { at: 0, value: null }

/** @returns {Promise<{ screen: boolean|null, ax: boolean|null }>} null = 查不出来 */
export function permissions(maxAgeMs = 5000) {
  if (permCache.value && Date.now() - permCache.at < maxAgeMs) return Promise.resolve(permCache.value)
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PERM_JXA], { timeout: 5000 }, (err, out) => {
      let value = { screen: null, ax: null }
      if (!err) {
        try { const p = JSON.parse(String(out).trim()); value = { screen: !!p.screen, ax: !!p.ax } } catch {}
      }
      permCache = { at: Date.now(), value }
      resolve(value)
    })
  })
}

export const SETTINGS_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  ax: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
}

// ── 用户设置 ────────────────────────────────────────────────────────────────
// 存在 ~/.dsh/dsh-mac-computer-use.json。每次现读（文件很小），设置页一改马上生效，不用重启 DSH。

export const CONFIG_FILE = process.env.DSH_CU_CONFIG || path.join(os.homedir(), '.dsh/dsh-mac-computer-use.json')
const DEFAULTS = { showCursor: true }

export function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } } catch { return { ...DEFAULTS } }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n')
  return next
}
