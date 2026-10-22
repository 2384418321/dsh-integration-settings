# Changelog

本文件的格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.10-dsh.4] - 2026-10-22

**只改文档与分发，`lib/` 代码与 0.2.10-dsh.3 完全一致**（功能无变化；升级到本版等价于 dsh.3）。

### 文档（真值修复）
- `README.md` / `README.en.md` / `INSTALL.zh-CN.md` 与仓库实际状态对齐：本分叉只有 **MCP 管理** 与 **思考解锁** 两个设置页
  （上游的 Skill 管理 / 全局人设已移除，后端接口仍在，只是没有 UI 入口）。
- 补上 **同步模型清单** 的说明：独立按钮、先预览「将新增 N / 将移除 M」再确认、一次同步同时刷新思考档位与可用模型清单、
  与页面「定时更新」共用同一调度；落盘位置写明 `config.providers` 的 `levels`/`models` 与 `unlock-schedule.json`。
- 删掉指向不存在的 `scripts/install.sh`、`scripts/build.mjs`、`test/` 的安装与开发指引，改为「本分叉直接编辑 `lib/`」。

### 分发
- 公开源码仓库：<https://github.com/2384418321/dsh-integration-settings>（MIT；`lib/` 构建产物随仓库提交，可直接
  `dsh plugin add github:2384418321/dsh-integration-settings`）。

## [0.2.10-dsh.3] - 2026-10-21

补完两件事：MCP 管理页支持**粘贴 mcpServers JSON 新增**（先预览再写入），以及界面上的**路径/凭据脱敏**（为对外分享与入插件市场做准备）。

### 新增
- **`POST /api/dsh-integration/mcp/import-json`**：接受 `{json: "<粘贴文本>" | {…}, dryRun?: boolean, overwrite?: boolean}`。
  - 兼容三种形状：`{"mcpServers":{名称:配置}}`、`{名称:配置}` 映射、`{"servers":[{serverName|name, …}]}`。
  - 每条按 `serverName` 归一：有 `url` 走 `streamable-http`（`type` 为 `sse`/`http`/`streamable-http` 都归一到它），有 `command` 走 `stdio`；
    保留 `args`/`env`/`cwd`/`headers`/`toolCallTimeoutMs`/`maxInstructionBytes`/`enabled`/`failOnStartupError`。
  - 返回 `{dryRun, wrote, added[], updated[], skipped[], failed[{name,error}], warnings[], serverCount, patchFile, mcpFile}`
    （`dryRun:true` 只算不写；`overwrite:false` 时同名进 `skipped`）。
  - **逐条容错**：单条不合法只进 `failed`，其余照写；一条都没写成功时不落盘。
  - 写盘仍走 `writeMcpServers()`（`validatePatchText` 校验 + `writeWithBackup` 备份后原子替换），`mcp.json` 与 `cordis.patch.yml` 同批更新。
  - **明文风险提示**：URL 查询串里出现 `token`/`api_key`/`key`/`secret`/`password` 等参数，或 `headers` 里有鉴权项时，返回 `warnings` 明确告知会明文写进 `cordis.patch.yml`，建议改环境变量引用。
- MCP 管理页新增**「粘贴 JSON 新增」**按钮：展开内联面板（文本域 + 支持形状说明 + 明文风险提示），
  先「预览」列出**将新增 / 将覆盖 / 将跳过 / 有问题**，再「确认写入」；写入成功后刷新列表并提示重启生效。

### 安全/隐私
- 前端脱敏补齐：`dsiMaskUrl()` 除原有的 userinfo（`https://user:pass@host`）外，
  再掩掉查询串与片段里的凭据参数（`?token=abc` → `?token=***`、`&api_key=…` → `&api_key=***`）。
- `dsiMaskPath()` 覆盖到 MCP 管理页的描述与 footer、Skill 页当前目录、人设页文件路径：
  本机绝对路径显示为 `~\.dsh\profiles\…`，不再把 `C:\Users\<用户名>` 带进截图/分享。

## [0.2.10-dsh.2] - 2026-10-21

把「思考解锁」一件事拆成两件事：**思考档位（reasoningEfforts）** 与 **可用模型清单（models）** 各自独立，
新增独立的「同步模型清单」按钮，先预览差异再确认写入，定时更新走同一条路径。

### 新增
- **`POST /api/dsh-integration/providers/models/sync-preview`**：只读预览。返回
  `{added,removed,kept,levels:{added,removed,kept},models:{added,removed,kept},levelModels,details,digest}`，
  每个网关还带 `status`（`pending` 有变化 / `current` 已一致 / `error` 探测失败）与 `digest`。
