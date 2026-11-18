// Disk-backed stand-in for the R2 bucket, used only by the local servers.
// Supports the calls the Worker makes: head, get, conditional put and delete.
// The office state keeps its historical file name (state.json); other objects,
// such as visual content, live under objects/.
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_KEY = 'office/state-v2.json';

export async function localBucket(dir) {
  await fs.mkdir(path.join(dir, 'objects'), {recursive: true});
  const fileFor = key =>
    key === STATE_KEY ? path.join(dir, 'state.json') : path.join(dir, 'objects', encodeURIComponent(key));
  const objects = new Map();
  let generation = 0,
    writes = Promise.resolve();

  async function load(key) {
    if (objects.has(key)) return objects.get(key);
    const body = await fs.readFile(fileFor(key), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!objects.has(key)) objects.set(key, body === null ? null : {body, etag: `local-${++generation}`});
    return objects.get(key);
  }
  function persist(key, body) {
    writes = writes
      .catch(() => {})
      .then(async () => {
        const file = fileFor(key);
        if (body === null) return fs.rm(file, {force: true});
        await fs.writeFile(file + '.tmp', body);
        await fs.rename(file + '.tmp', file);
      });
    return writes;
  }

  return {
    async head(key) {
      const object = await load(key);
      return object ? {key, etag: object.etag, size: object.body.length} : null;
    },
    async get(key) {
      const object = await load(key);
      if (!object) return null;
      const {body, etag} = object;
      return {key, etag, size: body.length, json: async () => JSON.parse(body), text: async () => body};
    },
    async put(key, body, options = {}) {
      const condition = options.onlyIf,
        current = await load(key);
      // No await between the check and the write, so concurrent puts cannot both win.
      if (condition?.etagMatches && condition.etagMatches !== current?.etag) return null;
      if (condition?.etagDoesNotMatch === '*' && current) return null;
      const object = {body: String(body), etag: `local-${++generation}`};
      objects.set(key, object);
      await persist(key, object.body);
      return {key, etag: object.etag};
    },
    async delete(keys) {
      for (const key of [].concat(keys)) {
        objects.set(key, null);
        await persist(key, null);
      }
    }
  };
}
