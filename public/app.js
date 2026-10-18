const $ = id => document.getElementById(id);
let selectedId = null;
let timer = null;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function statusName(status) {
  return ({ created: '准备中', running: '运行中', completed: '已完成', blocked: '受阻', failed: '失败', cancelled: '已停止', interrupted: '已中断', limit_reached: '达到上限' })[status] || status;
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    $('codex-state').textContent = data.codex || '未检测到 Codex CLI';
    $('key-state').textContent = data.deepseekConfigured ? 'DeepSeek API key 已配置' : '尚未配置 DeepSeek API key';
    $('connection-label').textContent = data.codex && data.deepseekConfigured ? 'Agent 已就绪' : '需要完成连接设置';
    $('status-dot').classList.toggle('good', Boolean(data.codex && data.deepseekConfigured));
  } catch (error) { $('connection-label').textContent = error.message; }
}

async function refreshList() {
  const rows = await api('/api/runs');
  const list = $('run-list');
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'run-item'; empty.textContent = '还没有任务'; list.append(empty);
  }
  for (const run of rows) {
    const button = document.createElement('button');
    button.className = 'run-item' + (run.id === selectedId ? ' active' : '');
    button.textContent = run.goal.length > 35 ? run.goal.slice(0, 35) + '…' : run.goal;
    const small = document.createElement('small'); small.textContent = `${statusName(run.status)} · ${new Date(run.created_at).toLocaleString('zh-CN')}`;
    button.append(small); button.onclick = () => showRun(run.id); list.append(button);
  }
}

function eventText(event) {
  const d = event.data;
  if (event.type === 'stage') return d.label;
  if (event.type === 'codex') return d.text;
  if (event.type === 'model') return `${d.provider} · ${d.model}${d.usage ? ` · ${d.usage.total_tokens || 0} tokens` : ''}`;
  if (event.type === 'tool') return `${d.name} ${JSON.stringify(d.args)}\n${d.result}`;
  if (event.type === 'tool_error') return `${d.name}: ${d.error}`;
  if (event.type === 'artifact') return d.path;
  if (event.type === 'source') return `${d.name} · ${d.type} · ${d.segments} 个片段`;
  if (event.type === 'cache') return d.label;
  if (event.type === 'review') return d.text;
  if (event.type === 'error') return d.message;
  if (event.type === 'final') return d.answer;
  return JSON.stringify(d);
}

function eventTitle(type) {
  return ({ stage: '任务阶段', codex: 'Codex', model: '模型调用', tool: '工具调用', tool_error: '工具异常', artifact: '生成文件', source: '资料解析', cache: '复用结果', review: 'Codex 审核', error: '运行错误', final: '最终结果', resume: '恢复任务', reformat: '重新排版' })[type] || type;
}

function renderArtifacts(run) {
  const container = $('task-artifacts');
  container.replaceChildren();
  const files = new Map();
  for (const event of run.events) {
    if (event.type === 'artifact' && typeof event.data.path === 'string') files.set(event.data.path, event);
  }
  container.classList.toggle('hidden', !run.answer || files.size === 0);
  if (!run.answer || !files.size) return;
  const heading = document.createElement('div'); heading.className = 'artifact-heading'; heading.textContent = '生成的文件';
  container.append(heading);
  for (const [filePath, event] of [...files].reverse()) {
    const link = document.createElement('a');
    link.className = 'artifact-link';
    link.href = `/api/runs/${encodeURIComponent(run.id)}/files/${event.id}`;
    link.textContent = filePath.split(/[\\/]/).pop() || filePath;
    link.title = filePath;
    link.download = link.textContent;
    container.append(link);
  }
}

