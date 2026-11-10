# Magpie v0.1.3336 已安装列表补丁

为额度通知插件精简 Magpie 的“已安装”列表：隐藏两行通用说明及“选项”文本框入口，保留图标、名称、版本、停用、移除与侧栏设置入口。其他插件和加载失败、停用状态的提示保持原样。

插件图标由插件自身提供。此补丁用于调整 Magpie 宿主界面，需要应用到宿主源码并重新构建。

## 构建

使用 Magpie **v0.1.3336** 源码和 Go **1.26.8 或更新版本**。在该源码根目录执行：

```sh
git apply /path/to/quota-row.patch
```

Linux x86-64 / NAS 构建示例：

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nogui -trimpath \
  -ldflags '-s -w -X main.version=v0.1.3336+quota-ui.1' -o magpie .
```

其他架构调整 `GOARCH`。部署前备份现有程序及 Magpie 配置目录，使用新程序验证页面后再切换。宿主升级时，需要为对应版本重新核对补丁。

## 来源

补丁针对 [Magpie v0.1.3336](https://github.com/yetone/magpie/tree/v0.1.3336) 的 `internal/gui/assets/plugins.js`，保留原注释；构建方式参考[官方 Dockerfile](https://github.com/yetone/magpie/blob/v0.1.3336/Dockerfile)。Magpie 使用 [MIT License](https://github.com/yetone/magpie/blob/v0.1.3336/LICENSE)。
