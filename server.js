import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, 'data');           // ไฟล์ที่มากับโค้ด (repo)
const DATA = process.env.DATA_DIR || SEED_DIR;           // volume สำหรับเก็บคำตอบ (เช่น /data บน Railway)

// เนื้อหา (ร่างแผน + หน่วยงาน) อ่านจาก repo เสมอ -> แก้แล้ว push = อัปเดตทุก deploy
const PLAN_FILE = path.join(SEED_DIR, 'plan.json');
const AGENCIES_FILE = path.join(SEED_DIR, 'agencies.json');
// คำตอบของผู้กรอก + บัญชีแอดมิน -> เก็บบน volume ให้ถาวร ไม่หายตอน redeploy
const RESPONSES_FILE = path.join(DATA, 'responses.json');
const ADMINS_FILE = path.join(DATA, 'admins.json');

await fs.mkdir(DATA, { recursive: true });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme-local';
// เซ็นชื่อ session token ของผู้ใช้ที่ล็อกอินด้วย user/pass — ถ้าไม่ตั้งค่าไว้ จะสุ่มใหม่ทุกครั้งที่ระบบรีสตาร์ท (แอดมินต้องล็อกอินใหม่)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3200;

// ---------- admin accounts (username/password) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return test.length === hash.length && crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'));
}
function signSession(username) {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 วัน
  const payload = `${username}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function verifySession(token) {
  try {
    const [username, expStr, sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${username}.${expStr}`).digest('hex');
    if (sig !== expected || Date.now() > Number(expStr)) return null;
    return username;
  } catch { return null; }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- helpers ----------
async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}
let writeLock = Promise.resolve();
async function writeJSON(file, data) {
  // serialize writes to avoid clobbering responses.json under concurrency
  writeLock = writeLock.then(() =>
    fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
  );
  return writeLock;
}

function isAdmin(req) {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (!t) return false;
  if (t === ADMIN_TOKEN) { req.adminUser = null; return true; } // master token (legacy/bootstrap)
  const username = verifySession(t);
  if (username) { req.adminUser = username; return true; }
  return false;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'admin token required' });
  next();
}

// ---------- admin: login + manage other admin accounts ----------
app.post('/api/admin/login', async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  if (!username || !password) return res.status(400).json({ error: 'username/password required' });
  const admins = await readJSON(ADMINS_FILE, {});
  const rec = admins[username];
  if (!rec || !verifyPassword(password, rec.salt, rec.hash)) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  res.json({ ok: true, token: signSession(username), username });
});

// รายชื่อแอดมิน (ไม่ส่งรหัสผ่าน/hash กลับ)
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  const admins = await readJSON(ADMINS_FILE, {});
  res.json(Object.keys(admins).sort());
});
// เพิ่มแอดมินใหม่ หรือรีเซ็ตรหัสผ่านของแอดมินเดิม
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  if (!username || !password) return res.status(400).json({ error: 'username/password required' });
  if (password.length < 8) return res.status(400).json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' });
  const admins = await readJSON(ADMINS_FILE, {});
  admins[username] = hashPassword(password);
  await writeJSON(ADMINS_FILE, admins);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  const admins = await readJSON(ADMINS_FILE, {});
  if (!admins[req.params.username]) return res.status(404).json({ error: 'not found' });
  delete admins[req.params.username];
  await writeJSON(ADMINS_FILE, admins);
  res.json({ ok: true });
});

// resolve an agency id -> human label + metadata, from agencies.json
// index of fixed (central) agencies; province agencies are free-text (province + category + typed name)
function buildAgencyIndex(agencies) {
  const map = new Map();
  for (const a of agencies.central || []) {
    map.set(a.id, {
      id: a.id, name: a.name, kind: 'central',
      committees: a.committees || [], province: '', unitType: ''
    });
  }
  return map;
}

// ---------- public: plan & agencies ----------
app.get('/api/plan', async (_req, res) => res.json(await readJSON(PLAN_FILE, {})));
app.get('/api/agencies', async (_req, res) => res.json(await readJSON(AGENCIES_FILE, {})));

// ---------- load an existing response (resume) ----------
app.get('/api/response/:agencyId', async (req, res) => {
  const all = await readJSON(RESPONSES_FILE, {});
  res.json(all[req.params.agencyId] || null);
});