async function refreshRun() {
  if (!selectedId) return;
  const run = await api(`/api/runs/${selectedId}`);
  $('welcome').classList.add('hidden'); $('task-view').classList.remove('hidden');
  $('task-title').textContent = run.goal;
  $('task-meta').textContent = `${run.workspace} · 创建于 ${new Date(run.created_at).toLocaleString('zh-CN')}`;
  $('task-status').textContent = statusName(run.status);
  $('task-status').className = `badge ${run.status}`;
  $('task-result').textContent = run.answer || 'Agent 正在工作，完成后将在这里显示结果。';
  $('task-result').classList.toggle('muted', !run.answer);
  renderArtifacts(run);
  $('stop-task').classList.toggle('hidden', run.status !== 'running');
  $('resume-task').classList.toggle('hidden', !['interrupted', 'failed', 'limit_reached'].includes(run.status));
  $('reformat-task').classList.toggle('hidden', run.status !== 'completed' || !run.inputCount);
  $('event-count').textContent = `· ${run.events.length} 条`;
  const timeline = $('event-list'); timeline.replaceChildren();
  for (const event of run.events) {
    const el = document.createElement('div'); el.className = 'event';
    const title = document.createElement('div'); title.className = 'event-title'; title.textContent = eventTitle(event.type);
    const time = document.createElement('span'); time.className = 'event-time'; time.textContent = new Date(event.created_at).toLocaleTimeString('zh-CN'); title.append(time);
    const content = document.createElement('div'); content.className = 'event-content'; content.textContent = eventText(event);
    el.append(title, content); timeline.append(el);
  }
  if (run.status === 'running' || run.status === 'created') {
    clearTimeout(timer); timer = setTimeout(async () => { try { await refreshRun(); await refreshList(); } catch {} }, 1600);
  } else clearTimeout(timer);
}

async function showRun(id) { selectedId = id; await refreshRun(); await refreshList(); }

$('task-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('submit-task'); button.disabled = true;
  try {
    const files = [...$('source-files').files];
    if (!files.length || files.length > 10) throw new Error('请选择 1–10 份资料');
    if (files.some(file => file.size > 25_000_000)) throw new Error('单个文件不能超过 25 MB');
    $('selected-files').textContent = `正在上传 ${files.length} 份资料…`;
    const uploads = await Promise.all(files.map(async file => {
      const response = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `上传失败：${file.name}`);
      return data.id;
    }));
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({
      goal: $('goal').value.trim(), workspace: $('workspace').value.trim(), inputs: uploads
    }) });
    $('goal').value = '';
    $('source-files').value = '';
    $('selected-files').textContent = '尚未选择文件';
    await showRun(run.id);
  } catch (error) { alert(error.message); updateSelectedFiles(); } finally { button.disabled = false; }
};

function updateSelectedFiles() {
  const files = [...$('source-files').files];
  $('selected-files').textContent = files.length ? files.map(file => file.name).join(' · ') : '尚未选择文件';
}
$('source-files').onchange = updateSelectedFiles;

$('new-task').onclick = () => { clearTimeout(timer); selectedId = null; $('task-view').classList.add('hidden'); $('welcome').classList.remove('hidden'); $('goal').focus(); refreshList(); };
document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { $('goal').value = button.dataset.prompt; $('goal').focus(); });
$('settings-open').onclick = () => { $('settings-dialog').showModal(); };
$('save-key').onclick = async () => {
  try { await api('/api/key', { method: 'POST', body: JSON.stringify({ key: $('api-key').value.trim() }) }); $('api-key').value = ''; await refreshStatus(); }
  catch (error) { alert(error.message); }
};
$('save-workspace').onclick = () => {
  const value = $('default-workspace').value.trim(); localStorage.setItem('harness.workspace', value); $('workspace').value = value; alert('默认目录已保存在此浏览器中');
};
$('stop-task').onclick = async () => { if (selectedId) { await api(`/api/runs/${selectedId}/cancel`, { method: 'POST' }); await refreshRun(); } };
$('resume-task').onclick = async () => { if (selectedId) { await api(`/api/runs/${selectedId}/resume`, { method: 'POST' }); await refreshRun(); } };
$('reformat-task').onclick = async () => { if (selectedId) { await api(`/api/runs/${selectedId}/reformat`, { method: 'POST' }); await refreshRun(); } };

$('workspace').value = localStorage.getItem('harness.workspace') || '';
$('default-workspace').value = $('workspace').value;
Promise.all([refreshStatus(), refreshList()]).catch(error => alert(error.message));
