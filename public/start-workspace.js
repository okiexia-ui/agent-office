// Project, conversation, and artifact links all open in the office shell.
const entry = new URL(location.href);
if (['office', 'workbench'].includes(entry.searchParams.get('view'))) {
  entry.searchParams.delete('view');
  history.replaceState(null, '', entry);
}
await import('./workspace.js');
