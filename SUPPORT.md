# 支持

## 获取帮助

- 阅读 [README](README.md) 与 [README.en.md](README.en.md)
- 搜索仓库 [Issues](https://github.com/FengPaul/dsh-llm-agy/issues) 是否已有相同问题
- 排查步骤:
  1. `dsh plugin --profile web add <本仓库目录>` 确认装配
  2. 重启 dsh web
  3. 设置 → 插件 → AntiGravity,点击"检测安装/登录"与"测试(回复 hi)"
  4. 若失败,确认 AGY CLI 已安装且可登录(见安装命令)

## 常见问题

### 检测显示"未安装"

```bash
agy --version   # 确认 AGY 可用
# 未安装时:
winget install --id Google.Antigravity
```

### 检测显示"未登录"

在终端运行 `agy` 并按提示完成登录;或重装后重新登录。

### 测试超时

检查 `proxy` 配置(默认 `http://127.0.0.1:7890`)。若无需代理,将配置设为空字符串。

## 问题反馈

请通过 [Issues](https://github.com/FengPaul/dsh-llm-agy/issues) 提交问题,并附上:
- dsh 版本与 profile
- 插件版本
- 面板检测/测试的完整输出
