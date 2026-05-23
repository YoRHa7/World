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

app.listen(PORT, () => {
    console.log(`\n  ✦ The Parsed World · Lore DB`);
    console.log(`  → listening on http://localhost:${PORT}`);
    console.log(`  → admin token: ${ADMIN_TOKEN === 'change-me-please' ? '\x1b[31mchange-me-please (DEFAULT — set ADMIN_TOKEN env var!)\x1b[0m' : '****'}\n`);
});
