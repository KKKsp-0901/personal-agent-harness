import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { extractDocument } from '../src/documents.mjs';
import { compositionIssues, extractWithRetry, runDocumentJob, suggestDocumentTitle, writeUniqueMarkdown } from '../src/document-pipeline.mjs';

test('extracts slide titles and body from PPTX', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-agent-'));
  try {
    const slide = '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第一章 计算机系统</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>CPU 执行指令</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
    const file = path.join(dir, 'course.pptx');
    await fs.writeFile(file, zipSync({ 'ppt/slides/slide1.xml': strToU8(slide) }));
    const doc = await extractDocument(file);
    assert.equal(doc.segments[0].heading, '第一章 计算机系统');
    assert.match(doc.segments[0].text, /CPU 执行指令/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('extracts headings and paragraphs from DOCX', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-agent-'));
  try {
    const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p><w:p><w:r><w:t>存储器保存数据</w:t></w:r></w:p></w:body></w:document>';
    const file = path.join(dir, 'course.docx');
    await fs.writeFile(file, zipSync({ 'word/document.xml': strToU8(xml) }));
    const doc = await extractDocument(file);
    assert.equal(doc.segments[0].heading, '第一章');
    assert.match(doc.segments[0].text, /存储器保存数据/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('editor rejects duplicate chapter headings and missing citations', () => {
  assert.deepEqual(compositionIssues('# 汇总\n## 第六章 LR分析\n## 第六章：LR分析\n内容', 1).includes('存在重复章节标题'), true);
  assert.deepEqual(compositionIssues('# 汇总\n## 正文\n## 资料\n内容', 1).includes('缺少来源标注'), true);
});

test('document workflow writes a verified knowledge summary', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-agent-'));
  try {
    const source = path.join(dir, 'notes.md');
    await fs.writeFile(source, '# 存储系统\n缓存减少平均访存时间。', 'utf8');
    const events = [];
    let codexCalls = 0;
    const result = await runDocumentJob({ id: 'test-job', goal: '提取知识点', workspace: dir, limits: { maxMinutes: 1 } }, {
      inputs: [{ name: 'notes.md', path: source }], dataDir: dir, key: 'test', signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      codex: async () => ++codexCalls === 1 ? '存储系统' : '# 存储系统 · 知识点汇总\n\n## 核心概念\n\n缓存通过保存近期或高频数据来减少平均访存时间。理解它时应区分命中率、访问延迟与存储容量，这些因素共同影响实际效果。\n\n> 来源：notes.md · 全文\n\n## 复习自测\n\n- 缓存为何能降低平均访存时间？\n- 命中率变化会怎样影响效果？\n\n这份汇总依据上传的资料整理，未读取图片或扫描文字。',
      extract: async () => [{ title: '存储系统', points: [{ name: '缓存', detail: '减少平均访存时间。', source: 'notes.md · 全文' }], questions: [] }]
    });
    assert.equal(result.status, 'completed');
    assert.equal(codexCalls, 2);
    assert.equal(events.filter(event => event.type === 'artifact').length, 1);
    assert.match(await fs.readFile(path.join(dir, '存储系统-知识点汇总.md'), 'utf8'), /缓存/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('content based names differ and repeated course gets a number', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-agent-'));
  try {
    const docs = [{ name: 'ch06-course.pdf' }];
    const title = suggestDocumentTitle(docs, [{ title: '第6章：自底向上LR语法分析方法' }, { title: '第6章：LR分析' }]);
    assert.equal(title, '第6章-自底向上LR语法分析方法');
    const first = await writeUniqueMarkdown(dir, title, 'first');
    const second = await writeUniqueMarkdown(dir, title, 'second');
    const other = await writeUniqueMarkdown(dir, suggestDocumentTitle([{ name: 'network.pdf' }], [{ title: '计算机网络' }]), 'other');
    assert.equal(path.basename(first), '第6章-自底向上LR语法分析方法-知识点汇总.md');
    assert.equal(path.basename(second), '第6章-自底向上LR语法分析方法-知识点汇总（2）.md');
    assert.equal(path.basename(other), '计算机网络-知识点汇总.md');
    assert.equal(await fs.readFile(first, 'utf8'), 'first');
    assert.equal(suggestDocumentTitle([{ name: '资料.pdf' }], [{ title: 'CPU' }, { title: '存储器' }]), 'CPU与存储器');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('truncated model output is split and retried', async () => {
  const sources = [];
  const result = await extractWithRetry({ source: `[来源：notes.md · 全文]\n${'知识点内容\n'.repeat(500)}`, emit: () => {} }, async ({ source }) => {
    sources.push(source);
    if (source.length > 2000) { const error = new Error('too long'); error.code = 'OUTPUT_TRUNCATED'; throw error; }
    return [{ title: '章节', points: [{ name: '知识点', detail: '说明', source: 'notes.md · 全文' }] }];
  });
  assert.ok(sources.length > 2);
  assert.ok(result.length > 1);
});
