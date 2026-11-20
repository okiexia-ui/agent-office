import {documentTool, documentSchema, documentDescription} from './pi-documents.mjs';
import {createPiComputer, computerParameters, computerDescription, configuredOrigins} from './pi-computer.mjs';
import {operateMac, macDescription, macParameters} from './pi-mac.mjs';

// This is an explicitly loaded Pi extension. The launcher supplies the private
// directory; the model never chooses the workspace root or the browser profile.
export default function officeTools(pi) {
  const root = process.env.OFFICE_PI_WORKSPACE;
  if (!root) throw new Error('缺少成员文件目录。');
  const textResult = value => ({content: [{type: 'text', text: JSON.stringify(value)}], details: {}});
  const allowedOrigins = (process.env.OFFICE_BROWSER_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  let originHint = '';
  try {
    originHint = [...configuredOrigins(allowedOrigins)].join(', ');
  } catch {
    // A malformed browser setting is reported when the browser is used.
  }
  pi.registerTool({
    name: 'office_document',
    label: '成员文档',
    description: documentDescription,
    parameters: documentSchema,
    executionMode: 'sequential',
    async execute(_id, args, signal) {
      return textResult(await documentTool({...args, root}, {signal}));
    }
  });
  let browser;
  pi.registerTool({
    name: 'office_browser',
    label: '独立浏览器',
    description: computerDescription + (originHint ? ' Allowed site origins: ' + originHint : ''),
    parameters: computerParameters,
    executionMode: 'sequential',
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      browser ??= createPiComputer({
        root,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        allowedOrigins
      });
      const cancel = () => {
        void browser.close().catch(() => {});
      };
      signal?.addEventListener('abort', cancel, {once: true});
      try {
        const result = await browser.run(args);
        const content = [{type: 'text', text: result.text}];
        if (result.image && ctx?.model?.input?.includes('image')) content.push(result.image);
        return {content, details: result.path ? {path: result.path} : {}};
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    }
  });
  pi.on('session_shutdown', async () => {
    await browser?.close();
  });
  if (process.platform === 'darwin' && process.env.OFFICE_PI_NATIVE_REQUEST === '1')
    pi.registerTool({
      name: 'office_mac',
      label: 'Mac 原生应用',
      description: macDescription,
      parameters: macParameters,
      executionMode: 'sequential',
      async execute(_id, args, signal) {
        return textResult(await operateMac(root, args, {signal}));
      }
    });
}
