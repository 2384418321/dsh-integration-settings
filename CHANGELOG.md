# Changelog

本文件的格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.2] - 2026-10-13

### 新增
- **一键解锁思考模式**：设置页从「模型供应商」改为「思考解锁」。打开页面即对每个已配置的网关发一次
  只读的 `GET /models`，读出 `reasoning_supported_efforts` / `can_disable_thinking`，逐模型与当前
  `reasoningEfforts` 比对；点「全部解锁」写回 `cordis.patch.yml`（写前自动备份，写后先校验 YAML
  再落盘）。识别阶段不写任何文件，页面显示「待解锁 N / 已解锁 M / 网关未声明 K」。
- 解锁前列出会**减少档位**的模型及其 `原档位 → 新档位`：网关的能力表是唯一真相，配置里多出来的
  档位会被去掉，不会悄悄收窄。
- 网关对某个模型完全没给思考信息时保留原声明，**不会**替你写成 `reasoningEfforts: false`；
  单个网关探测失败不影响其它网关；DSH 自带供应商（`deepseek-official` 等）不在 `llm-pi-ai`
  条目里，结构上不会被碰到。

### 测试
- 新增 6 项：`unlockPlan` 纯函数的四类分支（已一致 / 待解锁 / 网关沉默 / 网关已移除模型）、
  `dryRun` 不落盘、真实写入（含 silent 保留、其它分组逐字节不变、备份存在、二次运行不再改动）、
  单网关探测失败不中断、缺失 `llm-pi-ai` 条目报错。全套 62 项通过。

## [0.2.1] - 2026-10-13

### 修复
- **不再重排手写的供应商分组**：此前保存任意一个供应商，都会把整个 `providers:` 段按插件自己的
  风格重新序列化——手写分组里的流式列表 `input: [ "text", "image" ]`、带引号的 `name: "Auto"`
  等写法会被改成块式、去引号。现在只替换目标供应商自己那一段字节，其它分组的文本（含缩进、
  引号、流式写法）逐字节保留；把某个供应商**原样回存时文件零变化**。删除同样只删该条目的字节。
- **`reasoningEfforts: false` 不再丢失**：这是 DSH 的合法声明（表示「该模型不支持思考」），此前
  校验会静默丢掉它，导致既有分组里有 10 个模型在保存后失去该声明。
- **档位值原样保留**：`reasoningEfforts` 的值按原样写回（例如 `off: 'skip'` 不再被改写成空值），
  未知档位键也保留而不是丢弃。注意声明该字段即白名单——**未声明的档位不可选**。
- 页面新增档位摘要：供应商行显示「档位 low/high/max · N 个模型不支持思考 · M 个未声明」，
  模型行对 `false` 显示「思考 不支持」。

### 测试
- `test/providers.test.js` 22 → 26 项：新增「编辑一个供应商时另一分组逐字节不变」「原样回存不
  产生任何改动」「`reasoningEfforts: false` 与逐字档位值往返后保持」；全套 56 项通过。

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
