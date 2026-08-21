# dsh-llm-agy

> **AGY(Antigravity CLI)— DeepSeek Harness 的智能体增强引擎**
> 将 Google 的 AI 编程代理 Antigravity(由 Gemini 驱动)深度集成进 dsh:
> 独立推理子代理、深度网页搜索、文本模型图片输入、一键连通性诊断。开箱即用,零源码改动。

---

## 一、这是什么

**dsh-llm-agy** 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh) 的开源插件,把 Google 出品的 AI 编程代理 **Antigravity CLI**(AGY,基于 Gemini)无缝接入 dsh 生态,为你的工作流提供以下增强通道:

| 能力 | 说明 |
| --- | --- |
| **独立推理子代理** | 将前端/UI 等任务委派给 AGY 驱动的子代理(Gemini 3.7 Flash High),与主代理并行,长线会话可复用 |
| **深度网页搜索** | `web_search` 工具经由 AGY 的 Google 搜索通道完成**完整深度检索**——搜索、打开来源、阅读全文、综合成文,而非简单链接列表 |
| **文本模型图片输入** | 纯文本主模型(如 DeepSeek V4 Flash)也能**在输入栏直接粘贴图片**:后端由 AGY 就地读图,把图片转为文字描述进入消息。全程无感,不新增模型路由、不切换模型、不写磁盘 |
| **连通性诊断面板** | dsh 设置 → 插件内的 AntiGravity 卡片:检测本机安装与登录状态、发起真实连通性测试、一键复制各平台安装命令 |

插件严格遵循 dsh 官方扩展机制(profile bundle patch / `registerModelDiscovery` / `registerSearchProvider` / `llm/stream` waterfall / 客户端 slot),**不修改 dsh 任何源码**,可随 dsh 平滑升级。

## 二、核心功能

### 1. 独立推理子代理(provider 路由 `agy`)

主代理可随时将任务委派给 AGY——一个由 Gemini 驱动、具备独立思维链与工具面的第二大脑:

- 通过 `agentOptions.provider: 'agy'` 将任意子代理切换为 AGY 推理
- 内置开箱工具:`subagent_agy_ui`(前端/UI 设计、样式研究、视觉实现、截图核验,可复用长线会话)+ `list_agy_models`(查询 AGY 当前支持的模型 id,供 `subagent_agy_ui` 的 `model` 参数动态指定)
- 复杂大任务可拆分为多个独立子任务并行调度,再汇总整合

### 2. 文本模型图片输入(全局,零配置)

纯文本主模型(如 DeepSeek V4 Flash)不支持图片输入,但本插件让"输入栏贴图"开箱即用:

- **粘贴即用**:在任意输入栏粘贴图片,原生走 ImageBlock;插件在后端把图片落盘到工作区 `.dsh-llm-agy/tmp/pasted-images/`,替换为路径文本后交回原模型路由
- **完全透明**:不新增 provider 路由、不切换模型、不改前端,用户无感知
- **工具使用提示词**:插件注入全局 system prompt section,引导主代理"图片内容已在消息中,禁止委派子代理读图、不轮询后台子代理"(设置面板可关闭)

### 3. 深度网页搜索(搜索 provider `agy`)

将 dsh 的 `web_search` 工具从"返回链接列表"升级为"完成深度调研":

- 经由 AGY 的 `search_web`(Google 搜索)发起检索
- AGY 自主完成:搜索 → 打开每个来源阅读全文 → 综合撰写准确、完整、带引用的回答
- 结果语言跟随提问语言;全程不写入会话记录
- 一键切换:`web.searchProvider = 'agy'`(设置 → 模型,或 profile patch)

### 4. 连通性诊断面板(设置 → 插件 → AntiGravity)

无需命令行即可完成 AGY 环境体检:

- **检测安装/登录**:一键确认本机是否已安装 AGY、是否已登录
- **连通性测试**:发起真实指令,直接展示 AGY 的实际回复内容
- **安装命令**:Windows(winget)/ macOS(Homebrew)/ Linux(curl)/ npm 四平台命令,一键复制
- **工具说明**:内置工具速查(`subagent_agy_ui` / `web_search`)
- **开关**:"注入工具使用提示词"——控制是否注入全局工具使用提示词(默认开)
- 面板交互走官方模型探测通道(`api.llm.discoverModels`),**不占用会话**

## 三、快速开始

### 系统要求

- dsh(web profile,npx 版或源码版均可);兼容 dsh `>= 0.1.0-rc.6`
- Node.js ≥ 20
- AGY CLI(见下方安装命令)
- 兼容性验证日期:2026-08-21(验证于 dsh rc.8)

### 安装插件

```bash
# 从 Git 仓库安装(免构建——lib/ 已随仓库提交)
git clone https://github.com/flg1217/dsh-llm-agy.git
cd dsh-llm-agy
pnpm install          # 安装插件依赖(dsh 以 link: 方式挂载本地目录,需插件自身带 node_modules)
dsh plugin --profile web add <dsh-llm-agy 目录>
```

安装完成后**重启 dsh web**,进入 **设置 → 插件** 应能看到 **AntiGravity** 卡片;展开卡片,点击"检测安装/登录"确认环境就绪。

### 卸载插件

```bash
dsh plugin --profile web remove @flg1217/dsh-llm-agy
```

