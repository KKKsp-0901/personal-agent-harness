import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexTurn } from './agents.mjs';
import { extractDocument } from './documents.mjs';
import { documentSkill } from './skill.mjs';

const MAX_SOURCE_CHARS = 240_000;
const CHUNK_CHARS = 12_000;

function clean(value, max = 2000) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function meaningfulTitle(value) {
  const title = clean(value, 100).replace(/^(?:\d+[.、]\s*)/, '').replace(/[（(]第?\d+[—-]\d+页[）)]$/, '').trim();
  return title && !/^(?:正文|全文|未命名章节|知识点汇总|第\s*\d+\s*页)$/.test(title) ? title : '';
}
function safeFileStem(value) {
  const stem = clean(value, 100).replace(/[：:]/g, '-').replace(/[<>"/\\|?*\x00-\x1f]/g, ' ').replace(/[.\s]+$/g, '').trim().slice(0, 80);
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem) ? `${stem}-课程` : stem || '课程资料';
}
export function suggestDocumentTitle(documents, chapters, focus = '') {
  const titles = chapters.map(chapter => meaningfulTitle(chapter.title)).filter(Boolean);
  const numbered = titles.map(title => ({ title, number: title.match(/第\s*([一二三四五六七八九十\d]+)\s*章/)?.[1] })).filter(item => item.number);
  if (numbered.length && numbered.every(item => item.number === numbered[0].number)) {
    return safeFileStem(numbered[0].title);
  }
  if (titles.length === 1) return safeFileStem(titles[0]);
  const stems = documents.map(doc => path.parse(doc.name).name.replace(/^(?:ch|chapter|第)?\s*\d+\s*[-_：:]\s*/i, '')).filter(Boolean);
  if (stems.length === 1 && meaningfulTitle(stems[0]) && !/^(?:资料|课程资料|课件|文档|文件|扫描件|notes?|untitled|document)\d*$/i.test(stems[0])) return safeFileStem(stems[0]);
  if (stems.length > 1) {
    let common = stems[0];
    for (const stem of stems.slice(1)) while (common && !stem.startsWith(common)) common = common.slice(0, -1);
    common = common.replace(/[-_第\d\s]+$/g, '').trim();
    if (common.length >= 4) return safeFileStem(common);
  }
  const requested = meaningfulTitle(focus);
  if (requested && !/^(?:按章节整理知识点|提取知识点)$/.test(requested)) return safeFileStem(requested);
  return safeFileStem(titles.slice(0, 2).join('与') || stems[0] || '课程资料');
}

export async function writeUniqueMarkdown(workspace, title, content) {
  const stem = `${safeFileStem(title)}-知识点汇总`;
  for (let index = 1; index <= 999; index++) {
    const name = `${stem}${index === 1 ? '' : `（${index}）`}.md`;
    const output = path.join(workspace, name);
    let handle;
    try { handle = await fs.open(output, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { await handle.writeFile(content, 'utf8'); }
    catch (error) { await handle.close(); await fs.rm(output, { force: true }); throw error; }
    await handle.close();
    if (await fs.readFile(output, 'utf8') !== content) throw new Error('Markdown 文件写入后校验失败');
    return output;
  }
  throw new Error('同名文档已达到 999 份，请更换输出目录');
}
function sourceManifest(documents) {
  const lines = documents.flatMap(doc => doc.segments.map(segment => {
    const preview = segment.text.split('\n').slice(0, 2).join(' ').slice(0, 110);
    return `${doc.name} · ${segment.location} · ${segment.heading} · ${preview}`;
  }));
  const full = lines.join('\n');
  if (full.length <= 12000) return full;
  const stride = Math.ceil(full.length / 12000);
  return lines.filter((_, index) => index === 0 || index === lines.length - 1 || index % stride === 0).join('\n').slice(0, 12000);
}
function joinChunks(documents) {
  const chunks = [];
  let current = '';
  for (const doc of documents) for (const segment of doc.segments) {
    let text = segment.text;
    while (text) {
      const room = CHUNK_CHARS - current.length;
      if (room < 1000) { chunks.push(current); current = ''; continue; }
      const part = text.slice(0, room);
      current += `\n[来源：${doc.name} · ${segment.location} · ${segment.heading}]\n${part}\n`;
      text = text.slice(part.length);
      if (current.length >= CHUNK_CHARS) { chunks.push(current); current = ''; }
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function deepseekExtract({ source, outline, focus, key, signal, emit }) {
  const skill = await documentSkill('Knowledge extraction');
  const response = await fetch(`${(process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 12000,
      messages: [
        { role: 'system', content: `你是文档知识点提取 Agent。仅使用给定资料，不编造事实。${skill}\n请严格输出 JSON 对象，格式：{"chapters":[{"title":"章节名","points":[{"name":"知识点","detail":"清晰解释","source":"文件名 · 第N页"}],"questions":["复习问题"]}]}。没有知识点时返回空数组。` },
        { role: 'user', content: `提取重点：${focus || '全面整理'}\n章节规划：${outline}\n文档原文：\n${source}` }
      ]
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)])
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`DeepSeek 文档提取失败 (${response.status}): ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  const choice = data.choices?.[0];
  emit('model', { provider: 'DeepSeek', model: data.model || 'deepseek-flash', usage: data.usage || null });
  if (choice?.finish_reason === 'length') {
    const error = new Error('知识点输出达到模型长度上限');
    error.code = 'OUTPUT_TRUNCATED';
    throw error;
  }
  const content = choice?.message?.content;
  if (!content) throw new Error('DeepSeek 未返回知识点');
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.chapters)) throw new Error('DeepSeek 返回的知识点结构无效');
  return parsed.chapters;
}

function splitSource(source) {
  const midpoint = Math.floor(source.length / 2);
  const split = source.indexOf('\n', midpoint);
  const point = split > midpoint && split < source.length - 500 ? split : midpoint;
  const left = source.slice(0, point);
  const prefix = [...left.matchAll(/^\[来源：[^\n]+\]$/gm)].at(-1)?.[0] || '';
  return [left, `${prefix}\n${source.slice(point)}`];
}

export async function extractWithRetry(options, extract = deepseekExtract, depth = 0) {
  try { return await extract(options); }
  catch (error) {
    if (error.code !== 'OUTPUT_TRUNCATED' || depth >= 3 || options.source.length < 1800) throw error;
    options.emit('stage', { label: `输出过长，自动拆分资料块（第 ${depth + 1} 次）` });
    const parts = splitSource(options.source);
    const left = await extractWithRetry({ ...options, source: parts[0] }, extract, depth + 1);
    const right = await extractWithRetry({ ...options, source: parts[1] }, extract, depth + 1);
    return [...left, ...right];
  }
}

function mergeChapters(extractions) {
  const chapters = new Map();
  for (const item of extractions.flat()) {
    const title = clean(item.title, 120) || '未命名章节';
    if (!chapters.has(title)) chapters.set(title, { title, points: [], questions: [] });
    const chapter = chapters.get(title);
    for (const point of Array.isArray(item.points) ? item.points : []) {
      const name = clean(point.name, 160), detail = clean(point.detail, 1500), source = clean(point.source, 240);
      if (name && detail && !chapter.points.some(existing => existing.name === name && existing.source === source)) chapter.points.push({ name, detail, source });
    }
    for (const question of Array.isArray(item.questions) ? item.questions : []) {
      const text = clean(question, 240);
      if (text && !chapter.questions.includes(text)) chapter.questions.push(text);
    }
  }
  return [...chapters.values()].filter(chapter => chapter.points.length);
}

function normalizeComposedMarkdown(value) {
  let content = String(value || '').trim();
  if (/^```(?:markdown|md)?\s*\n/i.test(content) && /\n```\s*$/.test(content)) {
    content = content.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
  }
  return content + '\n';
}

export function compositionIssues(content, pointCount) {
  const issues = [];
  if (!/^# [^\n]+/m.test(content)) issues.push('缺少一级标题');
  const sections = [...content.matchAll(/^## ([^\n]+)/gm)].map(match => match[1]);
  if (sections.length < 2) issues.push('缺少章节结构');
  const normalized = sections.map(title => title.replace(/[\s\p{P}]/gu, '').toLowerCase());
  if (new Set(normalized).size !== normalized.length) issues.push('存在重复章节标题');
  if (!/来源[：:]/.test(content)) issues.push('缺少来源标注');
  if (content.length < Math.max(160, Math.min(pointCount * 35, 6000))) issues.push('内容过短，可能遗漏主要知识点');
  return issues;
}

export async function composeKnowledgeMarkdown({ codex, dataDir, signal, emit, documents, chapters, title, focus }) {
  const skill = await documentSkill('Final composition');
  const evidence = JSON.stringify(chapters);
  const sources = documents.map(doc => `${doc.name}（${doc.type}，${doc.segments.length} 个可读片段）`).join('；');
  const pointCount = chapters.reduce((sum, chapter) => sum + chapter.points.length, 0);
  const basePrompt = `你是最终成品编辑 Agent。${skill}\n请根据 DeepSeek 提取结果生成完整的中文 Markdown 成品。第一行使用“# ${title} · 知识点汇总”。保留重要知识点，但合并重复说法；每个主题段落之后紧邻来源。结构应适合复习阅读，避免一条事实一个标题。不要输出代码围栏、说明文字或未核实事实。\n用户重点：${focus}\n资料：${sources}\n提取结果 JSON：${evidence}`;
  let content = normalizeComposedMarkdown(await codex({ dataDir, signal, emit, prompt: basePrompt }));
  let issues = compositionIssues(content, pointCount);
  if (issues.length) {
    emit('stage', { label: 'Codex 修正成品结构' });
    content = normalizeComposedMarkdown(await codex({ dataDir, signal, emit, prompt: `${basePrompt}\n上一版成品：\n${content}\n请修正以下问题后重新输出完整 Markdown：${issues.join('；')}` }));
    issues = compositionIssues(content, pointCount);
  }
  if (issues.length) throw new Error(`Codex 排版结果未通过校验：${issues.join('；')}`);
  return content;
}

export async function runDocumentJob(run, { inputs, dataDir, key, emit, signal, codex = codexTurn, extract = deepseekExtract }) {
  if (!inputs.length) return { status: 'blocked', answer: '请先上传 PDF、PPTX、DOCX、MD 或 TXT 资料。' };
  const deadline = Date.now() + run.limits.maxMinutes * 60000;
  const check = () => { if (signal.aborted) throw new Error('任务已停止'); if (Date.now() > deadline) throw new Error('文档处理达到时间上限'); };
  const documents = [];
  let totalChars = 0;
  emit('stage', { label: '解析上传的资料' });
  for (const input of inputs) {
    check();
    const doc = await extractDocument(input.path, input.name);
    documents.push(doc);
    totalChars += doc.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    emit('source', { name: doc.name, type: doc.type, segments: doc.segments.length });
  }
  if (totalChars > MAX_SOURCE_CHARS) throw new Error(`可提取文字共 ${totalChars} 字，超过单次 24 万字上限；请拆分为多个任务`);
  const chunks = joinChunks(documents);
  const cacheDir = path.join(dataDir, 'document-cache', run.id);
  await fs.mkdir(cacheDir, { recursive: true });
  const manifest = sourceManifest(documents);
  const planSkill = await documentSkill('Chapter planning');
  check();
  emit('stage', { label: 'Codex 规划章节结构' });
  const outline = await codex({ dataDir, signal, emit, prompt: `你是文档整理协调 Agent。${planSkill}\n用户重点：${run.goal || '全面整理'}。资料位置与文字预览：\n${manifest}。只返回简洁章节计划。` });
  const extractions = [];
  for (const [index, chunk] of chunks.entries()) {
    check();
    emit('stage', { label: `DeepSeek 提取知识点 · ${index + 1}/${chunks.length}` });
    const hash = createHash('sha256').update(chunk).update(run.goal).digest('hex');
    const cacheFile = path.join(cacheDir, `${index + 1}-${hash}.json`);
    let chapters;
    try { chapters = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch {}
    if (Array.isArray(chapters)) emit('cache', { label: `复用第 ${index + 1} 块已提取的知识点` });
    else {
      chapters = await extractWithRetry({ source: chunk, outline, focus: run.goal, key, signal, emit }, extract);
      await fs.writeFile(cacheFile, JSON.stringify(chapters), 'utf8');
    }
    extractions.push(chapters);
  }
  const chapters = mergeChapters(extractions);
  if (!chapters.length) return { status: 'blocked', answer: '资料已解析，但没有提取到可核实的知识点。请检查文档是否包含可选中的文字。', plan: outline };
  check();
  emit('stage', { label: 'Codex 整理、核对与排版成品' });
  const title = suggestDocumentTitle(documents, chapters, run.goal);
  const content = await composeKnowledgeMarkdown({ codex, dataDir, signal, emit, documents, chapters, title, focus: run.goal });
  const output = await writeUniqueMarkdown(run.workspace, title, content);
  emit('artifact', { path: output, kind: 'file' });
  return { status: 'completed', answer: `已整理 ${documents.length} 份资料、${chapters.length} 个章节、${chapters.reduce((sum, c) => sum + c.points.length, 0)} 个知识点，并生成《${path.basename(output)}》。`, plan: outline };
}
