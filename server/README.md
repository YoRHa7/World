# 解析世界 · 世界观数据库 后端

为站点 `世界观数据库.html` 提供数据存储与文件管理。

## 功能
- **树形目录**：自定义任意层级的目录 / 条目结构
- **附件**：每个条目可挂载多张图片和多份文档
- **文档格式**：Markdown (.md)、LaTeX (.tex)、Word (.docx)、纯文本 (.txt)
  - `.md` 客户端用 marked + KaTeX 渲染
  - `.tex` 客户端做轻量解析 + KaTeX 数学公式
  - `.docx` 服务端用 mammoth 转 HTML 缓存
- **权限**：读取公开 · 写入需要 `ADMIN_TOKEN`

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

写操作请在请求头中带上 `X-Admin-Token: <你的 token>`。

## 部署提示
- 反向代理（nginx / caddy）转发到 `localhost:PORT`
- 上传体积上限可在 `server.js` 的 `limits` 调整（默认 64MB / 文件）
- 长期运行建议用 `pm2` 或 `systemd` 守护
