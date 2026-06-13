const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 4174;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-please';
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

app.listen(PORT, () => {
    console.log(`\n  ✦ The Parsed World · Lore DB`);
    console.log(`  → listening on http://localhost:${PORT}`);
    console.log(`  → admin token: ${ADMIN_TOKEN === 'change-me-please' ? '\x1b[31mchange-me-please (DEFAULT — set ADMIN_TOKEN env var!)\x1b[0m' : '****'}\n`);
});
