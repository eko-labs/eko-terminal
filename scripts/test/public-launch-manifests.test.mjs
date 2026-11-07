import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeArtifact, generateManifest, selectedFiles } from '../public-launch-manifests.mjs';

test('candidate inventory verifies all bytes and common release/disclosure coverage without implying acceptance', () => {
  const actual = generateManifest();
  assert.deepEqual(actual, JSON.parse(readFileSync(new URL('../../docs/public-launch/artifact-manifests.json', import.meta.url))));
  assert.equal(actual.publicationApproved, false);
  assert.equal(actual.bountyActive, false);
  assert.deepEqual(actual.verifiedDeployments, []);
  assert.equal(actual.publicWindow.openedAt, null);
  assert.equal(actual.publicWindow.closedAt, null);
  assert.equal(actual.publicWindow.opensAt, '2026-10-13T13:00:00Z');
  assert.equal(actual.publicWindow.closesAt, '2026-10-16T13:00:00Z');
  assert.equal(actual.publicWindow.ownerSignoffDate, '2026-10-18');
  assert.deepEqual(actual.repositories.map(repo => repo.name), ['contracts', 'playbooks', 'receipts-verifier']);
  for (const repo of actual.repositories) {
    assert.equal(repo.publicUrl, null);
    for (const path of ['LICENSE', 'SECURITY.md', '.well-known/security.txt']) assert.ok(repo.files.some(file => file.destination === path));
    assert.ok(repo.files.every(file => !/^(?:apps\/|\.env|.*\/(?:node_modules|runs|out|broadcast)\/)/.test(file.source)));
  }
});
test('digest binds destination, membership and exact source bytes, with deterministic ordering', () => {
  const read = path => Buffer.from(path === 'a.ts' ? 'fixture-a' : 'fixture-b');
  const pairs = [['a.ts', 'a.ts'], ['b.ts', 'b.ts']];
  const first = describeArtifact(pairs, read);
  assert.deepEqual(first, describeArtifact([...pairs].reverse(), read));
  assert.notEqual(first.sha256, describeArtifact(pairs, () => Buffer.from('tamper')).sha256);
  assert.notEqual(first.sha256, describeArtifact([pairs[0]], read).sha256);
  assert.notEqual(first.sha256, describeArtifact([['a.ts', 'renamed.ts'], pairs[1]], read).sha256);
  assert.throws(() => describeArtifact([pairs[0], pairs[0]], read), /Duplicate/);
  for (const path of ['/absolute.ts', '../escape.ts', 'folder/../escape.ts', 'folder\\escape.ts']) assert.throws(() => describeArtifact([[path, 'a.ts']], read), /relative/);
});
test('allowlist rejects secrets and runtime outputs even if they match a prefix', () => {
  const definition = { exact: [], prefixes: ['fixture/'] };
  assert.deepEqual(selectedFiles(definition, ['other/source.ts', 'fixture/.env.json', 'fixture/node_modules/source.ts', 'fixture/broadcast/run.json', 'fixture/runs/log.json', 'fixture/out/metadata.json', 'fixture/cache/metadata.json', 'fixture/dist/output.ts', 'fixture/source.ts']), ['fixture/source.ts']);
});
