# 开发说明

## 目录结构

```
dsh-llm-agy/
├── src/                      # TypeScript 源码
│   ├── index.ts              # 插件入口:LLM 适配器 + 搜索 provider + 设置/命令注册
│   ├── adapter.ts            # AgyLlmAdapter:spawn agy 的 LLM 适配
│   ├── search.ts             # AgySearchProvider:ctx.web.registerSearchProvider
│   ├── settings.ts           # settings namespace + registerModelDiscovery + /agy 命令
│   └── client/index.js       # 浏览器端 ModuleLoader bundle:设置面板卡片
├── lib/                      # 编译产物(随仓库提交,用户免构建即可装配)
├── scripts/                  # 构建与验证脚本
├── docs/                     # 文档
├── tests/                    # 测试(vitest)
├── cordis.patch.yml          # bundle patch
└── package.json              # exports + dsh.bundle/dsh.client 清单
```

## 构建

```
pnpm build    # → lib/*.js + lib/types/*.d.ts
```

构建分两步(见 `scripts/build.mjs`):

1. `tsc` 编译服务端 `src/*.ts` → `lib/`
2. 拷贝客户端 `src/client/index.js` → `lib/client.js`(ModuleLoader bundle,无需打包)

> 客户端刻意保持零构建依赖:浏览器端 bundle 由 dsh client-modules 直接托管,
> React/组件库通过 ModuleLoader 的 require 表解析,不参与打包。
>
> **发布约定**:`lib/` 产物提交进仓库,用户 clone 后免构建即可
> `dsh plugin --profile web add <目录>` 直接装配。

## 装配到 dsh

```bash
node scripts/link-profile.mjs            # dsh plugin --profile web add <仓库根>
# 重启 dsh web 后:设置 → 插件 → AntiGravity 卡片
```

## 可移植性验证

```
pnpm run verify:portable
```

零依赖验证:lib 产物齐全、exports 完整、patch 包名一致、入口可 import。
发布前必须通过。

## 测试

`pnpm test`(vitest)。当前聚焦纯函数:
- `search.ts` 的 URL/标题解析
- `settings.ts` 的安装/登录检测逻辑

## 发布

```bash
pnpm run verify:portable
npm publish
```

发布前注意:

- `package.json` 的 `repository.url` 改为真实仓库地址
- `dependencies` 中的 dsh 运行时依赖(`@deepseek-ai/dsh-llm` 等)随 dsh 版本走,
  保持与目标 dsh 的 rc 版本对齐
- npm 包名 `@dsh-external/dsh-llm-agy` 可按需更换 scope

## 设计约定

- 不改 dsh 源码:一切接入走官方扩展点(bundle patch / registerModelDiscovery / registerSearchProvider / settings namespace / client slots)
- 不写会话:检测、测试、搜索等辅助操作一律不经过 agent 命令系统
- 双面插件:node 半 + 浏览器半,通过 `dsh.bundle.patch` 与 `dsh.client` 声明
