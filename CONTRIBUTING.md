# 向 Fynvra 插件市场提交插件

感谢你为 Fynvra 写插件！本文说明怎么写插件、本地试用、提交审核以及发布更新。

## 0. 两类插件

| 类别 | 清单 `kind` | 运行方式 | 谁能提交 |
| --- | --- | --- | --- |
| PI 插件 | `"pi"`（缺省） | pi 扩展或 pi 包，在对话里提供工具、命令等 | 所有人（需审核） |
| Fynvra 插件 | `"fynvra"` | 在 Fynvra 后台独立进程常驻运行，只能通过宿主 API 做事 | 所有人（需审核） |

两类插件的差别：PI 插件只在对话里被调用时运行；Fynvra 插件在后台常驻运行，即使用户没在对话也会持续工作，所以审核会更严（见第 5 节）。第三方插件审核通过后都以 `tier: "reviewed"` 上架。下文除第 1.1 节外的示例以 PI 插件为主。

## 1. 写一个插件

PI 插件就是一个 [pi](https://github.com/earendil-works/pi) 包，再加一个 `fynvra-plugin.json` 清单。

插件根目录至少包含：

```
fynvra-plugin.json
package.json          # 用 pi.extensions 声明扩展入口（或者提供 extensions/ 目录）
extensions/xxx.ts
README.md             # 推荐，会显示在市场的插件详情里（≤ 256 KB）
LICENSE
```

`package.json` 示例：

```json
{
  "name": "my-fynvra-plugin",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/index.ts"] }
}
```

扩展的写法（注册工具、命令、事件等）见 pi 文档中的 extensions 与 packages 章节。

### fynvra-plugin.json

```json
{
  "schemaVersion": 1,
  "id": "io.github.you.weather",
  "name": "天气查询",
  "version": "1.0.0",
  "description": "查询城市天气。",
  "author": "你的名字",
  "license": "MIT",
  "engines": { "fynvra": ">=0.1.0" },
  "permissions": ["network"]
}
```

| 字段 | 规则 |
| --- | --- |
| `id` | 反向域名风格，匹配 `^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$`，≤ 64 字符。建议用你能控制的域名或 `io.github.<用户名>.<插件名>`。`com.fynvra.*` 保留给官方插件 |
| `name` | 1–60 字符 |
| `version` | `x.y.z` 或 `x.y.z-预发布标识`，≤ 40 字符 |
| `description` | ≤ 1000 字符 |
| `author` | 1–100 字符 |
| `license` | 1–40 字符，例如 `MIT`、`Apache-2.0` |
| `engines.fynvra` | 可选，只支持 `>=x.y.z` |
| `permissions` | 见下文（词表按类别区分），没有就写 `[]` |
| `kind` | 可选，`"pi"` 或 `"fynvra"`，缺省按 `"pi"` 处理 |
| `host` | 只有 `kind: "fynvra"` 时使用且必填，见 1.1 节 |

`id` 和 `version` 必须与注册表条目一致；索引中的权限和 engines 以这个文件为准。

### 1.1 Fynvra 插件

Fynvra 插件不需要是 pi 包（不检查 `pi.extensions`，`package.json` 可选，只在有 `dependencies` 时用来安装依赖）。清单示例：

```json
{
  "schemaVersion": 1,
  "id": "io.github.you.example",
  "name": "示例",
  "version": "1.0.0",
  "description": "……",
  "author": "你的名字",
  "license": "MIT",
  "kind": "fynvra",
  "host": { "main": "dist/main.mjs" },
  "permissions": ["notifications", "network"]
}
```

- `host.main` 是入口文件，必须是 **ESM 格式的 JS**：包内相对路径，只用 `/` 分隔，不能含 `..`、反斜杠或盘符，扩展名 `.js` 或 `.mjs`，并且该文件必须真实打进插件包。
- **构建时不会执行任何脚本**（不跑 `npm run build`、不编译 TypeScript）。作者要把构建好的 JS 一起提交到仓库，并且**不能压缩或混淆**，方便审核。
- 条目 `tier`：第三方填 `reviewed`（`com.fynvra.*` 是官方保留命名空间，只能是 `official`）。同一插件的所有版本 `kind` 必须相同。
- 宿主 API 的类型定义可以参考 [`official/com.fynvra.telegram/src/types/appPluginApi.ts`](official/com.fynvra.telegram/src/types/appPluginApi.ts)，[Telegram 插件](official/com.fynvra.telegram/) 本身就是一份完整的参考实现。
- 本地试用必须用 Fynvra **开发版**（从源码 `pnpm dev` 启动），在「设置 → 插件 → 添加本地 Fynvra 插件（开发）」里选择插件目录。正式安装版不能加载本地 Fynvra 插件。

### 权限含义

权限声明会展示给用户，也是审核依据。词表按插件类别区分，出现词表外的值会被拒绝。

**PI 插件**的权限**不是沙箱**：插件运行时拥有和 Fynvra 相同的能力，所以声明必须如实。

| 权限 | 含义 |
| --- | --- |
| `network` | 访问网络（`fetch`、`http`/`https`、WebSocket 等） |
| `filesystem` | 读写工作区以外的文件，或修改用户文件 |
| `shell` | 执行命令或启动子进程（`child_process` 等） |
| `env` | 读取环境变量 |
| `model-keys` | 读取或使用用户在 Fynvra 中配置的模型密钥 |

**Fynvra 插件**只能通过宿主 API 做事，权限决定它能调用哪些 API：

| 权限 | 含义 |
| --- | --- |
| `notifications` | 发送系统通知 |
| `network` | 访问网络，并可取得 Fynvra 的代理设置 |
| `workspaces` | 列出工作区（只有 id、名称、是否 git，不含路径） |
| `channel` | 使用渠道 API：创建并驱动本插件自己的会话、查看本插件发起的任务，外发文本会先经过过滤 |
| `ui` | 在设置页渲染声明式界面并接收用户操作 |

用到依赖时，依赖的行为也算插件的行为。

## 2. 本地试用

1. 在 Fynvra 中打开「设置 → 插件」，用「添加本地插件」选择你的插件目录。
2. 在对话里实际调用你的工具或命令，确认工作正常、没有报错。
3. 在本仓库检出目录中，可以用和 CI 相同的脚本做检查（需要 Node 22+）：
   ```bash
   node scripts/validate.mjs            # 校验条目格式
   ```

## 3. 打包规则与上限

插件包由 CI 打包，你不需要上传 zip：

- 打包内容就是插件根目录（条目里的 `path`，默认仓库根目录），zip 中没有顶层文件夹。
- 只在 `package.json` 有 `dependencies` 时才安装依赖：有 `package-lock.json` 时执行 `npm ci --omit=dev --ignore-scripts`，否则执行 `npm install --omit=dev --ignore-scripts --no-package-lock`。**任何安装脚本（postinstall 等）都不会执行**，依赖如果需要安装脚本才能工作，就无法上架。
- 排除 `.git/`、`.github/`、`node_modules/.bin/` 和所有符号链接；不拉取子模块。
- 出现 `.node` 原生模块时构建失败。
- 上限：zip ≤ 50 MB，解压后合计 ≤ 200 MB，≤ 20000 个文件；README.md ≤ 256 KB。
- 打包结果可复现：同一提交总是得到同一个 sha256。

## 4. 提交

### 方式一：提 PR（推荐）

Fork 本仓库，新增 `plugins/<id>.json`：

```json
{
  "id": "io.github.you.weather",
  "name": "天气查询",
  "description": "查询城市天气。",
  "author": "你的名字",
  "homepage": "https://github.com/you/weather",
  "repository": "https://github.com/you/weather",
  "license": "MIT",
  "category": "tools",
  "tags": ["weather"],
  "tier": "reviewed",
  "versions": [
    {
      "version": "1.0.0",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "changelog": "首个版本"
    }
  ]
}
```

- 文件名必须是 `<id>.json`。
- `repository` 必须是公开的 https 仓库；`commit` 是完整的 40 位小写 SHA。
- 插件不在仓库根目录时，在版本里加 `"path": "packages/weather"`。
- `category` 取 `tools`、`integration`、`productivity`、`dev`、`other` 之一；`tags` 最多 10 个，每个 ≤ 32 字符。
- 第三方插件 `tier` 一律填 `reviewed`；`official` 只用于本仓库 `official/` 下的官方插件。

按 PR 模板填写检查清单。CI 会校验、构建并生成扫描报告。

### 方式二：填 Issue 表单

不熟悉 PR 可以用 Issue 里的「提交插件」表单，填写仓库地址、提交 SHA、插件 id、说明、权限和联系方式，维护者会代为创建条目。

## 5. 审核标准

维护者 @LAIJiangFeng 会逐项检查：

- **功能与说明一致**：插件做的事和名称、说明、README 相符。
- **权限如实**：代码和依赖实际用到的能力都已声明；扫描报告中的命中项都能解释。
- **不收集、不外传用户数据**：除插件核心功能必需且已在说明中写明的请求外，不得上报任何数据。
- **不混淆**：不得有混淆、压缩后的自有代码，不得下载并执行远程代码，不得用 `eval`/`new Function` 执行动态拼接的代码。
- **不越界**：不读取 `~/.ssh`、浏览器数据、其他应用的凭据；不修改 Fynvra 或 pi 的配置。
- **许可证明确**：仓库有 LICENSE，且允许分发。
- **能用**：维护者会安装试用，明显不可用的插件会被退回。

**Fynvra 插件的额外要求**（它在后台常驻运行，审核更严）：

- **写清网络访问**：README 里列出插件会访问的所有网络地址，以及为什么要访问。
- **`channel` 权限从严**：只给「把外部消息（聊天、反馈等）接进 Fynvra 会话」的插件，审核时重点检查。这个权限能在用户的 git 工作区里创建受限会话、驱动它们修复问题并开 PR。
- **不得后台定时上报数据**。
- **卸载时不留常驻进程**：插件停用或卸载后，不能留下任何还在运行的进程。

审核不通过时会在 PR 中说明原因。

## 6. 更新插件

每次更新都要提一个 PR：在条目的 `versions` 中**追加**新版本和新提交，不要修改已有版本：

```json
"versions": [
  { "version": "1.0.0", "commit": "<旧 SHA>", "changelog": "首个版本" },
  { "version": "1.1.0", "commit": "<新 SHA>", "changelog": "新增 xx 功能" }
]
```

- 同时更新源码中 `fynvra-plugin.json` 的 `version`。
- 已发布的版本不可变：同一版本号不能换提交，有问题请发布新版本号。
- 维护者只审查两次提交之间的 diff，请在 PR 中附上对比链接（`https://github.com/<owner>/<repo>/compare/<旧SHA>...<新SHA>`），尽量让每次更新的 diff 小而清楚。
- 新增权限需要在 PR 中说明理由。

## 7. 撤回

发现安全问题时，作者或维护者可以提 PR 在 `revoked.json` 中追加一项（撤回指定版本或 `"all"`，附 200 字符以内的原因）。合并后 CI 会重新签名发布，Fynvra 客户端据此提示用户并停用插件。紧急情况请直接联系 @LAIJiangFeng。
