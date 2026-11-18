import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import worker from '../../dist/server/index.js';
import {callTool} from '../../worker/index.js';
import {MemoryBucket} from '../memory-bucket.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    args: ['--enable-unsafe-swiftshader']
  });
});
after(() => browser?.close());

async function office(t, serviceWorkers = 'block') {
  const env = {BUCKET: new MemoryBucket(), OFFICE_LOCAL: true};
  await callTool('office_heartbeat', {agent_id: 'hermes'}, env);
  const server = http.createServer(async (req, res) => {
    try {
      const init = {method: req.method, headers: req.headers};
      if (!['GET', 'HEAD'].includes(req.method)) Object.assign(init, {body: req, duplex: 'half'});
      const response = await worker.fetch(new Request(new URL(req.url, origin), init), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.destroy(error);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  function stopServer() {
    if (!server.listening) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  }
  t.after(stopServer);
  const context = await browser.newContext({serviceWorkers, viewport: {width: 1280, height: 800}});
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  return {env, origin, context, page, stopServer};
}

async function openLiveOffice(page, origin) {
  await page.goto(origin + '/office.html');
  await page.locator('#sync-pill.live').waitFor();
}
async function recruit(page, name) {
  await page.locator('#recruit-btn').click();
  await page.locator('#agent-name').fill(name);
  await page.locator('#recruit-form button[type=submit]').click();
}
const unavailable = {status: 503, json: {error: 'Temporary storage failure'}};
const stateResponse = (page, method, status) =>
  page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/api/state' &&
      response.request().method() === method &&
      response.status() === status
  );

test('An idle office reconnects after a failed poll and can dispatch a task', async t => {
  const {page, origin} = await office(t);
  await openLiveOffice(page, origin);
  let failing = true;
  await page.route('**/api/state', route => (failing ? route.fulfill(unavailable) : route.continue()));
  await page.locator('#simulation-toggle').click();
  await page.locator('#sync-pill.down').waitFor();
  failing = false;
  const [reconnected] = await Promise.all([
    stateResponse(page, 'GET', 200),
    page.locator('#simulation-toggle').click()
  ]);
  assert.equal(await reconnected.request().headerValue('if-none-match'), null);
  await page.locator('#sync-pill.live').waitFor();
  await page.locator('.new-task-trigger:visible').first().click();
  await page.locator('#task-dialog[open]').waitFor();
});

test('A rejected recruit rolls back while offline and stays out of the next successful save', async t => {
  const {page, origin, env} = await office(t);
  await openLiveOffice(page, origin);
  await page.locator('.view-link[data-view=members]').click();
  let rejectWrites = true,
    rejectReads = false;
  await page.route('**/api/state', route => {
    if (route.request().method() === 'PUT' && rejectWrites) {
      rejectReads = true;
      return route.fulfill(unavailable);
    }
    return rejectReads ? route.fulfill(unavailable) : route.continue();
  });
  await recruit(page, 'Failed recruit');
  await page.locator('#sync-pill.down').waitFor();
  assert.equal(await page.locator('#nav-member-count').textContent(), '1');
  assert.deepEqual(
    JSON.parse(env.BUCKET.value).agents.map(a => a.name),
    ['Hermes']
  );
  rejectReads = rejectWrites = false;
  await page.locator('#simulation-toggle').click();
  await page.locator('#sync-pill.live').waitFor();
  await Promise.all([stateResponse(page, 'PUT', 200), recruit(page, 'Saved recruit')]);
  assert.deepEqual(
    JSON.parse(env.BUCKET.value).agents.map(a => a.name),
    ['Hermes', 'Saved recruit']
  );
});

test('A late poll cannot overwrite the outcome of a newer save', {timeout: 30000}, async t => {
  const {page, origin} = await office(t);
  await openLiveOffice(page, origin);
  await page.locator('.view-link[data-view=members]').click();
  let captured, release;
  const capturedRead = new Promise(resolve => {
    captured = resolve;
  });
  const finishRead = new Promise(resolve => {
    release = resolve;
  });
  await page.route('**/api/state', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const stale = await route.fetch({headers: {accept: 'application/json', 'if-none-match': ''}});
    captured();
    await finishRead;
    await route.fulfill({response: stale});
  });
  try {
    await page.locator('#simulation-toggle').click();
    await capturedRead;
    await Promise.all([stateResponse(page, 'PUT', 200), recruit(page, 'New member')]);
    await page.locator('#sync-pill.live').waitFor();
    const delivered = stateResponse(page, 'GET', 200);
    release();
    await delivered;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#nav-member-count').textContent(), '2');
  } finally {
    release();
  }
});

test('Reloading a link to an older visual retains the selected result and its URL', async t => {
  const {page, origin, env} = await office(t);
  const publish = title =>
    callTool(
      'office_publish_visual',
      {
        agent_id: 'hermes',
        request_id: title,
        title,
        kind: 'document',
        content: title
      },
      env
    );
  const {visual} = await publish('First');
  await publish('Second');
  await page.goto(origin + '/');
  await page.locator('#visual-picker button').filter({hasText: 'First'}).click();
  const heading = page.locator('#visual-content .artifact-header h3');
  await heading.filter({hasText: 'First'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('visual'), visual.id);
  await page.reload();
  await heading.waitFor();
  assert.equal(await heading.textContent(), 'First');
  assert.equal(new URL(page.url()).searchParams.get('visual'), visual.id);
});

test('The first visit can reopen the demo and its scene offline; an unvisited page gets the offline notice', async t => {
  const {page, origin, context, stopServer} = await office(t, 'allow');
  await page.goto(origin + '/?demo=1');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await stopServer();
  await page.reload();
  await page.locator('#conversations [data-agent="a2"]').click();
  assert.equal(await page.locator('#conversation-title').textContent(), 'Claude');
  assert.equal(await page.frameLocator('#office-frame').locator('#canvas-container').count(), 1);
  await page.goto(origin + '/office.html');
  assert.equal(await page.locator('h1').textContent(), '暂时连不上办公室');
});
