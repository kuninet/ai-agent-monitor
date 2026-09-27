import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/aggregate.js';

describe('aggregate.js snapshot', () => {
  test('sessions, tasks, questions include projectKey and projectName', async () => {
    const snapshot = await buildSnapshot('today', 'all');
    assert.ok(Array.isArray(snapshot.sessions));
    assert.ok(Array.isArray(snapshot.tasks));
    assert.ok(Array.isArray(snapshot.questions));

    for (const s of snapshot.sessions) {
      assert.ok('projectKey' in s, 'session has projectKey');
      assert.ok('projectName' in s, 'session has projectName');
      assert.ok('project' in s, 'session has project');
    }
    for (const t of snapshot.tasks) {
      assert.ok('projectKey' in t, 'task has projectKey');
      assert.ok('projectName' in t, 'task has projectName');
      assert.ok('project' in t, 'task has project');
    }
    for (const q of snapshot.questions) {
      assert.ok('projectKey' in q, 'question has projectKey');
      assert.ok('projectName' in q, 'question has projectName');
      assert.ok('project' in q, 'question has project');
    }
  });
});
