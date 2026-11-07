# Reading Collector

> 读英文材料时把**生词 / 想法 / 事实**标出来、写注，读完整篇一键推送，落到 Obsidian，生词再进 Anki。

自己用的 Firefox 扩展，不是商业产品。设计目标是不打扰：**默认关闭**，只有点开阅读模式后才响应划词；平时页面上什么都不出现。

## 功能

- **三色标记**：🟢 生词 / 🟡 想法 / 🔵 事实
- **网页内浮层写注**：不是浏览器弹窗，就贴在选区旁边
- **点已有高亮可重开浮层**：改备注、删除
- **阅读模式开关**：popup 里一个 88px 圆，默认关闭；关闭时扩展在页面上零响应
- **一键推送**：读完整篇 → 右下角「推送 N 条」→ 下载 JSON（不常驻后台、不联网）
- **统计**：今天推送 / 近 7 天推送
- **活动热力图**：近 12 周，按天着色（悬停看当天条数）
- **最近推送**：最近 5 次，标题 + 日期 + 条数

## 数据去哪了

扩展只把数据存在**浏览器本地存储**，推送时生成一个 JSON 下载到本地：

```
~/Downloads/reading-push-YYYY-MM-DDTHH-MM-SS.json
```

再用 `tools/ingest_reading_push.py` 分流：

| 类型 | 去向 |
|---|---|
| 🟢 生词 | `english-reading/queue.tsv`（之后补音标释义进 Anki） |
| 🟡 想法 | Obsidian `clippings/ideas/YYYY-MM.md` |
| 🔵 事实 | Obsidian `clippings/facts/YYYY-MM.md` |

**零服务器、零上报。** manifest 里声明 `data_collection_permissions: none`。

## 安装

扩展走 [addons.mozilla.org](https://addons.mozilla.org) 的**自己分发（unlisted）**：

1. 打包：`cd extension && zip -r ../reading-collector-<version>.zip manifest.json background.js content.js content.css popup.html popup.js icons`
2. 上传到 AMO → 分发方式选 **On your own**（不是 Listed）
3. `Do You Need to Submit Source Code?` 选 **No**（纯手写，无构建产物）
4. 签名完成后，在版本页点 `.xpi` 文件名下载，拖进 Firefox 安装

> manifest 必须写 `browser_specific_settings.gecko.data_collection_permissions`，且 `strict_min_version ≥ 140.0`，否则 AMO 校验不通过。

## 开发

```bash
# 临时载入（改完点 Reload 即生效）
about:debugging#/runtime/this-firefox → Load Temporary Add-on → 选 manifest.json

# 发版
# 1) manifest.json 里 version +0.0.1
# 2) 重新 zip（见上）
# 3) AMO 上传同一 entry → 下载新 xpi 覆盖安装（数据保留）
```

设计规范见 [DESIGN.md](DESIGN.md)：间距只用 4 的倍数、圆角三档、字号 12/13/15、颜色全走 tokens。

## 已知限制

- 高亮按**字符偏移**恢复；页面大改版后对不上就跳过，不会错标
- Firefox Android 只能装 AMO 上架的版本，本地临时版装不上
- 推送是**手动**的：没点推送不会产生任何文件
- 选中标题这类短文本时，上下文取下一句补足

## 目录

```
extension/
  manifest.json
  content.js      选区标记、网页内浮层、推送
  background.js   下载 JSON
  popup.html/js   开关、统计、热力图、最近推送
  icons/
tools/
  ingest_reading_push.py   分流到 Obsidian / Anki 队列
DESIGN.md         设计 tokens
```

## License

MIT
