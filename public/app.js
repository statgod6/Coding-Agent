/* Data Agent — minimal client.
 * BYOK: keys live in localStorage, sent as headers per request.
 */
(() => {
  'use strict';

  const LS = {
    openrouter: 'da.openrouterKey',
    e2b: 'da.e2bKey',
    model: 'da.model',
    thread: 'da.threadId',
    userId: 'da.userId',
    theme: 'da.theme',
    sidebar: 'da.sidebar',
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    messages: $('messages'),
    prompt: $('prompt'),
    sendBtn: $('sendBtn'),
    newChatBtn: $('newChatBtn'),
    modelSelect: $('modelSelect'),
    settingsBtn: $('settingsBtn'),
    settingsModal: $('settingsModal'),
    closeSettings: $('closeSettings'),
    saveKeys: $('saveKeys'),
    clearKeys: $('clearKeys'),
    openrouterKey: $('openrouterKey'),
    e2bKey: $('e2bKey'),
    orDot: $('orDot'),
    e2bDot: $('e2bDot'),
    attachBtn: $('attachBtn'),
    fileInput: $('fileInput'),
    uploadChips: $('uploadChips'),
    convoList: $('convoList'),
    themeToggle: $('themeToggle'),
    sidebarToggle: $('sidebarToggle'),
  };

  // ---------------- State ----------------
  const state = {
    get openrouterKey() { return localStorage.getItem(LS.openrouter) || ''; },
    get e2bKey() { return localStorage.getItem(LS.e2b) || ''; },
    get model() { return localStorage.getItem(LS.model) || 'deepseek/deepseek-v3.2'; },
    get threadId() {
      let t = localStorage.getItem(LS.thread);
      if (!t) { t = crypto.randomUUID(); localStorage.setItem(LS.thread, t); }
      return t;
    },
    // Stable per-browser id so conversations are scoped to this user/device.
    get userId() {
      let u = localStorage.getItem(LS.userId);
      if (!u) { u = 'u_' + crypto.randomUUID(); localStorage.setItem(LS.userId, u); }
      return u;
    },
    setThread(id) { localStorage.setItem(LS.thread, id); },
    newThread() {
      const t = crypto.randomUUID();
      localStorage.setItem(LS.thread, t);
      return t;
    },
  };

  let busy = false;

  // ---------------- Theme ----------------
  function currentTheme() {
    return localStorage.getItem(LS.theme) === 'dark' ? 'dark' : 'light';
  }
  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    if (el.themeToggle) {
      el.themeToggle.textContent = t === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
    }
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(LS.theme, next);
    applyTheme(next);
  }

  // ---------------- Sidebar ----------------
  function toggleSidebar() {
    const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
    localStorage.setItem(LS.sidebar, collapsed ? 'collapsed' : 'open');
  }

  // ---------------- Settings ----------------
  function refreshKeyStatus() {
    el.orDot.classList.toggle('ok', !!state.openrouterKey);
    el.e2bDot.classList.toggle('ok', !!state.e2bKey);
  }
  function openSettings() {
    el.openrouterKey.value = state.openrouterKey;
    el.e2bKey.value = state.e2bKey;
    el.settingsModal.classList.remove('hidden');
  }
  function closeSettings() { el.settingsModal.classList.add('hidden'); }
  function saveKeys() {
    localStorage.setItem(LS.openrouter, el.openrouterKey.value.trim());
    localStorage.setItem(LS.e2b, el.e2bKey.value.trim());
    refreshKeyStatus();
    closeSettings();
  }
  function clearKeys() {
    localStorage.removeItem(LS.openrouter);
    localStorage.removeItem(LS.e2b);
    el.openrouterKey.value = '';
    el.e2bKey.value = '';
    refreshKeyStatus();
  }

  // ---------------- DOM helpers ----------------
  function clearEmptyState() {
    const es = el.messages.querySelector('.empty-state');
    if (es) es.remove();
  }
  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }
  function addMessage(role) {
    clearEmptyState();
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    wrap.innerHTML = `
      <div class="avatar">${role === 'user' ? '🧑' : '🦁'}</div>
      <div class="body">
        <div class="role">${role === 'user' ? 'You' : 'Data Agent'}</div>
        <div class="content"></div>
        <div class="artifacts"></div>
      </div>`;
    el.messages.appendChild(wrap);
    scrollToBottom();
    return {
      content: wrap.querySelector('.content'),
      artifacts: wrap.querySelector('.artifacts'),
    };
  }

  // ---------------- Tiny markdown renderer ----------------
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  function renderMarkdown(md) {
    const lines = md.split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // closing fence
        html += `<pre><code class="lang-${lang}">${escapeHtml(buf.join('\n'))}</code></pre>`;
        continue;
      }

      // Table (header row + separator)
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        const parseRow = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const headers = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') { rows.push(parseRow(lines[i])); i++; }
        html += '<table><thead><tr>' + headers.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>';
        for (const r of rows) html += '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        html += '</tbody></table>';
        continue;
      }

      // Heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const lvl = h[1].length; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; i++; continue; }

      // Unordered list
      if (/^\s*[-*]\s+/.test(line)) {
        html += '<ul>';
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`; i++;
        }
        html += '</ul>';
        continue;
      }
      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        html += '<ol>';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`; i++;
        }
        html += '</ol>';
        continue;
      }

      // Blank line
      if (line.trim() === '') { i++; continue; }

      // Paragraph (gather consecutive plain lines)
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) &&
        !/\|/.test(lines[i])
      ) { buf.push(lines[i]); i++; }
      html += `<p>${inline(buf.join(' '))}</p>`;
    }
    return html;
  }

  // ---------------- Streaming render context ----------------
  // The assistant bubble is built from an ORDERED sequence of segments
  // appended into `.content`: text blocks and tool cards interleaved. We never
  // replace `.content` innerHTML wholesale (that would erase tool cards), we
  // only ever update the *current* text segment or the *running* tool card.
  function newRenderCtx(asst) {
    return {
      content: asst.content,
      artifacts: asst.artifacts,
      textEl: null, // active text segment element
      textBuf: '', // markdown buffer for the active text segment
      runningTool: null, // active tool card element (for live output)
    };
  }

  function appendToken(ctx, delta) {
    if (!delta) return;
    if (!ctx.textEl) {
      ctx.textEl = document.createElement('div');
      ctx.textEl.className = 'seg-text';
      ctx.content.appendChild(ctx.textEl);
      ctx.textBuf = '';
    }
    ctx.textBuf += delta;
    ctx.textEl.innerHTML = renderMarkdown(ctx.textBuf);
    scrollToBottom();
  }

  // Any non-text event ends the current text run so the next tokens start a
  // fresh block *after* the tool card / notice.
  function breakText(ctx) {
    ctx.textEl = null;
    ctx.textBuf = '';
  }

  // ---------------- Tool call cards ----------------
  function toolCard(ctx, id, name, args) {
    breakText(ctx);
    const d = document.createElement('details');
    d.className = 'tool';
    d.open = true;
    d.dataset.toolId = id || '';
    const code = args && typeof args.code === 'string' ? args.code : '';
    const codeBlock = code
      ? `<pre class="tool-code"><code>${escapeHtml(code)}</code></pre>`
      : (args && Object.keys(args).length
          ? `<pre class="tool-code"><code>${escapeHtml(JSON.stringify(args, null, 2))}</code></pre>`
          : '');
    const icon = name === 'run_python' ? '🐍' : (name === 'install_package' ? '📦' : (name === 'save_artifact' ? '💾' : '🔧'));
    d.innerHTML = `
      <summary><span class="spin">●</span> <span class="tool-icon">${icon}</span> <span class="tool-name">${escapeHtml(name || 'tool')}</span> <span class="tool-state">running…</span></summary>
      ${codeBlock}
      <pre class="tool-out" style="display:none"></pre>`;
    ctx.content.appendChild(d);
    ctx.runningTool = d;
    scrollToBottom();
    return d;
  }

  // Live stdout/stderr streamed while the sandbox runs.
  function appendToolOutput(ctx, stream, delta) {
    if (!delta) return;
    const d = ctx.runningTool || ctx.content.querySelector('details.tool:last-of-type');
    if (!d) return;
    const out = d.querySelector('.tool-out');
    if (!out) return;
    out.style.display = 'block';
    out.dataset.live = '1';
    const span = document.createElement('span');
    if (stream === 'stderr') span.className = 'out-err';
    span.textContent = delta.endsWith('\n') ? delta : delta + '\n';
    out.appendChild(span);
    scrollToBottom();
  }

  function toolResult(ctx, id, output) {
    let d = id ? ctx.content.querySelector(`details[data-tool-id="${CSS.escape(id)}"]`) : null;
    if (!d) d = ctx.runningTool;
    if (!d) return;
    const spin = d.querySelector('.spin');
    if (spin) { spin.textContent = '✓'; spin.style.color = 'var(--green)'; }
    const stateEl = d.querySelector('.tool-state');
    if (stateEl) stateEl.textContent = 'done';
    const out = d.querySelector('.tool-out');
    // Only fill from the final result if nothing streamed live (avoids
    // duplicating the stdout we already showed line-by-line).
    if (out && out.dataset.live !== '1') {
      out.textContent = output || '(no output)';
      out.style.display = 'block';
    }
    if (ctx.runningTool === d) ctx.runningTool = null;
  }

  // ---------------- Artifacts ----------------
  function addArtifact(container, a) {
    const box = document.createElement('div');
    box.className = 'artifact';
    const isImg = (a.kind === 'image') || /\.(png|jpe?g|gif|svg|webp)$/i.test(a.filename || '');
    const url = a.url || '#';
    box.innerHTML =
      (isImg ? `<img src="${url}" alt="${escapeHtml(a.label || a.filename || 'artifact')}" />` : '') +
      `<a href="${url}" target="_blank" rel="noopener" download>⬇ ${escapeHtml(a.filename || 'download')}</a>`;
    container.appendChild(box);
    scrollToBottom();
  }

  // ---------------- SSE streaming ----------------
  async function send() {
    if (busy) return;
    const text = el.prompt.value.trim();
    if (!text) return;

    if (!state.openrouterKey || !state.e2bKey) {
      openSettings();
      return;
    }

    busy = true;
    el.sendBtn.disabled = true;
    el.prompt.value = '';
    el.prompt.style.height = 'auto';

    addMessage('user').content.innerHTML = renderMarkdown(text);
    const asst = addMessage('assistant');
    const ctx = newRenderCtx(asst);

    try {
      const resp = await fetch('/api/data-agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-openrouter-key': state.openrouterKey,
          'x-e2b-key': state.e2bKey,
        },
        body: JSON.stringify({
          threadId: state.threadId,
          userId: state.userId,
          message: text,
          model: state.model,
        }),
      });

      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        asst.content.innerHTML = `<div class="err">Request failed (${resp.status}). ${escapeHtml(txt)}</div>`;
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          if (!frame.trim()) continue;
          let event = 'message';
          let dataStr = '';
          for (const l of frame.split('\n')) {
            if (l.startsWith('event:')) event = l.slice(6).trim();
            else if (l.startsWith('data:')) dataStr += l.slice(5).trim();
          }
          let data = {};
          try { data = dataStr ? JSON.parse(dataStr) : {}; } catch { data = { raw: dataStr }; }

          if (event === 'token') {
            appendToken(ctx, data.delta || '');
          } else if (event === 'thinking') {
            breakText(ctx);
            const t = document.createElement('div');
            t.className = 'thinking';
            t.textContent = data.delta || '';
            ctx.content.appendChild(t);
          } else if (event === 'tool_call') {
            toolCard(ctx, data.id, data.tool, data.args);
          } else if (event === 'tool_output') {
            appendToolOutput(ctx, data.stream, data.delta || '');
          } else if (event === 'tool_result') {
            toolResult(ctx, data.id, data.output);
          } else if (event === 'artifact') {
            addArtifact(ctx.artifacts, data);
          } else if (event === 'error') {
            breakText(ctx);
            const e = document.createElement('div');
            e.className = 'err';
            e.textContent = data.message || 'Unknown error';
            ctx.content.appendChild(e);
          } else if (event === 'done') {
            // stream complete
          }
        }
      }
    } catch (err) {
      breakText(ctx);
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = String(err);
      ctx.content.appendChild(e);
    } finally {
      busy = false;
      el.sendBtn.disabled = false;
      scrollToBottom();
      // The conversation now exists / moved to the top — refresh the sidebar.
      refreshConversations();
    }
  }

  // ---------------- Upload ----------------
  async function uploadFile(file) {
    if (!state.e2bKey) { openSettings(); return; }
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = `⏳ ${file.name}`;
    el.uploadChips.appendChild(chip);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('threadId', state.threadId);
    try {
      const resp = await fetch('/api/data-agent/upload', {
        method: 'POST',
        headers: { 'x-e2b-key': state.e2bKey },
        body: fd,
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        chip.className = 'chip ok';
        chip.textContent = `✓ ${data.filename || file.name}`;
      } else {
        chip.className = 'chip err';
        chip.textContent = `✗ ${data.error || 'upload failed'}`;
      }
    } catch (e) {
      chip.className = 'chip err';
      chip.textContent = `✗ ${String(e)}`;
    }
  }

  // ---------------- Conversation history ----------------
  const EMPTY_STATE_HTML = `
      <div class="empty-state">
        <div class="empty-emoji">📊</div>
        <h1>What can I analyze for you?</h1>
        <p>Upload a dataset and ask a question. I run Python in a sandbox, build charts, and export results — all live.</p>
      </div>`;

  function showEmptyState() {
    el.messages.innerHTML = EMPTY_STATE_HTML;
  }

  // Rebuild a past conversation from its stored messages. Mirrors the live
  // renderer: user bubbles, assistant bubbles, tool cards (code) + results.
  // Returns the last assistant render-ctx so artifacts can be attached.
  function renderHistory(messages) {
    el.messages.innerHTML = '';
    if (!messages || messages.length === 0) { showEmptyState(); return null; }
    let ctx = null;
    for (const m of messages) {
      if (m.role === 'user') {
        ctx = null;
        addMessage('user').content.innerHTML = renderMarkdown(m.content || '');
      } else if (m.role === 'assistant') {
        const asst = addMessage('assistant');
        ctx = newRenderCtx(asst);
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) toolCard(ctx, tc.id, tc.name, tc.args || {});
        }
        if (m.content && m.content.trim()) {
          breakText(ctx);
          appendToken(ctx, m.content);
        }
      } else if (m.role === 'tool') {
        if (ctx) toolResult(ctx, m.tool_call_id, m.content);
      }
    }
    return ctx;
  }

  async function openConversation(id) {
    if (busy) return;
    state.setThread(id);
    markActiveConvo(id);
    el.uploadChips.innerHTML = '';
    try {
      const resp = await fetch(`/api/data-agent/threads/${id}/messages`);
      const data = await resp.json().catch(() => ({ messages: [] }));
      const lastCtx = renderHistory(data.messages || []);
      // Re-attach any saved artifacts to the last assistant bubble.
      if (lastCtx) {
        const arts = await fetch(`/api/data-agent/threads/${id}/artifacts`)
          .then((r) => r.json())
          .catch(() => []);
        // Endpoint returns newest-first; render chronologically.
        arts.slice().reverse().forEach((a) => addArtifact(lastCtx.artifacts, a));
      }
    } catch (err) {
      el.messages.innerHTML = `<div class="err">Could not load conversation: ${escapeHtml(String(err))}</div>`;
    }
    scrollToBottom();
  }

  function startNewConversation() {
    state.newThread();
    showEmptyState();
    el.uploadChips.innerHTML = '';
    markActiveConvo(null);
  }

  function markActiveConvo(id) {
    for (const item of el.convoList.querySelectorAll('.convo-item')) {
      item.classList.toggle('active', item.dataset.id === id);
    }
  }

  function renderConvoList(list) {
    el.convoList.innerHTML = '';
    if (!list || list.length === 0) {
      el.convoList.innerHTML = '<div class="convo-empty">No conversations yet</div>';
      return;
    }
    const current = localStorage.getItem(LS.thread);
    for (const c of list) {
      const item = document.createElement('div');
      item.className = 'convo-item' + (c.id === current ? ' active' : '');
      item.dataset.id = c.id;
      item.innerHTML =
        `<span class="convo-title">${escapeHtml(c.title || 'Untitled')}</span>` +
        `<button class="convo-del" title="Delete conversation">✕</button>`;
      item.addEventListener('click', () => openConversation(c.id));
      item.querySelector('.convo-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/data-agent/threads/${c.id}`, { method: 'DELETE' }).catch(() => {});
        if (c.id === localStorage.getItem(LS.thread)) startNewConversation();
        refreshConversations();
      });
      el.convoList.appendChild(item);
    }
  }

  async function refreshConversations() {
    try {
      const list = await fetch(
        `/api/data-agent/threads?userId=${encodeURIComponent(state.userId)}`
      ).then((r) => r.json());
      renderConvoList(Array.isArray(list) ? list : []);
    } catch {
      /* sidebar is best-effort */
    }
  }

  // ---------------- Wiring ----------------
  function autoGrow() {
    el.prompt.style.height = 'auto';
    el.prompt.style.height = Math.min(el.prompt.scrollHeight, 200) + 'px';
  }

  el.sendBtn.addEventListener('click', send);
  el.prompt.addEventListener('input', autoGrow);
  el.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  el.newChatBtn.addEventListener('click', () => {
    startNewConversation();
    refreshConversations();
  });
  el.modelSelect.addEventListener('change', () => localStorage.setItem(LS.model, el.modelSelect.value));
  el.settingsBtn.addEventListener('click', openSettings);
  el.themeToggle.addEventListener('click', toggleTheme);
  el.sidebarToggle.addEventListener('click', toggleSidebar);
  el.closeSettings.addEventListener('click', closeSettings);
  el.saveKeys.addEventListener('click', saveKeys);
  el.clearKeys.addEventListener('click', clearKeys);
  el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) closeSettings(); });
  el.attachBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    for (const f of el.fileInput.files) uploadFile(f);
    el.fileInput.value = '';
  });

  // ---------------- Init ----------------
  el.modelSelect.value = state.model;
  applyTheme(currentTheme());
  refreshKeyStatus();
  if (!state.openrouterKey || !state.e2bKey) openSettings();
  refreshConversations();
  // Restore the last open conversation on reload (shows empty state if new).
  {
    const t = localStorage.getItem(LS.thread);
    if (t) openConversation(t);
  }
})();
