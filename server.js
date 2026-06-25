import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, 'data');           // seed files ที่มากับโค้ด
const DATA = process.env.DATA_DIR || SEED_DIR;            // บน Railway ชี้ไป mount path ของ volume เช่น /data
const PLAN_FILE = path.join(DATA, 'plan.json');
const AGENCIES_FILE = path.join(DATA, 'agencies.json');
const RESPONSES_FILE = path.join(DATA, 'responses.json');

await fs.mkdir(DATA, { recursive: true });

// ครั้งแรกที่ volume ยังว่าง -> คัดลอก seed (plan/agencies) จากโค้ดไปลง volume
// responses.json ไม่ copy (ให้เริ่มว่างบน production)
if (DATA !== SEED_DIR) {
  for (const f of ['plan.json', 'agencies.json']) {
    const dest = path.join(DATA, f);
    try { await fs.access(dest); }
    catch { await fs.copyFile(path.join(SEED_DIR, f), dest).catch(() => {}); }
  }
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme-local';
const PORT = process.env.PORT || 3200;

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
  return t === ADMIN_TOKEN;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'admin token required' });
  next();
}

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
  let meta = idx.get(agencyId);
  if (!meta) {
    // province agency: free-text (province + category + typed name)
    const province = (body.province || '').trim();
    const category = (body.category || '').trim();
    const name = (body.agencyName || '').trim();
    if (body.kind === 'province' && province && category && name) {
      meta = { id: agencyId, name, kind: 'province', committees: [], province, unitType: category };
    } else {
      return res.status(400).json({ error: 'unknown agencyId' });
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
    submitter: (body.submitter || '').trim(),
    position: (body.position || '').trim(),
    phone: (body.phone || '').trim(),
    email: (body.email || '').trim(),
    comments: body.comments || {},          // { "8.1.1": {stance,text,files:[]} }
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

const STANCE_TH = { agree: 'เห็นด้วย', edit: 'ขอแก้ไข', add: 'ขอเพิ่มเติม' };

// flatten plan.json -> { nodeId: {dim, text} } for every commentable node
function flattenPlan(plan) {
  const idx = {};
  for (const s of plan.sections || []) {
    if (s.commentLevel === 'item') {
      for (const g of s.groups || [])
        for (const it of g.items || [])
          idx[it.no] = { dim: `${s.title} / ${g.title}`, text: it.text };
    } else if (s.commentLevel === 'group') {
      for (const g of s.groups || [])
        idx[g.no] = { dim: s.title, text: g.title };
    } else {
      idx[s.no] = { dim: s.title, text: s.title };
    }
  }
  return idx;
}

function csvEscape(v) {
  const s = (v == null ? '' : String(v)).replace(/"/g, '""');
  return `"${s}"`;
}

// build long-format rows (one row per commented measure) as arrays of cells
function buildExportRows(plan, all) {
  const mIndex = flattenPlan(plan); // nodeId -> {dim, text}
  const rows = [['หน่วยงาน', 'ประเภท', 'จังหวัด', 'อนุกรรมการ', 'ผู้กรอก', 'ตำแหน่ง', 'เบอร์โทร', 'อีเมล',
    'หัวข้อ/ด้าน', 'ข้อ', 'เนื้อหา', 'ความเห็น', 'ข้อเสนอแก้ไข/เพิ่มเติม', 'ความเห็นอื่น ๆ (ภาพรวม)', 'สถานะ', 'เวลาส่ง']];
  const typeOf = r => r.kind === 'province' ? `จังหวัด-${r.unitType}` : 'ส่วนกลาง';
  const statusOf = r => r.status === 'submitted' ? 'ส่งแล้ว' : 'ร่าง';
  for (const r of all) {
    const comments = r.comments || {};
    const noted = Object.entries(comments).filter(([, c]) => c && (c.stance || (c.text || '').trim()));
    // หน่วยที่ส่ง/ร่างแต่ไม่มีคอมเมนต์รายข้อ -> ลงไว้ 1 แถว เพื่อให้เห็นว่าหน่วยนี้ตอบแล้ว
    if (noted.length === 0) {
      rows.push([r.agencyName, typeOf(r), r.province || '', (r.committees || []).join(' '),
        r.submitter || '', r.position || '', r.phone || '', r.email || '',
        '', '', '', r.status === 'submitted' ? 'เห็นชอบทั้งฉบับ' : '', '',
        r.otherComment || '', statusOf(r), r.submittedAt || '']);
      continue;
    }
    for (const [no, c] of noted) {
      const m = mIndex[no] || { dim: '', text: '' };
      rows.push([r.agencyName, typeOf(r), r.province || '', (r.committees || []).join(' '),
        r.submitter || '', r.position || '', r.phone || '', r.email || '',
        m.dim, no, m.text, STANCE_TH[c.stance] || (c.stance || ''), c.text || '',
        r.otherComment || '', statusOf(r), r.submittedAt || '']);
    }
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
