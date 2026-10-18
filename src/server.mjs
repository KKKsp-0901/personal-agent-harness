import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runAgentLoop } from './agents.mjs';
import { authorizedPath, normalizeLimits } from './core.mjs';
import { runDocumentJob } from './document-pipeline.mjs';
import { SUPPORTED_DOCUMENTS } from './documents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.data');
await fs.mkdir(dataDir, { recursive: true });
const uploadDir = path.join(dataDir, 'uploads');
await fs.mkdir(uploadDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'harness.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, goal TEXT NOT NULL, workspace TEXT NOT NULL, status TEXT NOT NULL, limits TEXT NOT NULL, answer TEXT, plan TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_inputs(run_id TEXT NOT NULL, upload_id TEXT NOT NULL, PRIMARY KEY(run_id, upload_id));`);
db.prepare("UPDATE runs SET status='interrupted', updated_at=? WHERE status='running'").run(new Date().toISOString());
const active = new Map();
const port = Number(process.env.PORT || 4173);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

function getRun(id) {
  const row = db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  if (!row) return null;
  const inputCount = db.prepare('SELECT COUNT(*) AS count FROM run_inputs WHERE run_id=?').get(id).count;
  return { ...row, inputCount, limits: JSON.parse(row.limits), events: db.prepare('SELECT id,type,data,created_at FROM events WHERE run_id=? ORDER BY id').all(id).map(e => ({ ...e, data: JSON.parse(e.data) })) };
}
function append(id, type, data) {
  db.prepare('INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)').run(id, type, JSON.stringify(data), new Date().toISOString());
  db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(new Date().toISOString(), id);
}
function setStatus(id, status, answer = null, plan = null) {
  db.prepare('UPDATE runs SET status=?, answer=COALESCE(?,answer), plan=COALESCE(?,plan), updated_at=? WHERE id=?')
    .run(status, answer, plan, new Date().toISOString(), id);
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_100_000) throw new Error('请求过大');
  }
  return JSON.parse(text || '{}');
}
async function bodyBinary(req, maxBytes = 25_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('单个文件不能超过 25 MB');
    chunks.push(chunk);
  }
  if (!size) throw new Error('文件为空');
  return Buffer.concat(chunks);
}
function credential(action, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'src', 'credential.ps1'), action], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(0, 1000) || `凭据操作失败 (${code})`)));
    child.stdin.end(input);
  });
}
async function launch(id) {
  const run = getRun(id);
  if (!run || active.has(id)) return;
  const controller = new AbortController();
  active.set(id, controller);
  setStatus(id, 'running');
  append(id, 'stage', { label: '任务开始' });
  try {
    const key = process.env.DEEPSEEK_API_KEY || await credential('get');
    if (!key) throw new Error('请先在设置中保存 DeepSeek API key');
    const memories = db.prepare('SELECT content FROM memories ORDER BY created_at DESC LIMIT 30').all().map(row => row.content);
    const inputs = db.prepare('SELECT uploads.* FROM uploads JOIN run_inputs ON uploads.id=run_inputs.upload_id WHERE run_inputs.run_id=? ORDER BY uploads.created_at').all(id);
    const context = { dataDir, key, memories, signal: controller.signal, emit: (type, data) => append(id, type, data) };
    const result = inputs.length ? await runDocumentJob(run, { ...context, inputs }) : await runAgentLoop(run, context);
    setStatus(id, result.status, result.answer, result.plan);
    append(id, 'final', { status: result.status, answer: result.answer });
  } catch (error) {
    const status = controller.signal.aborted ? 'cancelled' : 'failed';
    setStatus(id, status, error.message);
    append(id, 'error', { message: error.message });
  } finally { active.delete(id); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return json(res, 403, { error: '不允许该访问地址' });
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return json(res, 400, { error: '请求路径无效' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, 403, { error: '不允许跨站请求' });
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const codex = spawnSync('codex', ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      const hasKey = Boolean(process.env.DEEPSEEK_API_KEY || await credential('get'));
      return json(res, 200, { codex: codex.status === 0 ? codex.stdout.trim() : null, deepseekConfigured: hasKey, port });
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      const name = path.basename(String(url.searchParams.get('name') || ''));
      const ext = path.extname(name).toLowerCase();
      if (!name || name.length > 180 || !SUPPORTED_DOCUMENTS.includes(ext)) return json(res, 400, { error: '仅支持 PDF、PPTX、DOCX、MD、TXT 文件' });
      const content = await bodyBinary(req);
      const id = randomUUID();
      const file = path.join(uploadDir, `${id}${ext}`);
      await fs.writeFile(file, content, { flag: 'wx' });
      db.prepare('INSERT INTO uploads(id,name,path,size,created_at) VALUES(?,?,?,?,?)').run(id, name, file, content.length, new Date().toISOString());
      return json(res, 201, { id, name, size: content.length });
    }
    if (url.pathname === '/api/key' && req.method === 'POST') {
      const payload = await bodyJson(req);
      if (typeof payload.key !== 'string' || payload.key.length < 8 || payload.key.length > 1000) return json(res, 400, { error: 'API key 格式无效' });
      await credential('set', payload.key);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/key' && req.method === 'DELETE') {
      await credential('delete');
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/memories' && req.method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all());
    }
    if (url.pathname === '/api/memories' && req.method === 'POST') {
      const payload = await bodyJson(req);
      const content = String(payload.content || '').trim();
      if (!content || content.length > 500) return json(res, 400, { error: '记忆内容须为 1–500 字' });
      const memory = { id: randomUUID(), content, created_at: new Date().toISOString() };
      db.prepare('INSERT INTO memories(id,content,created_at) VALUES(?,?,?)').run(memory.id, memory.content, memory.created_at);
      return json(res, 201, memory);
    }
    const memoryMatch = url.pathname.match(/^\/api\/memories\/([0-9a-f-]{36})$/);
    if (memoryMatch && req.method === 'PATCH') {
      const payload = await bodyJson(req);
      const content = String(payload.content || '').trim();
      if (!content || content.length > 500) return json(res, 400, { error: '记忆内容须为 1–500 字' });
      db.prepare('UPDATE memories SET content=? WHERE id=?').run(content, memoryMatch[1]);
      return json(res, 200, { ok: true });
    }
    if (memoryMatch && req.method === 'DELETE') {
      db.prepare('DELETE FROM memories WHERE id=?').run(memoryMatch[1]);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      const rows = db.prepare('SELECT id,goal,workspace,status,created_at,updated_at FROM runs ORDER BY created_at DESC LIMIT 50').all();
      return json(res, 200, rows);
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const payload = await bodyJson(req);
      const goal = String(payload.goal || '').trim() || '按章节整理知识点';
      if (goal.length > 5000) return json(res, 400, { error: '整理重点不能超过 5000 字' });
      const inputIds = Array.isArray(payload.inputs) ? [...new Set(payload.inputs)] : [];
      if (!inputIds.length || inputIds.length > 10) return json(res, 400, { error: '请上传 1–10 份资料' });
      const inputRows = inputIds.map(inputId => db.prepare('SELECT id FROM uploads WHERE id=?').get(inputId));
      if (inputRows.some(row => !row)) return json(res, 400, { error: '上传文件不存在，请重新上传' });
      if (!payload.workspace || !path.isAbsolute(payload.workspace)) return json(res, 400, { error: '请输入绝对路径的授权工作目录' });
      const workspace = await fs.realpath(payload.workspace);
      if (!(await fs.stat(workspace)).isDirectory()) return json(res, 400, { error: '授权工作目录不存在' });
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO runs(id,goal,workspace,status,limits,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, goal, workspace, 'created', JSON.stringify(normalizeLimits({ maxMinutes: 60, ...payload.limits })), now, now);
      for (const inputId of inputIds) db.prepare('INSERT INTO run_inputs(run_id,upload_id) VALUES(?,?)').run(id, inputId);
      void launch(id);
      return json(res, 201, { id });
    }
    const fileMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})\/files\/(\d+)$/);
    if (fileMatch && req.method === 'GET') {
      const run = getRun(fileMatch[1]);
      if (!run) return json(res, 404, { error: '任务不存在' });
      const event = run.events.find(item => item.id === Number(fileMatch[2]) && item.type === 'artifact');
      if (!event || typeof event.data.path !== 'string') return json(res, 404, { error: '文件记录不存在' });
      let file;
      try { file = await authorizedPath(run.workspace, event.data.path); }
      catch { return json(res, 404, { error: '文件已不存在或不在授权目录内' }); }
      const stat = await fs.stat(file);
      if (!stat.isFile()) return json(res, 404, { error: '文件已不存在' });
      if (stat.size > 20_000_000) return json(res, 413, { error: '文件过大，无法通过页面下载' });
      const content = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(content);
    }
    const match = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})(?:\/(cancel|resume|reformat))?$/);
    if (match) {
      const run = getRun(match[1]);
      if (!run) return json(res, 404, { error: '任务不存在' });
      if (!match[2] && req.method === 'GET') return json(res, 200, run);
      if (match[2] === 'cancel' && req.method === 'POST') {
        active.get(match[1])?.abort();
        return json(res, 200, { ok: true });
      }
      if (match[2] === 'resume' && req.method === 'POST') {
        if (!['interrupted', 'failed', 'limit_reached'].includes(run.status)) return json(res, 409, { error: '当前状态不能恢复' });
        append(run.id, 'resume', { note: '重新执行任务；写入操作按路径覆盖。请检查已有产物。' });
        void launch(run.id);
        return json(res, 200, { ok: true });
      }
      if (match[2] === 'reformat' && req.method === 'POST') {
        if (run.status !== 'completed' || !run.inputCount || active.has(run.id)) return json(res, 409, { error: '当前任务不能重新排版' });
        append(run.id, 'reformat', { note: '复用已有提取结果，由 Codex 重新整理 Markdown' });
        void launch(run.id);
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET' && (url.pathname === '/' || /^\/(app\.js|style\.css)$/.test(url.pathname))) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      const content = await fs.readFile(path.join(root, 'public', file));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      return res.end(content);
    }
    json(res, 404, { error: '找不到资源' });
  } catch (error) { json(res, 500, { error: error.message }); }
});

server.listen(port, '127.0.0.1', () => console.log(`Personal Agent Harness: http://127.0.0.1:${port}`));
