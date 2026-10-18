import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

export const SUPPORTED_DOCUMENTS = ['.pdf', '.pptx', '.docx', '.md', '.txt'];
const parser = new XMLParser({ ignoreAttributes: false, trimValues: false, parseTagValue: false });

function values(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function textNodes(node, tag) {
  if (node == null) return [];
  if (Array.isArray(node)) return node.flatMap(item => textNodes(item, tag));
  if (typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => key === tag ? values(value).map(String) : textNodes(value, tag));
}
function zipXml(zip, name) {
  const data = zip[name];
  if (!data) throw new Error(`文档缺少 ${name}`);
  return parser.parse(Buffer.from(data).toString('utf8'));
}

function extractPptx(buffer) {
  const zip = unzipSync(new Uint8Array(buffer), { filter: file => /^ppt\/slides\/slide\d+\.xml$/.test(file.name) });
  const slides = Object.keys(zip).sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  if (!slides.length) throw new Error('PPTX 中没有可读取的幻灯片');
  return slides.map((file, index) => {
    const xml = zipXml(zip, file);
    const tree = xml['p:sld']?.['p:cSld']?.['p:spTree'] || {};
    const shapes = values(tree['p:sp']);
    const lines = [];
    let title = '';
    for (const shape of shapes) {
      const paragraphs = values(shape['p:txBody']?.['a:p']);
      const shapeLines = paragraphs.map(p => textNodes(p, 'a:t').join('')).filter(Boolean);
      if (!title && /^(title|ctrTitle)$/.test(shape['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type'] || '')) title = shapeLines[0] || '';
      lines.push(...shapeLines);
    }
    for (const frame of values(tree['p:graphicFrame'])) lines.push(...textNodes(frame, 'a:t'));
    title ||= lines[0] || `幻灯片 ${index + 1}`;
    return { location: `第 ${index + 1} 页`, heading: title, text: lines.join('\n').trim() };
  });
}

function extractDocx(buffer) {
  const zip = unzipSync(new Uint8Array(buffer), { filter: file => file.name === 'word/document.xml' });
  const xml = zipXml(zip, 'word/document.xml');
  const body = xml['w:document']?.['w:body'];
  if (!body) throw new Error('Word 文档内容不可读取');
  const segments = [];
  let heading = '正文';
  let lines = [];
  const flush = () => { if (lines.length) segments.push({ location: heading, heading, text: lines.join('\n') }); lines = []; };
  for (const paragraph of values(body['w:p'])) {
    const text = textNodes(paragraph, 'w:t').join('').trim();
    if (!text) continue;
    const style = paragraph['w:pPr']?.['w:pStyle']?.['@_w:val'] || '';
    if (/^(Heading[1-6]|标题[1-6]|Title)$/i.test(style)) { flush(); heading = text; }
    else lines.push(text);
  }
  for (const table of values(body['w:tbl'])) {
    for (const row of values(table['w:tr'])) {
      const cells = values(row['w:tc']).map(cell => textNodes(cell, 'w:t').join('').trim());
      if (cells.some(Boolean)) lines.push(cells.join(' | '));
    }
  }
  flush();
  return segments.length ? segments : [{ location: '正文', heading: '正文', text: '' }];
}

async function extractPdf(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true });
  const pdf = await loading.promise;
  try {
    if (pdf.numPages > 300) throw new Error('PDF 超过 300 页，请拆分后上传');
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const lines = [];
      let line = '', y = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const nextY = item.transform?.[5];
        if (line && y != null && nextY != null && Math.abs(nextY - y) > 2) { lines.push(line.trim()); line = ''; }
        line += item.str + (item.hasEOL ? '\n' : ' ');
        if (item.hasEOL) { lines.push(line.trim()); line = ''; }
        y = nextY;
      }
      if (line.trim()) lines.push(line.trim());
      pages.push({ location: `第 ${index} 页`, heading: `第 ${index} 页`, text: lines.filter(Boolean).join('\n') });
      page.cleanup();
    }
    if (pages.reduce((sum, page) => sum + page.text.length, 0) < 30) throw new Error('PDF 没有可提取的文字层；扫描版请先进行 OCR');
    return pages;
  } finally { await loading.destroy(); }
}

export async function extractDocument(filePath, name = path.basename(filePath)) {
  const ext = path.extname(name).toLowerCase();
  if (!SUPPORTED_DOCUMENTS.includes(ext)) throw new Error(`不支持 ${ext || '未知'} 格式；请使用 PDF、PPTX、DOCX、MD 或 TXT`);
  const buffer = await fs.readFile(filePath);
  let segments;
  if (ext === '.pdf') segments = await extractPdf(buffer);
  else if (ext === '.pptx') segments = extractPptx(buffer);
  else if (ext === '.docx') segments = extractDocx(buffer);
  else segments = [{ location: '全文', heading: '全文', text: buffer.toString('utf8') }];
  segments = segments.map(segment => ({ ...segment, text: segment.text.replace(/\r/g, '').trim() })).filter(segment => segment.text);
  if (!segments.length) throw new Error(`${name} 中没有可提取的文字`);
  return { name, type: ext.slice(1).toUpperCase(), segments };
}
