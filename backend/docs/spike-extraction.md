# 文本提取 Spike 结论（M1/M2）

对照 PLAN.md 2.4「PDF 使用 PDF.js 提取文本，DOCX 使用 Mammoth 提取段落；首先在 Workers 运行环境验证兼容性和资源占用」执行，结果如下。

## 环境

- 本地：esbuild 打包 → Miniflare（真实 workerd 1.20251011，`nodejs_compat`，本地 D1/R2），vitest 驱动（`test/documents.test.ts`）。
- 真实 Cloudflare 环境：待账号到位后复测（见「待办」）。

## 结论

| 项 | 结论 | 说明 |
|---|---|---|
| PDF（unpdf，即 PDF.js serverless 发行版） | ✅ 可用 | 打包进 Workers bundle 正常；最小 PDF 夹具提取文本通过（`engine: "unpdf(pdf.js)"`）；页数上限 30、无文本层扫描件均明确报错 |
| DOCX（mammoth） | ❌ 不可用 | mammoth 在 **import 期**即依赖 Node 内建模块（`fs`/`os`/`path`/`url` 等），esbuild 打包进 Workers bundle 直接失败，属于导入级不兼容，无法通过 polyfill 缓解 |
| DOCX（fflate + OOXML 解析，PLAN.md 预案） | ✅ 可用 | 纯 JS 解压 `word/document.xml` 并抽取 `<w:t>` 节点；中文段落提取验证通过 |
| 文件限制 | ✅ 已实现 | 上传门槛：MIME 白名单 + 10MB；PDF 页数 ≤30；扫描件/加密/无文本层 → 422 明确报错并提示手动录入 |

采用实现：`src/infra/extract/pdf.ts`（unpdf）+ `src/infra/extract/docx.ts`（fflate+OOXML），`mammoth` 依赖已移除。

## 资源占用（真实环境待测）

本地无法精确测量 workerd 的 CPU 微秒数；真实环境验证项：

1. 30 页 PDF 在免费档单请求 CPU 限制（约 10ms）内是否超限；若超限，启用预案：按页拆 Workflow 步骤。
2. DOCX 大文件解压内存占用。

## 待办（账号到位后）

- [ ] 在真实 Cloudflare 环境运行 `test:workers` 与部署后冒烟，回填本文件（R1/R5 风险核销）。
