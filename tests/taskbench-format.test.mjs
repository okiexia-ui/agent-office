import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shortPath} from '../public/taskbench.js';

test('Project paths are shortened for the header and keep the folder name visible', () => {
  assert.equal(shortPath('/Users/someone/Projects/my-app'), '~/Projects/my-app');
  assert.equal(shortPath('/Users/someone'), '~');
  assert.equal(shortPath('/opt/work/app'), '/opt/work/app');
  const long = '/private/tmp/claude-501/a-very-long-generated-folder-name/session-1234567890/scratchpad/sample-project';
  assert.equal(shortPath(long), '/private/…/scratchpad/sample-project');
  const deep = '/Users/someone/Documents/客户项目/二〇二六年第四季度/交付材料与验收文档/sample-project';
  const short = shortPath(deep);
  assert.ok(short.startsWith('~/Documents/…/'), short);
  assert.ok(short.endsWith('/sample-project'), short);
  assert.equal(shortPath(''), '');
});
