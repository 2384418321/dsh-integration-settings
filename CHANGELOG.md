# Changelog

本文件的格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-11

首个公开版本。

### 新增
- **MCP 管理**：在 DSH 设置中增 / 删 / 改 / 启停 MCP 服务器。以 `.dsh-integration/mcp.json` 为真理源，
  每次整体重写当前 profile `cordis.patch.yml` 里的受管区块（两行标记注释包夹）；写入前做 YAML 结构校验
  与时间戳备份（保留 3 份），手写内容原样保留。
- **Skill 管理**：浏览 / 新建 / 编辑 / 删除技能（目录下的 `SKILL.md`），覆盖 DSH 全局、共享 `.agents`、
  Claude / Codex 全局目录，以及当前项目的 `.dsh` / `.agents` / `.claude` 目录；删除前备份旧 `SKILL.md`，
  目录名做 `../` 逃逸防护。
- **全局人设**：可视化编辑 `$DSH_HOME/AGENTS.md`，并列出最近 3 份备份供一键载回。
- 宿主端在 loopback 注册 `/api/dsh-integration` 路由，带 Host / Origin / `Sec-Fetch-Site` 校验、
  写操作凭证头、路径栅栏与写操作串行化。

### 说明
- 仓库直接提交构建产物 `lib/`，因此从 GitHub 安装无需本地构建。
- 仅支持全局作用域（`settings.section` 是 root scope 槽位），项目级技能与项目级 `AGENTS.md`
  需在会话内界面操作。

[0.1.0]: https://github.com/2384418321/dsh-integration-settings/releases/tag/v0.1.0
