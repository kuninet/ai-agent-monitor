import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Sanity check', () => {
  test('environment is healthy', () => {
    assert.equal(1 + 1, 2);
  });
});
