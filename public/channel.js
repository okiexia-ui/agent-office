import {MODELS} from './data.js';
const $ = selector => document.querySelector(selector);
const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]
  );
const STORE = 'agent-office-demo-channel-v1';
const regexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const friendlyError = message => {
  if (message.includes('Agent not found')) return '这位伙伴已离开办公室，请刷新成员后重新发送。';
  if (message.includes('Referenced channel message')) return '引用的消息已超出保留范围，请取消引用后重新发送。';
  if (message.includes('Task not found')) return '关联任务已不存在，请重新选择任务。';
  if (message.includes('already belongs')) return '消息重试内容有变化，请刷新后重新发送。';
  if (message.includes('concurrently')) return '伙伴们正在同时发言，请重试这条消息。';
  return message;
};

export function mentionedAgents(content, agents) {
  return agents
    .filter(agent =>
      [agent.name, agent.id].some(name =>
        new RegExp(`(^|[^A-Za-z0-9_@.+-])@${regexEscape(name)}(?=$|[^A-Za-z0-9_-])`, 'iu').test(content)
      )
    )
    .map(agent => agent.id);
}

export class ChannelChat {
  constructor({demo, getState, avatar, presence, onPrivate, onConnect, onChange, toast}) {
    Object.assign(this, {demo, getState, avatar, presence, onPrivate, onConnect, onChange, toast});
    this.dialog = $('#channel-dialog');
    this.messages = [];
    this.mentions = new Set();
    this.reply = null;
    this.loading = false;
    this.sending = false;
    this.signature = '';
    this.latest = 0;
    this.error = '';
    this.loaded = false;
    if (demo) {
      try {
        const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
        if (Array.isArray(saved))
          this.messages = saved
            .filter(
              m =>
                m &&
                typeof m.id === 'string' &&
                typeof m.content === 'string' &&
                ['user', 'agent'].includes(m.authorType) &&
                Array.isArray(m.mentions)
            )
            .slice(-200);
      } catch {}
    }
    $('#channel-close').onclick = () => this.dialog.close();
    $('#channel-private').onclick = () => this.onPrivate();
    $('#channel-connect').onclick = () => this.onConnect();
    $('#channel-refresh').onclick = () => this.load();
    $('#channel-filter').onchange = () => {
      const value = $('#channel-filter').value;
      if (value) $('#channel-task').value = value;
      this.signature = '';
      this.render();
    };
    $('#channel-reply-cancel').onclick = () => {
      this.reply = null;
      this.renderReply();
    };
    $('#channel-participants').onclick = event => {
      const button = event.target.closest('[data-mention]');
      if (!button) return;
      const id = button.dataset.mention;
      this.mentions.has(id) ? this.mentions.delete(id) : this.mentions.add(id);
      this.renderParticipants();
      this.updateComposer();
      $('#channel-input').focus();
    };
    $('#channel-log').onclick = event => {
      const reply = event.target.closest('[data-channel-reply]'),
        retry = event.target.closest('[data-channel-retry]'),
        filter = event.target.closest('[data-task-filter-channel]');
      if (reply) {
        this.reply = this.messages.find(m => m.id === reply.dataset.channelReply);
        if (this.reply?.authorId) this.mentions.add(this.reply.authorId);
        if (this.reply?.taskId) $('#channel-task').value = this.reply.taskId;
        this.renderReply();
        this.renderParticipants();
        this.updateComposer();
        $('#channel-input').focus();
      }
      if (retry) {
        const message = this.messages.find(m => m.id === retry.dataset.channelRetry);
        if (message) this.deliver(message);
      }
      if (filter) {
        $('#channel-filter').value = filter.dataset.taskFilterChannel;
        this.signature = '';
        this.render();
      }
    };
    $('#channel-input').addEventListener('input', () => this.updateComposer());
    $('#channel-input').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        this.send();
      }
    });
    $('#channel-form').onsubmit = event => {
      event.preventDefault();
      this.send();
    };
    setInterval(() => {
      if (this.dialog.open && !document.hidden && !demo) this.load();
    }, 3000);
  }
  agents() {
    return this.getState().agents;
  }
  open() {
    if (this.demo && !this.messages.length && !this.loaded) this.seedDemo();
    this.loaded = true;
    this.signature = '';
    this.render();
    if (!this.dialog.open) this.dialog.show();
    if (!this.demo) this.load();
    $('#channel-input').focus();
  }
  refresh() {
    if (this.dialog.open) this.render();
  }
  seedDemo() {
    const agents = this.agents(),
      a = agents.find(a => a.model === 'Codex') || agents[0],
      b = agents.find(x => x.model === 'Claude' && x.id !== a?.id) || agents.find(x => x.id !== a?.id);
    if (!a || !b) return;
    const task = this.getState().tasks.find(t => t.agentId === a.id),
      now = Date.now();
    const make = (author, content, mentions, replyTo, offset) => ({
      id: crypto.randomUUID(),
      sequence: this.messages.length + 1,
      authorType: author ? 'agent' : 'user',
      authorId: author?.id || null,
      authorName: author?.name || '你',
      authorModel: author?.model || null,
      content,
      mentions,
      replyTo: replyTo?.id || null,
      replyPreview: replyTo ? {authorName: replyTo.authorName, content: replyTo.content.slice(0, 180)} : null,
      taskId: task?.id || null,
      taskTitle: task?.title || null,
      createdAt: now - offset
    });
    const first = make(null, '我们一起把工作计划对齐吧，欢迎在这里讨论分工。', [a.id, b.id], null, 180000);
    this.messages.push(first);
    const second = make(
      a,
      `@${b.name} 我来拆解实现步骤，你能帮忙梳理验收要点吗？我们把结论留在同一个任务下。`,
      [b.id],
      first,
      120000
    );
    this.messages.push(second);
    this.messages.push(
      make(
        b,
        `@${a.name} 可以。建议先确认用户流程，再检查边界情况，最后一起核对结果。需要补充的信息也可以直接在这里问我。`,
        [a.id],
        second,
        60000
      )
    );
    this.saveDemo();
  }
  saveDemo() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.messages.slice(-200)));
    } catch {
      this.toast('当前浏览器无法保存讨论记录，本次内容仅保留在会话中');
    }
  }
  renderParticipants() {
    $('#channel-participants').innerHTML = this.agents()
      .map(
        a =>
          `<button type="button" class="channel-person ${this.mentions.has(a.id) ? 'selected' : ''}" data-mention="${escape(a.id)}" aria-label="提醒 ${escape(a.name)}" aria-pressed="${this.mentions.has(a.id)}" title="${escape(this.presence(a))}">${this.avatar(a)}<span>@${escape(a.name)}</span></button>`
      )
      .join('');
  }
  updateComposer() {
    const input = $('#channel-input').value;
    const targets = [...new Set([...this.mentions, ...mentionedAgents(input, this.agents())])].filter(id =>
      this.agents().some(a => a.id === id)
    );
    $('#channel-count').textContent = `${input.length} / 2000`;
    $('#channel-send').disabled = !input.trim() || input.length > 2000 || this.sending;
    $('#channel-send-label').textContent = this.sending ? '发送中' : '发送';
    $('#channel-targets').textContent = targets.length
      ? `将提醒：${targets.map(id => this.agents().find(a => a.id === id).name).join('、')}`
      : '所有人可见。点头像或输入 @名字，提醒具体的伙伴';
  }
  renderReply() {
    $('#channel-reply').hidden = !this.reply;
    $('#channel-reply-text').textContent = this.reply
      ? `回复 ${this.reply.authorName}：${this.reply.content.slice(0, 100)}`
      : '';
  }
  render() {
    $('#channel-members').textContent = `你和 ${this.agents().length} 位伙伴`;
    $('#channel-notice').textContent = this.demo
      ? '演示讨论：伙伴的发言是本地示例，没有调用模型。'
      : '@ 一位伙伴或回复它的消息，会进入它的待处理收件箱。';
    $('#channel-connect').hidden = this.demo;
    this.mentions = new Set([...this.mentions].filter(id => this.agents().some(a => a.id === id)));
    this.renderParticipants();
    this.renderReply();
    for (const [selector, label] of [
      ['#channel-task', '不关联任务'],
      ['#channel-filter', '全部讨论']
    ]) {
      const select = $(selector),
        selected = select.value,
        options =
          `<option value="">${label}</option>` +
          this.getState()
            .tasks.map(t => `<option value="${escape(t.id)}">${escape(t.title)}</option>`)
            .join('');
      if (select.innerHTML !== options) {
        select.innerHTML = options;
        select.value = this.getState().tasks.some(t => t.id === selected) ? selected : '';
      }
    }
    const filter = $('#channel-filter').value,
      messages = this.messages.filter(m => !filter || m.taskId === filter);
    const signature = JSON.stringify(messages) + filter + this.loading;
    $('#channel-error').hidden = !this.error;
    $('#channel-error').textContent = this.error;
    if (signature !== this.signature) {
      const log = $('#channel-log'),
        atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100 || !this.signature;
      this.signature = signature;
      log.innerHTML = messages.length
        ? messages
            .map(m => {
              const avatar =
                m.authorType === 'agent' && Object.hasOwn(MODELS, m.authorModel)
                  ? this.avatar({model: m.authorModel})
                  : '<span class="channel-human" aria-hidden="true">你</span>';
              const time = Number.isFinite(m.createdAt)
                ? new Date(m.createdAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})
                : '';
              const names = m.mentions.map(id => this.agents().find(a => a.id === id)?.name || id);
              return `<article class="channel-message ${m.authorType}" data-channel-message="${escape(m.id)}"><div class="channel-message-avatar">${avatar}</div><div class="channel-message-body"><div class="channel-author"><strong>${escape(m.authorName)}</strong><span>${m.authorType === 'agent' ? 'Agent' : '办公室主人'}</span><time>${time}</time>${this.demo ? '<small>演示</small>' : ''}</div>${m.replyPreview ? `<blockquote class="channel-quote"><strong>${escape(m.replyPreview.authorName)}</strong> ${escape(m.replyPreview.content)}</blockquote>` : ''}<div class="channel-bubble">${escape(m.content)}</div>${m.taskId ? `<button type="button" class="channel-task-tag" data-task-filter-channel="${escape(m.taskId)}">↳ ${escape(m.taskTitle || '相关任务')}</button>` : ''}<div class="channel-message-footer"><span>${m.localStatus === 'sending' ? '正在发送' : m.localStatus === 'failed' ? '发送失败' : names.length ? '提醒 ' + names.map(n => '@' + escape(n)).join(' ') : '频道消息'}</span>${m.localStatus === 'failed' ? `<button type="button" data-channel-retry="${escape(m.id)}">重试发送</button>` : !m.localStatus ? `<button type="button" data-channel-reply="${escape(m.id)}" aria-label="回复 ${escape(m.authorName)} 的消息">回复</button>` : ''}</div></div></article>`;
            })
            .join('')
        : `<div class="channel-empty"><span>#</span><h3>${filter ? '还没有关于这件事的讨论' : '让好想法在这里碰面'}</h3><p>${this.loading ? '正在读取公共频道' : '你和伙伴都可以在这里发起讨论、互相提问、同步进展。'}</p></div>`;
      if (atEnd) log.scrollTop = log.scrollHeight;
    }
    this.updateComposer();
  }
  async load() {
    if (this.demo || this.loading) return;
    this.loading = true;
    if (!this.messages.length && this.dialog.open) this.render();
    try {
      const response = await fetch('/api/channel', {cache: 'no-store', signal: AbortSignal.timeout(8000)}),
        data = await response.json();
      if (!response.ok || !Array.isArray(data.messages)) throw Error(data.error || '读取频道失败');
      if (data.latest_sequence >= this.latest) {
        const ids = new Set(data.messages.map(m => m.requestId));
        this.messages = [...data.messages, ...this.messages.filter(m => m.localStatus && !ids.has(m.requestId))];
        this.latest = data.latest_sequence;
      }
      this.error = '';
    } catch {
      this.error = '公共频道暂时无法连接，当前记录仍保留。可以刷新重试。';
    } finally {
      this.loading = false;
      if (this.dialog.open) this.render();
    }
  }
  async send() {
    const content = $('#channel-input').value.trim();
    if (!content || content.length > 2000 || this.sending) return;
    const mentions = [...new Set([...this.mentions, ...mentionedAgents(content, this.agents())])].filter(id =>
        this.agents().some(a => a.id === id)
      ),
      taskId = $('#channel-task').value || null;
    const message = {
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      authorType: 'user',
      authorId: null,
      authorName: '你',
      authorModel: null,
      content,
      mentions,
      replyTo: this.reply?.id || null,
      replyPreview: this.reply ? {authorName: this.reply.authorName, content: this.reply.content.slice(0, 180)} : null,
      taskId,
      taskTitle: this.getState().tasks.find(t => t.id === taskId)?.title || null,
      createdAt: Date.now(),
      localStatus: 'sending'
    };
    this.messages.push(message);
    this.reply = null;
    this.mentions.clear();
    this.signature = '';
    $('#channel-input').value = '';
    if ($('#channel-filter').value && $('#channel-filter').value !== taskId) $('#channel-filter').value = '';
    await this.deliver(message);
  }
  async deliver(message) {
    if (this.sending) return;
    this.sending = true;
    message.localStatus = 'sending';
    this.error = '';
    this.render();
    try {
      if (this.demo) {
        delete message.localStatus;
        message.sequence = (this.messages.at(-2)?.sequence || 0) + 1;
        const recipient = this.agents().find(a => message.mentions.includes(a.id));
        if (recipient) {
          const colleague =
            this.agents().find(
              a => a.id !== recipient.id && (message.mentions.includes(a.id) || a.model === 'Codex')
            ) || this.agents().find(a => a.id !== recipient.id);
          const reply = {
            id: crypto.randomUUID(),
            sequence: message.sequence + 1,
            authorType: 'agent',
            authorId: recipient.id,
            authorName: recipient.name,
            authorModel: recipient.model,
            content: colleague
              ? `@${colleague.name} 我收到这个讨论了。我们先把目标、分工和验收条件对齐，你可以补充实现上的考虑。`
              : '我收到这个讨论了。可以在这里继续补充目标和需要协作的部分。',
            mentions: colleague ? [colleague.id] : [],
            replyTo: message.id,
            replyPreview: {authorName: '你', content: message.content.slice(0, 180)},
            taskId: message.taskId,
            taskTitle: message.taskTitle,
            createdAt: Date.now()
          };
          this.messages.push(reply);
          if (colleague)
            this.messages.push({
              id: crypto.randomUUID(),
              sequence: reply.sequence + 1,
              authorType: 'agent',
              authorId: colleague.id,
              authorName: colleague.name,
              authorModel: colleague.model,
              content: `@${recipient.name} 好的。先确认输入和预期结果，再拆成可以分别推进的步骤；有阻碍就回到这个讨论里同步。`,
              mentions: [recipient.id],
              replyTo: reply.id,
              replyPreview: {authorName: recipient.name, content: reply.content.slice(0, 180)},
              taskId: message.taskId,
              taskTitle: message.taskTitle,
              createdAt: Date.now()
            });
        }
        this.messages = this.messages.slice(-200);
        this.saveDemo();
      } else {
        const response = await fetch('/api/channel', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              requestId: message.requestId,
              content: message.content,
              mentions: message.mentions,
              replyTo: message.replyTo,
              taskId: message.taskId
            }),
            signal: AbortSignal.timeout(12000)
          }),
          data = await response.json();
        if (!response.ok) throw Error(friendlyError(data.error || '发送失败'));
        this.messages = this.messages.map(m => (m.requestId === message.requestId ? data.message : m));
        this.latest = Math.max(this.latest, data.latest_sequence);
        this.onChange();
      }
    } catch (error) {
      const current = this.messages.find(m => m.requestId === message.requestId);
      if (current?.localStatus) {
        current.localStatus = 'failed';
        this.error =
          error instanceof TypeError
            ? '网络连接中断，可以重试同一条消息。'
            : error.name === 'TimeoutError'
              ? '发送超时，可重试；不会重复发布。'
              : error.message;
      }
    } finally {
      this.sending = false;
      if (this.dialog.open) this.render();
    }
  }
}
