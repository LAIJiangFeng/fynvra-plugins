# Fynvra 插件注册表

这是 [Fynvra](https://github.com/LAIJiangFeng/fynvra) 插件市场的注册表仓库，Fynvra 的「设置 → 插件 → 市场」从这里读取插件列表。仓库包含：

- **市场条目**（`plugins/`）：每个插件一个 JSON，锁定源码仓库、提交 SHA 和目录。
- **官方插件源码**（`official/`）。
- **构建、签名、校验脚本**（`scripts/`）：只依赖 Node 22+ 内置模块，不需要 `npm install`。

CI 把插件打包并生成签名索引，写入 `dist` 分支。Fynvra 只信任签名有效的索引（Ed25519），下载插件包后会核对 sha256，不一致就拒绝安装。

## 现有插件

| 插件 | ID | 类型 | 分级 |
| --- | --- | --- | --- |
| [Telegram 群反馈值班](official/com.fynvra.telegram/README.md) | `com.fynvra.telegram` | Fynvra 插件 | 官方 |

### Telegram 群反馈值班

**做什么**：群成员在 Telegram 群里 @机器人 反馈问题，插件自动分诊、必要时追问；定位到原因的 bug 由值班会话修复并开 PR，新功能需要你在设置页采纳后才会动手。支持图片和文档附件。

**怎么用**：

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather) 创建机器人，拿到 token。
2. 在 Fynvra 的插件设置页填入 token。
3. 把机器人拉进群，并关闭隐私模式（对 @BotFather 发 `/setprivacy` → 选择机器人 → `Disable`），或者把机器人设为群管理员。
4. 在设置页允许这个群。
5. 在群里 @机器人 描述问题即可。

**安全**：值班会话受限运行，只开 PR、不合并；发到群里的回复会先经过出站过滤，去掉密钥和本机路径。

详细说明见 [official/com.fynvra.telegram/README.md](official/com.fynvra.telegram/README.md)。

## 安装插件

- **从市场安装**（市场开放后）：Fynvra → 设置 → 插件 → 市场，找到插件，查看说明和权限后安装。
- **开发时**：在 Fynvra 的「设置 → 插件 → 添加本地 Fynvra 插件（开发）」里选择 `official/com.fynvra.telegram` 目录。

## 目录结构

```
plugins/<id>.json      市场条目
official/<id>/         官方插件源码
revoked.json           撤回列表
scripts/               validate / build / scan / publish / verify / gen-key
.github/workflows/     check.yml（PR 检查）、publish.yml（发布）
```

## 发布流程（维护者）

1. **PR**：触发 `check` 工作流，依次校验条目、构建变动的版本、生成扫描报告（在该次运行的 Summary 页）。扫描只作提示，结论由人工审核给出。
2. **合并到 main**：`publish` 工作流构建全部版本、签名索引，写入 `dist` 分支。已发布的版本直接复用原包；同一版本号指向不同提交会构建失败。
3. **首次发布前**要做三件事：
   - 用 `node scripts/gen-key.mjs` 生成签名密钥（私钥只写入文件，不会打印）；
   - 把私钥设为仓库 secret `FYNVRA_INDEX_SIGNING_KEY`；
   - 在仓库 Settings → Actions → General 里把 Workflow permissions 设为 **Read and write**（publish 要推送 `dist` 分支）。
4. **公钥**要内置进 Fynvra 客户端，客户端用它验证索引签名。私钥请离线备份，丢失后只能换新密钥并发布新版 Fynvra。

> 涉及 `official/` 源码的 PR 请用 merge commit 合并，不要 squash 或 rebase，否则条目锁定的提交 SHA 不会出现在 main 上，构建会失败。

撤回插件：在 `revoked.json` 中追加 `{ "id": "...", "versions": ["1.2.0"] 或 "all", "reason": "..." }`，合并后 CI 重新签名发布。

## 提交插件

PI 插件和 Fynvra 插件都接受第三方提交，审核通过后上架。写法、提交方式和审核标准见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本仓库的脚本与官方插件使用 [Apache-2.0](LICENSE)。第三方插件以各自仓库的许可证为准。
