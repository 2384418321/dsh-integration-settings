# 本地补丁说明

本目录是 `dsh-integration-settings` 的本地副本。当前版本 `0.2.10-dsh.3`。

## 改动一：移除两个设置页（0.2.9-dsh.1）

`lib/client.js` 的 `apply()` 里注册数组只保留：

- `integration-mcp`（MCP 管理）
- `integration-providers`（思考解锁）

被移除的两个条目原本是：

```js
{id:"integration-skills",order:62,labelKey:"skills.title",Component:We},
{id:"integration-persona",order:63,labelKey:"persona.title",Component:Ge},
```

组件函数 `We` / `Ge` 仍在 bundle 内（未注册即不渲染）。`/api/dsh-integration/skill/*`、`/persona/*` 接口仍存在但不再有 UI 入口。

## 改动二：模型清单同步与思考档位解锁分开（0.2.10-dsh.2，2026-10-21）

**这次改到了 `lib/index.js`（服务端），不只是客户端 bundle。** 原先「全部解锁」一个开关同时表达
"网关支持哪些思考档位"和"这个网关有哪些可用模型"两件事，语义混淆；现在拆开：

- 服务端新增 `syncDigest()` / `planModelSync(raw, gatewayModels)` / `syncProviderModels(env, {...})`
  （`lib/index.js`，"模型清单同步"那一段），以及两个路由：
  - `POST /providers/models/sync-preview` → 只读预览，返回
    `{added,removed,kept,levels:{added,removed,kept},models:{added,removed,kept},levelModels,details,digest}`
  - `POST /providers/models/sync-apply` → 写盘，需 `confirm:true` + `expectedDigests`（或单个 `digest` 字符串）
- 写盘复用原有 `writeWithBackup()`（`.bak-<时间戳>` + 原子替换，保留 3 份）；写前 `validatePatchText()` 校验。
- 抓取失败（`/models` 空数组 / 非 2xx / 全部网关探测失败）→ apply 返回 **502 `error.provider.sync.probe`**，
  配置文件不动；`planModelSync` 另外拒绝生成空模型表。**绝不把模型清单写空。**
- 定时更新 `runScheduledUnlock()` 现在一轮跑两步：`unlockProviderThinking()`（档位）+ `syncProviderModels()`
  （模型清单），自动确认；差异摘要写进 `unlock-schedule.json` 的 `lastResult.sync`，UI 显示「上次差异」。
- 客户端 `Qe`（`integration-providers`）新增 `syncPlan` 状态与「同步模型清单」按钮、预览面板
  （将新增 N / 将移除 M、逐网关明细、档位增减、确认/取消），以及定时卡片里的上次同步差异提示。

## 改动三：MCP 粘贴 JSON 新增 + 界面脱敏（0.2.10-dsh.3，2026-10-21）

**服务端**（`lib/index.js`）：新增 `importMcpJsonServers()` / `parseMcpJsonDocument()` /
`normalizeMcpJsonServer()` / `mcpJsonWarnings()`，路由 `POST /mcp/import-json`。

- 入参 `{json, dryRun?, overwrite?}`；`json` 可以是粘贴字符串或已解析对象。
- 支持 `{"mcpServers":{…}}`、`{名称:配置}`、`{"servers":[…]}` 三种形状。
- `url` → `streamable-http`（`sse`/`http`/`streamableHttp` 归一到它）；`command` → `stdio`；
  只保留 `mcpConfig()` 认识的字段（`args`/`env`/`cwd`/`headers`/超时/`enabled`/`failOnStartupError`）。
- 返回 `{dryRun, wrote, added, updated, skipped, failed[{name,error}], warnings, serverCount, patchFile, mcpFile}`；
  逐条容错，一条都没成功就不落盘；写盘仍走 `writeMcpServers()`（校验 + 备份 + 原子）。
- URL 查询串/headers 里带凭据时进 `warnings`，提示会明文写进 `cordis.patch.yml`。

**客户端**（`lib/client.js`，组件 `_e`）：新增状态 `jsonOpen/jsonText/jsonPlan` 与
`importJsonPreview()` / `importJsonConfirm()` 两个处理器，工具栏加「粘贴 JSON 新增」按钮，
展开内联面板：文本域 → 「预览」（dryRun）列出将新增/将覆盖/将跳过/有问题 → 「确认写入」。

**脱敏**：`dsiMaskUrl()` 追加查询串凭据掩码（`?token=…` → `?token=***`）；
`dsiMaskPath()` 补到 MCP 页描述与 footer、Skill 页当前目录、人设页文件路径（`C:\Users\<用户>` → `~`）。

### 上游若复活怎么办

