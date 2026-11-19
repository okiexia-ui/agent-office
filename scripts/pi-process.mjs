import {execFile} from 'node:child_process';
import {stripVTControlCharacters} from 'node:util';

// Pi's provider settings (including PI_CODING_AGENT_DIR) belong to Pi. The
// credential for the remote Office belongs only to the Office transport.
function invokePi(args, input, {signal, timeout, env}) {
  signal?.throwIfAborted();
  const {AGENT_OFFICE_TOKEN, HERMES_SITE_ACCESS_TOKEN, ...childEnv} = env;
  return new Promise((resolve, reject) => {
    const child = execFile(
      env.OFFICE_PI_BIN || 'pi',
      args,
      {env: {...childEnv, PI_OFFLINE: '1'}, timeout, killSignal: 'SIGKILL', signal, maxBuffer: 1024 * 1024},
      (error, stdout, stderr) => {
        if (signal?.aborted) return reject(signal.reason);
        if (!error) return resolve(stripVTControlCharacters(stdout).trim());
        let detail;
        if (error.code === 'ENOENT') detail = '找不到 Pi CLI，请安装 Pi 或设置 OFFICE_PI_BIN。';
        else if (error.killed) detail = 'Pi 运行超时或已被终止。';
        else if (/auth|api key|credential|401|403/i.test(stderr)) detail = '请核对 Pi 的模型授权。';
        else if (/model|provider|connect|fetch/i.test(stderr)) detail = '请检查 Pi 的模型名称及推理服务连接。';
        else detail = `Pi 未能完成请求（${error.code || error.signal || 'unknown'}）。`;
        reject(new Error(detail));
      }
    );
    // An early CLI exit can close the pipe while Node is writing the prompt.
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') {
        child.kill('SIGKILL');
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export function preflightPi({signal, env = process.env} = {}) {
  return invokePi(['--version'], '', {signal, timeout: 15000, env});
}

export async function generatePi(prompt, {signal, env = process.env, timeout = 180000, instructions = ''} = {}) {
  const args = [
    '--print',
    '--mode',
    'text',
    '--no-session',
    '--no-approve',
    '--no-context-files',
    '--no-skills',
    '--no-extensions',
    '--no-prompt-templates'
  ];
  // Pi interprets a bare path as a prompt file. Prefix profile text so a web
  // profile cannot cause a local file to be loaded as system instructions.
  if (instructions.trim()) args.push('--append-system-prompt', '办公室角色指令：\n' + instructions);
  if (env.OFFICE_PI_READ_TOOLS === '1') args.push('--tools', 'read,grep,find,ls');
  else args.push('--no-tools');
  if (env.OFFICE_PI_PROVIDER) {
    if (!env.OFFICE_PI_MODEL) throw new Error('指定 OFFICE_PI_PROVIDER 时还需设置 OFFICE_PI_MODEL。');
    args.push('--provider', env.OFFICE_PI_PROVIDER);
  }
  if (env.OFFICE_PI_MODEL) args.push('--model', env.OFFICE_PI_MODEL);
  const output = await invokePi(args, prompt, {signal, timeout, env});
  if (!output) throw new Error('Pi 没有返回回复正文。');
  return output;
}
