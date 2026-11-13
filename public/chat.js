const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const DEMO_KEY = 'agent-office-demo-chat-v1';

export class AgentChat {
  constructor({demo, getState, avatar, presence, onSelect, onRender, onConnect, onChange, toast}) {
    Object.assign(this, {demo, getState, avatar, presence, onSelect, onRender, onConnect, onChange, toast});
    this.dialog = $('#chat-dialog');
    this.cache = new Map(); this.drafts = new Map(); this.loading = new Set(); this.sending = new Set(); this.errors = new Map();
    this.current = null; this.signature = '';
    if (demo) {
      try {
        const saved = JSON.parse(localStorage.getItem(DEMO_KEY) || '{}');
        for (const [id, list] of Object.entries(saved)) {
          if (Array.isArray(list)) this.cache.set(id, list.filter(m => m && ['user','agent'].includes(m.role) && typeof m.content === 'string' && typeof m.id === 'string').slice(-100));
        }
      } catch {}
    }
    $('#chat-close').onclick = () => this.dialog.close();
    this.dialog.addEventListener('close', () => { this.saveDraft(); this.onSelect(null); });
    $('#chat-agent-select').onchange = event => this.open(event.target.value);
    $('#chat-form').onsubmit = event => { event.preventDefault(); this.send(); };
    $('#chat-input').addEventListener('input', () => { this.saveDraft(); this.updateComposer(); });
    $('#chat-input').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); this.send(); }
    });
    $('#chat-connect').onclick = () => this.onConnect();
    $('#chat-refresh').onclick = () => this.load(this.current, true);
    $('#chat-suggestions').onclick = event => {
      const button = event.target.closest('[data-prompt]');
      if (!button) return;
      $('#chat-input').value = button.dataset.prompt; this.saveDraft(); this.updateComposer(); $('#chat-input').focus();
    };
    $('#chat-log').onclick = event => {
      const button = event.target.closest('[data-retry]');
      const message = this.messages().find(m => m.id === button?.dataset.retry);
      if (message) this.deliver(message);
    };
    setInterval(() => { if (this.dialog.open && !document.hidden && !this.demo) this.load(this.current); }, 3000);
  }
  saveDraft() { if (this.current) this.drafts.set(this.current, $('#chat-input').value); }
  messages(id = this.current) { return this.cache.get(id) || []; }
  agent() { return this.getState().agents.find(a => a.id === this.current); }
  open(id) {
    if (!this.getState().agents.some(a => a.id === id)) return;
    this.saveDraft(); this.current = id; this.signature = '';
    $('#chat-input').value = this.drafts.get(id) || '';
    this.render(); this.onSelect(id);
    if (!this.dialog.open) this.dialog.show();
    if (!this.demo) this.load(id, true);
    $('#chat-input').focus();
  }
  refresh() { if (this.dialog.open) this.render(); }
  updateComposer() {
    const value = $('#chat-input').value;
    $('#chat-count').textContent = `${value.length} / 2000`;
    $('#chat-send').disabled = !value.trim() || value.length > 2000 || this.sending.has(this.current) || !this.agent();
    $('#chat-send-label').textContent = this.sending.has(this.current) ? '发送中' : '发送';
  }
  render() {
    const agent = this.agent();
    if (!agent) { if (this.dialog.open) this.dialog.close(); return; }
    $('#chat-avatar').innerHTML = this.avatar(agent);
    const select = $('#chat-agent-select');
    const options = this.getState().agents.map(a => `<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('');
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = agent.id;
    $('#chat-status').textContent = `${this.presence(agent)} · ${agent.role}`;
    const away = !this.demo && (!agent.lastSeen || Date.now()-agent.lastSeen>300000);
    $('#chat-connection').textContent = this.demo ? '演示对话：回复是本地示例，没有调用模型。' : away ? 'TA 现在不在线。可以先留言，连接后由它读取并回复。' : '留言保存在办公室，TA 读取后回复，这里会自动更新。';
    $('#chat-connect').hidden = !away;
    $('#chat-error').textContent = this.errors.get(agent.id) || '';
    $('#chat-error').hidden = !this.errors.has(agent.id);
    const messages = this.messages();
    const signature = JSON.stringify(messages) + (this.loading.has(agent.id) ? 'loading' : '') + agent.name;
    if (signature !== this.signature) {
      const log = $('#chat-log'), nearBottom = log.scrollHeight-log.scrollTop-log.clientHeight < 90 || !this.signature;
      this.signature = signature;
      log.innerHTML = messages.length ? messages.map(m => {
        const status = m.localStatus === 'sending' ? '正在发送' : m.localStatus === 'failed' ? '发送失败' : m.role === 'user' ? (m.replyId ? '已回复' : '已保存 · 等待回复') : this.demo ? '演示回复' : 'Agent 回复';
        const time = Number.isFinite(m.createdAt) ? new Date(m.createdAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}) : '';
        return `<article class="chat-message ${m.role}" data-message-id="${escape(m.id)}"><div class="message-author">${m.role === 'user' ? '你' : escape(agent.name)}<time>${time}</time></div><div class="message-bubble">${escape(m.content)}</div><div class="message-state">${status}${m.localStatus === 'failed' ? ` <button type="button" data-retry="${escape(m.id)}">重试发送</button>` : ''}</div></article>`;
      }).join('') : `<div class="chat-empty"><div class="chat-empty-mark">${this.avatar(agent)}</div><h3>和 ${escape(agent.name)} 说点什么</h3><p>${this.loading.has(agent.id) ? '正在读取聊天记录' : '问进展、交代想法，或者一起把下一步想清楚。'}</p><span>每位伙伴的记录互相独立</span></div>`;
      if (nearBottom) log.scrollTop = log.scrollHeight;
    }
    $('#chat-pending').hidden = !messages.some(m => m.role === 'user' && !m.replyId && !m.localStatus);
    $('#chat-pending').textContent = this.demo ? '正在生成演示回复' : '等待 TA 回复，可以先去做别的';
    this.updateComposer();
    this.onRender?.(agent);
  }
  async load(id, explicit = false) {
    if (this.demo || !id || this.loading.has(id)) return;
    this.loading.add(id); if (this.current === id && explicit) this.render();
    try {
      const response = await fetch(`/api/chat?agentId=${encodeURIComponent(id)}`, {cache:'no-store',signal:AbortSignal.timeout(8000)});
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.messages)) throw new Error(data.error || '聊天记录暂时无法加载');
      const serverIds = new Set(data.messages.map(m => m.requestId));
      const unsaved = this.messages(id).filter(m => m.localStatus && !serverIds.has(m.requestId));
      this.cache.set(id, [...data.messages, ...unsaved]); this.errors.delete(id);
    } catch (error) { this.errors.set(id, '连接暂时中断，保留当前记录。可以点击刷新重试。'); }
    finally { this.loading.delete(id); if (this.current === id && this.dialog.open) this.render(); }
  }
  async send() {
    const content = $('#chat-input').value.trim();
    if (!content || content.length > 2000 || this.sending.has(this.current) || !this.agent()) return;
    const message = {id:crypto.randomUUID(),requestId:crypto.randomUUID(),agentId:this.current,role:'user',content,createdAt:Date.now(),replyId:null,localStatus:'sending'};
    this.cache.set(this.current, [...this.messages(), message]);
    $('#chat-input').value = ''; this.saveDraft();
    await this.deliver(message);
  }
  async deliver(message) {
    const id = message.agentId;
    if (this.sending.has(id)) return;
    this.sending.add(id); message.localStatus = 'sending';
    if (this.current === id) this.render();
    try {
      if (this.demo) {
        delete message.localStatus;
        const agent = this.getState().agents.find(a => a.id === id);
        const task = this.getState().tasks.find(t => t.agentId === id && t.status !== 'done');
        const content = /进展|任务/.test(message.content) ? (task ? `演示进展：我正在处理「${task.title}」，当前进度 ${Math.round(task.progress)}%。你可以在任务看板里继续查看。` : '演示状态：目前没有待办任务，可以通过「分配任务」安排下一件事。') : /工位|座位/.test(message.content) ? `我的固定工位是 ${agent.seatId?.slice(-2) || '待分配'} 号。你可以在「工位管理」里帮我换个位置。` : `收到你的想法：「${message.content.slice(0,120)}」。这是一条演示回复。切换到实时办公室并连接 ${agent.name} 后，这里会显示它的真实回答。`;
        const reply = {id:crypto.randomUUID(),agentId:id,role:'agent',content,createdAt:Date.now(),replyTo:message.id};
        message.replyId = reply.id; this.cache.set(id, [...this.messages(id), reply].slice(-100));
        try { localStorage.setItem(DEMO_KEY, JSON.stringify(Object.fromEntries(this.cache))); } catch { this.toast('聊天记录仅保留在当前会话，浏览器存储不可用'); }
      } else {
        const response = await fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:id,requestId:message.requestId,content:message.content}),signal:AbortSignal.timeout(12000)});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '消息发送失败');
        this.cache.set(id, this.messages(id).map(m => m.requestId === message.requestId ? data.message : m));
        this.errors.delete(id); this.onChange();
      }
    } catch (error) {
      // A poll can confirm the send even if its POST response was lost.
      const current = this.messages(id).find(m => m.requestId === message.requestId);
      if (current?.localStatus) current.localStatus = 'failed';
      if (current?.localStatus) this.errors.set(id, error.name === 'TimeoutError' ? '请求超时，可重试同一条消息；不会重复发送。' : error instanceof TypeError ? '网络连接中断，消息尚未确认送达。请重试。' : error.message);
    }
    finally { this.sending.delete(id); if (this.current === id && this.dialog.open) this.render(); }
  }
}
