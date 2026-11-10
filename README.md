# Magpie 额度通知

Magpie 的 Bun 插件，提供额度不足、耗尽、恢复、重置前提醒，以及 MeoW、Bark 和 Webhook 推送。内置可视化设置页，保存后直接应用，无需手动编辑 JSON。

插件只查询额度接口，不发送模型提示词、不执行自动点灯或重置卡操作。

## 功能

- 最多三档剩余额度阈值，可一键选择 50 / 20 / 10% 或仅 10%。
- 按 5 小时和 7 天窗口分别设置恢复通知、重置前提醒及提前时间。
- Codex Plus 通知同时展示 5 小时和周额度；Pro 类套餐（含 `prolite`）展示周额度。
- 通知以 emoji 标注账号、套餐、额度、重置时间和读数时间；未知额度显示“暂无读数”。
- 多账号、多窗口独立判断，通知去重、限速和重试状态跨重启保留。
- 支持 MeoW、Bark 和通用 JSON Webhook，可同时配置多个渠道。
- 可选转发 Did Codex Reset 的外部预告和完成记录。

## 兼容与验证范围

- 页面面向 **Magpie 网页版**，包括 Docker / NAS 部署。桌面版直接打开时会提示使用网页版。
- 基础版本 v0.3.0 已在 Magpie v0.1.3336、Linux Bun 1.4.4 环境验证真实页面、设置保存和 MeoW 接收。
- v0.3.1 的通知格式变更使用 Node 24、Bun 1.4.4 和模拟接口验证；不将这些结果当作新版 NAS 实测结果。
- 已声明的 Bun 版本要求见 `package.json`，当前实际验证的 Bun 版本为 1.4.4。

## 安装

### 从 GitHub 安装

仓库公开后，在 Magpie 的“插件 → 添加插件”中填写：

```text
github:real-LEONEAST/magpie-quota-notify
```

仓库地址：https://github.com/real-LEONEAST/magpie-quota-notify 。也可以在运行 Magpie 的环境执行：

```sh
magpie plugin add github:real-LEONEAST/magpie-quota-notify
```

维护者创建版本标签后，可安装该标签，例如：

```sh
magpie plugin add github:real-LEONEAST/magpie-quota-notify#v0.3.1
```

安装完成后，从 Magpie 网页版左侧打开 **额度通知设置**。

### 从文件夹安装

将整个插件文件夹放到 Magpie 可读取的位置，然后执行：

```sh
magpie plugin add /path/to/magpie-quota-notify
```

Docker 示例，在宿主机执行：

```sh
docker cp ./magpie-quota-notify magpie:/config/
docker exec magpie /magpie plugin add /config/magpie-quota-notify
```

`magpie` 是示例容器名，请替换为实际名称。首次安装或升级后，如页面尚未出现，重新加载插件；日常保存设置不需要重新加载。

## 首次配置

1. 打开 **额度通知设置**，点击“＋ MeoW”“＋ Bark”或“＋ Webhook”。
2. MeoW 填写手机端昵称；Bark 填写设备 Key；Webhook 填写接收地址。分类、分组、服务地址和请求头在“更多渠道设置”中。
3. 选择“主动刷新”或“使用缓存”。如果 Magpie 的额度缓存长时间不变，选择主动刷新；它仅查询额度接口。
4. 按需要选择阈值预设、检查间隔和通知规则，然后点击“保存并应用”。
5. 点击一次“测试推送”，在手机端确认是否收到。页面的“服务已接收”表示推送服务接受了请求。

新安装未配置渠道时不会发送通知。旧版本的阈值和通知开关会保留；不会因为升级自动开启新提醒或外部转发。

## 提醒规则

| 设置 | 选项与行为 |
| --- | --- |
| 检查间隔 | 1 / 5 / 10 / 30 分钟，或自定义 1～60 分钟 |
| 提醒阈值 | 1～3 档剩余百分比，从大到小排列；每档每周期一次。一次检查跨多档时合并为最紧急的一档，耗尽优先 |
| 恢复通知 | 关闭 / 每次 / 用完后；5 小时和 7 天分别设置 |
| 重置前提醒 | 关闭 / 每次 / 有余量 / 用完后；每周期一次 |
| 提前多久 | 5 小时窗口：30 分钟 / 1 小时 / 2 小时；7 天窗口：6 小时 / 12 小时 / 1 天 |

“每次恢复”要求确认新周期且上一周期有使用；“用完后”在耗尽后读到有效剩余额度时通知，也保留周期内恢复的判断。

重置前“有余量”仅在剩余高于最后一档时提醒，“用完后”仅在耗尽时提醒预计即将恢复。提醒按检查间隔触发，不承诺精确到秒。无法确认周期类型的窗口保留原有耗尽后恢复通知，不猜测重置周期。

有效读数要求和时区在“更多设置”中。失效、回退、未刷新或时间倒退的读数不会用来确认恢复。

