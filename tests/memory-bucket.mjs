// In-memory stand-in for an R2 bucket, shared by the server tests.
// It is key-aware and supports the calls the Worker uses: get, head, conditional put and delete.
// `value` and `etag` expose the office state object so tests can seed or inspect old data.
export const STATE_KEY = 'office/state-v2.json';

export class MemoryBucket {
  objects = new Map();
  generation = 0;
  calls = {get: 0, head: 0, put: 0, delete: 0};

  get value() {
    return this.objects.get(STATE_KEY)?.body ?? null;
  }
  set value(body) {
    if (body === null) this.objects.delete(STATE_KEY);
    else this.objects.set(STATE_KEY, {body: String(body), etag: String(++this.generation)});
  }
  get etag() {
    return this.objects.get(STATE_KEY)?.etag ?? null;
  }
  set etag(etag) {
    const object = this.objects.get(STATE_KEY);
    if (object) object.etag = etag;
  }

  async head(key) {
    this.calls.head++;
    const object = this.objects.get(key);
    return object ? {key, etag: object.etag, size: object.body.length} : null;
  }
  async get(key) {
    this.calls.get++;
    const object = this.objects.get(key);
    if (!object) return null;
    const {body, etag} = object;
    return {key, etag, size: body.length, json: async () => JSON.parse(body), text: async () => body};
  }
  async put(key, body, options = {}) {
    await Promise.resolve();
    this.calls.put++;
    const condition = options.onlyIf,
      current = this.objects.get(key);
    if (condition?.etagMatches && condition.etagMatches !== current?.etag) return null;
    if (condition?.etagDoesNotMatch === '*' && current) return null;
    const etag = String(++this.generation);
    this.objects.set(key, {body: String(body), etag});
    return {key, etag};
  }
  async delete(keys) {
    this.calls.delete++;
    for (const key of [].concat(keys)) this.objects.delete(key);
  }
  keys(prefix = '') {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix));
  }
}
