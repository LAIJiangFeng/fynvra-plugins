# Fynvra 插件注册表

这是 [Fynvra](https://github.com/LAIJiangFeng/fynvra) 插件市场的注册表仓库。Fynvra 的「设置 → 插件 → 市场」从这里读取插件列表。

- **main 分支**：注册表源数据。`plugins/<id>.json` 是插件条目，锁定源码仓库和提交 SHA；`official/` 存放官方插件源码；`scripts/` 是校验、构建、签名脚本。
- **dist 分支**：只由 CI 写入，客户端从 `https://raw.githubusercontent.com/LAIJiangFeng/fynvra-plugins/dist/` 下载：
  - `index.json` 与 `index.json.sig`（Ed25519 签名，客户端只信任签名有效的索引）
  - `packages/<id>/<version>.zip` 插件包（CI 打包，依赖已用 `--ignore-scripts` 装好，安装时不执行任何脚本）
  - `readme/<id>/<version>.md` 插件说明
  - `published.json` 已发布版本记录，保证同一版本号永远对应同一个包

插件分两类，由清单 `fynvra-plugin.json` 的 `kind` 字段区分：

- **PI 插件**（`kind: "pi"`，缺省值）：普通的 pi 扩展或 pi 包，在对话里提供工具、命令等。第三方可以提交。
- **Fynvra 插件**（`kind: "fynvra"`）：在 Fynvra 后台独立进程常驻运行，只能通过宿主 API 做事，入口由 `host.main` 指定。**目前只接受官方插件**，由维护者发布。

所有插件（包括官方插件）都要经过维护者审核才能进入市场。分级只有两档：`official`（官方，源码在本仓库 `official/` 下）和 `reviewed`（第三方，已审核）。

## 在 Fynvra 里安装插件

1. 打开 Fynvra 的「设置 → 插件 → 市场」。
2. 找到插件，查看说明和它声明的权限，点击安装。
3. Fynvra 会下载插件包，核对 sha256 后安装。插件被撤回时，Fynvra 会提示并停用它。

想自己写插件？请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 维护者指南

### 目录结构

```
plugins/<id>.json          插件条目
revoked.json               撤回列表
official/<id>/             官方插件源码
keys/index-public.pem      索引签名公钥（上线时添加）
scripts/                   validate / build / scan / publish / verify / gen-key
scripts/test/              node --test 单元测试
.github/workflows/         check.yml（PR 检查）、publish.yml（发布）
```

脚本只依赖 Node 22+ 内置模块，不需要 `npm install`。

### 首次上线

1. 在 GitHub 创建公开仓库 `LAIJiangFeng/fynvra-plugins`，把本地 main 推上去：
   ```bash
   git remote add origin https://github.com/LAIJiangFeng/fynvra-plugins.git
   git push -u origin main
   ```
2. 生成签名密钥（私钥只写入文件，不会打印）：
   ```bash
   node scripts/gen-key.mjs
   ```
3. 按提示把私钥存入 Actions secret（bash）：
   ```bash
   gh secret set FYNVRA_INDEX_SIGNING_KEY --repo LAIJiangFeng/fynvra-plugins < ~/.fynvra-signing/fynvra-index-signing-key.pem
   ```
   私钥请离线备份；丢失后只能换新密钥并发布新版 Fynvra 客户端。
4. 把公钥保存为 `keys/index-public.pem` 提交到 main；把公钥发给 Fynvra 维护者内置到客户端。
5. 在仓库 Settings → Actions 中启用 Actions，并在 Settings → Actions → General → Workflow permissions 允许 `Read and write`（publish 需要推送 dist 分支）。
6. 推送 main（或在 Actions 页手动运行 publish）后，确认 dist 分支生成了 `index.json`、`index.json.sig` 和插件包。
7. 建议给 main 开启分支保护：必须通过 `check`、需要 CODEOWNERS 审核。

> 合并方式：涉及 `official/` 源码的 PR 请用 **merge commit** 合并，不要 squash 或 rebase，否则条目里锁定的提交 SHA 不会出现在 main 上，构建会失败。

### 审核与发布流程

1. 作者提 PR（或填 Issue 表单，由维护者代为建条目）。
2. `check` 工作流：校验条目 → 构建变动的版本 → 生成扫描报告（在该次运行的 Summary 页）。扫描只作提示，结论由人工审核给出。
3. 维护者按 CONTRIBUTING 中的审核标准审核。更新版本时只需审查新旧两次提交之间的 diff。
4. 合并到 main 后，`publish` 工作流构建全部版本、生成索引并用 `FYNVRA_INDEX_SIGNING_KEY` 签名，写入 dist 分支。已发布的版本直接复用原包，不会重新打包；同一版本号若指向不同提交会构建失败。

### 撤回插件

在 `revoked.json` 中追加一项，提 PR 并合并，CI 会重新签名发布：

```json
[
  { "id": "io.github.someone.bad", "versions": ["1.2.0"], "reason": "包含未声明的网络上报" },
  { "id": "io.github.someone.worse", "versions": "all", "reason": "恶意代码" }
]
```

`reason` 不超过 200 字符。撤回不会删除 dist 中已发布的包，由客户端负责提示和停用。

### 本地演练

```bash
node --test scripts/test
node scripts/validate.mjs
node scripts/gen-key.mjs --out /tmp/fynvra-test/key.pem         # 测试密钥，用完删除
node scripts/build.mjs --all --out .build --published dist/published.json
node scripts/publish.mjs --dist dist --build .build --key /tmp/fynvra-test/key.pem
node scripts/verify.mjs --dist dist --public-key /tmp/fynvra-test/public.pem   # 公钥保存为该文件
node scripts/scan.mjs .build
```

`.build/` 和 `dist/` 已被 `.gitignore` 忽略。

## 许可证

本仓库的脚本与官方插件使用 [Apache-2.0](LICENSE)。第三方插件以各自仓库的许可证为准。
