// Disk-backed stand-in for the R2 bucket, used only by the local servers.
// Supports the calls the Worker makes: head, get, conditional put and delete.
// The office state keeps its historical file name (state.json); other objects,
// such as visual content, live under objects/.
import fs from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

const STATE_KEY = 'office/state-v2.json';

function missingFile(error) {
  if (error.code !== 'ENOENT') throw error;
  return null;
}

// Each successful write replaces the inode. These tags survive a server restart
// and can be checked with stat alone, including from another preview process.
function metadata(key, stat) {
  return {key, etag: `local-${stat.ino}-${stat.ctimeNs}-${stat.mtimeNs}-${stat.size}`, size: Number(stat.size)};
}

export async function localBucket(dir) {
  await fs.mkdir(path.join(dir, 'objects'), {recursive: true});
  const fileFor = key =>
    key === STATE_KEY ? path.join(dir, 'state.json') : path.join(dir, 'objects', encodeURIComponent(key));
  async function head(key) {
    const stat = await fs.stat(fileFor(key), {bigint: true}).catch(missingFile);
    return stat && metadata(key, stat);
  }
  async function writeLocked(action) {
    const release = await lockfile.lock(dir, {
      lockfilePath: path.join(dir, '.write.lock'),
      retries: {retries: 50, minTimeout: 8, maxTimeout: 250, randomize: true}
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }

  return {
    head,
    async get(key) {
      const file = await fs.open(fileFor(key), 'r').catch(missingFile);
      if (!file) return null;
      try {
        // Reading both from the same handle pairs the body with its own version.
        const info = metadata(key, await file.stat({bigint: true}));
        const body = await file.readFile('utf8');
        return {...info, json: async () => JSON.parse(body), text: async () => body};
      } finally {
        await file.close();
      }
    },
    async put(key, body, options = {}) {
      return writeLocked(async () => {
        const condition = options.onlyIf;
        if (condition) {
          const current = await head(key);
          if (condition.etagMatches && condition.etagMatches !== current?.etag) return null;
          if (condition.etagDoesNotMatch === '*' && current) return null;
        }
        const file = fileFor(key);
        await fs.writeFile(file + '.tmp', String(body));
        await fs.rename(file + '.tmp', file);
        return head(key);
      });
    },
    async delete(keys) {
      await writeLocked(async () => {
        for (const key of [].concat(keys)) await fs.rm(fileFor(key), {force: true});
      });
    }
  };
}
