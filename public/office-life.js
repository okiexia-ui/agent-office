import {DESKS} from './layout.js';
const $ = selector => document.querySelector(selector);
const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]
  );

// One line of colour for each little office moment; shared with the embedded scene.
export const MOMENTS = {
  coffee: '咖啡在冒热气。停一下，好点子也要时间冲泡。',
  cat: '小猫伸了个懒腰，今天的陪伴不限量。',
  celebrate: '给每一点小进展，撒一把彩纸。',
  vacuum: '扫地机器人转了两圈：这条走道刚扫过。',
  pingpong: '两位伙伴同时去休息，就会在这里打一局。'
};

export class OfficeLife {
  constructor({getState, getScene, save, canEdit, recruit, toast}) {
    Object.assign(this, {getState, getScene, save, canEdit, recruit, toast});
    this.selected = DESKS[0].id;
    $('#desks-btn').onclick = () => this.open();
    $('#desk-map').onclick = event => {
      const button = event.target.closest('[data-desk]');
      if (button) {
        this.selected = button.dataset.desk;
        this.renderPicker();
      }
    };
    $('#desk-agent').onchange = () => this.updateMoveButton();
    $('#desk-save').onclick = () => this.move();
    $('#desk-recruit').onclick = () => {
      const seat = this.selected;
      $('#desks-dialog').close();
      this.recruit(seat);
    };
    document
      .querySelectorAll('[data-office-activity]')
      .forEach(button => (button.onclick = () => this.play(button.dataset.officeActivity)));
    this.focusUntil = 0;
    try {
      const value = Number(sessionStorage.getItem('office-focus-until'));
      if (value > Date.now() && value < Date.now() + 1500001) this.focusUntil = value;
    } catch {}
    $('#focus-btn').onclick = () => {
      this.focusUntil = this.focusUntil ? 0 : Date.now() + 25 * 60 * 1000;
      try {
        sessionStorage.setItem('office-focus-until', String(this.focusUntil));
      } catch {}
      this.tick();
      this.toast(this.focusUntil ? '给自己 25 分钟，专心做一件事。' : '专注计时已结束');
    };
    setInterval(() => this.tick(), 1000);
    this.tick();
  }
  open(seatId) {
    this.selected = DESKS.some(d => d.id === seatId) ? seatId : this.selected;
    this.renderPicker();
    if (!$('#desks-dialog').open) $('#desks-dialog').showModal();
  }
  refresh() {
    const count = this.getState().agents.length;
    $('#desk-count').textContent = `${count} / ${DESKS.length}`;
    $('#desk-summary').textContent = `${count} 个已分配 · ${DESKS.length - count} 个空位`;
    if ($('#desks-dialog').open) this.renderPicker(true);
  }
  renderPicker(preserve = false) {
    const agents = this.getState().agents,
      selected = DESKS.find(d => d.id === this.selected),
      owner = agents.find(a => a.seatId === this.selected);
    // Laid out like the room seen from above: window row first, four pods of four.
    $('#desk-map').innerHTML = [...DESKS]
      .sort((a, b) => a.z - b.z || a.x - b.x)
      .map(d => {
        const a = agents.find(a => a.seatId === d.id);
        return `<button type="button" class="desk-tile ${a ? 'occupied' : 'available'} ${d.id === this.selected ? 'selected' : ''}" data-desk="${d.id}" aria-pressed="${d.id === this.selected}" aria-label="${d.label}，${escape(a?.name || '空位')}"><span class="desk-number">${d.id.slice(-2)}</span><span class="desk-owner">${escape(a?.name || '空位')}</span></button>`;
      })
      .join('');
    $('#desk-selected').textContent = selected.label;
    $('#desk-current').textContent = owner
      ? `当前属于 ${owner.name}，选择其他成员可交换工位。`
      : '这张桌子还空着，安排一位伙伴入座吧。';
    const previous = $('#desk-agent').value;
    $('#desk-agent').innerHTML =
      '<option value="">选择入座成员</option>' +
      agents.map(a => `<option value="${escape(a.id)}">${escape(a.name)} · ${a.seatId.slice(-2)} 号</option>`).join('');
    $('#desk-agent').value = preserve && agents.some(a => a.id === previous) ? previous : owner?.id || '';
    $('#desk-recruit').hidden = !!owner || agents.length >= DESKS.length;
    this.updateMoveButton();
  }
  updateMoveButton() {
    const agents = this.getState().agents,
      agent = agents.find(a => a.id === $('#desk-agent').value),
      owner = agents.find(a => a.seatId === this.selected);
    $('#desk-save').disabled = !agent || agent.seatId === this.selected || !this.canEdit();
    $('#desk-save').textContent = owner && owner.id !== agent?.id ? '交换工位' : '安排入座';
  }
  async move() {
    if (!this.canEdit()) {
      this.toast('请等待办公室连接并同步');
      return;
    }
    const agents = this.getState().agents,
      agent = agents.find(a => a.id === $('#desk-agent').value),
      owner = agents.find(a => a.seatId === this.selected);
    if (!agent || agent.seatId === this.selected) return;
    const from = agent.seatId;
    if (owner) owner.seatId = from;
    agent.seatId = this.selected;
    $('#desk-save').disabled = true;
    const saved = await this.save();
    if (saved)
      this.toast(
        owner ? `${agent.name} 和 ${owner.name} 交换了工位` : `${agent.name} 搬到 ${this.selected.slice(-2)} 号工位啦`
      );
    this.renderPicker();
  }
  play(kind) {
    if (!MOMENTS[kind]) return;
    this.getScene()?.playActivity(kind);
    $('#office-moment').textContent = MOMENTS[kind];
    $('#office-moment').classList.add('show');
    document
      .querySelectorAll('[data-office-activity]')
      .forEach(b => b.classList.toggle('just-played', b.dataset.officeActivity === kind));
    clearTimeout(this.momentTimer);
    this.momentTimer = setTimeout(() => {
      document.querySelectorAll('.just-played').forEach(b => b.classList.remove('just-played'));
      $('#office-moment').classList.remove('show');
    }, 3500);
  }
  tick() {
    if (this.focusUntil && Date.now() >= this.focusUntil) {
      this.focusUntil = 0;
      try {
        sessionStorage.removeItem('office-focus-until');
      } catch {}
      this.play('celebrate');
      this.toast('25 分钟专注完成，休息一下吧。');
    }
    const remaining = Math.max(0, Math.ceil((this.focusUntil - Date.now()) / 1000));
    $('#focus-time').textContent = this.focusUntil
      ? `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`
      : '专注 25 分钟';
    $('#focus-btn').setAttribute('aria-pressed', String(!!this.focusUntil));
    $('#focus-btn').title = this.focusUntil ? '结束专注计时' : '开始 25 分钟专注';
  }
}
