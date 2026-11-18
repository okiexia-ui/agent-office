import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resultsForMessage, highlightedMessage} from '../public/collaboration-view.js';
test('Group results stay with their actual author and are not copied onto colleague replies', () => {
  const user = {id: 'u', authorType: 'user'},
    a = {id: 'a', authorType: 'agent', authorId: 'codex', replyTo: 'u'},
    b = {id: 'b', authorType: 'agent', authorId: 'gemini', replyTo: 'a'};
  const result = {id: 'v', agentId: 'codex', messageId: 'a'},
    onUser = {id: 'v2', agentId: 'codex', messageId: 'u'};
  assert.deepEqual(resultsForMessage(a, [user, a, b], [result, onUser]), [result, onUser]);
  assert.deepEqual(resultsForMessage(b, [user, a, b], [result, onUser]), []);
  assert.deepEqual(resultsForMessage(user, [user], [onUser]), [onUser]);
  assert.deepEqual(resultsForMessage(user, [user, a, b], [onUser]), []);
  const other = {id: 'c', authorType: 'agent', authorId: 'claude', replyTo: 'u'};
  assert.deepEqual(resultsForMessage(other, [user, a, other], [onUser]), []);
});
test('Mention styling escapes both message HTML and unusual member names', () => {
  const members = [
    {id: 'claude', name: 'Claude'},
    {id: 'r', name: '<img>'},
    {id: 'x', name: 'A+B'}
  ];
  const html = highlightedMessage(
    '@Claude 和 @A+B，给 @<img> 发消息。<script>alert(1)</script> email@claude.com',
    members
  );
  assert.match(html, /<span class="mention">@Claude<\/span>/);
  assert.match(html, /@A\+B<\/span>/);
  assert.match(html, /@&lt;img&gt;<\/span>/);
  assert.doesNotMatch(html, /<script>|<img>|email<span/);
  assert.match(highlightedMessage('@all 大家一起做', members), /<span class="mention">@all/);
});