- **`POST /api/dsh-integration/providers/models/sync-apply`**：写盘。要求 `confirm: true`，
  并接受 `expectedDigests: {providerId: digest}`（或单个 `digest` 字符串）做二次校验；
  预览后清单变了会返回 **409 `error.provider.sync.stale`**，提示重新预览。
- 写盘沿用 `writeWithBackup`（先落 `.bak-<时间戳>` 再原子替换，保留 3 份），并用 `validatePatchText` 校验后再写。
- 定时更新（`unlock-schedule.json`）一次跑完整链路：先解锁思考档位，再同步模型清单，
  自动确认但把差异摘要写进 `lastResult.sync`（新增/移除/保留个数、变更 id、档位增减、失败网关），
  UI 显示「上次差异」。
- 思考解锁页新增文案与预览面板：「将新增 N 个 / 将移除 M 个」、逐网关 `新增 x / 移除 y / 不变 z`、
  新增/移除的 id 列表、档位变化（如「新增 max；移除 low（影响 K 个模型）」），确认/取消按钮。

### 安全
- **抓取失败绝不写空**：网关 `/models` 为空、HTTP 非 2xx、或全部网关探测失败时，
  apply 返回 **502 `error.provider.sync.probe`**，`cordis.patch.yml` 一字不动
  （`planModelSync` 还会拒绝生成空模型表，双保险）。
- 预览不写盘、不备份、不改 `lastRunAt`；只有 apply 才落盘。
- 「全部解锁」按钮语义收窄为只写思考档位，不再顺带动模型列表；新增网关只写供应商条目本身。

## [0.2.9-dsh.1] - 2026-10-20

本地分叉版本（上游 `2384418321/dsh-integration-settings` 已删除，此目录为唯一副本）。

### 变更
- **移除 `Skill 管理` 设置页**（`integration-skills`）。
- **移除 `全局人设` 设置页**（`integration-persona`）。
- `lib/client.js` 的注册数组只保留 `integration-mcp` / `integration-providers`；两个页面的组件函数
  仍在 bundle 内，只是不再注册（宿主 `lib/index.js` 与 `/api/dsh-integration/skill/*`、
  `/persona/*` 接口未做改动）。
- `package.json` 的 `description` 改为"保留两个页面"的实际描述；版本号改为 `0.2.9-dsh.1`。

### 未变
- 服务端行为、MCP 管理、思考解锁与上游 0.2.8 一致。
- 回滚方法见 `LOCAL-PATCH.md`。

## [0.2.8] - 2026-10-18

新增**跨机器安装能力**：把安装这件事做成可交给 AI 执行的 runbook + 一键脚本，方便在另一台电脑上装好。

### 新增
- **`INSTALL.zh-CN.md`**：可执行安装手册。每一步都有命令与「期望输出」：环境与 CLI 探测 →
  安装 → 完全重启 → 三项验证 → 网关与凭据配置（含 YAML 缩进校验）→ 定时更新验收 →
  故障排查表 → 升级/卸载/回滚 → 给 AI 的验收清单。
- **`scripts/install.sh`**：一键安装脚本。自动探测 dsh CLI（macOS/常见安装布局，可用 `--cli` 覆盖）
  与 profile（默认 `desktop`，可用 `--profile` 覆盖）；已装则自动改走 `update`；`--dry-run`
  只打印将执行的命令。只调用 `dsh plugin add/update`，不删文件、不需要 sudo、不改系统路径。
- **`scripts/install.ps1`**：Windows / PowerShell 版本，参数与行为一致（纯 ASCII，兼容 PS 5.1）。

### 文档
- README（中/英）新增「方式 0：一键脚本」与指向安装手册的入口。
- 故障排查新增三条本机实测的踩坑：**页面全 404 + 插件 `pending`（inject 声明了已下线的服务）**、
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（pnpm 11 默认不跑 git 依赖 prepare）、
  `npm: command not found` / `spawnSync npx ENOENT`（依赖 prepare 需要 npm/npx）。

## [0.2.7] - 2026-10-18

修复**新版 DSH 下插件整体失效**：页面所有请求返回 `请求失败（HTTP 404）`，「定时更新状态读取失败」「读取失败」。
0.2.6 的定时更新功能本身没问题，坏的是宿主半边根本没被加载。

### 修复
- **根因**：宿主 `inject` 里声明了 `webRuntime`，而新版 DSH 已删除该服务（受信主机改由 `webApp` 公布）。
  cordis 等不到该服务，fiber 永远停在 `pending`，`apply()` 从不执行 ⇒ `/api/dsh-integration/*` 全部 404。
  这与插件代码质量无关，是 DSH 升级引入的不兼容：0.2.5 的 `inject` 同样是一串，只是当时服务还在。
