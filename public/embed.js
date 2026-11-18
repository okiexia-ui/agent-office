// The 3D office inside the workspace. The parent page owns the data: it sends the office
// state, theme, focus and visibility, and this page only renders them and reports clicks.
// It never talks to the server, so the workspace keeps a single sync request.
import {validState} from './data.js';
import {MOMENTS} from './office-life.js';

const $ = selector => document.querySelector(selector);
const VIEWS = [
  ['overview', '全景'],
  ['work', '工位'],
  ['lounge', '休息区'],
  ['top', '俯瞰']
];
const post = message => {
  if (window.parent !== window) window.parent.postMessage(message, location.origin);
};
let scene = null,
  state = null,
  focus = null,
  view = 'overview',
  momentTimer;

function showView(preset) {
  view = preset;
  const name = VIEWS.find(([id]) => id === preset)?.[1] || '自由';
  for (const button of document.querySelectorAll('[data-camera]'))
    button.setAttribute('aria-pressed', String(button.dataset.camera === preset));
  $('#view-name').textContent = name;
  $('#view-cycle').setAttribute('aria-label', `切换视角，当前${name}`);
}
function showZoom(percent) {
  $('#zoom-out').disabled = percent <= 50;
  $('#zoom-in').disabled = percent >= 320;
}
function setView(preset) {
  showView(preset);
  scene?.setView(preset);
}
function selectAgent(agentId) {
  post({type: 'office-select-agent', agentId});
}
// Desks belong to the full office; here a desk click opens a chat with whoever sits there.
function openDesk(deskId) {
  const owner = state?.agents.find(agent => agent.seatId === deskId);
  if (!owner) return;
  scene?.select(owner.id);
  selectAgent(owner.id);
}
function moment(kind) {
  if (!MOMENTS[kind]) return;
  scene?.playActivity(kind);
  $('#office-moment').textContent = MOMENTS[kind];
  $('#office-moment').classList.add('show');
  clearTimeout(momentTimer);
  momentTimer = setTimeout(() => $('#office-moment').classList.remove('show'), 3500);
}
// A short stage (a phone, a narrow column) hides the view bar so the room and its name
// labels get the whole height; the view switch then lives in the corner dock.
function fitControls() {
  const viewport = $('.scene-viewport').getBoundingClientRect();
  const compact = viewport.height < 300 || viewport.width < 360;
  document.body.classList.toggle('compact-stage', compact);
  // Too small for eight names side by side (a phone): show colour dots instead.
  document.body.classList.toggle('tiny-stage', viewport.height < 200 || viewport.width < 320);
  if (!scene) return;
  const bar = compact ? 0 : $('#scene-top').getBoundingClientRect().bottom - viewport.top;
  // Label anchors sit at a label's bottom edge; leave room for one label above the bar.
  scene.setInsets({
    frame: {top: compact ? 14 : bar + 8, bottom: 10},
    labelTop: (compact ? 4 : bar + 4) + 24,
    labelBottom: 8
  });
}

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  const data = event.data || {};
  if (data.type === 'office-state' && validState(data.state)) {
    state = data.state;
    scene?.updateAgents(state.agents);
  }
  if (data.type === 'office-theme' && typeof data.night === 'boolean') {
    document.body.classList.toggle('night', data.night);
    scene?.setNight(data.night);
  }
  if (data.type === 'office-focus-agent') {
    focus = data.agentId ?? null;
    scene?.select(focus);
  }
  if (data.type === 'office-visibility' && scene) {
    scene.renderer.setAnimationLoop(data.visible ? scene.animate : null);
    if (data.visible) scene.resize();
  }
});

document.querySelector('.segmented').addEventListener('click', event => {
  const button = event.target.closest('[data-camera]');
  if (button) setView(button.dataset.camera);
});
$('#view-cycle').onclick = () => setView(VIEWS[(VIEWS.findIndex(([id]) => id === view) + 1) % VIEWS.length][0]);
$('#zoom-in').onclick = () => scene?.zoom(0.15);
$('#zoom-out').onclick = () => scene?.zoom(-0.15);
$('#reset-view').onclick = () => setView('overview');

// Ask for data first; it is applied as soon as the scene exists.
post({type: 'office-ready'});
try {
  const {OfficeScene} = await import('./scene.js');
  scene = new OfficeScene(
    $('#canvas-container'),
    $('#agent-labels'),
    selectAgent,
    showZoom,
    openDesk,
    moment,
    preset => showView(preset),
    {embedded: true}
  );
  scene.setNight(document.body.classList.contains('night'));
  if (state) scene.updateAgents(state.agents);
  scene.select(focus);
  fitControls();
  new ResizeObserver(fitControls).observe($('.scene-viewport'));
  $('#scene-loading').hidden = true;
} catch (error) {
  console.error('Office scene could not start:', error);
  $('#scene-loading').innerHTML =
    '<div class="scene-error"><svg aria-hidden="true"><use href="#i-office"/></svg><p>这台设备暂时打不开 3D 办公室。群聊、私聊和成果都不受影响。</p></div>';
}
