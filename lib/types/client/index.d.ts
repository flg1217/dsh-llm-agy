// AntiGravity 插件面板卡片(注册 settings.plugin.item,与官方 WebSearch 卡片外观统一)。
// 复用 dsh primitives 组件(Button/图标/writeClipboard)与官方
// ui-settings-plugins 的 PluginCard/fields CSS(注入同款样式类)。
// 字段读写走官方 SettingsScope;状态/测试探测需会话级 remote(暂不可用)。
// 服务端直接 spawn agy CLI,不落会话。
window.__ModuleLoader__.load({
  id: '@flg1217/dsh-llm-agy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const slots = require('@deepseek-ai/dsh-client-ui-slots')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      Button, Input, Modal, IconLoadingOutline16, IconCheckOutline16, IconRefreshOutline16,
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
      // 模型输入框:铺满卡片宽度;min-width:0 避免 flex 项被内容撑爆导致超出卡片
      modelField: '.dshAgy_modelField{display:flex;width:100%;min-width:0;box-sizing:border-box}.dshAgy_modelField input{flex:1;min-width:0;width:100%;box-sizing:border-box}',
      // 获取模型弹窗列表:抄 Menu.module.css 的菜单卡片 + 行样式
      pickerList: '.dshAgy_pickerList{box-sizing:border-box;padding:4px;display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);max-height:60vh;overflow-y:auto}',
      pickerItem: '.dshAgy_pickerItem{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);text-align:left}.dshAgy_pickerItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      pickerLabel: '.dshAgy_pickerLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      pickerCheck: '.dshAgy_pickerCheck{flex:none;color:var(--dsw-alias-label-primary)}',
    }
    const cssText = Object.values(CSS).join('')
    const tagId = '@flg1217/llm-agy/plugin-card.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@flg1217/llm-agy'
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
      pre: 'dshAgy_pre', row: 'dshAgy_row', modelField: 'dshAgy_modelField',
      pickerList: 'dshAgy_pickerList', pickerItem: 'dshAgy_pickerItem',
      pickerLabel: 'dshAgy_pickerLabel', pickerCheck: 'dshAgy_pickerCheck',
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
      { name: 'search_web_agy', desc: 'AGY 深度网络搜索:自动搜索、阅读全文、综合引用回答,无短超时限制' },
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
      const scope = props.scope


      // 探测(状态/测试)需 remote.llm 会话服务;0.1.2 插件设置卡(root)暂不可用。
      const runProbe = react.useCallback(async (_provider, setOut, setBusy) => {
        setBusy(true)
        setOut('状态/测试探测在 0.1.2 插件设置页暂不可用(需会话级 remote);字段编辑正常。')
        setBusy(false)
      }, [])

      const onStatus = react.useCallback(() => runProbe('status', setStatusText, setChecking), [runProbe])
      const onTest = react.useCallback(() => runProbe('test', setTestText, setTesting), [runProbe])

      // 看图分工提示开关:读写 agy settings namespace 的 delegationGuide。
      const [guideOn, setGuideOn] = react.useState(true)
      react.useEffect(() => {
        try {
          const v = scope.getSnapshot().value
          if (v?.delegationGuide !== undefined) setGuideOn(Boolean(v.delegationGuide))
        } catch { /* 镜像未就绪 */ }
        return scope.subscribe(() => {
          const v2 = scope.getSnapshot().value
          if (v2?.delegationGuide !== undefined) setGuideOn(Boolean(v2.delegationGuide))
        })
      }, [scope])
      const toggleGuide = react.useCallback(async () => {
        const next = !guideOn
        setGuideOn(next)
        try {
          await scope.set('delegationGuide', next)
        } catch (e) {
          setGuideOn(!next)
        }
      }, [scope, guideOn])

      // 使用 AGY 读取图片开关:读写 agy settings namespace 的 readImageAgy。
      const [imageRelayOn, setImageRelayOn] = react.useState(true)
      react.useEffect(() => {
        try {
          const v = scope.getSnapshot().value
          if (v?.readImageAgy !== undefined) setImageRelayOn(Boolean(v.readImageAgy))
        } catch { /* 镜像未就绪 */ }
        return scope.subscribe(() => {
          const v2 = scope.getSnapshot().value
          if (v2?.readImageAgy !== undefined) setImageRelayOn(Boolean(v2.readImageAgy))
        })
      }, [scope])
      const toggleImageRelay = react.useCallback(async () => {
        const next = !imageRelayOn
        setImageRelayOn(next)
        try {
          await scope.set('readImageAgy', next)
        } catch (e) {
          setImageRelayOn(!next)
        }
      }, [scope, imageRelayOn])

      // AGY 搜索接管开关:读写 agy settings namespace 的 searchOverride。
      const [searchOverrideOn, setSearchOverrideOn] = react.useState(true)
      react.useEffect(() => {
        let cancelled = false
        connection.api.settings.describe({}).then((resp) => {
          if (cancelled) return
          const ns = resp?.result?.value?.namespaces?.find?.((n) => n.ns === 'agy')
          if (ns?.value?.searchOverride !== undefined) setSearchOverrideOn(Boolean(ns.value.searchOverride))
        }).catch(() => {})
        return () => { cancelled = true }
      }, [connection])
      const toggleSearchOverride = react.useCallback(async () => {
        const next = !searchOverrideOn
        setSearchOverrideOn(next)
        try {
          await connection.api.settings.mutate({
            ns: 'agy',
            ops: [{ path: ['searchOverride'], op: 'set', value: next }],
          })
        } catch (e) {
          setSearchOverrideOn(!next)
        }
      }, [connection, searchOverrideOn])

      // 默认模型 + 代理:config 探测取当前值与明细;models 探测取可选列表;
      // 弹窗用官方 Modal,输入框用官方 Input(铺满卡片宽度)。
      const [models, setModels] = react.useState([])
      const [currentModel, setCurrentModel] = react.useState('')
      const [savedModel, setSavedModel] = react.useState('')
      const [currentProxy, setCurrentProxy] = react.useState('')
      const [savedProxy, setSavedProxy] = react.useState('')
      const [detailText, setDetailText] = react.useState('')
      const [loadingModels, setLoadingModels] = react.useState(false)
      const [pickerOpen, setPickerOpen] = react.useState(false)

      // 初始值与明细:读 SettingsScope 镜像(结构化、经网关校验)。
      // 避免响应 schema 校验失败导致解析出垃圾值)。
      const loadConfig = react.useCallback(async () => {
        try {
          const v = scope.getSnapshot().value ?? {}
          const model = v.model ?? ''
          const proxy = v.proxy ?? ''
          setCurrentModel(model)
          setSavedModel(model)
          setCurrentProxy(proxy)
          setSavedProxy(proxy)
          setDetailText(`命令:${v.command ?? 'agy'} | 强度:${v.effort ?? 'high'} | 代理:${proxy || '(空)'}`)
        } catch { /* 忽略 */ }
      }, [scope])

      const loadModels = react.useCallback(async () => {
        setLoadingModels(true)
        setModels([])
        setLoadingModels(false)
      }, [])

      react.useEffect(() => {
        if (!open) return
        // 只加载存储的历史值,不自动拉取模型列表(点"获取模型"时才请求)。
        loadConfig()
      }, [open, loadConfig])

      // 提交默认模型:非空 = set,空 = unset(重置为 schema 默认,不写空字符串)。
      const writeModel = react.useCallback(async (value) => {
        try {
          if (value === '') await scope.unset('model')
          else await scope.set('model', value)
          if (value !== '') { setCurrentModel(value); setSavedModel(value) }
          loadConfig()
        } catch { /* 写失败回读还原 */ loadConfig() }
      }, [scope, loadConfig])

      const onModelInput = react.useCallback((e) => setCurrentModel(e.target.value), [])
      const onModelBlur = react.useCallback(() => {
        const value = currentModel.trim()
        if (value === savedModel) return
        writeModel(value)
      }, [currentModel, savedModel, writeModel])

      const openPicker = react.useCallback(async () => {
        setPickerOpen(true)
        if (models.length === 0) loadModels()
      }, [models.length, loadModels])
      const pickFromList = react.useCallback((value) => {
        writeModel(value)
        setPickerOpen(false)
      }, [writeModel])

      // 提交代理:非空 = set,空 = unset;与已保存值一致时跳过。
      const onProxyInput = react.useCallback((e) => setCurrentProxy(e.target.value), [])
      const onProxyBlur = react.useCallback(async () => {
        const value = currentProxy.trim()
        if (value === savedProxy) return
        try {
          if (value === '') await scope.unset('proxy')
          else await scope.set('proxy', value)
          setCurrentProxy(value)
          setSavedProxy(value)
        } catch { /* 写失败回读还原 */ loadConfig() }
      }, [currentProxy, savedProxy, scope, loadConfig])

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

          // 默认模型:字符串输入 + "获取模型"弹窗选择
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '默认模型'),
              react.createElement(Button, {
                size: 'sm', variant: 'ghost', onClick: openPicker, disabled: loadingModels,
                icon: loadingModels
                  ? react.createElement(IconLoadingOutline16, { size: 12 })
                  : react.createElement(IconRefreshOutline16, { size: 12 }),
              }, loadingModels ? '获取中...' : '获取模型'),
            ),
            react.createElement(Input, {
              type: 'text', value: currentModel, onChange: onModelInput, onBlur: onModelBlur,
              placeholder: '输入模型 id',
              className: C.modelField,
            }),
            detailText !== '' && react.createElement('p', { className: C.hint, style: { fontFamily: 'var(--dsw-font-family-code, monospace)' } }, detailText),
            react.createElement('p', { className: C.hint }, '可直接输入模型 id(失焦保存),或点"获取模型"从弹窗选择;留空则使用 AGY 默认'),
          ),

          // 代理:HTTP 代理,留空不设
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '代理'),
            ),
            react.createElement(Input, {
              type: 'text', value: currentProxy, onChange: onProxyInput, onBlur: onProxyBlur,
              placeholder: '例如 http://127.0.0.1:7890',
              className: C.modelField,
            }),
            react.createElement('p', { className: C.hint }, '例如 http://127.0.0.1:7890;留空则不设置代理(运行时未设置时回落到该地址)'),
          ),

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
                ? '开启:注入工具使用提示词'
                : '关闭:不注入工具使用提示词',
            ),
          ),

          // 使用 AGY 读取图片开关
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '使用 AGY 读取图片'),
              react.createElement('input', {
                type: 'checkbox',
                checked: imageRelayOn,
                onChange: toggleImageRelay,
                style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 16, height: 16, cursor: 'pointer' },
              }),
            ),
            react.createElement('p', { className: C.hint },
              imageRelayOn
                ? '开启:粘贴的图片由 AGY 读取为文字描述,文本模型也能看图(无需切换模型)'
                : '关闭:粘贴图片按原生流程处理(多模态模型可自己看图)',
            ),
          ),

          // AGY 搜索接管开关
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, 'AGY 搜索接管 web_search'),
              react.createElement('input', {
                type: 'checkbox',
                checked: searchOverrideOn,
                onChange: toggleSearchOverride,
                style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 16, height: 16, cursor: 'pointer' },
              }),
            ),
            react.createElement('p', { className: C.hint },
              searchOverrideOn
                ? '开启:全局 web_search 工具由 AGY 深度搜索提供'
                : '关闭:不占全局搜索(避免与其它搜索 provider 冲突),仅提供独立的 agy_web_search 工具',
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

          // 获取模型弹窗:官方 Modal(模糊遮罩/Escape/标题/关闭) + Menu 样式列表
          react.createElement(Modal, {
            open: pickerOpen,
            onClose: () => setPickerOpen(false),
            title: '选择模型',
            closeLabel: '关闭',
          },
            loadingModels && models.length === 0
              ? react.createElement('p', { className: C.hint }, '加载中...')
              : models.length === 0
                ? react.createElement('p', { className: C.hint }, '未获取到模型列表,请确认 AGY CLI 已安装')
                : react.createElement('div', { className: C.pickerList },
                    models.map((m) => react.createElement('button', {
                      key: m,
                      type: 'button',
                      className: C.pickerItem,
                      onClick: () => pickFromList(m),
                    },
                      react.createElement('span', { className: C.pickerLabel }, m),
                      m === currentModel && react.createElement(IconCheckOutline16, { className: C.pickerCheck, size: 14 }),
                    )),
                  ),
          ),
        ),
      )
    }

    function apply(ctx) {
      const agyScope = ctx.settingsScope.bind({ namespace: 'agy' })
      const sectionInject = () => ({
        scope: agyScope,
      })
      ctx.effect(() => {
        return ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            // id(rc.6 list 槽)与 key(rc.7 keyed 槽)都传,兼容两种槽类型。
            id: 'agy',
            key: 'agy',
            order: 30,
            label: () => 'AntiGravity',
            inject: sectionInject,
          }, AgyCard)
        })
      }, 'llm-agy-client: settings.plugin.item')
    }



    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    exports.name = 'llm-agy-client'
    return module.exports
  },
})
