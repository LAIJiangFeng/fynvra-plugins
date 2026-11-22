## 插件信息

- 插件 id：
- 本次变更：<!-- 新插件 / 新版本 x.y.z / 撤回 / 其他 -->
- 源码仓库与提交：<!-- https://github.com/... @ 40 位 SHA -->
- 与上一版本的对比链接（更新时必填）：<!-- https://github.com/<owner>/<repo>/compare/<旧SHA>...<新SHA> -->

## 声明的权限及理由

<!-- 例如：network —— 调用 xxx API；没有权限写「无」 -->

## 检查清单

- [ ] 已在 Fynvra 中试用过这个版本（PI 插件用「添加本地插件」；Fynvra 插件用开发版的「添加本地 Fynvra 插件（开发）」）
- [ ] Fynvra 插件：README 写明了会访问的网络地址及原因，没有后台定时上报，卸载后不留常驻进程
- [ ] `fynvra-plugin.json` 的 id、version 与条目一致
- [ ] 权限声明如实，没有用到未声明的能力
- [ ] 插件不收集、不外传用户数据（或已在说明中写清用途并取得用户同意）
- [ ] 代码没有混淆、压缩或动态下载执行的代码
- [ ] 许可证明确，仓库中有 LICENSE 文件
- [ ] 本地 `node scripts/validate.mjs` 通过
