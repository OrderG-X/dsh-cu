/**
 * dsh-mac-computer-use 的网页端：DSH「插件」页里我们这张卡的设置页。
 *
 *   状态：能不能用、看得到几个窗口
 *   清单：命令行工具、屏幕录制权限、辅助功能权限、光标浮层 —— 缺哪个就给哪个的按钮
 *   开关：屏幕上显示操作光标
 *
 * 数据全走插件自己挂在 DSH webServer 上的路由（plugin/panel.js），每 2.5 秒刷一次。
 * 走官方客户端插件机制：window.__ModuleLoader__.load({ id, factory })，factory 里 apply(ctx)
 * → 注册到 plugins.bundle.config（包详情页）和 plugins.row.config（行详情页）两个 keyed slot。
 * 拿不到 react 或 DSH 的组件就安静退出 / 用最朴素的替身，别把宿主页面搞崩。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mac-computer-use',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const opt = (id) => { try { return require(id) } catch (_) { return null } }
    const React = opt('react')
    if (!React) {
      exports.apply = () => {}
      exports.inject = ['slots', 'locale']
      return module.exports
    }
    const UI = opt('@deepseek-ai/dsh-client-ui-primitives') || {}
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const PKG = 'dsh-mac-computer-use'
    const ROW = 'mac-computer-use'
    const NS = 'dsh-mac-computer-use'
    const ROUTE = '/dsh-mac-computer-use/panel'
    const REPO = 'https://github.com/OrderG-X/dsh-mac-computer-use'

    // 占位符用 %x：不跟 DSH 自己的 {name} 插值撞
    const zh = {
      checking: '正在检查…',
      ready: '可以用了',
      needsPerm: '还差系统权限',
      notInstalled: '还没装好',
      unsupported: '只支持 macOS',
      windows: '能看到 %n 个窗口',
      windowsUnknown: '命令行工具跑不起来，看不到窗口',
      summaryOn: '可以用了 · 能看到 %n 个窗口',
      summaryPerm: '缺少系统权限，点开看怎么开',
      summaryOff: '还没装命令行工具，点开看怎么装',
      binTitle: '命令行工具 dsh-cu',
      binOk: '已装好',
      binMissing: '还没装。在「终端」里运行下面这条（要先装 Xcode 命令行工具：xcode-select --install）：',
      srcInstalled: '~/.dsh/bin',
      srcDev: '开发目录',
      srcEnv: 'DSH_CU_BIN',
      copyInstall: '复制安装命令',
      copied: '安装命令已复制，到「终端」里粘贴回车，装完回来这里会自动更新',
      screenTitle: '屏幕录制权限',
      screenHint: '截图、按文字找按钮都要用。',
      axTitle: '辅助功能权限',
      axHint: '点击、输入、按键、滚动、拖拽和按编号点都要用；没开的话这些操作会直接报错（系统会把它们丢掉）。',
      permOk: '已开',
      permMissing: '没开',
      permUnknown: '查不出来',
      openSettings: '打开系统设置',
      settingsOpened: '已打开系统设置：在列表里打开 DeepSeek Harness 的开关。屏幕录制改完要重启 DSH 才生效。',
      overlayTitle: '光标浮层',
      overlayRunning: '正在显示',
      overlayIdle: '已装，操作时自动出现',
      overlayMissing: '没装：看不到光标，不影响操作（装命令行工具时会一起装）',
      showCursor: '屏幕上显示操作光标',
      showCursorHint: '关掉只是不画光标，点击、输入照做。',
      plugin: '插件 v%v',
      guide: '使用说明',
      failed: '操作没成功：%e',
      unreachable: '读不到插件状态，重启 DSH 后再试',
    }
    const en = {
      checking: 'Checking…',
      ready: 'Ready',
      needsPerm: 'Missing system permissions',
      notInstalled: 'Not installed yet',
      unsupported: 'macOS only',
      windows: 'Can see %n window(s)',
      windowsUnknown: 'The command-line tool did not run, so no windows are visible',
      summaryOn: 'Ready · can see %n window(s)',
      summaryPerm: 'Missing system permissions — open for steps',
      summaryOff: 'Command-line tool not installed — open for steps',
      binTitle: 'Command-line tool dsh-cu',
      binOk: 'Installed',
      binMissing: 'Not installed. Run this in Terminal (needs Xcode Command Line Tools first: xcode-select --install):',
      srcInstalled: '~/.dsh/bin',
      srcDev: 'dev folder',
      srcEnv: 'DSH_CU_BIN',
      copyInstall: 'Copy install command',
      copied: 'Install command copied. Paste it in Terminal; this page updates by itself once it is done',
      screenTitle: 'Screen Recording permission',
      screenHint: 'Needed for screenshots and finding buttons by their text.',
      axTitle: 'Accessibility permission',
      axHint: 'Needed for clicking, typing, keys, scrolling, dragging and clicking by number; without it these fail with an error (macOS drops them).',
      permOk: 'On',
      permMissing: 'Off',
      permUnknown: 'Unknown',
      openSettings: 'Open System Settings',
      settingsOpened: 'Opened System Settings: turn on DeepSeek Harness in the list. Screen Recording changes need a DSH restart.',
      overlayTitle: 'Cursor overlay',
      overlayRunning: 'Showing',
      overlayIdle: 'Installed, appears while working',
      overlayMissing: 'Not installed: no visible cursor, actions still work (installed together with the command-line tool)',
      showCursor: 'Show the action cursor on screen',
      showCursorHint: 'Off only hides the cursor; clicks and typing still happen.',
      plugin: 'Plugin v%v',
      guide: 'Guide',
      failed: 'That did not work: %e',
      unreachable: 'Could not read the plugin status; restart DSH and try again',
    }

    const fmt = (s, vars) => String(s).replace(/%([a-z])/g, (m, k) => (vars && k in vars ? String(vars[k]) : m))

    const CSS = `
.dcu{display:grid;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dcu-card{border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l));background:var(--dsw-alias-settings-card-fill,transparent);border-radius:12px;overflow:hidden}
.dcu-row{display:flex;align-items:flex-start;gap:12px;padding:12px 14px}
.dcu-row+.dcu-row{border-top:1px solid var(--dsw-alias-border-l)}
.dcu-main{flex:1;min-width:0;display:grid;gap:2px}
.dcu-title{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dcu-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dcu-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dcu-dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:6px;background:var(--dsw-alias-label-tertiary)}
.dcu-dot[data-s=on]{background:var(--dsw-alias-state-success-primary,#34c759);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 22%,transparent)}
.dcu-dot[data-s=warn]{background:var(--dsw-alias-state-warn-primary,#ff9f0a)}
.dcu-dot[data-s=off]{background:var(--dsw-alias-state-error-primary,#ff453a)}
.dcu-dot[data-s=idle]{background:var(--dsw-alias-label-tertiary)}
.dcu-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:4px 8px;margin-top:4px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);user-select:all;word-break:break-all}
.dcu-note{font-size:12px;padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ff9f0a) 12%,transparent);color:var(--dsw-alias-label-primary)}
.dcu-note[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 12%,transparent)}
.dcu-note[data-tone=err]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff453a) 12%,transparent)}
.dcu-foot{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcu-foot a{color:var(--dsw-alias-link);text-decoration:none}
.dcu-foot a:hover{text-decoration:underline}
.dcu-tag{font-size:11px;font-weight:500;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l);color:var(--dsw-alias-label-secondary)}
.dcu-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.dcu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcu-btn:disabled{opacity:.45;cursor:default}
.dcu-switch{flex:none;margin-top:2px}`
    function ensureCss() {
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="dsh-mac-computer-use"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = 'dsh-mac-computer-use'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── DSH 组件，拿不到就用朴素替身 ────────────────────────────────────────
    function Toggle({ checked, disabled, label, onChange }) {
      if (UI.Switch) return h('span', { className: 'dcu-switch' }, h(UI.Switch, { checked, disabled, label, onChange }))
      return h('input', { className: 'dcu-switch', type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled, onChange: (e) => onChange(e.target.checked) })
    }
    function Btn({ onClick, disabled, children, primary }) {
      if (UI.Button) return h(UI.Button, { variant: primary ? 'primary' : 'outline', size: 'sm', disabled, onClick }, children)
      return h('button', { type: 'button', className: 'dcu-btn', disabled, onClick }, children)
    }

    // ── 数据 ──────────────────────────────────────────────────────────────
    async function fetchState(action) {
      const res = await fetch(ROUTE, action
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action), credentials: 'same-origin' }
        : { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** 2.5 秒刷一次；页面藏起来时不刷。 */
    function useDesktopState() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const alive = useRef(true)
      const load = useCallback(async () => {
        try {
          const s = await fetchState()
          if (alive.current) { setState(s); setError('') }
        } catch (e) {
          if (alive.current) setError(String((e && e.message) || e))
        }
      }, [])
      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load()
        }, 2500)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load])
      const act = useCallback(async (action) => {
        const s = await fetchState(action)
        if (alive.current) setState(s)
        return s
      }, [])
      return { state, error, act }
    }

    function phaseOf(s) {
      if (!s) return 'checking'
      if (s.platform && s.platform !== 'darwin') return 'unsupported'
      if (!s.bin) return 'off'
      const p = s.perms || {}
      if (p.screen === false || p.ax === false || s.windows == null) return 'warn'
      return 'on'
    }

    // ── 概要（行卡片上的一句话）────────────────────────────────────────────
    function Summary({ t }) {
      const { state } = useDesktopState()
      const p = phaseOf(state)
      if (p === 'checking') return t('checking')
      if (p === 'unsupported') return t('unsupported')
      if (p === 'off') return t('summaryOff')
      if (p === 'warn') return t('summaryPerm')
      return fmt(t('summaryOn'), { n: state.windows })
    }

    // ── 设置页 ────────────────────────────────────────────────────────────
    function Page({ t }) {
      const { state, error, act } = useDesktopState()
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const p = phaseOf(state)

      const run = async (action, ok) => {
        setBusy(true)
        try {
          const s = await act(action)
          if (s.actionError) setNote({ tone: 'err', text: fmt(t('failed'), { e: s.actionError }) })
          else setNote(ok ? { tone: 'ok', text: ok } : null)
        } catch (e) {
          setNote({ tone: 'err', text: fmt(t('failed'), { e: String((e && e.message) || e) }) })
        } finally {
          setBusy(false)
        }
      }

      const statusTitle = { checking: t('checking'), on: t('ready'), warn: t('needsPerm'), off: t('notInstalled'), unsupported: t('unsupported') }[p]
      const status = h('div', { className: 'dcu-card' },
        h('div', { className: 'dcu-row' },
          h('span', { className: 'dcu-dot', 'data-s': p === 'unsupported' ? 'off' : p === 'checking' ? 'idle' : p }),
          h('div', { className: 'dcu-main' },
            h('div', { className: 'dcu-title' }, statusTitle),
            state && state.bin
              ? h('div', { className: 'dcu-sub' }, state.windows == null ? t('windowsUnknown') : fmt(t('windows'), { n: state.windows }))
              : null)))

      // 一行清单：状态点 + 标题 + 说明 + 右侧按钮
      const item = (key, dot, title, sub, extra, button) => h('div', { key, className: 'dcu-row' },
        h('span', { className: 'dcu-dot', 'data-s': dot }),
        h('div', { className: 'dcu-main' },
          h('div', { className: 'dcu-title' }, title, sub ? h('span', { className: 'dcu-tag' }, sub) : null),
          extra),
        button)

      const permItem = (key, value, title, hint) => item(key,
        value === true ? 'on' : value === false ? 'off' : 'idle',
        title,
        value === true ? t('permOk') : value === false ? t('permMissing') : t('permUnknown'),
        h('p', { className: 'dcu-hint' }, hint),
        value === false ? h(Btn, { disabled: busy, onClick: () => run({ action: 'openSettings', pane: key }, t('settingsOpened')) }, t('openSettings')) : null)

      const checklist = state && state.platform === 'darwin' ? h('div', { className: 'dcu-card' },
        state.bin
          ? item('bin', 'on', t('binTitle'), t('binOk') + ' · ' + t({ installed: 'srcInstalled', dev: 'srcDev', env: 'srcEnv' }[state.bin.source] || 'srcInstalled'))
          : item('bin', 'off', t('binTitle'), null,
            h('div', null, h('p', { className: 'dcu-hint' }, t('binMissing')), h('div', { className: 'dcu-cmd' }, state.installCmd)),
            h(Btn, { primary: true, disabled: busy, onClick: () => run({ action: 'copyInstall' }, t('copied')) }, t('copyInstall'))),
        permItem('screen', state.perms && state.perms.screen, t('screenTitle'), t('screenHint')),
        permItem('ax', state.perms && state.perms.ax, t('axTitle'), t('axHint')),
        item('overlay',
          state.overlay && state.overlay.running ? 'on' : state.overlay && state.overlay.installed ? 'idle' : 'warn',
          t('overlayTitle'), null,
          h('p', { className: 'dcu-hint' }, state.overlay && state.overlay.running ? t('overlayRunning') : state.overlay && state.overlay.installed ? t('overlayIdle') : t('overlayMissing')),
          null)) : null

      const switches = state && state.platform === 'darwin' ? h('div', { className: 'dcu-card' },
        h('div', { className: 'dcu-row' },
          h('div', { className: 'dcu-main' },
            h('div', { className: 'dcu-title' }, t('showCursor')),
            h('p', { className: 'dcu-hint' }, t('showCursorHint'))),
          h(Toggle, { label: t('showCursor'), checked: state.showCursor !== false, disabled: busy, onChange: (on) => run({ action: 'cursor', on }) }))) : null

      const notes = [
        error && !state ? { tone: 'err', text: t('unreachable') } : null,
        note,
      ].filter(Boolean)

      return h('div', { className: 'dcu' },
        status,
        checklist,
        switches,
        ...notes.map((n, i) => h('div', { key: `n${i}`, className: 'dcu-note', 'data-tone': n.tone }, n.text)),
        h('div', { className: 'dcu-foot' },
          state && state.plugin ? h('span', null, fmt(t('plugin'), { v: state.plugin })) : null,
          h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('guide'))))
    }

    function makeCard(boundT) {
      return function DesktopControlCard(props) {
        ensureCss()
        const t = typeof props.t === 'function' ? props.t : boundT
        return props.view === 'summary' ? h(Summary, { t }) : h(Page, { t })
      }
    }

    function apply(ctx) {
      const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (k) => zh[k] || k
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mac-computer-use: dictionaries')
      }
      const Card = makeCard(t)
      const mount = (name, key) => {
        const reg = () => ctx.slots.register({ name, key, locale: NS }, Card)
        ctx.effect(() => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject(name, reg) : reg()), `dsh-mac-computer-use: ${name}`)
      }
      mount('plugins.bundle.config', PKG)
      mount('plugins.row.config', `${PKG}#${ROW}`)
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