如残留,手工清理:移除 profile(`~/.dsh/profiles/web`)的 `cordis.patch.yml` 中
`dsh-llm-agy` 的 `- insert` 块,以及 `package.json` dependencies 中对应的
`@flg1217/dsh-llm-agy` 行。卸载后重启 dsh web 即完全移除
(AGY CLI 本身不受影响)。

### 安装 AGY(Antigravity CLI)

```bash
# Windows
winget install --id Google.Antigravity

# macOS
brew install --cask antigravity

# Linux / macOS(通用)
curl -fsSL https://antigravity.google/install | bash

# 或 npm 全局
npm install -g @antigravity/cli
```

官方文档:https://antigravity.google/docs/cli/install

### 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `agy` | AGY 可执行文件命令 |
| `model` | `gemini-3.7-flash-high` | 推理模型 |
| `effort` | `high` | 推理强度(low / medium / high) |
| `proxy` | `http://127.0.0.1:7890` | 流量代理(空字符串禁用) |
| `searchProviderId` | `agy` | dsh web 搜索 provider 的 id(空字符串禁用搜索接入) |
| `delegationGuide` | `true` | 注入全局"工具使用提示词"系统提示(设置面板可切) |

可在设置面板直接修改,或编辑 profile 的 `cordis.patch.yml`。

## 四、典型用法

### 网页搜索走 AGY 深度调研

```yaml
# profile patch(~/.dsh/profiles/web/cordis.patch.yml)
- id: web
  config:
    searchProvider: agy
```

此后主代理调用 `web_search` 时,将获得 AGY 深度检索后撰写的完整回答与来源引用。

### 文本模型读图

无需任何配置——输入栏粘贴图片后,后端在请求组装时**由 AGY 就地读图**,把图片转为文字描述直接进入消息,主代理直接基于图片内容回答(无需调用任何工具)。

```
用户:请分析这张图片(粘贴图片)
后端:AGY 读图 → 消息里携带图片内容描述 → 主代理直接分析
```
### 子代理委派给 AGY

**无需配置**——插件启动时自动注册工具(全局可见,所有会话/预设生效):

- `subagent_agy_ui`(continuable,可复用长线会话):前端/UI 设计、样式研究、视觉实现、截图核验;接受可选 `model` 参数,主代理可动态指定模型 id(不传则用插件默认模型)
- `list_agy_models`:从 `agy models` 实时解析当前支持的模型 id 列表,委派前先查询再传准确 id

由 AGY/Gemini 驱动(`agentOptions.provider: agy`),独立于主代理的模型。如不需要,可在插件配置里设 `registerSubagentTools: false` 关闭。看图不委派子代理——粘贴图片由 AGY 就地读图。

前端/UI 类任务:委派 `subagent_agy_ui`,由独立 Gemini 模型完成设计、实现与截图核验。

### 诊断命令行

```bash
/agy status        # 检测 AGY 安装与登录状态
/agy test          # 发起真实测试,展示 AGY 回复
/agy               # 帮助
```

## 五、工作原理

插件为**双面结构**,由 dsh 官方扩展机制装配:

```
┌─────────────── 宿主进程(node 半)───────────────────┐
│ index.ts       插件入口                              │
│ adapter.ts     AgyLlmAdapter — spawn agy 推理适配     │
│ search.ts      ctx.web.registerSearchProvider         │
│ settings.ts    settings + registerModelDiscovery      │
│ image-paste.ts llm/stream 监听器 + resolveModelInfo   │
│                包装:ImageBlock → 工作区路径文本       │
│ read-image.ts  AGY 读图执行(图片中继调用)          │
│ delegate-guide.ts 全局工具使用提示词 section          │
└──────────────────────────────────────────────────────┘
┌─────────────── 浏览器(web 半)───────────────────────┐
│ client/index.js  settings.plugin.item 卡片            │
│                  复用官方组件与样式                    │
└──────────────────────────────────────────────────────┘
```

- **装配**:`cordis.patch.yml`(bundle patch)+ package.json 的 `dsh.bundle`/`dsh.client` 清单,`dsh plugin add` 一键完成
- **推理**:服务端 spawn AGY CLI(stream-json 协议),实时流式输出与 token 统计由 dsh harness 统一呈现
- **图片输入**:包装 `llm.resolveModelInfo` 为文本模型声明 image 能力(绕过 dsh 的拒绝校验);`llm/stream` waterfall 监听器把 ImageBlock 落盘为路径文本后直接调用原 adapter——**不新增 provider、不切换模型、不改前端**
- **读图**:图片中继在请求组装时 spawn AGY 就地读图,返回文字描述
- **搜索**:`search()` 直接调用 AGY,由其自主完成检索与综合
- **面板**:检测/测试经官方 `api.llm.discoverModels` 通道触发,服务端执行、结果回显,**不写会话、不改 dsh 源码**

## 六、参与开发

```bash
git clone https://github.com/flg1217/dsh-llm-agy.git
cd dsh-llm-agy
pnpm install
pnpm build          # tsc 服务端 + 客户端 bundle 拷贝
pnpm typecheck
pnpm test
```

详见 [docs/CONTRIBUTING.zh.md](docs/CONTRIBUTING.zh.md)。

## 七、许可证

[MIT](LICENSE)