- **修法**：`inject` 改为 `['webServer', 'sessions']`；旧版 DSH 的 `webRuntime.trustedHosts` 保留为
  `ctx.get('webRuntime')` 兼容读取，不回写 `inject`。
- **受信主机**：改为取 `webApp.getAdvertisedUrl()` / `webServer.getOrigin()` 的 host（含端口与去端口两种写法），
  旧版回退 `webRuntime.trustedHosts`；服务缺失时仍只放行 loopback，安全语义不变。
- **回归测试**：新增断言「`inject` 只引用当前 DSH 确实提供的服务」，防止再次因服务下线静默卡死。

### 升级
装完必须**完全退出并重新打开 DeepSeek Harness**（fiber 卡死无法热修），刷新页面后「思考解锁」恢复正常。

## [0.2.6] - 2026-10-16

「思考解锁」支持**定时自动更新**：DSH 运行期间按周期自己探测网关、把最新档位写回配置，不必再手动打开页面点「全部解锁」。

### 新增
- **定时更新**：默认每 6 小时跑一次，页面可改成 15 分钟 / 30 分钟 / 1 / 2 / 6 / 12 / 24 小时，也可以直接关掉。
  计时状态存在 `<profile>/.dsh-integration/unlock-schedule.json`（`0600`），显示「下次 / 上次」时间与上次结果
  （更新了几个模型 / 无改动 / 哪几个网关探测失败）。
- **「立即执行一次」**：不等点，按同一条路径立刻跑一次并记录；不会把已关掉的开关重新打开。
- **宿主路由**：`GET|POST /provider/schedule`（读 / 改周期与开关、范围是否只处理 WorkBuddy 网关）、
  `POST /provider/schedule/run`（立即执行）。写操作同样受 `x-dsh-integration: 1` + `application/json` 围栏约束。
- 区间被宿主钳制在 15 分钟 ~ 24 小时，页面传什么都不会写出离谱周期。改周期、或把已关掉的开关重新打开，
  **都会从现在重新计时**（否则 6 小时改 15 分钟会先干等旧点位，重新打开又会立刻触发）。
- 页面上只能改开关 / 周期 / 范围三项；`lastRunAt`、`lastResult`、`nextRunAt` 由宿主自己维护，页面回传的旧值一律忽略。

### 设计要点
- **复用同一条解锁路径**：定时任务调用的是「全部解锁」用的同一个 `unlockProviderThinking`（同样的网关身份
  判断、同样的 `onlyWorkbuddy` 范围、同样的字节区间改写与写前 `.bak-<时间戳>` 备份），并排在**同一条串行队列**
  里，因此定时任务与手点按钮不可能同时改文件。
- **到点才跑，不补跑**：睡眠 / 合盖 / 退出 DSH 跨过的时段**不逐段重放**，只在下次启动发现「已过点」时补一次，
  之后按新间隔继续，避免睡醒后连着一串写盘。
- **只在 DSH 运行期间生效**：不装系统级定时任务（cron / launchd / 开机自启都没有），退出即停。定时器 `unref()`，
  不会拖着宿主进程不退出。
- **失败不中断**：单个网关探测失败只记进 `lastError` 与 `lastResult.failedProviders`，其余网关照常处理，
  下一次到点再试；配置没有实际变化时一个字节都不写。

### 测试
- 75/75（较 0.2.5 的 60 项新增 15 项）。`test/schedule.test.js` 覆盖周期钳制、默认一个周期宽限期、启动不立即跑、已存的
  `nextRunAt` 不被睡眠重放、损坏 / 缺失状态文件回落、`0600` 落盘、到点写回并排下一次、强制执行、探测失败后
  周期存活，以及 `onlyWorkbuddy` 开关的生效与放宽。
- `test/host.test.js` 新增一条**不 mock 网络**的端到端用例：临时 profile + 真实 HTTP 网关 + 已过期的 `nextRunAt`，
  `apply()` 后由插件自己探测并把 `reasoningEfforts`（含带引号的 `"off"`）写回，同时校验 `lastRunAt` / `nextRunAt` /
  `lastResult` 与文件未被重新排版；同一点位不会跑第二次。新增路由在真实 HTTP 上逐条断言（含写围栏 403、周期钳制、
  改周期 / 重新打开会重排下次时间、回传旧 `nextRunAt` 被忽略）。
- `test/client-render.test.js` 补一条：`/provider/schedule` 尚在飞行时该 section 必须照常渲染，不得白屏。

## [0.2.5] - 2026-10-14

修复「新增网关」里点「测试连接并拉取模型」报 `未知接口：POST /provider/probe`。