// ---------- save draft / submit ----------
async function saveResponse(req, res, status) {
  const body = req.body || {};
  const agencyId = body.agencyId;
  if (!agencyId) return res.status(400).json({ error: 'agencyId required' });

  const agencies = await readJSON(AGENCIES_FILE, {});
  const idx = buildAgencyIndex(agencies);
  const email = (body.email || '').trim();
  let meta = idx.get(agencyId);
  if (!meta) {
    // province agency: free-text (province + category + typed name)
    const province = (body.province || '').trim();
    const category = (body.category || '').trim();
    const name = (body.agencyName || '').trim();
    if (body.kind === 'province' && province && category && name) {
      meta = { id: agencyId, name, kind: 'province', committees: [], province, unitType: category };
    } else if (body.kind === 'expert' && email) {
      // ผู้ทรงคุณวุฒิ: ระบุตัวด้วยอีเมล (agencyId = e:<email>)
      meta = { id: agencyId, name: 'ผู้ทรงคุณวุฒิ', kind: 'expert', committees: [], province: '', unitType: '' };
    } else {
      return res.status(400).json({ error: 'unknown agencyId' });
    }
  }

  const comments = body.comments || {};

  // การส่งจริง (submit) ต้องให้ความเห็นครบทุกข้อ — draft ไม่บังคับ
  if (status === 'submitted') {
    const plan = await readJSON(PLAN_FILE, {});
    const isTouched = c => !!(c && (c.stance || (c.text || '').trim()));
    const missing = flattenPlan(plan).filter(n => !isTouched(comments[n.no])).map(n => n.no);
    if (missing.length) {
      return res.status(400).json({ error: `ยังตอบไม่ครบ ขาดอีก ${missing.length} ข้อ`, missing });
    }
  }

  const all = await readJSON(RESPONSES_FILE, {});
  const prev = all[agencyId] || {};
  const now = new Date().toISOString();

  const rec = {
    agencyId,
    agencyName: meta.name,
    kind: meta.kind,
    province: meta.province,
    unitType: meta.unitType,
    committees: meta.committees,
    email,
    comments,                               // { "8.1.1": {stance,text,files:[]} }
    otherComment: (body.otherComment || '').trim(),
    status,
    createdAt: prev.createdAt || now,
    updatedAt: now,
    submittedAt: status === 'submitted' ? now : (prev.submittedAt || null),
  };
  all[agencyId] = rec;
  await writeJSON(RESPONSES_FILE, all);
  res.json({ ok: true, status, updatedAt: now });
}
app.post('/api/draft', (req, res) => saveResponse(req, res, 'draft'));
app.post('/api/submit', (req, res) => saveResponse(req, res, 'submitted'));

// ---------- admin: responses + export ----------
app.get('/api/admin/responses', requireAdmin, async (_req, res) => {
  const all = await readJSON(RESPONSES_FILE, {});
  res.json(Object.values(all));
});

// delete a single agency's response (e.g. test entries)
app.delete('/api/admin/response/:agencyId', requireAdmin, async (req, res) => {
  const all = await readJSON(RESPONSES_FILE, {});
  if (!all[req.params.agencyId]) return res.status(404).json({ error: 'not found' });
  delete all[req.params.agencyId];
  await writeJSON(RESPONSES_FILE, all);
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  const agencies = await readJSON(AGENCIES_FILE, {});
  const all = Object.values(await readJSON(RESPONSES_FILE, {}));
  const sub = all.filter(r => r.status === 'submitted');
  const centralTotal = agencies.central?.length || 0;
  const provinceCount = (agencies.provinces || []).length;
  const categoryCount = (agencies.provinceCategories || []).length;
  res.json({
    centralTotal,
    centralSubmitted: sub.filter(r => r.kind === 'central').length,
    provinceSubmitted: sub.filter(r => r.kind === 'province').length,
    // province-category slots expected (one lead response per province per sector)
    provinceSlots: provinceCount * categoryCount,
    submitted: sub.length,
    drafts: all.filter(r => r.status === 'draft').length,
  });
});

const STANCE_TH = { agree: 'เห็นด้วย', edit: 'ขอแก้ไข/เพิ่มเติม', add: 'ขอแก้ไข/เพิ่มเติม' };

// flatten plan.json -> ordered [{no, dim, text}] for every commentable node
function flattenPlan(plan) {
  const list = [];
  for (const s of plan.sections || []) {
    if (s.commentLevel === 'item') {
      for (const g of s.groups || [])
        for (const it of g.items || [])
          list.push({ no: it.no, dim: `${s.title} / ${g.title}`, text: it.text });
    } else if (s.commentLevel === 'group') {
      for (const g of s.groups || [])
        list.push({ no: g.no, dim: s.title, text: g.title });
    } else {
      list.push({ no: s.no, dim: s.title, text: s.title });
    }
  }
  return list;
}

