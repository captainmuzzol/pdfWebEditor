# PDF便捷编辑工具

> 面向无网环境与旧版浏览器的本地 PDF 预览与批处理工具

## 简介
- 支持本地部署，无需外部 CDN 或网络依赖。
- 以简洁直观的界面完成上传、预览、旋转、展开为单页、排序、选择、合并导出与重命名等操作。
- 会话隔离与强制下载，减少在浏览器内打开 PDF 导致的页面跳转与状态丢失。

## 功能特性
- 上传与管理
  - 拖拽上传文件夹或选择本地 PDF 文件
  - 服务器按会话隔离存储：`uploads/<sessionID>/`
  - 上传后按文件名自动排序（中文友好、数字顺序）
- 预览与编辑
  - 生成首页缩略图；单个文件可展开为“逐页”条目以便精确排序与选择
  - 每个条目支持旋转角度（90° 步进），合并时保留旋转
  - 网格支持拖拽排序；提供“全选”“反向排序”操作
- 选择与清理
  - 支持至少 1 个条目合并导出
  - “全部清空”删除当前会话所有文件
  - “选中清空”删除已勾选文件（若勾选的是展开页，会清空其对应源文件的所有页）
- 合并与下载
  - 支持整文件合并与页级精确合并
  - 合并完成弹窗可“自由重命名”（自动保留 `.pdf`）或按模板组合（模板 + 第X次 + 姓名）命名
  - 强制下载，不在浏览器内打开 PDF；仅当前会话可下载自身文件
- 兼容与离线
  - 目标兼容 2018 年 Chrome；建议使用较新 Chromium 获得更好性能
  - 内置依赖：PDF.js 与 SortableJS，存放于 `public/vendor/`

## 快速开始
- 环境：安装 Node.js（建议 v16+）
- 启动：
  ```bash
  npm start
  # 或
  node server.js
  ```
- 访问：`http://localhost:8712/`

## 无网部署
- 拷贝完整项目目录到服务器，需包含：
  - `node_modules/`
  - `public/vendor/pdfjs`（`pdf.min.js`, `pdf.worker.min.js`）
  - `public/vendor/sortable`（`Sortable.min.js`）
- 前端脚本引用位置：
  - PDF.js：`/vendor/pdfjs/pdf.min.js`
  - Worker：`/vendor/pdfjs/pdf.worker.min.js`
  - SortableJS：`/vendor/sortable/Sortable.min.js`
- Windows Server 需开放 `PORT` 入站规则

## 使用指南
- 顶部栏
  - 左侧面板两排按钮：第一排“选择文件夹”“选择PDF文件”；第二排“全选”“全部清空”“选中清空”“反向排序”；右侧为“合并导出选中条目”
  - 右侧拖拽虚线框（加大版），支持拖入文件夹或 PDF
- 网格区
  - 缩略图更大；点击可打开预览弹窗，预览自适应当前页面尺寸
  - 单文件“展开”后，列表中将出现每一页的独立条目
  - 勾选条目后即可合并导出（允许仅勾选 1 个）
- 合并与重命名
  - 合并完成后弹窗可“自由重命名”（输入不含扩展名，自动追加 `.pdf`）
  - 若自由命名为空，则可选择模板并配置“第X次”与“姓名”组合命名（当 X=0 时不拼接“第0次”）

## 配置
- 环境变量（可选）：
  - `PORT`：服务端口，默认 `8712`
  - `MAX_UPLOAD_MB`：单个 PDF 上传大小上限，默认 `200`
- 队列并发：合并队列并发为 2，避免资源耗尽

## 接口说明
- `POST /upload`
  - 接收多个 PDF 文件，保存到 `uploads/<sessionID>/`，返回会话内文件列表（已排序）
- `POST /merge`
  - 请求体可为页级组合 `pageItems` 或文件级 `fileIds`
  - 至少 1 项即可合并，返回 `downloadUrl` 与 `filename`
- `POST /clear`
  - 清空当前会话目录中的所有文件与页面列表
- `POST /clear-selected`
  - 接收 `fileIds`（原始文件名的 UUID），删除对应文件，并移除其所有页面条目
- `GET /download/:sid/:filename?name=自定义名称`
  - 强制下载合并产物，仅允许当前会话下载自身文件；支持自定义下载文件名

## 会话与安全
- 会话：`express-session` 基于 Cookie，`maxAge` 为 24 小时；会话过期不会自动清理磁盘文件
- 下载校验：仅当前会话可下载自身文件（`sid === req.sessionID`）
- 日志：`winston` 写入 `combined.log` 与 `error.log`，同时输出控制台

## 性能与限制
- 大型或多页 PDF 的缩略生成与预览需要时间；建议分批展开与合并
- “选中清空”对展开页的处理按源文件清理；勾选某一页将清空其对应整文件
- 服务器不会自动定期清理；如需按时间阈值自动清理，建议追加定时任务

## 目录结构
```text
pdfWebEditor/
├─ server.js           # 后端服务与路由
├─ views/index.ejs     # 前端页面与样式（内联）
├─ public/
│  ├─ js/app.js        # 前端交互逻辑（缩略/预览/合并/排序/清理）
│  ├─ vendor/
│  │  ├─ pdfjs/
│  │  │  ├─ pdf.min.js
│  │  │  └─ pdf.worker.min.js
│  │  └─ sortable/
│  │     └─ Sortable.min.js
│  └─ favicon.png
├─ uploads/            # 会话上传与合并产物（运行时生成）
├─ package.json
└─ README.md
```

## 内置依赖（离线）
- PDF.js：`public/vendor/pdfjs`
- SortableJS：`public/vendor/sortable`

## 运行提示
- 推荐使用较新的 Chromium 浏览器，获得更好渲染性能与稳定性
- 若端口占用，请调整 `PORT` 环境变量或释放占用端口
- 若需要限制磁盘占用，建议上线前配置定时清理策略或在 UI 中提示手动清理
