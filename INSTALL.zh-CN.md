# 安装手册（给 AI / 给人，照着做即可）

本文件是 **可执行 runbook**：每一步都给出命令与「期望输出」，按顺序做完就装好了。
把它连同仓库地址一起发给另一台电脑上的 AI，即可让它独立完成安装。

- 仓库：`https://github.com/2384418321/dsh-integration-settings`
- 目标：在 DSH（DeepSeek Harness）桌面的某个 profile 里装上本插件，设置页出现
  `MCP 管理 / 思考解锁` 两页，且「思考解锁」页的「同步模型清单」与定时更新能真正跑起来。

> 这是社区插件，不是 DeepSeek 官方产品。改动会落在目标机器的 profile 目录里，
> 安装前建议先备份该目录（第 6 步有回滚办法）。

---

## 0. 先决条件（缺一不可）

| 项目 | 要求 | 备注 |
| --- | --- | --- |
| DSH 桌面版 | **0.2.0-rc.2 及以上**（宿主包名 `@deepseek-ai/*`） | 更低版本槽位/loader 机制不同，不保证可用 |
| 磁盘 | 几十 MB | 仓库已提交构建产物 `lib/` |
| 网络 | 能访问 github.com | 安装即从 GitHub 拉取 |
| Node.js | **不需要**（仅改源码/跑测试才要 `^22.19.0 \|\| >=24`） | 例外见 F3：pnpm 装 git 依赖时可能间接需要 npm/npx |

**不需要**：npm 发布包、本地构建、管理员权限。

## 1. 探测 DSH 安装位置与 CLI（只读，先做）

```bash
# macOS
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
# Windows（PowerShell）：$DSH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
# Linux/其它：在 DSH 安装目录下找 resources/runtime/cli/bin/dsh

"$DSH" --version           # 期望：打印版本号（如 0.2.1-rc.2）
ls "$HOME/.dsh/profiles"   # 期望：列出 profile 目录，桌面版默认叫 desktop
```

拿不准路径时先找安装目录：

```bash
# macOS
mdfind -name "DeepSeek Harness.app" | head -3
# Linux
ls /opt 2>/dev/null; find / -maxdepth 4 -name "runtime" -path "*Harness*" 2>/dev/null | head
```

**判断标准**：`"$DSH" --version` 能输出版本，且 `$HOME/.dsh/profiles/<你的 profile>` 存在。
后续命令中的 `desktop` 一律替换成实际的 profile 名。

## 2. 安装（一条命令）

```bash
"$DSH" plugin --profile desktop add github:2384418321/dsh-integration-settings
```

**期望输出**：pnpm 完成安装，最后出现 `dsh-integration-settings <版本号>`；
profile 的 `package.json` 里 `dsh.profile.bundles` 数组新增 `"dsh-integration-settings"`。

确认登记：

```bash
"$DSH" plugin --profile desktop list        # 期望：列表中出现 dsh-integration-settings
```

## 3. 完全重启 DSH（必做）

宿主半边（路由、定时器）**只在进程启动时加载一次**：不重启的话，页面会是新的、接口还是旧的
（典型症状：页面显示 `请求失败（HTTP 404）`）。

- macOS：`Cmd+Q` 完全退出（关窗口不算），再重新打开。
- Windows/Linux：退出托盘/进程后重新启动。

重启前顺手确认没有多个实例在跑（多实例时容易改到旧的那只）：

```bash
ps -eo pid,lstart,command | grep "DeepSeek Harness.app/Contents/MacOS" | grep -v grep
```

## 4. 验证安装（三项，全部通过才算成功）

1. **插件已装配**：设置 → 插件（或注入器面板）里本插件状态为 `active`（不是 `pending` / `failed`）。
2. **菜单出现**：设置左栏底部有 `MCP 管理 / 思考解锁` 两页。
3. **宿主路由可用**：打开「思考解锁」页，卡片能显示「待解锁 / 已解锁 / 网关未声明」或
   「未检测到网关」等**正常内容**；**不是** `定时更新状态读取失败：请求失败（HTTP 404）`。

> ⚠️ 不要用 `curl` 判断路由是否注册：DSH 的 web 层有鉴权，未带会话的 `curl` 一律返回
> `401 unauthorized`，无法区分「路由不存在」与「路由存在但未鉴权」。用上面三项判断。

## 5. 配置网关（「思考解锁」真正要干活的前提）

插件只改写 **当前 profile 里 `- id: llm-pi-ai` 条目的 `config.providers`**。
如果那个 profile 还没配任何供应商，页面会提示「还没有配置任何供应商」——此时先加网关：

**方式 A（推荐，图形化）**：在「思考解锁」页点「新增网关」，填名称、Base URL、模型 id、密钥；
保存后按提示重启 DSH。

**方式 B（手工编辑）**：编辑 `$HOME/.dsh/profiles/<profile>/cordis.patch.yml`，在 `llm-pi-ai` 条目下：

```yaml
    providers:
      workbudy:                      # 6 空格
        api: openai-completions      # 8 空格
        baseURL: http://<host>:<port>/v1
        apiKeyEnv: WORKBUDY_API_KEY  # 只写环境变量名，密钥放凭据文件
        models:                      # 8 空格
          - id: cn:glm-5.1           # 10 空格（列表项）
            name: GLM-5.1            # 12 空格
            contextWindow: 131072
            maxTokens: 32768
            input: text
```

密钥写到 `$HOME/.dsh/.credentials.yaml` 的 `refs:` 段（形如 `WORKBUDY_API_KEY: sk-...`），
两个文件权限都应是 `0600`。**不要把密钥明文写进 patch。**

缩进校验（缩进错会导致整个 profile 加载失败）：

