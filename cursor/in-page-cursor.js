// 页内光标浮层 —— 模仿 ChatGPT / Kimi 浏览器扩展的"小鼠标"
//
// 原理：GPT 那些扩展的页内鼠标不是系统光标，是内容脚本注入页面的 DOM 浮层。
//       我们用 Chrome 官方 CDP（Runtime.evaluate）注入同一套东西，不需要装扩展。
//
// 用法：把整段 IIFE 用 Runtime.evaluate 注入一次，之后调：
//   window.__dshCursor.move(x, y)    平滑移动到视口坐标
//   window.__dshCursor.click(x, y)   画涟漪
//   window.__dshCursor.press()       箭头按一下的反馈
//   window.__dshCursor.label("点击 登录")   光标旁边冒个小标签
//   window.__dshCursor.hide()        移除
//
// 特性：
//   * Shadow DOM 隔离 —— 不会和页面自己的 CSS 打架
//   * position:fixed + 最高 z-index —— 浮在页面最上层，跟着 viewport
//   * pointer-events:none —— 绝不挡住真实点击
//   * 移动时沿运动方向拉伸（跟桌面浮层同一套 scoot 手感），落位收回
//   * 点击有涟漪 + 按压缩放 —— 一眼看出"它在点哪儿"
//   * 会出现在截图里 —— 人和模型看到同一画面，可互相验证
//   * 箭头形状和系统浮层光标同源：从 Codex Computer Use 的资源里描出来的，
//     这里用半透明"雾状"版（对应 Codex 的 FogCursorStyle），跟桌面那个实心版区分开

(() => {
  const ID = '__dsh_cursor__';
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = `
      <style>
        .c{position:fixed;left:0;top:0;width:30px;height:30px;pointer-events:none;
           background:linear-gradient(150deg,#16337a,#2E6EFF 30%,#7FA8FF 55%,#EAF1FF 72%,#5B8CFF 88%,#2E6EFF);
           background-size:100% 320%;
           -webkit-mask-image:url(data:image/png;base64,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);
           mask-image:url(data:image/png;base64,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);
           -webkit-mask-size:100% 100%;mask-size:100% 100%;
           -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
           animation:dshflow 3.2s ease-in-out infinite alternate;
           transition:transform .45s cubic-bezier(.25,.65,.35,1), scale .12s ease;
           transform-origin:1px 1px;
           filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));will-change:transform}
        .c.press{scale:.88}
        .r{position:fixed;width:30px;height:30px;margin:-13px 0 0 -13px;border-radius:50%;
           border:3px solid #4D6BFE;opacity:0;pointer-events:none}
        .r.on{animation:rip .5s ease-out}
        .lbl{position:fixed;max-width:240px;padding:3px 9px;border-radius:9px;
             font:12px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
             color:#fff;background:rgba(77,107,254,.94);white-space:nowrap;overflow:hidden;
             text-overflow:ellipsis;opacity:0;transition:opacity .22s ease;
             pointer-events:none;transform:translate(20px,20px);box-shadow:0 2px 8px rgba(0,0,0,.3)}
        .lbl.on{opacity:1}
        @keyframes dshflow{from{background-position:50% 0%}to{background-position:50% 100%}}
        @keyframes rip{from{opacity:.95;transform:scale(.25)}to{opacity:0;transform:scale(1.9)}}
      </style>
      <div class="c"></div>
      <div class="r"></div>
      <div class="lbl"></div>`;
    document.documentElement.appendChild(host);
    host.__sr = sr;
  }
  const sr = host.__sr;
  const cur = sr.querySelector('.c');
  const rip = sr.querySelector('.r');
  const lbl = sr.querySelector('.lbl');
  let labelTimer = 0;

  // 移动：跟桌面浮层同一套 scoot 手感 —— 沿运动方向拉伸，落位收回
  let lastX = null, lastY = null, settleTimer = 0;
  const place = (x, y) => { cur.style.transform = `translate(${x}px, ${y}px)`; };
  const move = (x, y) => {
    const dx = lastX === null ? 0 : x - lastX;
    const dy = lastY === null ? 0 : y - lastY;
    const dist = Math.hypot(dx, dy);
    if (dist > 8) {
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const stretch = dist > 200 ? 1.28 : 1 + Math.min(0.28, (dist / 200) * 0.28);
      const tilt = Math.max(-9, Math.min(9, (dy / Math.max(dist, 1)) * 9));
      cur.style.transition = 'transform .10s ease-out, scale .12s ease';
      cur.style.transform =
        `translate(${x}px, ${y}px) rotate(${tilt}deg) ` +
        `rotate(${ang}deg) scale(${stretch}, ${1 / stretch}) rotate(${-ang}deg)`;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        cur.style.transition = 'transform .34s cubic-bezier(.22,.9,.3,1), scale .12s ease';
        place(x, y);
      }, 110);
    } else {
      place(x, y);                       // 第一次定位 / 小幅移动：直接摆过去
    }
    lastX = x; lastY = y;
    lbl.style.left = x + 'px';
    lbl.style.top = y + 'px';
  };
  const click = (x, y) => {
    rip.style.left = x + 'px';
    rip.style.top = y + 'px';
    rip.classList.remove('on');
    void rip.offsetWidth;
    rip.classList.add('on');
  };
  const press = () => {
    cur.classList.add('press');
    setTimeout(() => cur.classList.remove('press'), 150);
  };
  const label = (text) => {
    lbl.textContent = text == null ? '' : String(text);
    lbl.classList.add('on');
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => lbl.classList.remove('on'), 1800);
  };
  const hide = () => host.remove();

  window.__dshCursor = { move, click, press, label, hide, version: 2 };
  return 'ready';
})();
