import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { DownloadInfo } from '../src/bazaar.ts';
import { foreignFiles, hasFile, readMetadata, versionDir, writeMetadata } from '../src/store.ts';

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

test('readMetadata is null until metadata.json exists', async () => {
  assert.equal(await readMetadata(join(dir, 'missing')), null);
  assert.equal(await readMetadata(dir), null);
  await writeMetadata(dir, info, { abi: 'arm64-v8a', sdk: 33, source: 'ir.divar', now: new Date(0) });
  assert.equal((await readMetadata(dir))?.sdk, 33);
});

test('foreignFiles lists stored APKs the expected files do not account for', async () => {
  await writeFile(join(dir, 'base.apk'), '123456789');
  await writeFile(join(dir, 'split-1.apk'), '123');
  await writeFile(join(dir, 'split-9.apk'), '1');
  await writeFile(join(dir, 'split-2.apk.part'), '1');
  assert.deepEqual(await foreignFiles(dir, info.files), ['base.apk', 'split-9.apk']);
  assert.deepEqual(await foreignFiles(join(dir, 'missing'), info.files), []);
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
