# Changelog

本文件的格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-13

### 新增
- 第四个设置页 **模型供应商**：可视化新增 / 编辑 / 删除 OpenAI 兼容网关供应商，不再需要手改
  `cordis.patch.yml`。
  - 「测试连接并拉取模型」直接读网关 `GET /models`，把模型列表、上下文 / 输出上限、思考档位
    一并映射成 DSH 的 `models[]` 与 `reasoningEfforts`。
  - 密钥只写 `$DSH_HOME/.credentials.yaml` 的 `refs:`，`cordis.patch.yml` 里只留 `apiKeyEnv` 引用名。
  - 自动生成 `apiKeyEnv` 名、可勾选模型子集、可设默认思考档位；保存 / 删除都写 `0600` 备份并
    保留最近 3 份。
  - 与 MCP 管理同样走 YAML 文档树改写，保留注释与其它条目；供应商合并进已有的
    `- id: llm-pi-ai` 条目，不新建同名条目（重复 id 会让 DSH 启动失败）。

### 测试
- 新增 `test/providers.test.js`（22 项）：校验、网关探测成功 / 401 / 非 JSON / 空目录 / 连接被拒、
  patch 合并与删除、凭据增删、以及带真实临时目录的读写落盘用例。

### 修复
- 测试沙箱不再泄漏到真实 profile：`DSH_PROFILE_DIR` 在 DSH 会话里是导出的环境变量，会覆盖测试
  自己设的 `DSH_HOME`，此前会把用例写进真实 `cordis.patch.yml`。现在沙箱显式固定
  `DSH_HOME` / `DSH_PROFILE_DIR` / `DSH_PROFILE` 并断言解析结果落在临时目录内。

## [0.1.1] - 2026-10-11

### 新增
- 英文文档 `README.en.md`，中英文 README 顶部互相切换链接。

### 修复
- peer 依赖范围带上显式预发布分支（`>=0.1.2-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`，
  cordis 同理）。原写法 `>=0.1.2-rc.1 <0.3.0` 在**默认 semver 规则**下不匹配 `0.2.0-rc.2`
  这类预发布版本（预发布版本只被同 `major.minor.patch` 的带预发布比较器命中），会误导消费方与
  插件市场校验。

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

[0.1.1]: https://github.com/2384418321/dsh-integration-settings/releases/tag/v0.1.1
[0.1.0]: https://github.com/2384418321/dsh-integration-settings/releases/tag/v0.1.0
