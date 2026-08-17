// AntiGravity 插件面板卡片(注册 settings.plugin.item,与官方 WebSearch 卡片外观统一)。
// 复用 dsh primitives 组件(Button/图标/writeClipboard)与官方
// ui-settings-plugins 的 PluginCard/fields CSS(注入同款样式类)。
// 检测/测试走 api.llm.discoverModels({settingsNs:'agy', provider:'status'|'test'}),
// 服务端直接 spawn agy CLI,不落会话。
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-llm-agy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const slots = require('@deepseek-ai/dsh-client-ui-slots')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      Button, IconLoadingOutline16, IconCheckOutline16, IconRefreshOutline16,
      IconCopyOutline16, IconChevronDownOutline14, writeClipboard,
    } = P

    // ── 官方 PluginCard CSS(与 ui-settings-plugins 完全一致) ──
    const CSS = {
      card: '.dshAgy_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      cardHover: '.dshAgy_card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      cardOpen: '.dshAgy_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      header: '.dshAgy_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      headerFocus: '.dshAgy_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      headText: '.dshAgy_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      name: '.dshAgy_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      description: '.dshAgy_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      chevron: '.dshAgy_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      chevronOpen: '.dshAgy_chevronOpen{transform:rotate(180deg)}',
      body: '.dshAgy_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      field: '.dshAgy_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      fieldTop: '.dshAgy_field+.dshAgy_field{border-top:1px solid var(--dsw-alias-border-l2)}',
      fieldHead: '.dshAgy_fieldHead{align-items:center;gap:8px;display:flex}',
      label: '.dshAgy_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      hint: '.dshAgy_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      badge: '.dshAgy_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      code: '.dshAgy_code{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:6px 10px;font-size:12px}',
      pre: '.dshAgy_pre{margin:8px 0 0;white-space:pre-wrap;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px 10px}',
      row: '.dshAgy_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0}',
    }
    const cssText = Object.values(CSS).join('')
    const tagId = '@dsh-external/llm-agy/plugin-card.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@dsh-external/llm-agy'
      tag.dataset.pluginCss = tagId
      tag.textContent = cssText
      document.head.appendChild(tag)
    }
    const C = {
      card: 'dshAgy_card', cardOpen: 'dshAgy_cardOpen', header: 'dshAgy_header',
      headText: 'dshAgy_headText', name: 'dshAgy_name', description: 'dshAgy_description',
      chevron: 'dshAgy_chevron', chevronOpen: 'dshAgy_chevronOpen', body: 'dshAgy_body',
      field: 'dshAgy_field', fieldHead: 'dshAgy_fieldHead', label: 'dshAgy_label',
      hint: 'dshAgy_hint', badge: 'dshAgy_badge', code: 'dshAgy_code',
      pre: 'dshAgy_pre', row: 'dshAgy_row',
    }

    // 多系统安装命令 + 工具说明
    const INSTALL_CMDS = [
      { label: 'Windows (winget)', cmd: 'winget install --id Google.Antigravity' },
      { label: 'macOS (Homebrew)', cmd: 'brew install --cask antigravity' },
      { label: 'Linux / macOS (curl)', cmd: 'curl -fsSL https://antigravity.google/install | bash' },
      { label: 'npm (global)', cmd: 'npm install -g @antigravity/cli' },
    ]
    const TOOLS = [
      { name: 'subagent_agy_ui', desc: '前端/UI 设计、样式、视觉实现、截图核验(continuable 可复用长线会话)' },
      { name: 'read_image_agy', desc: '看图:AGY/Gemini 读图返回文字描述(全局常驻,文本模型也可用)' },
      { name: 'web_search', desc: 'web_search 走 AGY 的 Google 搜索(search_web),深度搜索返回完整内容' },
    ]

    /** 安装命令行:label + code + 复制按钮(带已复制状态)。 */
    function InstallCommandRow({ label, cmd }) {
      const [copied, setCopied] = react.useState(false)
      const copy = react.useCallback(async () => {
        try { await writeClipboard(cmd) } catch { /* 剪贴板失败静默 */ }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }, [cmd])
      return react.createElement('div', { className: C.field },
        react.createElement('div', { className: C.fieldHead },
          react.createElement('span', { className: C.label }, label),
          react.createElement('span', { className: C.hint, style: { fontFamily: 'var(--dsw-font-family-code, monospace)' } }, cmd),
          react.createElement(Button, {
            size: 'sm', variant: 'ghost', onClick: copy,
            icon: copied
              ? react.createElement(IconCheckOutline16, { size: 12 })
              : react.createElement(IconCopyOutline16, { size: 12 }),
          }, copied ? '已复制' : '复制'),
        ),
      )
    }

    function AgyCard(props) {
      const [open, setOpen] = react.useState(false)
      const [checking, setChecking] = react.useState(false)
      const [testing, setTesting] = react.useState(false)
      const [statusText, setStatusText] = react.useState('')
      const [testText, setTestText] = react.useState('')
      const connection = props.connection

      // 走 api.llm.discoverModels:服务端 registerModelDiscovery 直接 spawn agy,不落会话。
      const runProbe = react.useCallback(async (provider, setOut, setBusy) => {
        setBusy(true)
        try {
          const resp = await connection.api.llm.discoverModels({
            settingsNs: 'agy',
            provider,
          })
          if (!resp?.result?.ok) {
            setOut(resp?.result?.error?.message ?? '探测失败')
            return
          }
          const found = resp.result.value?.models ?? []
          setOut(found.map((m) => m.name ?? m.id).join('\n') || '(无结果)')
        } catch (e) {
          setOut(String(e))
        } finally {
          setBusy(false)
        }
      }, [connection])

      const onStatus = react.useCallback(() => runProbe('status', setStatusText, setChecking), [runProbe])
      const onTest = react.useCallback(() => runProbe('test', setTestText, setTesting), [runProbe])

      // 看图分工提示开关:读写 agy settings namespace 的 delegationGuide。
      const [guideOn, setGuideOn] = react.useState(true)
      react.useEffect(() => {
        let cancelled = false
        connection.api.settings.describe({}).then((resp) => {
          if (cancelled) return
          const ns = resp?.result?.value?.namespaces?.find?.((n) => n.ns === 'agy')
          if (ns?.value?.delegationGuide !== undefined) setGuideOn(Boolean(ns.value.delegationGuide))
        }).catch(() => {})
        return () => { cancelled = true }
      }, [connection])
      const toggleGuide = react.useCallback(async () => {
        const next = !guideOn
        setGuideOn(next)
        try {
          await connection.api.settings.mutate({
            ns: 'agy',
            ops: [{ path: 'delegationGuide', op: 'set', value: next }],
          })
        } catch (e) {
          setGuideOn(!next)
        }
      }, [connection, guideOn])

      return react.createElement('li', { className: `${C.card} ${open ? C.cardOpen : ''}` },
        // 卡片头(与官方 PluginCard 一致)
        react.createElement('button', {
          type: 'button', className: C.header, 'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}: AntiGravity`,
          onClick: () => setOpen(!open),
        },
          react.createElement('span', { className: C.headText },
            react.createElement('span', { className: C.name }, 'AntiGravity'),
            react.createElement('span', { className: C.description }, '检测安装/登录、连通性测试、安装命令与工具说明'),
          ),
          react.createElement(IconChevronDownOutline14, { className: `${C.chevron} ${open ? C.chevronOpen : ''}` }),
        ),
        open && react.createElement('div', { className: C.body },
          // 检测与测试
          react.createElement('div', { className: C.row },
            react.createElement(Button, {
              size: 'md', onClick: onStatus, disabled: checking,
              icon: checking
                ? react.createElement(IconLoadingOutline16, { size: 14 })
                : react.createElement(IconRefreshOutline16, { size: 14 }),
            }, checking ? '检测中...' : '检测安装/登录'),
            react.createElement(Button, {
              size: 'md', onClick: onTest, disabled: testing,
              icon: testing ? react.createElement(IconLoadingOutline16, { size: 14 }) : undefined,
            }, testing ? '测试中...' : '测试(回复 hi)'),
          ),
          react.createElement('p', { className: C.hint }, '若已安装仍提示未安装,请重启 dsh 服务(PATH 生效后需重启)'),
          statusText !== '' && react.createElement('pre', { className: C.pre }, statusText),
          testText !== '' && react.createElement('pre', { className: C.pre }, testText),

          // 看图分工提示开关
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '注入工具使用提示词'),
              react.createElement('input', {
                type: 'checkbox',
                checked: guideOn,
                onChange: toggleGuide,
                style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 16, height: 16, cursor: 'pointer' },
              }),
            ),
            react.createElement('p', { className: C.hint },
              guideOn
                ? '开启:注入工具使用提示词(看图用 read_image_agy,需重启会话生效)'
                : '关闭:不注入工具使用提示词',
            ),
          ),

          // 安装命令(多系统,每行带复制按钮)
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '安装命令'),
              react.createElement('span', { className: C.badge }, 'antigravity.google/docs/cli/install'),
            ),
            react.createElement('p', { className: C.hint }, '官方安装文档:https://antigravity.google/docs/cli/install'),
          ),
          ...INSTALL_CMDS.map((item) => react.createElement(InstallCommandRow, { key: item.label, label: item.label, cmd: item.cmd })),

          // 工具说明
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '工具说明'),
            ),
            react.createElement('ul', { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
              TOOLS.map((t) => react.createElement('li', { key: t.name, className: C.hint },
                react.createElement('strong', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t.name), ' — ', t.desc,
              )),
            ),
          ),
        ),
      )
    }

    function apply(ctx) {
      const sectionInject = () => ({
        connection: ctx.connection,
      })
      ctx.effect(() => {
        return ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            id: 'llm-agy',
            order: 30,
            label: () => 'AntiGravity',
            inject: sectionInject,
          }, AgyCard)
        })
      }, 'llm-agy-client: settings.plugin.item')
    }

    function apply(ctx) {
      const sectionInject = () => ({
        connection: ctx.connection,
      })
      ctx.effect(() => {
        return ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            id: 'llm-agy',
            order: 30,
            label: () => 'AntiGravity',
            inject: sectionInject,
          }, AgyCard)
        })
      }, 'llm-agy-client: settings.plugin.item')
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection']
    exports.name = 'llm-agy-client'
    return module.exports
  },
})
