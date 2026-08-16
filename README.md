# dsh-llm-agy

> **AGY(Antigravity CLI)— DeepSeek Harness 的智能体增强引擎**
> 将 Google 的 AI 编程代理 Antigravity(由 Gemini 驱动)深度集成进 dsh:
> 独立推理子代理、深度网页搜索、一键连通性诊断。开箱即用,零源码改动。

---

## 一、这是什么

**dsh-llm-agy** 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh) 的开源插件,把 Google 出品的 AI 编程代理 **Antigravity CLI**(AGY,基于 Gemini)无缝接入 dsh 生态,为你的工作流提供三条独立增强通道:

| 能力 | 说明 |
| --- | --- |
| **独立推理子代理** | 将前端/UI、视觉审阅等任务委派给 AGY 驱动的子代理(Gemini 3.7 Flash High),与主代理并行,长线会话可复用 |
| **深度网页搜索** | `web_search` 工具经由 AGY 的 Google 搜索通道完成**完整深度检索**——搜索、打开来源、阅读全文、综合成文,而非简单链接列表 |
| **连通性诊断面板** | dsh 设置 → 插件内的 AntiGravity 卡片:检测本机安装与登录状态、发起真实连通性测试、一键复制各平台安装命令 |

插件严格遵循 dsh 官方扩展机制(profile bundle patch / `registerModelDiscovery` / `registerSearchProvider` / 客户端 slot),**不修改 dsh 任何源码**,可随 dsh 平滑升级。

## 二、核心功能

### 1. 独立推理子代理(provider 路由 `agy`)

主代理可随时将任务委派给 AGY——一个由 Gemini 驱动、具备独立思维链与工具面的第二大脑:

- 通过 `agentOptions.provider: 'agy'` 将任意子代理切换为 AGY 推理
- 内置开箱工具:`subagent_agy_ui`(前端/UI 设计、样式研究、视觉实现、截图核验,可复用长线会话)与 `subagent_agy_vision`(看图、设计稿分析,一次性会话)
- 复杂大任务可拆分为多个独立子任务并行调度,再汇总整合

### 2. 深度网页搜索(搜索 provider `agy`)

将 dsh 的 `web_search` 工具从"返回链接列表"升级为"完成深度调研":

- 经由 AGY 的 `search_web`(Google 搜索)发起检索
- AGY 自主完成:搜索 → 打开每个来源阅读全文 → 综合撰写准确、完整、带引用的回答
- 结果语言跟随提问语言;全程不写入会话记录
- 一键切换:`web.searchProvider = 'agy'`(设置 → 模型,或 profile patch)

### 3. 连通性诊断面板(设置 → 插件 → AntiGravity)

无需命令行即可完成 AGY 环境体检:

- **检测安装/登录**:一键确认本机是否已安装 AGY、是否已登录
- **连通性测试**:发起真实指令,直接展示 AGY 的实际回复内容
- **安装命令**:Windows(mwinget)/ macOS(Homebrew)/ Linux(curl)/ npm 四平台命令,一键复制
- **工具说明**:内置工具速查
- 面板交互走官方模型探测通道(`api.llm.discoverModels`),**不占用会话**

## 三、快速开始

### 系统要求

- dsh(web profile,npx 版或源码版均可)
- Node.js ≥ 20
- AGY CLI(见下方安装命令)

### 安装插件

```bash
# 方式一:通过 npm(发布后)
npx @deepseek-ai/dsh plugin --profile web add @dsh-external/dsh-llm-agy

# 方式二:从 Git 仓库安装(免构建——lib/ 已随仓库提交)
git clone https://github.com/FengPaul/dsh-llm-agy.git
dsh plugin --profile web add <dsh-llm-agy 目录>

# 方式三:本地一键脚本(仓库内)
node scripts/link-profile.mjs
```

安装完成后**重启 dsh web**,进入 **设置 → 插件 → AntiGravity** 展开卡片,点击"检测安装/登录"确认环境就绪。

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

### 子代理委派给 AGY

在 agent 预设或工具行中配置:

```yaml
- id: tool-subagent-agy-ui
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_agy_ui
    agentOptions:
      provider: agy            # 由 AGY/Gemini 完成推理
      model: gemini-3.7-flash-high
```

前端/UI 类任务:委派 `subagent_agy_ui`,由独立 Gemini 模型完成设计、实现与截图核验;
看图类任务:委派 `subagent_agy_vision`,每次调用为独立会话。

### 诊断命令行

```bash
/agy status        # 检测 AGY 安装与登录状态
/agy test          # 发起真实测试,展示 AGY 回复
/agy               # 帮助
```

## 五、工作原理

插件为**双面结构**,由 dsh 官方扩展机制装配:

```
┌─────────────── 宿主进程(node 半)───────────────┐
│ index.ts    插件入口                             │
│ adapter.ts  AgyLlmAdapter — spawn agy 推理适配   │
│ search.ts   ctx.web.registerSearchProvider       │
│ settings.ts settings + registerModelDiscovery    │
└──────────────────────────────────────────────────┘
┌─────────────── 浏览器(web 半)───────────────────┐
│ client/index.js  settings.plugin.item 卡片       │
│                  复用官方组件与样式               │
└──────────────────────────────────────────────────┘
```

- **装配**:`cordis.patch.yml`(bundle patch)+ package.json 的 `dsh.bundle`/`dsh.client` 清单,`dsh plugin add` 一键完成
- **推理**:服务端 spawn AGY CLI(stream-json 协议),实时流式输出与 token 统计由 dsh harness 统一呈现
- **搜索**:`search()` 直接调用 AGY,由其自主完成检索与综合
- **面板**:检测/测试经官方 `api.llm.discoverModels` 通道触发,服务端执行、结果回显,**不写会话、不改 dsh 源码**

## 六、参与开发

```bash
git clone https://github.com/FengPaul/dsh-llm-agy.git
cd dsh-llm-agy
pnpm install
pnpm build          # tsc 服务端 + 客户端 bundle 拷贝
pnpm typecheck
pnpm test
```

详见 [docs/CONTRIBUTING.zh.md](docs/CONTRIBUTING.zh.md)。

## 七、许可证

[MIT](LICENSE)