```bash
ruby -ryaml -e 'd=YAML.load_file(ARGV[0]); w=d.find{|e| e.is_a?(Hash) && e["id"]=="llm-pi-ai"}; p w["config"]["providers"].keys' \
  "$HOME/.dsh/profiles/desktop/cordis.patch.yml"
```

改完**必须完全重启 DSH**。

## 6. 验收「定时更新」（本插件的核心能力）

1. 打开「思考解锁」，把「定时自动更新」开关打开，周期默认 6 小时（可改 15 分钟 ~ 24 小时）。
2. 点「立即执行一次」，页面应显示本次结果（解锁了几个模型 / 无变化 / 哪些网关失败）。
3. 检查状态文件（插件自己写，0600）：

   ```bash
   cat "$HOME/.dsh/profiles/desktop/.dsh-integration/unlock-schedule.json"
   ```

   期望字段：`enabled: true`、`intervalMinutes: 360`、`lastRunAt`（毫秒时间戳）、
   `nextRunAt = lastRunAt + interval`、`lastResult`、`lastError`（空串表示无错）。

**判定成功**：`lastRunAt` 有值且 `nextRunAt` 比它大约一个周期；之后每 6 小时会自己再跑一次
（只在 DSH 运行期间；合盖/退出期间错过的时间**不补跑**，启动时若已过点会补一次）。

## 7. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| **页面所有接口 404**（`定时更新状态读取失败：请求失败（HTTP 404）`），插件状态 `pending` | 宿主 `inject` 声明了运行时不存在的服务，cordis 永远等不到 ⇒ `apply()` 不执行 ⇒ 路由没注册。历史原因：`webRuntime` 在新版 DSH 已删除 | 用 **0.2.7 及以上**（`inject` 已收成 `['webServer','sessions']`）；升级后完全重启 |
| 同上但插件状态 `failed` | bundle 加载失败 | 见 F4 |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | pnpm 11 默认不执行 git 依赖的 `prepare` | 在 `$HOME/.dsh/profiles/<profile>/pnpm-workspace.yaml` 加：<br>`allowBuilds:`<br>`  '<包名>': true`<br>再重跑安装 |
| `sh: npm: command not found` / `spawnSync npx ENOENT` | 该 profile 里有依赖需要 `npm install` 做 prepare，而这台机器没有 npm/npx | 装 Node.js（自带 npm/npx），或确认 `npm -v` / `npx -v` 可用后重试；装完可临时 `PATH=$HOME/.local/bin:$PATH` |
| 设置里没有这两个菜单 | 未登记 / 重启的 profile 不对 / `lib/` 缺失 | `"$DSH" plugin --profile <名> list` 核对；确认 `dsh.profile.bundles` 含包名；确认重启的是同一 profile |
| 菜单点了空白 | 客户端代码在 root scope 槽位调用了 seat hook | 用发布版（0.2.x 已修）；自改源码时不要动 `settings.section` 条目的 hook 用法 |
| MCP 改动不生效 | patch 只在启动时读 | 完全重启 DSH |
| 写操作 403 / 415 | 缺 `x-dsh-integration: 1`、非 JSON、Host/Origin 不可信 | 用页面操作；自定义脚本要带该头且 Host 必须是 loopback |
| 页面报 `ambiguous_profile` | 多个 profile 都装了本插件 | 页面选择器指定，或设 `DSH_PROFILE_DIR` / `--profile <名>` |

**F4 通用排查**：看 DSH 启动时的 stderr，常见 `<bin>: skipping profile bundle "dsh-integration-settings": <原因>`。

## 8. 升级 / 卸载 / 回滚

```bash
# 升级
"$DSH" plugin --profile desktop update dsh-integration-settings

# 卸载
"$DSH" plugin --profile desktop remove dsh-integration-settings
# 再从 profile package.json 的 dsh.profile.bundles 删掉本包名（CLI 通常会自动删）
```

回滚：插件每次写 `cordis.patch.yml` 前都会在 profile 目录留时间戳备份（保留 3 份），
改名覆盖回去即可；也可以只删掉 `# >>> dsh-integration-settings:managed:*` 与
`# <<< dsh-integration-settings:managed:*` 之间的受管区块。
本机数据（`<profile>/.dsh-integration/`）与凭据（`$DSH_HOME/.credentials.yaml`）不随卸载删除，需要手工清理。

## 9. 给 AI 的验收清单（逐条勾，全绿才算交付）

- [ ] `"$DSH" --version` 有输出，profile 目录存在
- [ ] 安装命令 success，`plugin list` 中出现 `dsh-integration-settings`
- [ ] DSH 已**完全**重启（且只有一个实例在跑）
- [ ] 插件状态 `active`（不是 `pending`）
- [ ] 设置左栏出现两页菜单（MCP 管理 / 思考解锁），两页都能打开、无白屏
- [ ] 「思考解锁」不再报 HTTP 404
- [ ] 至少一个网关可用（能看到模型 / 待解锁统计），否则记录为「未配置，功能待用」
- [ ] 打开定时开关后，`.dsh-integration/unlock-schedule.json` 出现且 `nextRunAt ≈ lastRunAt + interval`
- [ ] 报告里写清：DSH 版本、profile 名、插件版本、网关数量、状态文件 `lastRunAt/nextRunAt`

## 10. 安全边界（安装时须知）

- 插件**不内置任何凭据**；密钥只存在本机 `$DSH_HOME/.credentials.yaml`（0600）。
- 宿主路由只接受 loopback / 受信 Host，写请求需要 `x-dsh-integration: 1` 头，跨站一律 403。
- 只改写 `llm-pi-ai` 条目的 `config.providers` 中你明确选择的供应商，其它分组逐字节保留。
- DSH 自带的 `deepseek-official` / `deepseek-account` 不在 profile patch 里，结构上不会被碰到。
