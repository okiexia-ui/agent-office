// What the workbench needs to set up Pi's local model without editing .env.local:
// saved settings, and what this computer already has (Pi CLI, llama-server, running
// Ollama / LM Studio, GGUF files in the usual model folders).
import {access, mkdir, readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listApiModels} from './studio-provider.mjs';

export class PiSetupError extends Error {}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
export const LOCAL_SERVICES = [
  {id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1'},
  {id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1'}
];

// {file} runs a GGUF with llama-server; {url, model} uses a service already running on this computer.
export function validatePiSettings(input) {
  if (!input || typeof input !== 'object') throw new PiSetupError('请选择本机模型。');
  if (typeof input.file === 'string') {
    const file = input.file.trim();
    if (!path.isAbsolute(file) || !/\.gguf$/i.test(file) || file.length > 4096)
      throw new PiSetupError('请填写 GGUF 模型文件的完整路径，以 .gguf 结尾。');
    return {file: path.normalize(file)};
  }
  if (typeof input.url === 'string' && typeof input.model === 'string') {
    const model = input.model.trim();
    let url;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw new PiSetupError('本机模型服务地址无效。');
    }
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.includes(url.hostname) || url.username || url.password)
      throw new PiSetupError('Pi 只连接这台电脑上的模型服务（127.0.0.1 或 localhost）。');
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) throw new PiSetupError('请选择模型。');
    return {url: url.origin + url.pathname.replace(/\/+$/, ''), model};
  }
  throw new PiSetupError('请选择本机模型。');
}

// The settings become the same variables .env.local would set.
export function piSettingsEnv(settings) {
  if (settings?.file) return {OFFICE_MODEL_FILE: settings.file};
  if (settings?.url) return {OFFICE_MODEL_URL: settings.url, OFFICE_MODEL_ID: settings.model};
  return {};
}

export async function readPiSettings(file) {
  try {
    return validatePiSettings(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.error('忽略无效的本机模型设置：' + error.message);
    return null;
  }
}

export async function writePiSettings(file, settings) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(settings ?? {}), {mode: 0o600});
  await rename(temporary, file);
}

async function executable(file) {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

// Apps opened from Finder get a short PATH, so also look where Homebrew installs llama.cpp.
export async function findLlamaServer(env = process.env) {
  const name = env.OFFICE_LLAMA_BIN || 'llama-server';
  if (name.includes('/')) return (await executable(name)) ? name : null;
  const dirs = [...(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of new Set(dirs.filter(Boolean))) {
    const candidate = path.join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

// Usual download folders of LM Studio and llama.cpp. Desktop, Documents and Downloads are left
// out on purpose: reading them would make macOS ask for permission on every check.
export function modelFolders(home = os.homedir()) {
  return [
    path.join(home, '.lmstudio', 'models'),
    path.join(home, '.cache', 'lm-studio', 'models'),
    path.join(home, '.cache', 'llama.cpp'),
    path.join(home, 'Library', 'Caches', 'llama.cpp'),
    path.join(home, 'models')
  ];
}

export async function findGgufFiles(folders = modelFolders(), {limit = 40, depth = 4} = {}) {
  const found = [];
  async function walk(dir, level) {
    if (found.length >= limit || level > depth) return;
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, level + 1);
      // Vision projector files are not chat models.
      else if (entry.isFile() && /\.gguf$/i.test(entry.name) && !/mmproj/i.test(entry.name)) {
        const {size} = await stat(full).catch(() => ({size: 0}));
        found.push({file: full, name: entry.name, size});
      }
    }
  }
  for (const folder of folders) await walk(folder, 0);
  return found;
}

// Model services already running on this computer, with their chat models.
export async function detectServices({send = fetch, timeout = 1500} = {}) {
  return (
    await Promise.all(
      LOCAL_SERVICES.map(async service => {
        try {
          const models = await listApiModels({baseUrl: service.baseUrl}, {send, signal: AbortSignal.timeout(timeout)});
          return {...service, models};
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);
}
