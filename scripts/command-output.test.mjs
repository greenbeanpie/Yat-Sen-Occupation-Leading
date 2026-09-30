import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonArrayResult } from './command-output.mjs';

test('parses JSON stdout even when stderr has ANSI/proxy brackets', () => {
  const stdout = '[{"name":"existing-database"}]\n';
  const stderr = '\u001b[33m▲ [WARNING] Proxy environment variables detected.\u001b[0m';
  assert.deepEqual(parseJsonArrayResult({ code: 0, stdout, stderr, output: stdout + stderr }), [{ name: 'existing-database' }]);
});
test('retains migration result arrays without trimming by diagnostic brackets', () => {
  assert.deepEqual(parseJsonArrayResult({ code: 0, stdout: ' [{"results":[{"name":"0001.sql"}],"success":true}] ' }), [{ results: [{ name: '0001.sql' }], success: true }]);
});
test('fails closed on command failure, invalid output or non-array JSON', () => {
  assert.throws(() => parseJsonArrayResult({ code: 1, stdout: '[]' }), /Command failed/);
  assert.throws(() => parseJsonArrayResult({ code: 0, stdout: 'warning [x]\n[]' }));
  assert.throws(() => parseJsonArrayResult({ code: 0, stdout: '{}' }), /JSON array/);
});
