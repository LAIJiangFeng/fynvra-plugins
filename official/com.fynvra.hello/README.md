# Hello Fynvra

Fynvra 官方示例插件。

## 功能

注册一个工具 `hello_fynvra`：

- 参数：`name`（可选），要问候的名字。
- 返回：问候语和当前时间。

安装后在对话里让模型「用 hello_fynvra 跟我打个招呼」即可看到效果。

## 权限

不需要任何权限：不访问网络、不读写文件、不执行命令、不读取环境变量。

## 作为插件模板

这是一个最小的 pi 包：

```
fynvra-plugin.json     # Fynvra 插件清单（id、版本、权限）
package.json           # pi.extensions 指向扩展入口
extensions/hello.ts    # 扩展代码
README.md
```

写自己的插件时可以复制这个目录，改掉 id、名称和代码。
