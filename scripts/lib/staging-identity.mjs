import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import contract from '../../apps/server/src/build-identity-contract.json' with { type: 'json' };

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function bundleBuildInfo(directory, revision) {
  assert.ok(revision === null || /^[a-f0-9]{40}$/.test(revision), 'EKO_SOURCE_REVISION must be a full lowercase Git SHA');
  const bundles = Object.fromEntries(contract.bundleFiles.map(file => [file, sha256(readFileSync(join(directory, file)))]));
  return { formatVersion: contract.formatVersion, sourceRevision: revision, bundles, bundleDigest: sha256(canonicalJson(bundles)) };
}
export function validateIdentity(identity) {
  assert.deepEqual(Object.keys(identity).sort(), ['build', 'configDigest', 'configVersion', 'role']);
  assert.ok(['api', 'worker', 'indexer', 'engines'].includes(identity.role), 'Expected an API, worker, indexer or engines identity');
  assert.equal(identity.configVersion, contract.configVersion);
  assert.match(identity.configDigest, /^[a-f0-9]{64}$/);
  const build = identity.build;
  assert.deepEqual(Object.keys(build).sort(), ['bundleDigest', 'bundles', 'formatVersion', 'sourceRevision']);
  assert.equal(build.formatVersion, contract.formatVersion);
  assert.match(build.sourceRevision, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(build.bundles).sort(), contract.bundleFiles);
  for (const digest of Object.values(build.bundles)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(build.bundleDigest, sha256(canonicalJson(build.bundles)));
}
export function compareIdentity(actual, expected) {
  validateIdentity(actual);
  assert.deepEqual(actual, expected, 'Live build or effective allowlisted configuration differs');
}
