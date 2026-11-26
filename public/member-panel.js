// Owns the member detail area while roster and office sync continue independently.
import {openAgentFiles, closeAgentFiles} from './agent-files.js';
import {VISUAL_KINDS} from './visual-renderer.js';

const $ = id => document.getElementById(id);

export function createMemberPanel({config, select, refresh, connect, prompt, openVisual, notify}) {
  const tabs = $('member-tabs'),
    settings = $('member-settings'),
    files = $('member-files');
  let member,
    fileScope,
    visuals = [],
    tab = 'chat',
    creating = false,
    inProject = false;
  let epoch = 0,
    mountedSettings,
    projects,
    filesFor,
    roster = [];
  const canProject = config?.workbench === true;
  const buttons = [...tabs.querySelectorAll('[data-member-tab]')];

  function updateUrl() {
    const url = new URL(location.href);
    if (creating) url.searchParams.set('create', '1');
    else url.searchParams.delete('create');
    if (tab !== 'chat' && member && !creating) url.searchParams.set('panel', tab);
    else url.searchParams.delete('panel');
    if (!inProject) url.searchParams.delete('task');
    history.replaceState(null, '', url);
  }
  function stopEditors() {
    epoch++;
    if (mountedSettings) mountedSettings.unmountMemberSettings(settings);
    mountedSettings = null;
    settings.replaceChildren();
    closeAgentFiles();
    filesFor = null;
    if (inProject) projects?.hide();
    inProject = false;
  }
  function show() {
    tabs.hidden = !member || creating;
    $('create-navigation').hidden = !creating;
    buttons.forEach(b => {
      const selected = b.dataset.memberTab === tab;
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
    });
    $('member-chat').hidden = tab !== 'chat' || creating;
    settings.hidden = tab !== 'settings' && !creating;
    files.hidden = tab !== 'files' || creating;
    $('office-messages').hidden = inProject;
    $('member-project').hidden = !inProject;
    $('project-controls').hidden = !member;
    $('open-project-task').hidden = inProject || !canProject;
    $('assign-task').hidden = inProject;
    $('back-to-chat').hidden = !inProject;
  }
  function listDeliveries() {
    const host = $('member-deliveries');
    const items = visuals.filter(v => v.agentId === member?.id);
    const signature = JSON.stringify(items.map(v => [v.id, v.title, v.kind]));
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    host.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = '已交付成果';
    host.append(h);
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'panel-caption';
      p.textContent = '这位成员还没有发布成果。';
      host.append(p);
    }
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = (VISUAL_KINDS[item.kind] || '文件') + ' · ' + item.title;
      b.onclick = () => openVisual(item.id);
      host.append(b);
    }
  }
  function showFiles() {
    if (tab !== 'files' || !member) return;
    const hasFiles = config?.fileTools === true && member.id === fileScope;
    if (hasFiles && filesFor !== member.id) {
      openAgentFiles(member, prompt, () => setTab('chat'));
      filesFor = member.id;
    } else if (!hasFiles && filesFor) {
      closeAgentFiles();
      filesFor = null;
    }
    $('files-capability').hidden = hasFiles;
    $('files-capability').textContent = '这里列出该成员发布到办公室的成果。成员自己的文件由其运行端管理。';
    listDeliveries();
  }
  async function edit(template) {
    const ticket = epoch;
    if (!config?.studio) {
      settings.textContent = '成员设置由运行办公室的本机管理。';
      return;
    }
    try {
      const editor = await import('./agent-studio.js');
      if (epoch !== ticket) return;
      mountedSettings = editor;
      await editor.mountMemberSettings(settings, {
        agent: creating ? null : member,
        template,
        onChanged: refresh,
        onConnect: connect,
        onAgent: async agent => {
          if (epoch !== ticket) return;
          setTab('chat');
          await refresh();
          await select(agent.id);
        }
      });
    } catch {
      if (epoch === ticket) settings.textContent = '暂时无法读取成员设置，请重新打开设置。';
    }
  }
  function setTab(next, {create = false, template} = {}) {
    if (!create && next !== 'chat' && !member) return;
    stopEditors();
    tab = next;
    creating = create;
    show();
    updateUrl();
    if (tab === 'settings') void edit(template);
    if (tab === 'files') showFiles();
  }
  async function project(options = {}) {
    if (!canProject || !member) return;
    stopEditors();
    const ticket = epoch;
    tab = 'chat';
    creating = false;
    inProject = true;
    show();
    updateUrl();
    try {
      const {mountMemberProjects} = await import('./taskbench.js');
      if (ticket !== epoch) return;
      projects ??= mountMemberProjects($('member-project'));
      await projects.open(member, options);
    } catch {
      if (epoch === ticket) {
        setTab('chat');
        notify('项目任务暂时无法打开，请重试。');
      }
    }
  }
  tabs.onclick = event => {
    const next = event.target.closest('[data-member-tab]');
    if (next && next.dataset.memberTab !== tab) setTab(next.dataset.memberTab);
  };
  tabs.onkeydown = event => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const n =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (i + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
    setTab(buttons[n].dataset.memberTab);
    buttons[n].focus();
  };
  $('cancel-create').onclick = () => setTab('chat');
  $('open-project-task').onclick = () => project();
  $('back-to-chat').onclick = () => setTab('chat');
  async function projectCommand(options) {
    if (!canProject) return;
    if (!member) {
      const first = roster.find(a => a.id === 'pi-local') || roster.find(a => !a.managedDisabled);
      if (!first) return notify('请先创建或连接一位成员。');
      await select(first.id);
    }
    await project(options);
  }
  document.addEventListener('office-project-command', e => {
    if (!canProject || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    void projectCommand(e.detail === 'folder' ? {newTask: true, pickFolder: true} : {newTask: true});
  });
  show();
  return {
    update(agent, agents, available, shared) {
      if (agent?.id !== member?.id) {
        stopEditors();
        creating = false;
        tab = 'chat';
      }
      member = agent;
      roster = agents;
      fileScope = available;
      visuals = shared;
      show();
      showFiles();
    },
    reset() {
      setTab('chat');
    },
    create(template) {
      setTab('settings', {create: true, template});
    },
    settings() {
      setTab('settings');
    },
    files() {
      setTab('files');
    },
    project,
    isCreating: () => creating
  };
}
