# CueCarry

把旧字幕中的人工校对迁移到新剪辑的字幕上，保留新字幕的时间轴。

**English:** Carry human text corrections from an original SRT and its corrected version into a new SRT. Review uncertain matches before export. Runs locally in your browser, with no build step, API, uploads, or runtime dependencies.

## 适合什么场景

你已经校对过一遍自动字幕，重新剪辑或识别后，又得到了一份编号、时间和内容都有变化的字幕。CueCarry 比较三份文件：

| 输入 | 含义 | 用途 |
| --- | --- | --- |
| A | 原始识别字幕 | 找到原文 |
| B | 在 A 上完成的人工校对 | 提取 A → B 的文字修改 |
| C | 新剪辑或重新识别的字幕 | 作为输出的编号、时间轴和顺序 |

例如，A 中的“语音是别”在 B 中改成“语音识别”。C 中这句的时间已经后移，只要能唯一匹配，CueCarry 就把校对后的整条文字放到 C 的位置。C 中新增的片头和未修改的文字照常保留。

## 开始使用

1. 下载并解压整个仓库，或克隆仓库。
2. 用现代桌面浏览器直接打开根目录的 `index.html`。无需安装 Node.js 或启动服务器，断网也能使用。
3. 为 A、B、C 选择 UTF-8 `.srt` 文件，或直接粘贴内容。也可以先载入内置示例。
4. 生成迁移方案，逐条检查文字修改。对不确定的条目，选择保留 C，或明确指定 C 中的目标字幕并应用。
5. 处理所有待确认条目后，下载 SRT 和 JSON 审核记录。重置可清空当前工作。

文件处理在当前浏览器页面内完成；应用没有后端、API 调用、上传、CDN 或分析脚本。刷新或关闭页面会丢失尚未导出的工作。下载的审核记录含字幕原文和决策，分享前请自行检查内容。

## 匹配与复核

| 状态 | 含义 | 默认行为 |
| --- | --- | --- |
| `ready` | 原文在 A 和 C 中均能唯一定位；允许忽略空白差异 | 应用 B 的整条文字，也可选择保留 C |
| `already-applied` | 有充分的唯一性条件表明 C 已包含校对后的文字 | 保留 C |
| `conflict` | 重复短句、多个目标，或原文与改后文字同时存在 | 必须人工决定 |
| `not-found` | 找不到可靠的精确匹配 | 必须人工决定；相似候选仅供参考 |

重复句即使在 C 中只剩一处，也不能证明它就是当初被修改的那一处。相似度不会触发自动应用；“未找到”也不等于确定已删除。手动应用会替换所选目标的**整条文字**，请检查是否覆盖了 C 中新增的信息。两个修改不能同时写入同一个目标。

输出保持 C 的字幕数量、编号、顺序和时间行；仅替换确认应用的文字。B 的时间轴不会覆盖 C。输入的 BOM 和换行会被规范化，输出不是源文件的逐字节副本。

## 示例

`examples/` 中的三份短字幕均为本项目创作的合成素材：

- [`A-original.srt`](examples/A-original.srt)：原始识别，包含重复短句。
- [`B-corrected.srt`](examples/B-corrected.srt)：5 处文字修改，结构与 A 相同。
- [`C-new-timeline.srt`](examples/C-new-timeline.srt)：新增片头、时间后移，一处重复句消失，一句改写，一句缺失，一句已校对。

示例预期产生 1 条可直接迁移、1 条重复句冲突、2 条未找到（其中一条有相似候选）、1 条已存在修改。选择保留所有待确认项后，只有唯一匹配的“语音识别”修正会写入新字幕。

## 当前边界

- **A 和 B 必须保留相同的字幕数量、编号、顺序、起止时间。** 在 B 中切分、合并、增删或重新计时会被拒绝；请提供只改文字的校对版本。
- C 可以增删或重排字幕，但本版本不推断切分/合并关系，也不自动找回缺失句子。
- 仅支持 SRT；需有数字编号、有效的 `HH:MM:SS,mmm --> HH:MM:SS,mmm` 时间行、正时长及非空文字。拒绝重复编号和格式错误；小时可超过 99。
- 整条字幕匹配不理解语义、说话人或画面。即使唯一匹配，也值得复核；本工具不保证语义正确性。
- 不做语音识别、翻译、自动校时、视频剪辑或模糊匹配自动应用。
- 浏览器显示字幕标签为普通文字，不执行字幕中的 HTML 或脚本。导出的字幕保留原有文字内容。

## 相关工具

如果任务是按时间码比较、组合两份已同步的字幕，可以看看 [srt-merger](https://github.com/machinewrapped/srt-merger)。如果需要跨语言的语义对齐和双语字幕合并，可以看看 [DuoSubs](https://github.com/CK-Explorer/DuoSubs)。CueCarry 聚焦 A → B 校对在 C 上的迁移；这些工具解决的流程有所不同。

## 开发与验证

应用使用原生 HTML、CSS、JavaScript。`src/core.js` 通过浏览器全局 `CueCarry` 和 Node.js CommonJS 导出同一套函数：`parseSrt`、`serializeSrt`、`buildPlan`、`applyDecisions`。

安装 Node.js 20 或 22 后，在仓库目录运行：

```sh
node --test
```

无需 `npm install`。黑盒测试覆盖解析错误、BOM/CRLF、长时长、唯一匹配、重复文本、相似候选、人工决策、冲突目标、输入不变性，以及 C 的时间轴与编号保持不变。HTML 字符串测试检查核心层的文字保留；浏览器界面仍需人工验证展示与下载流程。

GitHub Actions 在 Windows 和 Ubuntu 上使用 Node.js 20、22 执行相同测试。

手动检查：直接打开 `index.html`，载入示例；确认待复核项目未处理时无法导出；选择保留或目标后下载两种结果；检查 SRT 的编号和时间行与 C 一致。也可粘贴含 `<script>` 或 `<img onerror=...>` 的字幕，确认只显示文字。

欢迎提交可复现的问题与改进。提交示例时请使用合成字幕或你有权公开的内容。

## 许可

[MIT](LICENSE) · Copyright 2026 CueCarry contributors
