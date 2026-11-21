# 向 Fynvra 插件市场提交插件

感谢你为 Fynvra 写插件！本文说明怎么写插件、本地测试、提交审核以及发布更新。

## 1. 写一个插件

Fynvra 插件就是一个 [pi](https://github.com/earendil-works/pi) 包，再加一个 `fynvra-plugin.json` 清单。最简单的做法是复制官方示例 [`official/com.fynvra.hello`](official/com.fynvra.hello)。

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
| `permissions` | 见下文，没有就写 `[]` |

`id` 和 `version` 必须与注册表条目一致；索引中的权限和 engines 以这个文件为准。

### 权限含义

权限声明会展示给用户，也是审核依据。**它不是沙箱**：插件运行时拥有和 Fynvra 相同的能力，所以声明必须如实。

| 权限 | 含义 |
| --- | --- |
| `network` | 访问网络（`fetch`、`http`/`https`、WebSocket 等） |
| `filesystem` | 读写工作区以外的文件，或修改用户文件 |
| `shell` | 执行命令或启动子进程（`child_process` 等） |
| `env` | 读取环境变量 |
| `model-keys` | 读取或使用用户在 Fynvra 中配置的模型密钥 |

用到依赖时，依赖的行为也算插件的行为。

## 2. 本地测试

1. 在 Fynvra 中打开「设置 → 插件」，用「添加本地插件」选择你的插件目录。
2. 在对话里实际调用你的工具或命令，确认工作正常、没有报错。
3. 在本仓库检出目录中，可以用和 CI 相同的脚本做检查（需要 Node 22+）：
   ```bash
   node scripts/validate.mjs            # 校验条目格式
   node --test scripts/test             # 脚本自身的测试
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