## 通知示例

以下账号和读数均为演示数据。

### Plus 账号

```text
⏳ Codex Plus · 7 days 即将重置

👤 账号：demo-plus@example.com
💳 套餐：Plus
⏱️ 5 小时额度：剩余 100% · 已用 0%
🔄 预计重置：11/11 01:30（北京时间）
📅 周额度：剩余 86% · 已用 14%
🔄 预计重置：11/11 14:40（北京时间）
🕒 读数：11/10 22:15（北京时间）
```

### Pro 类账号

```text
⏳ Codex Pro Lite · 7 days 即将重置

👤 账号：demo-pro@example.com
💳 套餐：Pro Lite
📅 周额度：剩余 78% · 已用 22%
🔄 预计重置：11/11 14:40（北京时间）
🕒 读数：11/10 22:15（北京时间）
```

套餐取自 Magpie 额度接口的 `plan` 字段。缺失的额度不填成 0% 或 100%。旧版排队消息如果没有套餐快照，继续显示原来的触发窗口。

## 外部重置消息

“启用转发”默认关闭。开启后通过 [Did Codex Reset 公共 API](https://didcodexreset.com/api.html) 查询，不需要 API Key，也不发送账号或 Magpie 网关密钥。

- 默认每 5 分钟检查，单次最多读取三页，并遵守 `Retry-After`。
- 首次开启可选择推送当前尚未到期的预告；已有完成历史只建立基线。
- 根据稳定的 `signalId` 去重，时间、范围或置信度变化时作为更新推送。
- 只有日期的排期显示为时段，不虚构精确时刻；过期、已履行或未知时间的排期不会作为当前预告。
- 外部消息单独标明第三方来源，不代表本机账号已经恢复。账号恢复仍由有效额度读数确认。
- 关闭转发会取消尚未发送的外部消息。接口失败不影响账号额度监控。

## 数据保存与隐私

插件将运行数据保存在 Magpie 配置目录，而不是源码目录：

| 文件 | 内容 |
| --- | --- |
| `quota-notify-settings.sqlite` | 页面设置、渠道配置、测试请求和详细发送回执 |
| `quota-notify-state.json` | 账号额度快照、窗口状态、待发送消息、去重和限速记录 |
| `quota-notify-lock.sqlite` | 多宿主互斥，不保存额度内容 |

这些运行文件可能包含账号邮箱、MeoW 昵称、推送密钥、Webhook 地址和通知内容，不应上传到公开仓库。设置数据库保存实际渠道值，页面将密钥留空显示；页面遮盖不等于数据库加密。

源码与测试只使用示例账号和模拟服务。仓库的 `.gitignore` 排除常见运行数据和部署文件，发布包另使用 `files` 白名单。不要将真实部署截图、凭据辅助脚本或 NAS 备份加入仓库。

页面服务仅监听运行环境中的 `127.0.0.1:3479`，通过 Magpie 的页面代理访问，无需新增 Docker 端口映射。自定义端口使用原插件 Options 的 `uiPort`，修改后需要重新加载插件。

## 升级与备份

升级前备份插件源码、原 Options 及上述运行文件。数据库有 `-wal`、`-shm` 等事务文件时一并保留，使用一致的数据库备份或短暂停止 Magpie 后复制。

首次迁移旧版时从插件原 Options 导入；之后以设置数据库为准。原 `plugins.json` 不由本插件改写。更换安装来源时也要迁移原 Options，避免丢失尚未导入的设置；同一插件不要同时启用多个安装来源。

恢复旧版时同时恢复相应配置与状态备份。插件不会主动删除这些文件。

## 开发测试

无需额外 npm 依赖：

```sh
node --test tests/*.test.mjs
bun test tests/
```

测试使用模拟的额度和推送接口，不会发送真实通知。入口只导出一个初始化函数，辅助函数位于独立模块。

## 发布到 GitHub

1. 将本目录中的文件放在仓库根目录，确保根目录直接包含 `package.json`、`index.mjs` 和 `page/`。不要只上传 ZIP。
2. 将仓库设为公开，在 Topics 中添加 `magpie-plugin`。
3. 创建版本标签和 Release 后，再使用对应标签固定安装版本。
4. 在独立 Magpie 测试环境验证 GitHub 安装与页面入口，再推荐给其他用户。

Magpie 支持 Git 仓库安装；带 `magpie-plugin` 主题的合格仓库可出现在“发现 → 非官方 GitHub 插件”中，不代表官方审核。[官方插件文档](https://usemagpie.ai/docs/plugins)

## 参考与许可

- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)
- [MeoW API](https://www.chuckfang.com/MeoW/api_doc.html)
- [Bark API](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)
- [Did Codex Reset API](https://didcodexreset.com/api.html)
- [Lamplighter](https://github.com/PosvdM/cpa-plugin-lamplighter)：通知选项交互参考。

MIT，见 [LICENSE](LICENSE)。