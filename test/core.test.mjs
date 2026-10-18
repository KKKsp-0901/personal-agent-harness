import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizedPath, normalizeLimits, runTool, safeWebUrl } from '../src/core.mjs';

test('normalizes execution limits', () => {
  assert.deepEqual(normalizeLimits({ maxSteps: 999, maxRounds: 0, maxMinutes: 2 }), { maxSteps: 30, maxRounds: 1, maxMinutes: 2 });
});

test('workspace tool can write and read text but refuses escape paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-test-'));
  try {
    const events = [];
    const context = { workspace: dir, emit: (type, data) => events.push({ type, data }) };
    assert.match(await runTool('write_file', { path: 'note.md', content: 'hello' }, context), /已写入/);
    assert.equal(await runTool('read_file', { path: 'note.md' }, context), 'hello');
    await assert.rejects(authorizedPath(dir, '../outside.md', { write: true }), /超出授权目录/);
    await assert.rejects(runTool('write_file', { path: 'bad.js', content: 'x' }, context), /只能写入/);
    assert.equal(events.filter(e => e.type === 'artifact').length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('web tool rejects local addresses', () => {
  assert.throws(() => safeWebUrl('http://127.0.0.1/private'), /不允许/);
  assert.throws(() => safeWebUrl('file:///secret'), /只支持/);
  assert.equal(safeWebUrl('https://example.com/page').hostname, 'example.com');
});
