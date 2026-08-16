# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-08-16

### 新增

- **LLM 适配器**(provider 路由 `agy`):子代理 `agentOptions.provider: 'agy'` 时由 AGY/Gemini 完成推理,支持 `subagent_agy_ui`(continuable 长线会话)/ `subagent_agy_vision`(one-shot)自定义子代理
- **Web 搜索 provider**(`agy`):`web_search` 工具经 AGY 的 `search_web`(Google)完成深度检索,返回完整综合回答与来源引用
- **设置面板卡片**:设置 → 插件 → AntiGravity,复用官方组件与样式——检测安装/登录、连通性测试(展示 AGY 真实回复)、多系统安装命令一键复制、工具说明
- **模型探测通道**:`api.llm.discoverModels({ settingsNs: 'agy', provider: 'status' | 'test' })`,服务端直接 spawn AGY,不写会话
- **`/agy` 命令**:`/agy status`、`/agy test`、`/agy`(帮助)
- **可移植性验证**:`pnpm run verify:portable` 无依赖验证包可直接装配
