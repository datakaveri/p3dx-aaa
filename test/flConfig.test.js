import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlConfigFromSubmission } from '../src/services/formSubmissions.service.js';

const sub = { num_server_rounds: 5, local_epochs: 2, learning_rate: 0.01, batch_size: 32 };

test('maps a submission to fl_config', () => {
  assert.deepEqual(buildFlConfigFromSubmission(sub), {
    num_rounds: 5, local_epochs: 2, learning_rate: 0.01, batch_size: 32,
  });
});

test('coerces numeric strings and truncates integer fields', () => {
  assert.deepEqual(
    buildFlConfigFromSubmission({ num_server_rounds: '5', local_epochs: 2.9, learning_rate: '0.5', batch_size: '16' }),
    { num_rounds: 5, local_epochs: 2, learning_rate: 0.5, batch_size: 16 }
  );
});

test('returns undefined for a missing submission or missing/non-finite values', () => {
  assert.equal(buildFlConfigFromSubmission(null), undefined);
  assert.equal(buildFlConfigFromSubmission({ ...sub, batch_size: null }), undefined);
  assert.equal(buildFlConfigFromSubmission({ ...sub, learning_rate: 'abc' }), undefined);
  assert.equal(buildFlConfigFromSubmission({ ...sub, local_epochs: Infinity }), undefined);
  assert.equal(buildFlConfigFromSubmission({ num_server_rounds: 5 }), undefined);
});
