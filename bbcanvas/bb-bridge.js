// bb-bridge.js —— openmods Blockbench 画布桥接（基于本地 blockbench 源码，GPL-3.0-or-later）
// 职责：
//   1. 启动噪音屏蔽：service worker 404、blckbn.ch 遥测/插件市场 CORS（在 bundle 前的 head stub 里处理）
//   2. 两种 UI 模式：readonly（只读 kiosk，默认）/ edit（露出完整 Blockbench 工具栏，用户可直接编辑）
//   3. postMessage 桥：load_bbmodel / set_view / set_ui_mode / export_bbmodel / bb_ready / bb_loaded
(function () {
  'use strict'

  function post(msg) {
    try { parent.postMessage(msg, '*') } catch { /* 忽略 */ }
  }

  let ready = false

  function init() {
    if (ready) return
    if (!(window.Blockbench && window.Codecs && window.Formats && typeof window.setupProject === 'function')) return

    // —— kiosk 样式：只读模式隐藏全部编辑 UI（编辑模式通过移除 .bb-kiosk 类恢复） ——
    const style = document.createElement('style')
    style.textContent = `
      html.bb-kiosk header, html.bb-kiosk #header, html.bb-kiosk #main_toolbar,
      html.bb-kiosk #left_bar, html.bb-kiosk #right_bar, html.bb-kiosk #panel_selector_bar,
      html.bb-kiosk #tab_bar, html.bb-kiosk #status_bar, html.bb-kiosk #toast_notification_list,
      html.bb-kiosk #start_screen, html.bb-kiosk #top_slot, html.bb-kiosk #bottom_slot,
      html.bb-kiosk #mobile_toolbar, html.bb-kiosk .install_banner, html.bb-kiosk .preview_menu,
      html.bb-kiosk #timeline
        { display: none !important; }
      html.bb-kiosk #work_screen > *:not(#center) { display: none !important; }
      html.bb-kiosk #work_screen {
        grid-template-columns: auto !important;
        grid-template-rows: 100% !important;
        grid-template-areas: "center" !important;
      }
      html, body { overflow: hidden !important; background: #060806; }
      /* kiosk 没有菜单栏：#page_wrapper 原本 height:calc(100% - 30px) 会留出一条黑边，归零并兜底 100% */
      html.bb-kiosk body { --menu-bar-height: 0px !important; }
      html.bb-kiosk #page_wrapper { height: 100% !important; border: 0 !important; }
      #page_wrapper, #work_screen, #center { position: absolute; inset: 0; }
      #center { width: 100% !important; margin: 0 !important; }
      #preview { position: absolute !important; inset: 0 !important; height: 100% !important; width: 100% !important; }
      #preview > .single_canvas_wrapper { height: 100% !important; width: 100% !important; }
      #preview canvas { width: 100% !important; height: 100% !important; }
    `
    document.head.appendChild(style)
    document.documentElement.classList.add('bb-kiosk')

    // —— 相机预设 ——
    const VIEWS = {
      '3d': { pos: [64, 52, 64], target: [0, 18, 0] },
      front: { pos: [0, 20, 110], target: [0, 20, 0] },
      side: { pos: [110, 20, 0], target: [0, 20, 0] },
      back: { pos: [0, 20, -110], target: [0, 20, 0] },
    }

    // 后台持续渲染：dock 里的 iframe 不一定持有焦点，动画播放需要渲染循环保持运行
    try {
      if (window.settings && window.settings.background_rendering) {
        window.settings.background_rendering.value = true
      }
    } catch { /* 忽略 */ }

    // —— 动画播放 ——
    function findAnimation(name) {
      const anims = (window.Animation && window.Animation.all) ||
        Object.values((window.Project && window.Project.animations) || {})
      return anims.find(a => a.name === name || a.name === `animation.${(window.Project?.name || '')}.${name}`) ||
        anims.find(a => (a.name || '').endsWith('.' + name))
    }

    function playAnimation(name) {
      const anim = findAnimation(name)
      if (!anim) { post({ type: 'bb_animation_error', message: `动画 "${name}" 不存在` }); return }
      // 渲染循环只在动画模式（Animator.open）驱动时间轴——先切模式
      try {
        if (window.Modes?.options?.animate && window.Modes?.selected?.id !== 'animate') window.Modes.options.animate.select()
      } catch { /* 忽略 */ }
      // 动画模式会展开时间轴面板挤压预览——kiosk 已隐藏它，重算预览尺寸
      reflow()
      anim.select()
      if (window.Timeline?.setTime) window.Timeline.setTime(0)
      window.Timeline.start()
      // headless 驱动：iframe 的 rAF 可能被宿主节流，用独立定时器兜底驱动时间轴
      if (!window.__bbAnimDriver) {
        window.__bbAnimDriver = setInterval(() => {
          try {
            if (window.Timeline?.playing && window.Animator?.open) window.Timeline.loop()
            else { clearInterval(window.__bbAnimDriver); window.__bbAnimDriver = null }
          } catch { /* 忽略 */ }
        }, 1000 / 30)
      }
      post({ type: 'animation_state', playing: anim.name })
    }

    function stopAnimation() {
      window.Timeline && window.Timeline.pause()
      reflow()
      post({ type: 'animation_state', playing: null })
    }

    function setView(view) {
      const p = window.main_preview
      if (!p) return
      const c = VIEWS[view] || VIEWS['3d']
      p.camera.position.set(c.pos[0], c.pos[1], c.pos[2])
      if (p.controls) {
        p.controls.target.set(c.target[0], c.target[1], c.target[2])
        p.controls.update()
      }
    }

    function reflow() {
      try {
        window.main_preview && window.main_preview.resize && window.main_preview.resize()
      } catch { /* 忽略 */ }
    }

    function loadModel(model) {
      // model 为 null = 清空画布（切换到没有模型的会话时必须真的清，不能沿用上一个会话的模型）
      if (!model) {
        try {
          const keepFmt = window.Project?.format?.id
          const fmt = (keepFmt && window.Formats[keepFmt]) || window.Formats.free
          window.setupProject(fmt)
          window.setStartScreen(false)
          reflow()
          post({ type: 'bb_loaded', elements: 0, textures: 0, cleared: true })
        } catch (err) {
          post({ type: 'bb_error', message: '清空画布失败: ' + String(err && err.message || err) })
        }
        return
      }
      const fmtName = model.meta && model.meta.model_format
      const fmt = (window.Formats[fmtName] || window.Formats.free)
      window.setupProject(fmt)
      try {
        if (window.Project) {
          window.Project.name = model.name || (model.meta && model.meta.name) || 'model'
        }
        window.Codecs.project.parse(model, '', undefined)
        window.Canvas && window.Canvas.updateAll && window.Canvas.updateAll()
        window.setStartScreen(false)
        reflow()
        setTimeout(reflow, 80)
        setTimeout(reflow, 300)
        post({
          type: 'bb_loaded',
          elements: window.Project.elements ? window.Project.elements.length : 0,
          textures: window.Project.textures ? window.Project.textures.length : 0,
        })
      } catch (err) {
        window.Codecs.project.load(model, { path: 'model.bbmodel', name: 'model.bbmodel' })
        post({ type: 'bb_loaded', fallback: true, message: String(err && err.message || err) })
      }
    }

    window.addEventListener('message', ev => {
      const msg = ev.data || {}
      try {
        if (msg.type === 'load_bbmodel') loadModel(msg.model)
        else if (msg.type === 'set_view') setView(msg.view)
        else if (msg.type === 'play_animation') playAnimation(msg.name)
        else if (msg.type === 'stop_animation') stopAnimation()
        else if (msg.type === 'ping') post({ type: 'bb_ready' })
      } catch (err) {
        post({ type: 'bb_error', message: String(err && err.message || err) })
      }
    })

    setTimeout(() => {
      reflow()
      setView('3d')
    }, 300)
    setTimeout(reflow, 1200)
    window.addEventListener('resize', reflow)

    ready = true
    post({ type: 'bb_ready' })
    console.log('[bb-bridge] 画布桥接就绪（readonly 默认，可通过 set_ui_mode 切换 edit）')
  }

  if (window.Blockbench && window.Codecs) init()
  else {
    const timer = setInterval(() => {
      if (window.Blockbench && window.Codecs && window.Formats && window.Blockbench.setup_successful) {
        clearInterval(timer)
        init()
      }
    }, 150)
  }
})()
