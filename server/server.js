const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 4174;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '1MIKI0';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// ── Static viewer (so you can just open http://localhost:4174/) ──
const PUBLIC_DIR = path.resolve(__dirname, '..');
app.use(express.static(PUBLIC_DIR));

// ── Auth middleware (write ops only) ──
function requireAuth(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ── Multer storage ──
const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
        const ext = path.extname(file.originalname);
        const hash = crypto.randomBytes(8).toString('hex');
        cb(null, `${Date.now()}-${hash}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 64 * 1024 * 1024 }, // 64MB per file
});

// ── Helpers ──
function detectKind(file) {
    const mt = (file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname).toLowerCase();
    if (mt.startsWith('image/')) return 'image';
    if (ext === '.md' || ext === '.markdown') return 'markdown';
    if (ext === '.tex' || ext === '.latex') return 'latex';
    if (ext === '.docx' || ext === '.doc' ||
        mt.includes('officedocument.wordprocessingml')) return 'word';
    return 'text';
}

function nowMs() { return Date.now(); }

function buildTree() {
    const rows = db.prepare(`
        SELECT id, parent_id, name, type, description, sort_order, created_at, updated_at
        FROM nodes
        ORDER BY sort_order ASC, id ASC
    `).all();
    const byId = new Map();
    rows.forEach(r => byId.set(r.id, { ...r, children: [] }));
    const roots = [];
    rows.forEach(r => {
        const node = byId.get(r.id);
        if (r.parent_id && byId.has(r.parent_id)) {
            byId.get(r.parent_id).children.push(node);
        } else {
            roots.push(node);
        }
    });
    return roots;
}

function descendantIds(rootId) {
    const out = new Set([rootId]);
    const stack = [rootId];
    const stmt = db.prepare('SELECT id FROM nodes WHERE parent_id = ?');
    while (stack.length) {
        const id = stack.pop();
        for (const row of stmt.all(id)) {
            if (!out.has(row.id)) { out.add(row.id); stack.push(row.id); }
        }
    }
    return [...out];
}

// ═══════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════

// Quick health
app.get('/api/health', (_, res) => res.json({ ok: true, time: nowMs() }));

// Does the provided token unlock admin?
app.post('/api/auth/check', (req, res) => {
    const token = req.body && req.body.token;
    res.json({ ok: token === ADMIN_TOKEN });
});

// Full tree
app.get('/api/tree', (_, res) => res.json({ tree: buildTree() }));

// Node detail (with attachments)
app.get('/api/nodes/:id', (req, res) => {
    const id = Number(req.params.id);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (!node) return res.status(404).json({ error: 'Not found' });
    const attachments = db.prepare(`
        SELECT id, kind, filename, original_name, mime_type, size_bytes, sort_order, created_at
        FROM attachments WHERE node_id = ?
        ORDER BY sort_order ASC, id ASC
    `).all(id);
    res.json({ node, attachments });
});

// Create node (folder or entry)
app.post('/api/nodes', requireAuth, (req, res) => {
    const { parent_id = null, name, type, description = '' } = req.body || {};
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    if (!['folder', 'entry'].includes(type)) return res.status(400).json({ error: 'bad type' });
    if (parent_id !== null) {
        const parent = db.prepare('SELECT type FROM nodes WHERE id = ?').get(parent_id);
        if (!parent) return res.status(400).json({ error: 'parent not found' });
        if (parent.type !== 'folder') return res.status(400).json({ error: 'parent must be folder' });
    }
    const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(sort_order),-1) AS m FROM nodes WHERE parent_id IS ?'
    ).get(parent_id).m;
    const now = nowMs();
    const info = db.prepare(`
        INSERT INTO nodes (parent_id, name, type, description, sort_order, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)
    `).run(parent_id, name.trim(), type, description, maxOrder + 1, now, now);
    res.json({ id: info.lastInsertRowid });
});

// Update node (rename, edit description, move)
app.patch('/api/nodes/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (!node) return res.status(404).json({ error: 'Not found' });
    const { name, description, parent_id, sort_order } = req.body || {};
    if (parent_id !== undefined && parent_id !== null) {
        if (descendantIds(id).includes(parent_id)) {
            return res.status(400).json({ error: 'cannot move into own subtree' });
        }
        const parent = db.prepare('SELECT type FROM nodes WHERE id = ?').get(parent_id);
        if (!parent) return res.status(400).json({ error: 'parent not found' });
        if (parent.type !== 'folder') return res.status(400).json({ error: 'parent must be folder' });
    }
    db.prepare(`
        UPDATE nodes SET
            name        = COALESCE(?, name),
            description = COALESCE(?, description),
            parent_id   = ?,
            sort_order  = COALESCE(?, sort_order),
            updated_at  = ?
        WHERE id = ?
    `).run(
        name ?? null,
        description ?? null,
        parent_id === undefined ? node.parent_id : parent_id,
        sort_order ?? null,
        nowMs(),
        id
    );
    res.json({ ok: true });
});

// Delete node (cascades children & attachments; cleans up files)
app.delete('/api/nodes/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id)) {
        return res.status(404).json({ error: 'Not found' });
    }
    const ids = descendantIds(id);
    const placeholders = ids.map(() => '?').join(',');
    const files = db.prepare(
        `SELECT filename FROM attachments WHERE node_id IN (${placeholders})`
    ).all(...ids);
    db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
    for (const f of files) {
        const p = path.join(UPLOAD_DIR, f.filename);
        fs.promises.unlink(p).catch(() => {});
    }
    res.json({ ok: true });
});

// Upload attachment(s) to a node
app.post('/api/nodes/:id/attachments', requireAuth, upload.array('files', 20), async (req, res) => {
    const nodeId = Number(req.params.id);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Not found' });
    if (node.type !== 'entry') return res.status(400).json({ error: 'attachments only on entry nodes' });

    const created = [];
    const insert = db.prepare(`
        INSERT INTO attachments
        (node_id, kind, filename, original_name, mime_type, size_bytes, rendered_html, sort_order, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(sort_order),-1) AS m FROM attachments WHERE node_id = ?'
    ).get(nodeId).m;
    let order = maxOrder + 1;

    for (const f of (req.files || [])) {
        const kind = detectKind(f);
        let rendered = null;
        if (kind === 'word') {
            try {
                const r = await mammoth.convertToHtml({ path: f.path });
                rendered = r.value;
            } catch (e) {
                rendered = `<p style="color:#ff6666">Word 解析失败: ${e.message}</p>`;
            }
        }
        const info = insert.run(
            nodeId, kind, f.filename, f.originalname,
            f.mimetype || '', f.size || 0, rendered, order++, nowMs()
        );
        created.push({ id: info.lastInsertRowid, kind, original_name: f.originalname });
    }
    db.prepare('UPDATE nodes SET updated_at = ? WHERE id = ?').run(nowMs(), nodeId);
    res.json({ created });
});