### 修复
- 0.2.3 下线供应商管理时把宿主路由 `POST /provider/probe` 一并删掉，0.2.4 只恢复了 `/provider/save`，
  而页面上的「测试连接并拉取模型」仍在调用它 —— 于是新增网关时拉不到模型列表，只能手填或直接报错。
  本版把该路由装回：只读网关的 `/v1/models`，**不写任何配置**，成功返回归一化后的模型列表
  （含网关真实支持的思考档位），失败统一回 502 `error.provider.probe`。
- 宿主测试补断言：该路由必须存在**并真正走到网络层**（路由缺失时会回 404「未知接口」，正是本次回归的形态），
  坏地址回 502 而不是 404；`/provider/delete`、`/provider/rename`、`/provider/remove` 继续为 404。

### 测试
- 60/60。真实网关复测：局域网网关 `POST /provider/probe` 返回 20 个模型、19 个带思考档位。

## [0.2.4] - 2026-10-13

思考解锁只认 WorkBuddy 网关，并把「新增 / 编辑网关」加回来（但不提供删除）。

### 新增
- **按身份识别网关**：默认只解锁真正的 WorkBuddy 网关。先看 `<origin>/healthz` 的 `service` 是否含
  `workbuddy`（本机两个网关回 `workbuddy-manager` / `workbuddy2api`，无需密钥），认不出时回落到
  「`/v1/models` 的模型 id 是否全部带 `cn:` / `global:` 命名空间」。识别结果逐行标注，其它网关列出
  原因后跳过，配置一字不改；页面上可取消勾选「只解锁 WorkBuddy 网关」来放宽。
- **新增 / 编辑网关**：`POST /provider/save` 回到宿主路由（`/state` 与客户端页同步提供入口）。
  密钥写进凭据文件的 `refs:`，写前自动备份。

### 变更
- **没有删除路径**：`/provider/delete` 与 `removeProviderFromPatch` / `removeCredentialRef` 不再导出，
  供应商 `id` 建好后不可改（不提供改名，因此也不存在「删旧建新」）。误点不会丢网关。

### 测试
- providers.test.js 新增 7 项：`detectGatewayKind` 的 WorkBuddy / 沉默 / 坏地址三态、`realmNamespaced`
  的边界、非 WorkBuddy 网关默认不被改写、显式放宽后照常解锁、回落判据、`saveProvider` 新增与就地编辑
  （另一分组保持原样）。夹具 `stubFetch` 现在同时应答 `/healthz` 与 `/models`。

## [0.2.3] - 2026-10-13

### 变更
- **设置页只做「思考解锁」**：移除供应商的**新增 / 编辑 / 删除**能力——页面按钮与表单、
  `ProviderEditor`、宿主端 `POST /provider/probe`、`/provider/save`、`/provider/delete` 三条路由，
  以及 `core.js` 里只服务于它们的 `saveProvider` / `deleteProvider` / `renderProviderConfig` /
  `validateModel` / `mergeCredentialRef` / `removeCredentialRef` / `removeProviderFromPatch` 一并删除。
  宿主端只剩 `GET /provider/list`（只读状态）与 `POST /provider/unlock`（解锁写入）两条路由。
- **自动识别改为按网关形态判断**（新增 `judgeProvider`）：不再假定 `providers:` 下的每一项都是网关，
  只有同时满足「`api` 为空或 `openai-completions`」+「`baseURL` 是 http(s) 地址」+
  「`apiKeyEnv` 的凭据在 `.credentials.yaml` 的 `refs:` 里或存在同名环境变量」才被探测；其余在页面上
  标出**跳过原因**（`api` 不是 OpenAI 兼容 / 地址不可解析 / 凭据缺失），既不探测也不改写，并计入返回值
  的 `gatewayProviders` / `skippedProviders`。探测失败单独标记为 `unreachable`，不与其他网关互相影响。
- 页面新增「查看模型」：展开某供应商的**只读**模型清单，逐个显示当前声明的档位与网关要求的目标档位
  （含会去掉哪几档），替代原先的编辑表单。
- 解锁用 `apiKeyEnv` 取密钥时支持环境变量回退（凭据文件里没有该引用时读同名环境变量）。

### 测试
- 删除 12 项只覆盖已移除 API 的用例；新增 3 项：`judgeProvider` 的四类判定与原因（含 `ftp:`、
  无法解析的地址、缺失凭据、无 `apiKeyEnv`、环境变量回退）、非网关供应商**不被探测**、凭据缺失的
  网关被标为跳过而不是失败。两项 patch 往返用例改为走解锁路径（配置直接取自 patch 自身，不再经
  `renderProviderConfig`）。全套 53 项通过。

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
