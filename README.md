# 知识点汇总 · Document Agent

一个在 Windows 本地运行的多模型文档整理工具。上传课程 PPTX、PDF、DOCX、Markdown 或纯文本资料，自动按章节提取知识点，生成以内容主题命名的 Markdown 文档。

## 工作流程

1. **文档解析**：PPTX 按幻灯片提取标题、正文和表格文字；DOCX 按标题段落、正文及表格提取；PDF 按页提取可选中的文字层。每段文字保留来源位置。
2. **Codex 规划**：根据资料标题和页码建立章节结构。
3. **DeepSeek 提取**：分块识别概念、定义、原理、流程、公式和复习问题，返回带来源位置的结构化知识点。
4. **Codex 成品编辑**：根据 DeepSeek 的结构化结果合并重复章节与知识点、核对来源并撰写完整 Markdown，包含分章内容、复习自测和资料说明。
5. **交付与重排**：验证标题、章节、来源和篇幅后生成带下载链接的文件。已完成任务可点击“重新排版”，复用已缓存的 DeepSeek 提取结果生成新版本。

三个 Agent 阶段共用项目内的 [document-knowledge Skill](skills/document-knowledge/SKILL.md)。Skill 将章节规划、知识点提取和最终编辑的规则集中管理；修改后重启服务即可生效。它要求保留原文章节编号、为知识点附来源并合并重复内容。

## 使用

要求 Windows 10/11、Node.js 24+、已登录的 [Codex CLI](https://github.com/openai/codex)，以及 [DeepSeek API key](https://api-docs.deepseek.com/)。

安装依赖：pnpm install（或 npm install）。启动：node src/server.mjs。浏览器打开 http://127.0.0.1:4173，在设置中保存 API key，选择输出目录，上传 1–10 份资料。单文件上限 25 MB；可提取文字总量上限 24 万字。输出文件按内容命名，例如「第6章-自底向上LR语法分析方法-知识点汇总.md」；同名时使用「（2）」「（3）」等序号，不覆盖已有文件。

DeepSeek API key 保存在当前 Windows 用户凭据管理器，也可通过 DEEPSEEK_API_KEY 环境变量提供。任务记录位于 .data/harness.sqlite，上传资料位于 .data/uploads/；这些数据不会进入 Git。服务只监听 127.0.0.1。

本地服务未设置登录认证，仅供当前电脑使用；不要通过端口转发或反向代理公开。服务会校验本机 Host 与跨站写入请求，Office 文档解压后的 XML 也有体积限制。

## 支持范围

| 格式 | 提取方式 | 限制 |
| --- | --- | --- |
| PPTX | 幻灯片标题、正文、表格文字 | 图片中的文字、复杂图表不识别 |
| PDF | 逐页读取文字层 | 扫描版需先 OCR；单文件最多 300 页 |
| DOCX | 标题段落、正文、表格文字 | 图片和复杂版式不识别 |
| MD / TXT | UTF-8 文本 | 保留原文文本 |

旧式 .ppt / .doc 请先另存为 .pptx / .docx。程序不会编造缺失的知识点；来源不明确或图片内容未读时，应检查原文。

运行测试：node --test。

## 项目说明

产品思路参考 [Fei2411/DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot)，没有直接复制其源代码。项目使用 [MIT License](LICENSE)。