// Delete attachment
app.delete('/api/attachments/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT filename FROM attachments WHERE id = ?').get(id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    fs.promises.unlink(path.join(UPLOAD_DIR, a.filename)).catch(() => {});
    res.json({ ok: true });
});

// Serve raw attachment file
app.get('/api/attachments/:id/file', (req, res) => {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT filename, original_name, mime_type FROM attachments WHERE id = ?').get(id);
    if (!a) return res.status(404).end();
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.sendFile(path.join(UPLOAD_DIR, a.filename));
});

// Get rendered/text content for an attachment (md/tex/word/text)
app.get('/api/attachments/:id/content', (req, res) => {
    const id = Number(req.params.id);
    const a = db.prepare(`
        SELECT kind, filename, original_name, rendered_html
        FROM attachments WHERE id = ?
    `).get(id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.kind === 'word') return res.json({ kind: a.kind, html: a.rendered_html || '' });
    const p = path.join(UPLOAD_DIR, a.filename);
    try {
        const text = fs.readFileSync(p, 'utf8');
        res.json({ kind: a.kind, text });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  SEARCH — full-text-ish lookup over node names & descriptions
// ═══════════════════════════════════════════════════════════════════
app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const like = `%${q.replace(/[%_]/g, c => '\\' + c)}%`;
    const rows = db.prepare(`
        SELECT id, parent_id, name, type, description
        FROM nodes
        WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
        ORDER BY name ASC LIMIT 80
    `).all(like, like);
    // Build breadcrumb trail names for each hit
    const nameStmt = db.prepare('SELECT parent_id, name FROM nodes WHERE id = ?');
    const results = rows.map(r => {
        const trail = [];
        let pid = r.parent_id;
        let guard = 0;
        while (pid && guard++ < 32) {
            const p = nameStmt.get(pid);
            if (!p) break;
            trail.unshift(p.name);
            pid = p.parent_id;
        }
        return { id: r.id, name: r.name, type: r.type, description: r.description, trail };
    });
    res.json({ results });
});

// ═══════════════════════════════════════════════════════════════════
//  LEVELS — community 2D platformer levels (关卡工坊)
//  · read: public
//  · create: public (returns one-time edit_key)
//  · update / delete: requires the level's edit_key or admin token
// ═══════════════════════════════════════════════════════════════════
const MAX_LEVEL_DATA = 512 * 1024; // 512KB of JSON per level

function validateLevelPayload(body, { partial = false } = {}) {
    const out = {};
    if (!partial || body.name !== undefined) {
        const name = String(body.name || '').trim();
        if (!name || name.length > 60) return { error: 'name 必填，且不超过 60 字' };
        out.name = name;
    }
    if (body.author !== undefined) out.author = String(body.author).slice(0, 40);
    if (body.description !== undefined) out.description = String(body.description).slice(0, 500);
    if (!partial || body.data !== undefined) {
        const data = typeof body.data === 'string' ? body.data : JSON.stringify(body.data || null);
        if (!data || data === 'null') return { error: 'data 必填' };
        if (data.length > MAX_LEVEL_DATA) return { error: '关卡数据过大' };
        try { JSON.parse(data); } catch { return { error: 'data 必须是合法 JSON' }; }
        out.data = data;
    }
    for (const k of ['width', 'height']) {
        if (body[k] !== undefined) {
            const v = Number(body[k]);
            if (!Number.isInteger(v) || v < 8 || v > 400) return { error: `${k} 非法` };
            out[k] = v;
        }
    }
    return { out };
}

function canEditLevel(req, level) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token === ADMIN_TOKEN) return true;
    const key = req.headers['x-edit-key'] || req.query.edit_key;
    return !!key && key === level.edit_key;
}

