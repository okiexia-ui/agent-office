import {readLocalConfig} from './local-mode.js';

const query = new URLSearchParams(location.search);
const config = query.get('demo') === '1' ? null : await readLocalConfig();
const officeLink =
  query.get('view') === 'office' || ['agent', 'visual', 'studio', 'connect'].some(key => query.has(key));
if (config?.mode === 'local' && config.workbench === true && !officeLink) {
  const {openTaskbench} = await import('./taskbench.js');
  openTaskbench();
} else {
  await import('./workspace.js');
  if (config?.workbench === true) {
    const link = document.querySelector('#mode-switch');
    link.href = './';
    link.textContent = '项目工作台';
  }
}
