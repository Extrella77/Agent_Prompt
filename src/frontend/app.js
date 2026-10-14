/* ==========================================================================
 * DeepSeek 风格知识库问答 · 前端交互
 * - 通信：axios（fetch adapter + responseType: 'stream'）解析 SSE，失败自动回退原生 fetch
 * - 会话：后端多会话存储，左侧历史栏可新建 / 切换 / 删除对话
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------ 基础配置 ------------------------------ */
  // 由后端托管页面时同源访问；直接用浏览器打开本地 html 时才走绝对地址
  var API_BASE = location.protocol === 'http:' || location.protocol === 'https:'
    ? ''
    : 'http://127.0.0.1:8000';

  // 支持通过 ?api=http://127.0.0.1:8000 手动指定后端地址
  var apiParam = new URLSearchParams(location.search).get('api');
  if (apiParam) API_BASE = apiParam.replace(/\/+$/, '');

  var AI_AVATAR =
    '<span class="avatar"><svg viewBox="0 0 48 48" fill="none">' +
    '<path d="M42.6 13.4c-6.9 1.5-11.9 5.9-14.4 11.9-2.4-4.6-7.3-8-13.1-8.9 1.5 2.8 2.2 5.6 2.2 8.3 0 6.6-4.7 12.3-11.2 13.7 3.9 2.5 8.5 3.7 13.5 3.7 12.4 0 22.6-8.6 24.5-20.7.3-2.3.3-4.6-.1-6.9-.4-.4-.9-.8-1.4-1.1z" fill="currentColor"/></svg></span>';

  var SESSION_ICON =
    '<svg class="item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-2.9-.4L4 21l1.4-4.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>';

  var DELETE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6m2 0v13.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5V6"/><path d="M10 11v6M14 11v6"/></svg>';

  /* ------------------------------ DOM ------------------------------ */
  var appEl = document.getElementById('app');
  var chatEl = document.getElementById('chat');
  var messagesEl = document.getElementById('messages');
  var welcomeEl = document.getElementById('welcome');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('sendBtn');
  var stopBtn = document.getElementById('stopBtn');
  var clearBtn = document.getElementById('clearBtn');
  var themeBtn = document.getElementById('themeBtn');
  var chipsEl = document.getElementById('chips');
  var sessionListEl = document.getElementById('sessionList');
  var sidebarEmptyEl = document.getElementById('sidebarEmpty');
  var newChatBtn = document.getElementById('newChatBtn');
  var toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
  var chatTitleEl = document.getElementById('chatTitle');

  var modalMask = document.getElementById('modalMask');
  var modalTitle = document.getElementById('modalTitle');
  var modalDesc = document.getElementById('modalDesc');
  var modalConfirm = document.getElementById('modalConfirm');
  var modalCancel = document.getElementById('modalCancel');

  var state = { busy: false, controller: null, currentId: null, sessions: [] };
  var stickBottom = true;

  /* ------------------------------ 通用请求 ------------------------------ */
  function errText(err) {
    if (!err) return '未知错误';
    var data = err.response && err.response.data;
    if (data && data.detail) return String(data.detail);
    return err.message || String(err);
  }

  async function http(method, url, data) {
    if (window.axios) {
      try {
        if (method === 'get') return (await axios.get(url)).data;
        if (method === 'delete') return (await axios.delete(url)).data;
        return (await axios.post(url, data || {})).data;
      } catch (err) {
        throw new Error(errText(err));
      }
    }

    var options = { method: method.toUpperCase(), headers: {} };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }
    var res = await fetch(url, options);
    var payload = null;
    try { payload = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error((payload && payload.detail) || 'HTTP ' + res.status);
    return payload;
  }

  /* ------------------------------ 主题 ------------------------------ */
  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('ds-theme', theme); } catch (e) { /* ignore */ }
  }

  (function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('ds-theme'); } catch (e) { /* ignore */ }
    if (saved === 'dark' || saved === 'light') return setTheme(saved);
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(dark ? 'dark' : 'light');
  })();

  themeBtn.addEventListener('click', function () {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  /* ------------------------------ 确认弹窗 ------------------------------ */
  function openConfirm(options) {
    return new Promise(function (resolve) {
      modalTitle.textContent = options.title || '确认操作？';
      modalDesc.textContent = options.desc || '';
      modalConfirm.textContent = options.confirmText || '确定';
      modalMask.hidden = false;

      function cleanup(result) {
        modalMask.hidden = true;
        modalConfirm.removeEventListener('click', onOk);
        modalCancel.removeEventListener('click', onCancel);
        modalMask.removeEventListener('click', onMask);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onMask(e) { if (e.target === modalMask) cleanup(false); }
      function onKey(e) { if (e.key === 'Escape') cleanup(false); }

      modalConfirm.addEventListener('click', onOk);
      modalCancel.addEventListener('click', onCancel);
      modalMask.addEventListener('click', onMask);
      document.addEventListener('keydown', onKey);
      modalConfirm.focus();
    });
  }

  /* ------------------------------ 滚动 ------------------------------ */
  function scrollToBottom(instant) {
    if (instant) {
      chatEl.scrollTop = chatEl.scrollHeight;
    } else {
      chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' });
    }
  }

  chatEl.addEventListener('scroll', function () {
    stickBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
  });

  function maybeAutoScroll() {
    if (stickBottom) chatEl.scrollTop = chatEl.scrollHeight;
  }

  /* ------------------------------ 消息渲染 ------------------------------ */
  function appendUserMessage(text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg user';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
  }

  function createAiNode() {
    var wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.innerHTML = AI_AVATAR;

    var body = document.createElement('div');
    body.className = 'msg-body';

    var md = document.createElement('div');
    md.className = 'md';

    body.appendChild(md);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);

    return { wrap: wrap, body: body, md: md, typing: null };
  }

  function appendAiMessage(text) {
    var node = createAiNode();
    node.md.innerHTML = window.renderMarkdown(text);
    return node;
  }

  function appendAiTyping() {
    var node = createAiNode();
    var typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    node.md.appendChild(typing);
    node.typing = typing;
    return node;
  }

  /** 打字机渲染器：把后端来的字符按帧平滑吐到页面上 */
  function createStreamer(mdEl) {
    var pending = '';
    var rendered = '';
    var raf = null;
    var ended = false;
    var onFinish = null;

    function paint(withCursor) {
      mdEl.innerHTML = window.renderMarkdown(rendered);
      if (withCursor) attachCursor();
    }

    function attachCursor() {
      var cursor = document.createElement('span');
      cursor.className = 'cursor';
      var last = mdEl.lastElementChild;
      if (last && !last.classList.contains('code-block')) {
        last.appendChild(cursor);
      } else {
        mdEl.appendChild(cursor);
      }
    }

    function finish() {
      if (!ended || pending.length) return;
      paint(false);
      if (onFinish) {
        var cb = onFinish;
        onFinish = null;
        cb();
      }
    }

    function step() {
      raf = null;
      if (!pending.length) return finish();
      // 积压越多吐得越快，保证长回答也能很快追平
      var take = Math.max(1, Math.min(pending.length, Math.ceil(pending.length / 14)));
      rendered += pending.slice(0, take);
      pending = pending.slice(take);
      paint(pending.length > 0 || !ended);
      if (pending.length) {
        raf = requestAnimationFrame(step);
      } else {
        finish();
      }
    }

    return {
      push: function (text) {
        pending += text;
        if (!raf && !ended) raf = requestAnimationFrame(step);
      },
      end: function (cb) {
        ended = true;
        onFinish = cb || null;
        if (pending.length) {
          if (!raf) raf = requestAnimationFrame(step);
        } else {
          finish();
        }
      },
      flush: function () {
        rendered += pending;
        pending = '';
        paint(false);
      },
      getText: function () {
        return rendered + pending;
      }
    };
  }

  /* ------------------------------ SSE 解析 ------------------------------ */
  function handleEvent(raw, handlers) {
    var dataLines = [];
    raw.split('\n').forEach(function (line) {
      line = line.replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') return; // 空行 / 心跳注释
      if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
    });
    if (!dataLines.length) return;

    var payload;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch (e) {
      return;
    }

    if (payload.type === 'start') {
      handlers.onStart && handlers.onStart(payload.session);
    } else if (payload.type === 'token' && payload.content) {
      handlers.onToken && handlers.onToken(payload.content);
    } else if (payload.type === 'error') {
      throw new Error(payload.content || '服务处理失败');
    }
  }

  async function consumeStream(stream, handlers) {
    var reader = stream.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        var idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          var raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleEvent(raw, handlers);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(buffer, handlers);
    } finally {
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
  }

  function isAbort(err) {
    return !!err && (err.name === 'AbortError' || err.code === 'ERR_CANCELED' || err.message === 'canceled');
  }

  async function fetchFallback(url, payload, handlers, signal) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: signal
    });

    if (!res.ok) {
      var detail = '';
      try {
        var data = await res.json();
        detail = data && data.detail ? data.detail : '';
      } catch (e) { /* ignore */ }
      throw new Error(detail || '服务返回 ' + res.status);
    }
    if (!res.body) throw new Error('当前浏览器不支持流式响应');
    await consumeStream(res.body, handlers);
  }

  /** 主通信入口：优先 axios 流式，失败回退原生 fetch */
  async function streamChat(payload, handlers, signal) {
    var url = API_BASE + '/chat';

    if (window.axios) {
      var started = false;
      try {
        var res = await axios.post(url, payload, {
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          adapter: 'fetch',
          responseType: 'stream',
          signal: signal
        });
        var stream = res && res.data;
        if (!stream || typeof stream.getReader !== 'function') {
          throw new Error('axios 流式响应不可用');
        }
        started = true;
        await consumeStream(stream, handlers);
        return;
      } catch (err) {
        if (isAbort(err) || started) throw err;
        console.warn('[chat] axios 流式请求失败，回退到 fetch：', err);
      }
    }

    await fetchFallback(url, payload, handlers, signal);
  }

  /* ------------------------------ 会话列表 ------------------------------ */
  async function loadSessions() {
    try {
      var data = await http('get', API_BASE + '/sessions');
      state.sessions = (data && data.sessions) || [];
    } catch (err) {
      console.warn('[sessions] 加载失败：', err);
      state.sessions = [];
    }
    renderSessionList();
  }

  function renderSessionList() {
    sessionListEl.innerHTML = '';
    var list = state.sessions || [];
    sidebarEmptyEl.hidden = list.length > 0;

    list.forEach(function (session) {
      var item = document.createElement('div');
      item.className = 'session-item' + (session.id === state.currentId ? ' active' : '');
      item.dataset.id = session.id;
      item.title = session.title || '新对话';
      item.innerHTML = SESSION_ICON + '<span class="session-title"></span>' +
        '<button class="session-del" type="button" title="删除这条对话">' + DELETE_ICON + '</button>';

      item.querySelector('.session-title').textContent = session.title || '新对话';

      item.addEventListener('click', function (e) {
        if (e.target.closest('.session-del')) return;
        if (session.id === state.currentId) return;
        openSession(session.id);
      });

      item.querySelector('.session-del').addEventListener('click', function (e) {
        e.stopPropagation();
        deleteSession(session.id, session.title);
      });

      sessionListEl.appendChild(item);
    });
  }

  function resetToNewChat() {
    state.currentId = null;
    messagesEl.innerHTML = '';
    welcomeEl.hidden = false;
    chatTitleEl.textContent = '新对话';
    renderSessionList();
  }

  async function openSession(id) {
    if (state.busy && state.controller) state.controller.abort();
    try {
      var data = await http('get', API_BASE + '/sessions/' + encodeURIComponent(id));
      state.currentId = id;
      chatTitleEl.textContent = (data.session && data.session.title) || '新对话';

      messagesEl.innerHTML = '';
      var messages = (data.session && data.session.messages) || [];
      messages.forEach(function (msg) {
        if (msg.role === 'user') appendUserMessage(msg.content);
        else appendAiMessage(msg.content);
      });
      welcomeEl.hidden = messages.length > 0;

      renderSessionList();
      stickBottom = true;
      scrollToBottom(true);
      if (window.innerWidth < 860) appEl.classList.add('collapsed');
    } catch (err) {
      toast('打开对话失败：' + err.message);
      await loadSessions();
    }
  }

  function newChat() {
    if (state.busy && state.controller) state.controller.abort();
    resetToNewChat();
    inputEl.focus();
    if (window.innerWidth < 860) appEl.classList.add('collapsed');
  }

  async function deleteSession(id, title) {
    var ok = await openConfirm({
      title: '删除这条对话？',
      desc: '「' + (title || '新对话') + '」的聊天记录将从历史列表中移除，删除后无法恢复。',
      confirmText: '删除'
    });
    if (!ok) return;

    try {
      await http('delete', API_BASE + '/sessions/' + encodeURIComponent(id));
    } catch (err) {
      toast('删除失败：' + err.message);
      return;
    }

    if (state.currentId === id) resetToNewChat();
    toast('对话已删除');
    await loadSessions();
  }

  async function clearChat() {
    if (!state.currentId) {
      var hasContent = messagesEl.children.length > 0;
      messagesEl.innerHTML = '';
      welcomeEl.hidden = false;
      inputEl.value = '';
      autoResize();
      updateSendState();
      toast(hasContent ? '对话已清空' : '当前已经是新对话');
      return;
    }

    var ok = await openConfirm({
      title: '清空当前对话？',
      desc: '本次对话的聊天记录会从页面和历史列表中一并移除，且无法恢复。',
      confirmText: '确定清空'
    });
    if (!ok) return;

    if (state.busy && state.controller) state.controller.abort();
    try {
      await http('delete', API_BASE + '/sessions/' + encodeURIComponent(state.currentId));
    } catch (err) {
      toast('清空失败：' + err.message);
      return;
    }

    resetToNewChat();
    toast('对话已清空');
    await loadSessions();
    inputEl.focus();
  }

  /* ------------------------------ 交互状态 ------------------------------ */
  function updateSendState() {
    if (state.busy) return;
    sendBtn.disabled = inputEl.value.trim().length === 0;
  }

  function setBusy(busy) {
    state.busy = busy;
    sendBtn.classList.toggle('loading', busy);
    sendBtn.disabled = busy || inputEl.value.trim().length === 0;
    stopBtn.hidden = !busy;
    if (!busy) {
      state.controller = null;
      updateSendState();
    }
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  function toast(message) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('toast-out'); }, 2200);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
  }

  /* ------------------------------ 发送流程 ------------------------------ */
  async function send(question) {
    question = (question || '').trim();
    if (!question || state.busy) return;

    welcomeEl.hidden = true;
    appendUserMessage(question);

    inputEl.value = '';
    autoResize();

    state.controller = new AbortController();
    setBusy(true);
    stickBottom = true;
    scrollToBottom(true);

    var node = appendAiTyping();
    var streamer = createStreamer(node.md);
    var gotToken = false;
    var stopped = false;

    function onToken(text) {
      if (!gotToken) {
        gotToken = true;
        if (node.typing && node.typing.parentNode) node.typing.remove();
      }
      streamer.push(text);
      maybeAutoScroll();
    }

    function onStart(session) {
      if (!session) return;
      state.currentId = session.id;
      chatTitleEl.textContent = session.title || '新对话';
      loadSessions();
    }

    try {
      await streamChat(
        { question: question, session_id: state.currentId },
        { onStart: onStart, onToken: onToken },
        state.controller.signal
      );
      await new Promise(function (resolve) { streamer.end(resolve); });
    } catch (err) {
      if (isAbort(err)) {
        stopped = true;
        streamer.flush();
      } else {
        console.error('[chat] 请求失败：', err);
        var raw = streamer.getText();
        var message = err && err.message ? err.message : '未知错误';
        streamer.end(function () {
          if (!raw) {
            node.md.innerHTML = '';
            node.wrap.classList.add('error');
            node.md.textContent = '请求失败：' + message +
              '（请确认后端已启动：uvicorn backend.main:app --reload）';
          } else {
            node.md.insertAdjacentHTML('beforeend', '<p class="note">（回答中断：' + message + '）</p>');
          }
        });
      }
    } finally {
      if (node.typing && node.typing.parentNode) node.typing.remove();
      if (stopped) {
        node.md.insertAdjacentHTML('beforeend', '<p class="note">已停止生成</p>');
      }
      setBusy(false);
      stickBottom = true;
      maybeAutoScroll();
      inputEl.focus();
      loadSessions();
    }
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  inputEl.addEventListener('input', function () {
    autoResize();
    updateSendState();
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send(inputEl.value);
    }
  });

  sendBtn.addEventListener('click', function () {
    send(inputEl.value);
  });

  stopBtn.addEventListener('click', function () {
    if (state.controller) state.controller.abort();
  });

  clearBtn.addEventListener('click', clearChat);
  newChatBtn.addEventListener('click', newChat);
  toggleSidebarBtn.addEventListener('click', function () {
    appEl.classList.toggle('collapsed');
  });

  chipsEl.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) send(chip.dataset.q || chip.textContent);
  });

  // 代码块「复制」按钮（事件委托）
  messagesEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-btn');
    if (!btn) return;
    var code = (window.mdCodeStore && window.mdCodeStore.get(btn.dataset.codeRef)) || '';
    var done = function (ok) {
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () { btn.textContent = '复制'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try { done(document.execCommand('copy')); } catch (err) { done(false); }
      document.body.removeChild(ta);
    }
  });

  /* ------------------------------ 启动 ------------------------------ */
  (async function init() {
    if (window.innerWidth < 860) appEl.classList.add('collapsed');

    autoResize();
    updateSendState();
    inputEl.focus();

    await loadSessions();
    if (state.sessions.length) {
      await openSession(state.sessions[0].id);
    } else {
      resetToNewChat();
    }
  })();
})();
