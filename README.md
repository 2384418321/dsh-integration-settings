# dsh-integration-settings

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH supported through 0.2.0-rc.2](https://img.shields.io/badge/DSH-up%20to%200.2.0--rc.2-2563eb.svg)](#环境要求)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933.svg)](#环境要求)

**简体中文** | [English](README.en.md)

给 DeepSeek Harness（DSH）**设置**里补上四个可视化菜单，把四件平时只能手改文件的事变成点选操作：

| 设置菜单 | 管什么 | 背后落盘位置 |
| --- | --- | --- |
| **MCP 管理** | 增 / 删 / 改 / 启停 MCP 服务器 | 当前 profile 的 `cordis.patch.yml`（受管区块）+ `.dsh-integration/mcp.json`（真理源） |
| **Skill 管理** | 浏览 / 新建 / 编辑 / 删除技能 | DSH 全局、共享 `.agents`、Claude / Codex 全局目录，以及当前项目的 `.dsh` / `.agents` / `.claude` 目录 |
| **全局人设** | 可视化编辑人设文件（等价于 Claude Code 的 `CLAUDE.md`） | `$DSH_HOME/AGENTS.md`（全局）与 `<项目>/AGENTS.md`（当前项目） |
| **模型供应商** | 新增 / 编辑 / 删除 OpenAI 兼容网关，自动拉模型列表与思考档位 | 当前 profile 的 `cordis.patch.yml`（`llm-pi-ai` 条目的 `config.providers`）+ `$DSH_HOME/.credentials.yaml`（`refs`，只存密钥） |

> 这是社区插件，不是 DeepSeek 官方产品。安装前请自行评估，建议先备份 profile 目录。

## 环境要求

- **DSH 桌面版 0.2.0-rc.2**（本插件按该版本的 `settings.section` 槽位与 loader patch 机制开发；
  宿主包名从此版本起为 `@deepseek-ai/*`）。
- **Node.js `^22.19.0 || >=24`**：仅在本地构建 / 跑测试时需要；**直接安装不需要 Node**，
  因为仓库里已提交构建产物 `lib/`。
- 安装完成后**必须重启 DSH**：MCP 改动由 loader 在启动时读取（技能、人设改动即时生效）。

## 安装

三种方式任选其一；下面用 `desktop` profile 举例，**换成你自己的 profile 名**即可
（DSH 桌面版的默认 profile 就是 `desktop`）。

### 方式 A：从 GitHub 安装（推荐）

```bash
# dsh CLI 在 DSH 应用目录里：
#   macOS        /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
#   Windows 等   <DSH 安装目录>/resources/runtime/cli/bin/dsh（Windows 上是 dsh.cmd）
# 若已把 dsh 加入 PATH，直接写 dsh 也行；布局不同时可在安装目录里搜 runtime/cli
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 1) 安装：会登记依赖并把包名追加到 profile 的 dsh.profile.bundles
"$DSH" plugin --profile desktop add github:2384418321/dsh-integration-settings

# 2) 确认已登记（列表里出现 dsh-integration-settings 即成功）
"$DSH" plugin --profile desktop list
```

仓库直接提交了 `lib/` 构建产物，所以**从 GitHub 安装既不需要 npm 发布，也不需要本地构建**。

### 方式 B：从本地目录安装（改源码调试用）

```bash
git clone https://github.com/2384418321/dsh-integration-settings.git
cd dsh-integration-settings
pnpm install
node scripts/build.mjs            # 只有改了 src/ 才需要重跑

DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "$(pwd)"    # 本地目录以 link: 形式登记
```

以 `link:` 登记时，改完 `src/` 重跑 `node scripts/build.mjs` 再重启 DSH 即可，不必重装。

### 方式 C：绕开 dsh CLI 手工登记

1. 在 profile 目录里安装（profile 目录：`$DSH_HOME/profiles/<profile 名>`）：

   ```bash
   cd "$HOME/.dsh/profiles/desktop"
   pnpm add github:2384418321/dsh-integration-settings
   ```

2. 确认该目录 `package.json` 的 `dsh.profile.bundles` 数组里**有**
   `"dsh-integration-settings"`（缺了就手工追加到数组末尾）。
3. 重启 DSH。

### 安装完成后怎么确认

1. DSH 重启后，**设置**（Settings）左栏底部出现四项：`MCP 管理 / Skill 管理 / 全局人设 / 模型供应商`。
2. 打开「MCP 管理」，页面上方的 **profile 徽标**应显示你要操作的那个 profile 名；
   多 profile 场景下先核对徽标，再动手改。
3. 已有 MCP 服务器应被列出；`cordis.patch.yml` 里手写但未被纳管的行会以横幅提示，可一键导入。

## 卸载

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-integration-settings
```

再从 profile 的 `dsh.profile.bundles` 里删掉本包名，并（可选）清理 profile 的
`cordis.patch.yml` 中 `# >>> dsh-integration-settings:managed:mcp` 到
`# <<< dsh-integration-settings:managed:mcp` 之间的受管区块。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 装完了，设置里没有这三个菜单 | ① 确认 `list` 与 profile `package.json` 的 `dsh.profile.bundles` 里有本包名；② 确认重启的是**同一个** profile；③ 若 bundle 加载失败，DSH 启动时会往 stderr 打 `<bin>: skipping profile bundle "dsh-integration-settings": <原因>` 并静默跳过——常见原因是改了 `src/` 没重新构建（`lib/` 缺失）、Node 版本过低或依赖解析失败 |
| 点进菜单一片空白 | `settings.section` 是 root scope 槽位，一旦在条目里调用 seat 上的 session hook（`usePanelInfo` 等）就会触发 `Minified React error #311`，shell 会把整个槽位替换成 `<div data-slot-error="settings.section"></div>`。改客户端代码时请守「root scope 条目不调用任何 seat hook」这条（见下方设计要点） |
| MCP 改了不生效 | profile patch 由 loader **启动时**读取：重启 DSH 后生效（页面上也有提示）。技能、人设改动即时生效 |
| 写操作报 403 / 415 | 宿主路由要求写请求带 `x-dsh-integration: 1` 与 `application/json`；非 loopback / 不可信 Host、`Origin` 与 `Host` 不一致、`Sec-Fetch-Site: cross-site` 一律 403 |
| patch 写坏了想回滚 | 每次写入前都会在 profile 目录留时间戳备份（保留 3 份），改名覆盖回去即可；也可以只删掉两行标记之间的受管区块 |
| 页面报 `ambiguous_profile` | 有多个 profile 的依赖里含本插件，无法唯一确定。用页面上的 profile 选择器指定，或设置 `DSH_PROFILE_DIR` / 传 `--profile <名>` |

**数据与隐私**：插件不内置任何凭据。密钥请按下面的写法引用环境变量（`!!js process.env.X`），
不要明文写进 patch；`.dsh-integration/` 是你的本机数据，已在 `.gitignore` 里排除。

## 设计要点

### MCP 管理
DSH 没有「MCP 注册表」这种东西：**一个 MCP 服务器就是 profile patch 里的一条 loader 行**。

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github                              # 工具名 => mcp__github__<tool>
        transport: stdio                                # stdio | streamable-http
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env: { GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN }
```

- 因为「新增未知 id 的 patch 条目」只有 `- insert:` 一种合法写法，所以本插件把
  **受管区块整体重写**：JSON（`.dsh-integration/mcp.json`）是真理源，区块每次由它重新生成。
- 区块用两行标记注释包夹，`cordis.patch.yml` 里其它手写内容原样保留；写入前做 YAML 结构校验 +
  时间戳备份（保留 3 份）。
- 已经在 patch 里手写、但插件还不认识的 MCP 行会在页面上以横幅提示，可一键导入纳管。
- `!!js` 表达式（例如 `!!js process.env.GITHUB_TOKEN`）在往返编辑中不会丢失，密钥不会落盘：
  `env` / `headers` 的任意层级值、以及 `args` 中以 `!!js ` 开头的元素都会被写成真正的 YAML 标签
  （`TOKEN: !!js process.env.GITHUB_TOKEN`），普通字符串则保持原样；读回时又是字符串，往返无损。
- 若 profile 的 patch 文件是模板里的 `[]` 空占位，插件会在写入受管区块前先丢掉这行占位，
  避免生成 `Unexpected seq-item-ind token` 这类非法 YAML。

### 改的是哪个 profile？
按以下顺序解析，尽量不猜（顺序：权威 → 显式 → 推断）：

1. 宿主服务 `ctx.get('desktopProfiles').current.dir`（桌面版里就是当前真正在用的 profile，最权威）；
2. 环境变量 `DSH_PROFILE_DIR`；
3. `--profile <名>` / `--profile=<名>` 参数或 `DSH_PROFILE` 环境变量（该 profile 目录需存在）；
4. 扫描 `$DSH_HOME/profiles/*`，找**唯一**一个依赖里含本插件的 profile；
5. 有多个候选时优先 `desktop`；仍无法唯一确定则报 `ambiguous_profile` 并提示手动指定，不会瞎写。

可在页面上方的 profile 徽标确认当前操作对象。

### 设置页 seat 里的坑（改这个插件前必读）
`settings.section` 是 **root scope** 槽位。shell 给每个条目的 props 里塞了一整套 seat 分享：
`usePanelInfo`、`useSessions`、`useSessionStatus`、`useWorkspaces`、`useResource`、
`useSessionRetainInfo`、`renderFactorySlot`、`t`、`close`。

- **这些 `use*` 在 root scope 条目里调用会抛异常**（它们属于 session scope）。一旦把调用包在
  `try/catch` 里把异常吞掉，React 的 hook 链就错位了，**下一次渲染**会在组件里第一个 `useState`
  处抛 `Minified React error #311`；shell 有 per-entry 错误边界，会把整个 slot 换成
  `<div data-slot-error="settings.section"></div>` —— 用户看到的就是「点进去空白」。
  所以：**root scope 条目绝不调用 seat 上的任何 hook**，只用普通 prop（本插件的 `sessionIdOf`
  只读 `props.sessionId`）。
- 更不能让 hook 调用顺序依赖 props 形状（第二个渲染时 props 变了 → "more/fewer hooks than
  during the previous render"，同样白屏）。
- `test/client-hooks.test.js` 专门守这两条：用计数版 React 直接驱动组件函数，断言 seat 上的
  session hook **一次都没被调用**、且两套不同 props 下 hook 序列完全一致。改组件时别绕过它。
- 需要一次渲染看不出来的 bug 时，`renderToString` 抓不到 hook 顺序变化；用
  `DSI_DEBUG=1 node scripts/build.mjs` 出**不压缩、保留函数名 + 内联 sourcemap** 的客户端包，
  再用无头 Chrome 打开真实 GUI 看控制台栈（栈里会直接出现 `McpSection` 这样的函数名）。

### Skill 管理
技能 = 目录下的 `SKILL.md`，带 YAML frontmatter（`name` kebab-case + `description`）。
删除是整目录删除，写入前备份旧的 `SKILL.md`；目录名做 `../` 逃逸防护。

### 全局人设
DSH 的 `@deepseek-ai/dsh-agent-instructions` 插件会在每个会话的首个请求注入一条 baseline：
`$DSH_HOME/AGENTS.md`（就是你的人设）+ 项目链（项目根 → 会话 cwd 的 `AGENTS.md`/`CLAUDE.md`
以及 `AGENTS.local.md`/`CLAUDE.local.md`）。本页就是这份全局文件的编辑器，并列出最近 3 份备份
供一键载回。

### 模型供应商
DSH 的模型供应商由 `@deepseek-ai/dsh-llm-pi-ai` 的 `config.providers` 决定，写在各 profile 的
`cordis.patch.yml` 里。本页把这件事变成表单：填 `id / baseURL / apiKeyEnv / apiKey` → 点
「测试连接并拉取模型」读网关的 `GET /models` → 勾选要暴露的模型 → 保存。

几个关键设计（都不是随意选择）：

- **只改进已有的 `- id: llm-pi-ai` 条目**，不新建第二个同名条目——cordis 的同 id 条目会让 DSH
  启动直接失败（去重得用 `dev_fix_patch`）。找不到该条目时页面会黄条提示。
- **走 YAML 文档树改写**（解析成 document 改节点再序列化），不是 `parse → JS → stringify`，
  这样文件里的注释和其它条目的内容都原样保留。
- **密钥不写进 patch**：`apiKeyEnv` 只是引用名，密钥本体写到 `$DSH_HOME/.credentials.yaml` 的
  `refs:` 段。页面上的 apiKey 输入框只在「新增」或「想换密钥」时填，留空就不动既有密钥。
- **思考档位自动映射**：网关 `GET /models` 返回的 `reasoning_supported_efforts` 会转成 pi-ai 的
  `reasoningEfforts` 字典。注意 `off` 必须写成带引号的 `"off":`——YAML 1.1 会把裸 `off:` 解析成
  布尔 `false`，档位字典的键类型就错了。
- **兼容手写分组**：页面对 `providers:` 下每个供应商只改自己那一段字节，不改动的分组会**逐字节
  原样保留**——手写的流式列表（`input: [ "text", "image" ]`）、带引号的标量、以及
  `reasoningEfforts: false`（声明「不支持思考」的模型）都不会被重排或丢掉。把某个供应商原样
  保存回去时文件零变化。注意：`reasoningEfforts` 一旦声明就是白名单，**未声明的档位即不可选**；
  `false` 表示该模型不支持思考，`{}` 和不写都表示「沿用网关目录里的能力」。
- 保存/删除都会写 `.bak-<时间戳>` 备份（各保留最近 3 份），两个文件权限都按 `0600` 写。

改完需**重启 DSH** 才会在模型选择器里出现；重启前可用 `de_models` 核对每个模型是否带上了
「思考等级」。

## 安全边界

宿主端只注册一个 loopback HTTP 路由 `/api/dsh-integration`：

- **Host 校验**：只接受 loopback 或 `ctx.webRuntime.trustedHosts` 里的 host；`Origin` 与 `Host`
  不一致直接 403；`Sec-Fetch-Site: cross-site` 直接 403（防止网页跨站打本地接口）。
- **写操作凭证**：所有非 GET 请求必须带 `x-dsh-integration: 1` 与 `application/json`，否则 403/415。
- **路径栅栏**：技能目录只允许单层 kebab-case 目录名；备份文件名做白名单匹配；不跟随符号链接逃逸。
- **串行化**：所有写操作经同一条 Promise 队列，避免并发写坏 patch。
- 不写凭据：`env`/`headers` 里若填密钥明文，那是用户自己的选择；推荐按 README 用 `!!js process.env.X`。

## 开发

```bash
pnpm install                    # 首次
node scripts/build.mjs          # esbuild：src/index.js -> lib/index.js，src/client.jsx -> lib/client.js
DSI_DEBUG=1 node scripts/build.mjs   # 调试用：客户端包不压缩、保留函数名、内联 sourcemap
node --test test/*.test.js      # 30 个测试（必须给 glob；node --test test/ 会把目录当模块）
```

- `test/core.test.js`：patch 区块生成/替换/幂等、`!!js` 标签往返、`[]` 空占位、服务器校验、
  技能 CRUD（含 `../` 逃逸拒绝）、人设备份轮转与读取。
- `test/host.test.js`：**对着构建产物**起真 HTTP 服务，覆盖 10 条路由 + 三道安全栅栏。
- `test/client.test.js`：按 `window.__ModuleLoader__.load` 的真实加载方式加载客户端包，
  断言三个 `settings.section` 注册（含无 locale 服务、locale 抛异常两种降级路径）。
- `test/client-render.test.js`：用真 React + `react-dom/server` 按 shell 的 `as()` 语义复刻
  React 种子，断言三个页面都能渲染出非空 DOM。
- `test/client-hooks.test.js`：hook 顺序与 seat hook 的白盒回归（见上一节）。

调试小工具：浏览器控制台里 `localStorage.dsiDebug = '1'` 后重载，会**打印一次** seat 分享的
props 键名（默认静默，不影响用户控制台）。

参考实现：`@michengai/dsh-skills-manager`（`settings.section` 槽位 + esbuild banner/footer 打包方式）。
槽位契约见 `@deepseek-ai/dsh-client-ui-settings` 的 `slots.d.ts`：
`settings.section` = `{ kind: 'list', scope: 'root', owner: { close } }`，注册方自带
`id` / `order` / `label`。

## 已知限制

- **只覆盖全局作用域**：`settings.section` 是 root scope 槽位，拿不到会话上下文（见上面
  「设置页 seat 里的坑」），所以技能页只列出全局技能目录、人设页只编辑 `$DSH_HOME/AGENTS.md`，
  项目级技能目录/项目级 `AGENTS.md` 需要在会话内的界面上才能出现。页面标题里已注明这一点。
  宿主端 `/state?session=<id>` 与 `x-dsh-integration-session` 头已经预留，将来若有会话内的槽位可直接复用。
- profile patch 的改动由 loader 在**启动时**读取；本机 desktop profile 没有 HMR bundle，
  所以 MCP 改动**需要重启 DSH** 才生效（页面内已提示）。技能与人设改动即时生效。
- MCP 页暂不支持编辑 `reconnect` 子对象与 MCP prompt templates（前者保留原值、后者 DSH 不支持）。
- 未注册 icon：`settings.section` 的 owner props 只约定 `id`/`order`/`label`，图标由 shell 兜底。

## 许可证

[MIT](LICENSE) © 2026 2384418321
