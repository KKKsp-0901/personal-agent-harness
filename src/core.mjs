import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_LIMITS = { maxSteps: 12, maxRounds: 3, maxMinutes: 20 };
export const TOOL_NAMES = ['list_files', 'read_file', 'write_file', 'web_search', 'fetch_web'];

export function normalizeLimits(input = {}) {
  return {
    maxSteps: clamp(input.maxSteps, 1, 30, DEFAULT_LIMITS.maxSteps),
    maxRounds: clamp(input.maxRounds, 1, 5, DEFAULT_LIMITS.maxRounds),
    maxMinutes: clamp(input.maxMinutes, 1, 60, DEFAULT_LIMITS.maxMinutes)
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export async function authorizedPath(root, requested, { write = false } = {}) {
  const base = await fs.realpath(root);
  const candidate = path.resolve(base, String(requested || '.'));
  const relative = path.relative(base, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('路径超出授权目录');
  }
  let existing = candidate;
  while (true) {
    try { existing = await fs.realpath(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('路径不可访问');
      existing = parent;
    }
  }
  const realRelative = path.relative(base, existing);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('路径通过链接指向授权目录之外');
  }
  if (!write) {
    const stat = await fs.stat(candidate);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('不支持的文件类型');
  }
  return candidate;
}

export function safeWebUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 HTTP(S) 地址');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('不允许访问本地或内网地址');
  return url;
}

export async function runTool(name, args, context) {
  const { workspace, emit, signal } = context;
  if (signal?.aborted) throw new Error('任务已停止');
  if (!TOOL_NAMES.includes(name)) throw new Error(`未知工具：${name}`);
  let result;
  if (name === 'list_files') {
    const target = await authorizedPath(workspace, args.path || '.');
    const entries = await fs.readdir(target, { withFileTypes: true });
    result = entries.filter(e => !e.name.startsWith('.')).slice(0, 150)
      .map(e => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`).join('\n') || '目录为空（没有可见文件）';
  } else if (name === 'read_file') {
    const target = await authorizedPath(workspace, args.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('只能读取文件');
    if (stat.size > 1_000_000) throw new Error('文件超过 1 MB');
    if (!/\.(md|markdown|txt|csv|json|yaml|yml|log)$/i.test(target)) throw new Error('首版仅支持文本文件');
    result = (await fs.readFile(target, 'utf8')).slice(0, 100_000);
  } else if (name === 'write_file') {
    const target = await authorizedPath(workspace, args.path, { write: true });
    if (!/\.(md|markdown|txt)$/i.test(target)) throw new Error('只能写入 Markdown 或纯文本文件');
    const content = String(args.content ?? '');
    if (Buffer.byteLength(content) > 1_000_000) throw new Error('写入内容超过 1 MB');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, content, { flag: 'wx' });
    await fs.rename(temp, target);
    const verified = await fs.readFile(target, 'utf8');
    if (verified !== content) throw new Error('写入后校验失败');
    result = `已写入并回读校验 ${path.relative(workspace, target)}（${content.length} 字符）\n内容预览：${content.slice(0, 3000)}`;
    emit?.('artifact', { path: target, kind: 'file' });
  } else if (name === 'web_search') {
    result = await webSearch(String(args.query || ''), signal);
  } else if (name === 'fetch_web') {
    result = await fetchWeb(String(args.url || ''), signal);
  }
  emit?.('tool', { name, args: redactArgs(name, args), result: String(result).slice(0, 500) });
  return result;
}

function redactArgs(name, args) {
  return name === 'write_file' ? { path: args.path, contentLength: String(args.content || '').length } : args;
}

async function webSearch(query, signal) {
  if (!query.trim() || query.length > 300) throw new Error('搜索词无效');
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(12000)]), headers: { 'User-Agent': 'Mozilla/5.0 PersonalAgentHarness/0.1' } });
  if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map(([, item]) => ({
    title: xmlValue(item, 'title'), url: xmlValue(item, 'link'), snippet: xmlValue(item, 'description')
  })).filter(item => { try { safeWebUrl(item.url); return true; } catch { return false; } });
  if (!items.length) throw new Error('搜索未返回可引用结果');
  return JSON.stringify(items);
}

function xmlValue(xml, tag) {
  const value = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '';
  return value.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}

async function fetchWeb(rawUrl, signal) {
  let url = safeWebUrl(rawUrl);
  let response;
  for (let i = 0; i < 4; i++) {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(12000)]), headers: { 'User-Agent': 'Mozilla/5.0 PersonalAgentHarness/0.1' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    url = safeWebUrl(new URL(response.headers.get('location'), url).href);
  }
  if (!response.ok) throw new Error(`网页返回 ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!/text\/html|text\/plain/.test(type)) throw new Error('只支持 HTML 或纯文本网页');
  const text = (await response.text()).slice(0, 250_000).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return JSON.stringify({ url: url.href, text: text.slice(0, 16000) });
}
