import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { DownloadInfo } from '../src/bazaar.ts';
import { hasFile, isComplete, versionDir, writeMetadata } from '../src/store.ts';

const info: DownloadInfo = {
  package: 'ir.divar',
  appName: 'Divar',
  versionCode: 260921010,
  files: [
    { name: 'base.apk', urls: ['https://a/base'], size: 5, sha1: 'a'.repeat(40) },
    { name: 'split-1.apk', urls: ['https://a/split'], size: 3, sha1: 'b'.repeat(40) },
  ],
  additionalFiles: [{ raw: true }],
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bazar-dl-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('versionDir is <out>/<package>/<versionCode>-<abi>', () => {
  assert.equal(versionDir('apks', 'ir.divar', 260921010, 'x86_64'), join('apks', 'ir.divar', '260921010-x86_64'));
});

test('a directory is complete only once metadata.json exists', async () => {
  assert.equal(await isComplete(join(dir, 'missing')), false);
  assert.equal(await isComplete(dir), false);
  await writeMetadata(dir, info, { abi: 'arm64-v8a', sdk: 33, source: 'ir.divar', now: new Date(0) });
  assert.equal(await isComplete(dir), true);
});

test('hasFile needs the exact size', async () => {
  await writeFile(join(dir, 'base.apk'), '12345');
  assert.equal(await hasFile(dir, 'base.apk', 5), true);
  assert.equal(await hasFile(dir, 'base.apk', 6), false);
  assert.equal(await hasFile(dir, 'split-1.apk', 3), false);
});

test('writeMetadata records the version without URLs and leaves no .part', async () => {
  await writeMetadata(dir, info, {
    abi: 'arm64-v8a',
    sdk: 33,
    source: 'https://cafebazaar.ir/app/ir.divar',
    now: new Date('2026-10-09T10:00:00.000Z'),
  });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')), {
    package: 'ir.divar',
    appName: 'Divar',
    versionCode: 260921010,
    abi: 'arm64-v8a',
    sdk: 33,
    source: 'https://cafebazaar.ir/app/ir.divar',
    downloadedAt: '2026-10-09T10:00:00.000Z',
    files: [
      { name: 'base.apk', size: 5, sha1: 'a'.repeat(40) },
      { name: 'split-1.apk', size: 3, sha1: 'b'.repeat(40) },
    ],
    additionalFiles: [{ raw: true }],
  });
  assert.deepEqual(await readdir(dir), ['metadata.json']);
});