// List levels (metadata only)
app.get('/api/levels', (_, res) => {
    const rows = db.prepare(`
        SELECT id, name, author, description, width, height, plays, created_at, updated_at
        FROM levels ORDER BY updated_at DESC LIMIT 200
    `).all();
    res.json({ levels: rows });
});

// Get one level (full data, never the edit_key)
app.get('/api/levels/:id', (req, res) => {
    const row = db.prepare(`
        SELECT id, name, author, description, data, width, height, plays, created_at, updated_at
        FROM levels WHERE id = ?
    `).get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ level: row });
});

// Create level — public; responds with a one-time edit_key
app.post('/api/levels', (req, res) => {
    const { error, out } = validateLevelPayload(req.body || {});
    if (error) return res.status(400).json({ error });
    const editKey = crypto.randomBytes(16).toString('hex');
    const now = nowMs();
    const info = db.prepare(`
        INSERT INTO levels (name, author, description, data, width, height, plays, edit_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,0,?,?,?)
    `).run(
        out.name, out.author || '', out.description || '', out.data,
        out.width || 60, out.height || 20, editKey, now, now
    );
    res.json({ id: info.lastInsertRowid, edit_key: editKey });
});

// Update level — edit_key or admin
app.patch('/api/levels/:id', (req, res) => {
    const id = Number(req.params.id);
    const level = db.prepare('SELECT * FROM levels WHERE id = ?').get(id);
    if (!level) return res.status(404).json({ error: 'Not found' });
    if (!canEditLevel(req, level)) return res.status(401).json({ error: '无编辑权限（缺少 edit_key）' });
    const { error, out } = validateLevelPayload(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    db.prepare(`
        UPDATE levels SET
            name        = COALESCE(?, name),
            author      = COALESCE(?, author),
            description = COALESCE(?, description),
            data        = COALESCE(?, data),
            width       = COALESCE(?, width),
            height      = COALESCE(?, height),
            updated_at  = ?
        WHERE id = ?
    `).run(
        out.name ?? null, out.author ?? null, out.description ?? null,
        out.data ?? null, out.width ?? null, out.height ?? null, nowMs(), id
    );
    res.json({ ok: true });
});

// Delete level — edit_key or admin
app.delete('/api/levels/:id', (req, res) => {
    const id = Number(req.params.id);
    const level = db.prepare('SELECT * FROM levels WHERE id = ?').get(id);
    if (!level) return res.status(404).json({ error: 'Not found' });
    if (!canEditLevel(req, level)) return res.status(401).json({ error: '无删除权限（缺少 edit_key）' });
    db.prepare('DELETE FROM levels WHERE id = ?').run(id);
    res.json({ ok: true });
});

// Count a play
app.post('/api/levels/:id/play', (req, res) => {
    const info = db.prepare('UPDATE levels SET plays = plays + 1 WHERE id = ?')
        .run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  鎏金枢界 · 档案库（新数据库）
//  · 读取公开 · 写入需要管理密钥
// ═══════════════════════════════════════════════════════════════════
app.get('/api/arc/entries', (req, res) => {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    let sql = `SELECT id, title, category, summary, tags, created_at, updated_at FROM arc_entries`;
    const where = [], args = [];
    if (q) {
        const like = `%${q.replace(/[%_]/g, c => '\\' + c)}%`;
        where.push(`(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`);
        args.push(like, like, like);
    }
    if (category) { where.push('category = ?'); args.push(category); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY updated_at DESC LIMIT 300';
    const entries = db.prepare(sql).all(...args);
    const cats = db.prepare(`SELECT category, COUNT(*) n FROM arc_entries GROUP BY category ORDER BY n DESC`).all();
    res.json({ entries, categories: cats });
});

app.get('/api/arc/entries/:id', (req, res) => {
    const entry = db.prepare('SELECT * FROM arc_entries WHERE id = ?').get(Number(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const threads = db.prepare(`
        SELECT t.id, t.title, t.author, t.pinned, t.updated_at,
               (SELECT COUNT(*) FROM forum_posts p WHERE p.thread_id = t.id) AS replies
        FROM forum_threads t WHERE t.entry_id = ?
        ORDER BY t.pinned DESC, t.updated_at DESC LIMIT 50
    `).all(entry.id);
    res.json({ entry, threads });
});

app.post('/api/arc/entries', requireAuth, (req, res) => {
    const { title, category = '未分类', summary = '', content = '', tags = '' } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
    const now = nowMs();
    const info = db.prepare(`
        INSERT INTO arc_entries (title, category, summary, content, tags, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)
    `).run(String(title).trim().slice(0, 80), String(category).slice(0, 30),
           String(summary).slice(0, 300), String(content).slice(0, 100000),
           String(tags).slice(0, 200), now, now);
    res.json({ id: info.lastInsertRowid });
});

app.patch('/api/arc/entries/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM arc_entries WHERE id = ?').get(id)) {
        return res.status(404).json({ error: 'Not found' });
    }
    const { title, category, summary, content, tags } = req.body || {};
    db.prepare(`
        UPDATE arc_entries SET
            title = COALESCE(?, title), category = COALESCE(?, category),
            summary = COALESCE(?, summary), content = COALESCE(?, content),
            tags = COALESCE(?, tags), updated_at = ?
        WHERE id = ?
    `).run(title ?? null, category ?? null, summary ?? null, content ?? null, tags ?? null, nowMs(), id);
    res.json({ ok: true });
});

app.delete('/api/arc/entries/:id', requireAuth, (req, res) => {
    const info = db.prepare('DELETE FROM arc_entries WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  鎏金枢界 · 共鸣场（论坛）
//  · 浏览 / 发帖 / 回帖公开 · 置顶 / 删除需要管理密钥
// ═══════════════════════════════════════════════════════════════════
app.get('/api/forum/threads', (req, res) => {
    const entryId = req.query.entry_id ? Number(req.query.entry_id) : null;
    let sql = `
        SELECT t.id, t.entry_id, t.title, t.author, t.pinned, t.created_at, t.updated_at,
               (SELECT COUNT(*) FROM forum_posts p WHERE p.thread_id = t.id) AS replies,
               (SELECT title FROM arc_entries e WHERE e.id = t.entry_id) AS entry_title
        FROM forum_threads t`;
    const args = [];
    if (entryId) { sql += ' WHERE t.entry_id = ?'; args.push(entryId); }
    sql += ' ORDER BY t.pinned DESC, t.updated_at DESC LIMIT 200';
    res.json({ threads: db.prepare(sql).all(...args) });
});

app.get('/api/forum/threads/:id', (req, res) => {
    const id = Number(req.params.id);
    const thread = db.prepare(`
        SELECT t.*, (SELECT title FROM arc_entries e WHERE e.id = t.entry_id) AS entry_title
        FROM forum_threads t WHERE t.id = ?
    `).get(id);
    if (!thread) return res.status(404).json({ error: 'Not found' });
    const posts = db.prepare('SELECT * FROM forum_posts WHERE thread_id = ? ORDER BY id ASC LIMIT 500').all(id);
    res.json({ thread, posts });
});

function cleanText(s, max) { return String(s || '').trim().slice(0, max); }

app.post('/api/forum/threads', (req, res) => {
    const title = cleanText(req.body?.title, 80);
    const author = cleanText(req.body?.author, 30) || '旅人';
    const content = cleanText(req.body?.content, 20000);
    const entryId = req.body?.entry_id ? Number(req.body.entry_id) : null;
    if (!title) return res.status(400).json({ error: '标题不能为空' });
    if (entryId && !db.prepare('SELECT 1 FROM arc_entries WHERE id = ?').get(entryId)) {
        return res.status(400).json({ error: '关联档案不存在' });
    }
    const now = nowMs();
    const info = db.prepare(`
        INSERT INTO forum_threads (entry_id, title, author, content, pinned, created_at, updated_at)
        VALUES (?,?,?,?,0,?,?)
    `).run(entryId, title, author, content, now, now);
    res.json({ id: info.lastInsertRowid });
});

app.post('/api/forum/threads/:id/posts', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM forum_threads WHERE id = ?').get(id)) {
        return res.status(404).json({ error: 'Not found' });
    }
    const author = cleanText(req.body?.author, 30) || '旅人';
    const content = cleanText(req.body?.content, 20000);
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    const now = nowMs();
    const info = db.prepare(
        'INSERT INTO forum_posts (thread_id, author, content, created_at) VALUES (?,?,?,?)'
    ).run(id, author, content, now);
    db.prepare('UPDATE forum_threads SET updated_at = ? WHERE id = ?').run(now, id);
    res.json({ id: info.lastInsertRowid });
});

app.patch('/api/forum/threads/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM forum_threads WHERE id = ?').get(id)) {
        return res.status(404).json({ error: 'Not found' });
    }
    const { pinned, title } = req.body || {};
    db.prepare(`
        UPDATE forum_threads SET
            pinned = COALESCE(?, pinned), title = COALESCE(?, title), updated_at = ?
        WHERE id = ?
    `).run(pinned === undefined ? null : (pinned ? 1 : 0), title ?? null, nowMs(), id);
    res.json({ ok: true });
});

app.delete('/api/forum/threads/:id', requireAuth, (req, res) => {
    const info = db.prepare('DELETE FROM forum_threads WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

app.delete('/api/forum/posts/:id', requireAuth, (req, res) => {
    const info = db.prepare('DELETE FROM forum_posts WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// ── 首次启动时播种正典档案与欢迎帖 ──
function seedNexus() {
    if (db.prepare('SELECT COUNT(*) c FROM arc_entries').get().c > 0) return;
    const now = nowMs();
    const ins = db.prepare(`
        INSERT INTO arc_entries (title, category, summary, content, tags, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)
    `);
    const seeds = [
        ['原素', '能量体系', '物质存在的基础，世界由八种原素构成。',
         '# 原素\n\n物质存在的基础。八种原素按凝结稳定性依次出现：\n\n**土 → 金 → 水 → 木 → 火 → 气 → 光 → 暗**\n\n土最稳定最先凝结；暗最晚，但一旦稳定极难分解。\n\n## 对立共鸣\n\n- 土 ↔ 气（稳固 ↔ 流动）\n- 金 ↔ 木（硬化 ↔ 生长）\n- 水 ↔ 火（溶解 ↔ 燃烧）\n- 光 ↔ 暗（揭示 ↔ 隐匿）— 昼夜更替的引擎\n\n对立共鸣是世界气候节律与能量流动的基础。', '能量,八原素,共鸣'],
        ['生息', '能量体系', '世界本源的直接延伸，附着于有机生命结构之上，不可再生。',
         '# 生息\n\n世界本源的直接延伸，附着于有机生命结构之上。\n\n**不可再生** —— 耗尽后不会自然恢复，以分散形式回归原素场。\n\n生息总量决定了世界能量平衡的承载能力。仙术所消耗的「元气」是生息的流动本身，可恢复，因此仙术不破坏世界平衡。', '能量,生命,元气'],
        ['魔力', '能量体系', '生息被强行转化为高密度不稳定能量的产物。',
         '# 魔力\n\n生息被**强行转化**为高密度不稳定能量的产物。\n\n在原素场中积聚到一定程度后，会干扰原素的自然循环，迫使世界启动回收机制——汲取乃至解析。\n\n**三层关系**：原素是本源能量的物质形态，生息是本源能量附着于生命的形态，魔力是生息的异化形态。', '能量,异化,失衡'],
        ['世界平衡机制', '平衡机制', '世界对抗魔力积累的自我调节能力，非人格化的内在趋势。',
         '# 世界平衡机制\n\n世界具有自我调节能力，用以对抗魔力积累带来的失衡。这一机制**不是人格化的意志**，而是类似物理定律的内在趋势。\n\n## 三档机制\n\n1. **献祭**（精细调节）— 特定生命体产生前往中心岛的内在驱动，在世界树前献祭自身生息，完成小规模主动回收。代价是献祭者完全消失。\n2. **汲取**（粗调）— 局部魔力浓度超临界时，世界强制回收该区域生命体的生息。体质弱者可能直接死亡。\n3. **解析**（精调·不可逆）— 魔力浓度超更高阈值时，区域内所有物质（包括魔力和生命体）被强制还原为原素，不留任何残留。\n\n世界树是平衡状态的有机映射。**EC 174 年，世界树正在枯萎。**', '平衡,献祭,汲取,解析,世界树'],
        ['一体两面之盘', '世界形体', '现实世界是一只双面盘，从界外看像一块夹心饼干。',
         '# 一体两面之盘\n\n现实世界是一只**盘**——地平之世。盘有正反两个可居面，从界外看像一块夹心饼干：两片大陆面之间夹着过渡地带。\n\n正反两面互不知晓彼此存在，唯一物理通道是**大断崖**。两面的天空都是**有界的**。', '盘世界,大断崖,背面世界'],
        ['昼夜与日月星辰', '世界形体', '光暗原素经双环倒腾而成昼夜；日月星辰是大环中的小环。',
         '# 昼夜与日月星辰\n\n光与能量皆由原素流动带来。光暗原素彼此相斥：**正面的光多了，背面的暗就多**，每个局部区域独立守恒。\n\n天界之外有**界外大环**（假想轨道·非物理），盘内过渡地带有**过渡内环**，两环一表一里交换原素，使光暗交替有节律。\n\n**日月星辰是大环中的小环**——与大环交换原素，便产生了日月更替。', '昼夜,大环,日月'],
    ];
    for (const s of seeds) ins.run(...s, now, now);
    const t = db.prepare(`
        INSERT INTO forum_threads (entry_id, title, author, content, pinned, created_at, updated_at)
        VALUES (?,?,?,?,1,?,?)
    `).run(null, '欢迎来到共鸣场 · 发帖规则', '枢界',
           '这里是鎏金枢界的论坛。档案库中的每篇档案都可以发起关联讨论；「世界脉络」页有能量循环的动画演示。署名自拟，互相尊重。',
           now, now);
    db.prepare('INSERT INTO forum_posts (thread_id, author, content, created_at) VALUES (?,?,?,?)')
        .run(t.lastInsertRowid, '旅人', '终于有论坛了！', now + 1);
}
seedNexus();

app.listen(PORT, () => {
    console.log(`\n  ✦ The Parsed World · Lore DB`);
    console.log(`  → listening on http://localhost:${PORT}`);
    console.log(`  → admin token: ${ADMIN_TOKEN === 'change-me-please' ? '\x1b[31mchange-me-please (DEFAULT — set ADMIN_TOKEN env var!)\x1b[0m' : '****'}\n`);
});