上游最后版本 0.2.8。若上游复活并发布 0.2.9（或更高），把本目录 `lib/` 换成新构建后：

1. 按「改动一」重新删两条注册项；
2. 按「改动二」把 `planModelSync` / `syncProviderModels` / 两个路由 / `runScheduledUnlock` 的两步逻辑
   与「同步模型清单」UI 重新打上（上游没有这些）；
3. 按「改动三」把 `importMcpJsonServers` 系列 + `/mcp/import-json` 路由 + 粘贴面板与脱敏函数重新打上；
4. 版本号抬到下一号。

## 来源

- 上游：`github:2384418321/dsh-integration-settings`，版本 0.2.8（基线 commit `7d4092c62058af53e59f423fc5c9fa3379292f05`）
- 本地接入方式：profile 的 `package.json` 里依赖改为 `link:D:/DeepSeek/dsh-integration-settings-local`

## 上游状态（2026-10-20 核实）

- `https://github.com/2384418321/dsh-integration-settings` 已 **404**（带 token 访问同一结果），仓库列表里也没有同名仓库；`registry.npmjs.org/dsh-integration-settings` 返回 404，从未发布到 npm。
- 结论：**没有上游可更新**。本目录是目前唯一的可运行副本，备份在 `office` 仓库
  `clients/dsh/local-packages/dsh-integration-settings`（10 个文件，与本地逐文件哈希一致）。
- 因此依赖用 `link:` 不是"暂时绕过更新"，而是终态；dsh 插件市场对 `link:`/`file:` 依赖不做版本更新。
- **版本号 `0.2.9-dsh.1`**（2026-10-20）：`0.2.9` 表示"比上游最后的 0.2.8 多一层本地修订"，
  `-dsh.1` 是本地分叉序号（这一逻辑上与 semver 的 prerelease 语义一致：比较时高于 0.2.8、低于 0.2.9）。
  改号后设置页/市场里能一眼区分"这是本地改过的构建"，不会与上游 0.2.8 混淆；
  `description` 也同步改成"保留两个页面"的实际情况。
- **版本号 `0.2.10-dsh.2`**（2026-10-21）：在 `-dsh.1` 基础上加入「同步模型清单」（服务端 + 客户端），
  按同一抬号规则进一位（0.2.9 → 0.2.10，序号 -.1 → -.2）。
- **版本号 `0.2.10-dsh.3`**（2026-10-21）：在 `-dsh.2` 基础上加入 MCP 粘贴 JSON 新增与界面脱敏，
  同上游基线下再进一位序号（`-dsh.2` → `-dsh.3`）。

## 备份与同步（重要）

- 本目录在 **`D:\DeepSeek` 下，不在任何 git 仓库里**；改它不会自动进 `office` 仓库，也没有 watcher。
  仓库里的副本是**快照**，只有跑一次同步脚本才会更新：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\吕文\workbuddy-env-office\clients\dsh\scripts\sync-dsh-bucket.ps1 -DryRun   # 预演
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\吕文\workbuddy-env-office\clients\dsh\scripts\sync-dsh-bucket.ps1            # 提交+推送+回读
  ```

- 因此**每次改完本目录都要跑上面第二条**，否则仓库里留下的是旧版本（历史上就出现过仓库显示 0.2.8、
  本地已是 0.2.9-dsh.1 的时间窗）。改版本号这类"只改元数据"的改动同样需要同步。
- 判新旧看仓库 `clients/dsh/plugins.json` 的 `installed` 与 `clients/dsh/local-packages/dsh-integration-settings/package.json`
  的 `version`；两者与本地一致才算同步完成。

## 恢复办法

把依赖改回上游 `github:` spec 并 `pnpm install`（需上游仓库存在；当前已不存在，故此法暂不可用）。
替代方式：把 `lib/client.js` 里那两条注册数组项加回去（bundle 内组件 `We`/`Ge` 仍在）。

## 附：文档与分发（0.2.10-dsh.4）

本版**没有改 `lib/` 任何一行**，只做两件事：

1. **文档真值修复**：`README.md` / `README.en.md` / `INSTALL.zh-CN.md` 原先描述的是上游仓库
   （四个设置页、`src/` + esbuild 构建链、`test/` 测试集、`scripts/install.sh` 一键脚本），与本分叉实际状态不符。
   现已改为：两个设置页、直接编辑 `lib/`、无构建链与测试集，并补上「同步模型清单」按钮的说明。
2. **公开仓库**：<https://github.com/2384418321/dsh-integration-settings>（MIT），供
   `dsh plugin add github:2384418321/dsh-integration-settings` 安装，也作为插件市场收录的源码地址。
