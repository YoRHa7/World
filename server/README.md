# 鎏金枢界 · NEXUS 后端

为新站点 `index.html` → `nexus.html`（档案库 + 共鸣场论坛 + 世界脉络动画）提供数据存储；
同时兼容旧站点 `世界观数据库.html`、`关卡编辑器.html`（关卡工坊）的数据与文件管理。

> **管理密钥（ADMIN_TOKEN）默认值为 `1MIKI0`**，可用环境变量覆盖。

## NEXUS 接口
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/arc/entries?q=&category=` | – | 档案列表 + 分类计数 |
| GET | `/api/arc/entries/:id` | – | 档案详情 + 关联回响 |
| POST/PATCH/DELETE | `/api/arc/entries/:id` | ✓ | 织入 / 修订 / 抹除档案 |
| GET | `/api/forum/threads[?entry_id=]` | – | 回响串列表 |
| GET | `/api/forum/threads/:id` | – | 回响串 + 全部回帖 |
| POST | `/api/forum/threads` | – | 发起回响串（可带 entry_id） |
| POST | `/api/forum/threads/:id/posts` | – | 回帖 |
| PATCH/DELETE | `/api/forum/threads/:id` | ✓ | 置顶 / 改题 / 删除 |
| DELETE | `/api/forum/posts/:id` | ✓ | 删除单条回帖 |

首次启动会自动播种「原素 / 生息 / 魔力 / 世界平衡机制 / 一体两面之盘 / 昼夜与日月星辰」六篇档案与一条置顶欢迎帖。

---

为站点 `世界观数据库.html` 与 `关卡编辑器.html`（关卡工坊）提供数据存储与文件管理。

## 功能
- **树形目录**：自定义任意层级的目录 / 条目结构
- **附件**：每个条目可挂载多张图片和多份文档
- **文档格式**：Markdown (.md)、LaTeX (.tex)、Word (.docx)、纯文本 (.txt)
  - `.md` 客户端用 marked + KaTeX 渲染
  - `.tex` 客户端做轻量解析 + KaTeX 数学公式
  - `.docx` 服务端用 mammoth 转 HTML 缓存
- **搜索**：`/api/search` 按名称 / 简介模糊检索条目（数据库页左侧搜索框走客户端过滤，此接口供外部调用）
- **关卡工坊**：社区共创的 2D 平台游戏关卡库
  - 任何人可创建关卡，创建时返回一次性 `edit_key`（编辑器自动保存在浏览器本地）
  - 修改 / 删除需携带 `X-Edit-Key`（或管理员令牌）
- **权限**：读取公开 · 设定写入需要 `ADMIN_TOKEN` · 关卡写入凭 `edit_key`

## 启动

```bash
cd server
npm install

# 设置一个安全的管理员令牌（重要）
export ADMIN_TOKEN="你的强密码"

# 可选：自定义端口（默认 4174）
export PORT=4174

npm start
```

访问 [http://localhost:4174/世界观数据库.html](http://localhost:4174/世界观数据库.html)
或从 `index.html` 入口点进入。

> 后端默认会把项目根目录（`server/..`）作为静态文件目录提供，因此启动后通过同一个端口即可访问所有 HTML 页面与 API。

## 管理操作
1. 打开 `世界观数据库.html`，点击右上角「管理登录」
2. 输入 `ADMIN_TOKEN` → 登录成功后页面进入编辑模式
3. 左侧目录树可：新建子目录 / 新建子条目 / 重命名 / 移动 / 删除
4. 选中条目后可在右侧上传图片与文档

## 数据落地
- 元数据：`server/data.db` (SQLite, WAL 模式)
- 文件：`server/uploads/`

两者都已加入 `.gitignore`，请自行备份。

## API 速查

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/tree` | – | 获取完整树 |
| GET | `/api/nodes/:id` | – | 节点详情 + 附件列表 |
| POST | `/api/nodes` | ✓ | 创建节点 `{parent_id, name, type, description}` |
| PATCH | `/api/nodes/:id` | ✓ | 重命名 / 移动 / 改简介 |
| DELETE | `/api/nodes/:id` | ✓ | 级联删除节点 |
| POST | `/api/nodes/:id/attachments` | ✓ | 上传附件 (multipart `files`) |
| GET | `/api/attachments/:id/file` | – | 下载原文件 |
| GET | `/api/attachments/:id/content` | – | 取文本 / 已渲染 HTML |
| DELETE | `/api/attachments/:id` | ✓ | 删除附件 |
| POST | `/api/auth/check` | – | 校验令牌 `{token}` |
| GET | `/api/search?q=` | – | 按名称 / 简介检索条目（含面包屑路径） |
| GET | `/api/levels` | – | 关卡列表（仅元数据） |
| GET | `/api/levels/:id` | – | 关卡完整数据 |
| POST | `/api/levels` | – | 创建关卡，返回 `{id, edit_key}` |
| PATCH | `/api/levels/:id` | ◆ | 更新关卡 |
| DELETE | `/api/levels/:id` | ◆ | 删除关卡 |
| POST | `/api/levels/:id/play` | – | 试玩计数 +1 |

写操作请在请求头中带上 `X-Admin-Token: <你的 token>`；
关卡写操作（◆）带上创建时获得的 `X-Edit-Key`（管理员令牌亦可）。

## 部署提示
- 反向代理（nginx / caddy）转发到 `localhost:PORT`
- 上传体积上限可在 `server.js` 的 `limits` 调整（默认 64MB / 文件）
- 长期运行建议用 `pm2` 或 `systemd` 守护
