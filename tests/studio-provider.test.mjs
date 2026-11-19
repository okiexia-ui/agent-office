import test from 'node:test';
import assert from 'node:assert/strict';
import {generateApi, listApiModels, validateBaseUrl} from '../scripts/studio-provider.mjs';

const connection = {baseUrl: 'https://provider.test/v1/', model: 'custom-model', apiKey: 'sample-test-credential'};
const ok = () => Response.json({choices: [{message: {content: ' 收到。 ', reasoning_content: 'internal'}}]});

test('accepts compatible provider bases or full endpoints and rejects credential-bearing or insecure remote URLs', () => {
  assert.equal(validateBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(validateBaseUrl(' https://api.openai.com/v1/chat/completions/ '), 'https://api.openai.com/v1');
  assert.equal(validateBaseUrl('http://[::1]:8098/v1'), 'http://[::1]:8098/v1');
  assert.equal(validateBaseUrl('https://chat/completions'), 'https://chat/completions');
  for (const url of [
    'http://example.test',
    'ftp://127.0.0.1',
    'http://127.0.0.1.test',
    'https://x:y@foo.test',
    'https://example.test/?key=abc',
    'https://example.test/#foo',
    'https://exa\nmple.test'
  ])
    assert.throws(() => validateBaseUrl(url), /HTTPS/);
});

test('sends the selected model, instructions, user prompt and key to one provider and extracts only assistant text', async () => {
  const answer = await generateApi(connection, 'draft', {
    instructions: 'be concise',
    send: async (url, request) => {
      assert.equal(url, 'https://provider.test/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'manual');
      assert.deepEqual(request.headers, {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer sample-test-credential'
      });
      assert.deepEqual(JSON.parse(request.body), {
        model: 'custom-model',
        messages: [
          {role: 'system', content: 'be concise'},
          {role: 'user', content: 'draft'}
        ],
        stream: false
      });
      return ok();
    }
  });
  assert.equal(answer, '收到。');
  await generateApi({...connection, apiKey: ''}, 'local chat', {
    send: async (url, request) => {
      assert.ok(!('Authorization' in request.headers));
      return ok();
    }
  });
});

test('hides upstream diagnostics and keys, rejects redirects, oversized replies and malformed completions', async () => {
  for (const status of [307, 401, 402, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(
      generateApi(connection, 'hi', {
        send: async () => {
          calls++;
          return new Response(connection.apiKey, {status, headers: {location: 'https://other.test'}});
        }
      }),
      err => err.message.includes(String(status)) && !err.message.includes(connection.apiKey)
    );
    assert.equal(calls, 1);
  }
  for (const response of [
    new Response(connection.apiKey),
    Response.json({choices: [{message: {content: null, reasoning_content: connection.apiKey}}]}),
    new Response(new Uint8Array(1024 * 1024 + 1)),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(connection.apiKey));
        }
      })
    )
  ]) {
    await assert.rejects(
      generateApi(connection, 'hi', {send: async () => response}),
      e => !e.message.includes(connection.apiKey)
    );
  }
  await assert.rejects(
    generateApi(connection, 'hi', {signal: AbortSignal.abort(), send: () => assert.fail('already aborted')}),
    {name: 'AbortError'}
  );
});

test('model discovery authenticates a single GET, limits the catalog and exposes only usable unique IDs', async () => {
  const models = await listApiModels(connection, {
    send: async (url, req) => {
      assert.equal(url, 'https://provider.test/v1/models');
      assert.equal(req.method, 'GET');
      assert.equal(req.body, undefined);
      assert.equal(req.redirect, 'manual');
      assert.equal(req.headers.Authorization, 'Bearer ' + connection.apiKey);
      const data = [
        {id: 42},
        {id: 'b'},
        {id: 'b'},
        {id: 'long'.repeat(100)},
        {id: '\n'},
        {id: connection.apiKey},
        {id: ' c '}
      ];
      for (let i = 0; i < 400; i++) data.push({id: 'm' + i});
      return Response.json({data});
    }
  });
  assert.deepEqual(models.slice(0, 3), ['b', 'c', 'm0']);
  assert.equal(models.length, 256);
  for (const bad of [
    Response.json({error: connection.apiKey}),
    new Response(new Uint8Array(1024 * 1024 + 1)),
    new Response(connection.apiKey, {status: 307, headers: {location: 'https://other.test'}})
  ])
    await assert.rejects(
      listApiModels(connection, {send: async () => bad}),
      e => !e.message.includes(connection.apiKey)
    );
});