function csvEscape(v) {
  const s = (v == null ? '' : String(v)).replace(/"/g, '""');
  return `"${s}"`;
}

// เนื้อความในเซลล์ของแต่ละข้อ: เห็นด้วย / ขอแก้ไข: <ข้อเสนอ>
function cellFor(c) {
  if (!c) return '';
  const st = c.stance ? (STANCE_TH[c.stance] || c.stance) : '';
  const txt = (c.text || '').trim();
  if (st && txt) return `${st}: ${txt}`;
  return st || txt || '';
}

// build wide-format rows: 1 row per agency, 1 column per commentable measure
function buildExportRows(plan, all) {
  const nodes = flattenPlan(plan); // ordered [{no, dim, text}]
  const header = ['หน่วยงาน', 'ประเภท', 'จังหวัด', 'อนุกรรมการ', 'อีเมล',
    'สถานะ', 'เวลาส่ง', 'ความเห็นอื่น ๆ (ภาพรวม)',
    ...nodes.map(n => `${n.no} ${n.text}`)];
  const rows = [header];
  const typeOf = r => r.kind === 'province' ? `จังหวัด-${r.unitType}` : 'ส่วนกลาง';
  const statusOf = r => r.status === 'submitted' ? 'ส่งแล้ว' : 'ร่าง';
  for (const r of all) {
    const comments = r.comments || {};
    const row = [r.agencyName, typeOf(r), r.province || '', (r.committees || []).join(' '),
      r.email || '', statusOf(r), r.submittedAt || '', r.otherComment || ''];
    for (const n of nodes) row.push(cellFor(comments[n.no]));
    rows.push(row);
  }
  return rows;
}

// CSV (UTF-8 + BOM) — for those who import via "Data > From Text/CSV"
app.get('/api/admin/export.csv', requireAdmin, async (_req, res) => {
  const plan = await readJSON(PLAN_FILE, {});
  const all = Object.values(await readJSON(RESPONSES_FILE, {}));
  const rows = buildExportRows(plan, all);
  const csv = '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="festival-review-2570.csv"');
  res.send(csv);
});

// Excel (.xls) = UTF-16LE + Tab-separated. เปิดด้วยดับเบิลคลิกแล้วภาษาไทยไม่เพี้ยนทุกเวอร์ชัน
app.get('/api/admin/export.xls', requireAdmin, async (_req, res) => {
  const plan = await readJSON(PLAN_FILE, {});
  const all = Object.values(await readJSON(RESPONSES_FILE, {}));
  const rows = buildExportRows(plan, all);
  // Tab-separated; แทน tab/newline ในเนื้อหาด้วยช่องว่างกันคอลัมน์เพี้ยน
  const clean = v => (v == null ? '' : String(v)).replace(/[\t\r\n]+/g, ' ');
  const text = '﻿' + rows.map(r => r.map(clean).join('\t')).join('\r\n');
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-16le');
  res.setHeader('Content-Disposition', 'attachment; filename="festival-review-2570.xls"');
  res.send(Buffer.from(text, 'utf16le'));
});

// ---------- admin: manage agencies ----------
function findAgency(agencies, id) {
  for (const a of agencies.central || []) if (a.id === id) return { type: 'central', obj: a };
  for (const p of agencies.provinces || [])
    for (const u of p.units || []) if (u.id === id) return { type: 'unit', obj: u, province: p.province };
  return null;
}
// rename (central or province unit); central may also update committees
app.put('/api/admin/agency/:id', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const agencies = await readJSON(AGENCIES_FILE, {});
  const found = findAgency(agencies, req.params.id);
  if (!found) return res.status(404).json({ error: 'not found' });
  found.obj.name = name;
  if (found.type === 'central' && Array.isArray(req.body.committees)) found.obj.committees = req.body.committees;
  await writeJSON(AGENCIES_FILE, agencies);
  res.json({ ok: true });
});
// add a central agency
app.post('/api/admin/agency', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const agencies = await readJSON(AGENCIES_FILE, {});
  agencies.central = agencies.central || [];
  const id = 'c' + Date.now();
  agencies.central.push({ id, name, committees: Array.isArray(req.body.committees) ? req.body.committees : [] });
  await writeJSON(AGENCIES_FILE, agencies);
  res.json({ ok: true, id });
});
// delete a central agency (province units are fixed)
app.delete('/api/admin/agency/:id', requireAdmin, async (req, res) => {
  const agencies = await readJSON(AGENCIES_FILE, {});
  const before = (agencies.central || []).length;
  agencies.central = (agencies.central || []).filter(a => a.id !== req.params.id);
  if (agencies.central.length === before) return res.status(400).json({ error: 'ลบได้เฉพาะหน่วยงานส่วนกลาง' });
  await writeJSON(AGENCIES_FILE, agencies);
  res.json({ ok: true });
});

// ---------- pages ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => console.log(`festival-review running on http://localhost:${PORT}`));
