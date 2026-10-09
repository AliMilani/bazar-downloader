import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { AppNotFoundError, type Abi, type DownloadInfo } from '../src/bazaar.ts';
import { run, type Deps } from '../src/cli.ts';
import type { DownloadOptions } from '../src/download.ts';

const info: DownloadInfo = {
  package: 'ir.divar',
  appName: 'Divar',
  versionCode: 7,
  files: [
    { name: 'base.apk', urls: ['https://a/base'], size: 5, sha1: 'a'.repeat(40) },
    { name: 'split-1.apk', urls: ['https://a/split'], size: 3, sha1: 'b'.repeat(40) },
  ],
  additionalFiles: [],
};

type Harness = Deps & {
  infoCalls: { pkg: string; abi: Abi; sdk: number }[];
  downloads: DownloadOptions[];
  out: string[];
  err: string[];
};

function harness(overrides: Partial<Deps> = {}): Harness {
  const h: Harness = {
    infoCalls: [],
    downloads: [],
    out: [],
    err: [],
    getDownloadInfo: async (pkg, options) => {
      h.infoCalls.push({ pkg, ...options });
      return { ...info, package: pkg };
    },
    downloadFile: async (options) => {
      h.downloads.push(options);
      await writeFile(options.dest, Buffer.alloc(options.size));
    },
    readLinks: async () => [],
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    now: () => new Date('2026-10-09T10:00:00.000Z'),
    ...overrides,
  };
  return h;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bazar-dl-cli-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('stores every file, writes metadata and prints the directory', async () => {
  const h = harness();
  const code = await run(['https://cafebazaar.ir/app/ir.divar?l=en', '--out', root], h);
  const dir = join(root, 'ir.divar', '7-arm64-v8a');
  assert.equal(code, 0);
  assert.deepEqual(h.out, [dir]);
  assert.deepEqual(h.infoCalls, [{ pkg: 'ir.divar', abi: 'arm64-v8a', sdk: 33 }]);
  assert.deepEqual(
    h.downloads.map((d) => [d.dest, d.size, d.sha1, d.urls]),
    [
      [join(dir, 'base.apk'), 5, 'a'.repeat(40), ['https://a/base']],
      [join(dir, 'split-1.apk'), 3, 'b'.repeat(40), ['https://a/split']],
    ],
  );
  const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
  assert.equal(metadata.source, 'https://cafebazaar.ir/app/ir.divar?l=en');
  assert.equal(metadata.downloadedAt, '2026-10-09T10:00:00.000Z');
  assert.equal(metadata.files.length, 2);
});

test('--abi and --sdk reach the store and the directory name', async () => {
  const h = harness();
  const code = await run(['ir.divar', '--abi', 'x86_64', '--sdk', '22', '--out', root], h);
  assert.equal(code, 0);
  assert.deepEqual(h.infoCalls, [{ pkg: 'ir.divar', abi: 'x86_64', sdk: 22 }]);
  assert.deepEqual(h.out, [join(root, 'ir.divar', '7-x86_64')]);
});

test('a complete version is skipped on rerun', async () => {
  await run(['ir.divar', '--out', root], harness());
  const h = harness();
  const code = await run(['ir.divar', '--out', root], h);
  assert.equal(code, 0);
  assert.deepEqual(h.downloads, []);
  assert.deepEqual(h.out, [join(root, 'ir.divar', '7-arm64-v8a')]);
  assert.match(h.err.join('\n'), /already stored/);
});

test('the same link twice in one run downloads once', async () => {
  const h = harness();
  const code = await run(['ir.divar', 'https://cafebazaar.ir/app/ir.divar', '--out', root], h);
  assert.equal(code, 0);
  assert.equal(h.downloads.length, 2);
  assert.equal(h.out.length, 2);
});

test('an incomplete version downloads only the missing files', async () => {
  const dir = join(root, 'ir.divar', '7-arm64-v8a');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'base.apk'), Buffer.alloc(5));
  const h = harness();
  const code = await run(['ir.divar', '--out', root], h);
  assert.equal(code, 0);
  assert.deepEqual(h.downloads.map((d) => d.dest), [join(dir, 'split-1.apk')]);
  assert.equal(existsSync(join(dir, 'metadata.json')), true);
});

test('metadata is not written when a download fails', async () => {
  const h = harness({
    downloadFile: async () => {
      throw new Error('SHA-1 mismatch');
    },
  });
  const code = await run(['ir.divar', '--out', root], h);
  assert.equal(code, 1);
  assert.equal(existsSync(join(root, 'ir.divar', '7-arm64-v8a', 'metadata.json')), false);
  assert.deepEqual(h.out, []);
});

test('one failed argument does not stop the rest', async () => {
  const h = harness();
  const getDownloadInfo = h.getDownloadInfo;
  h.getDownloadInfo = async (pkg, options) => {
    if (pkg === 'no.such.app') throw new AppNotFoundError();
    return getDownloadInfo(pkg, options);
  };
  const code = await run(['no.such.app', 'ir.divar', '--out', root], h);
  assert.equal(code, 1);
  assert.deepEqual(h.out, [join(root, 'ir.divar', '7-arm64-v8a')]);
  assert.deepEqual(h.err.filter((line) => line.startsWith('no.such.app')), ['no.such.app: not found on Cafe Bazaar']);
});

test('an unexpected error becomes one line with its cause', async () => {
  const h = harness({
    getDownloadInfo: async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.cafebazaar.ir') });
    },
  });
  const code = await run(['ir.divar', 'ir.torob', '--out', root], h);
  assert.equal(code, 1);
  assert.deepEqual(h.err, [
    'ir.divar: fetch failed (getaddrinfo ENOTFOUND api.cafebazaar.ir)',
    'ir.torob: fetch failed (getaddrinfo ENOTFOUND api.cafebazaar.ir)',
  ]);
});

test('an unwritable output directory fails that argument without a stack trace', async () => {
  const blocker = join(root, 'file');
  await writeFile(blocker, 'x');
  const h = harness();
  const code = await run(['ir.divar', '--out', blocker], h);
  assert.equal(code, 1);
  assert.equal(h.err.length, 1);
  assert.match(h.err[0], /^ir\.divar: .*ENOTDIR/);
});

test('warns about additional files and records them', async () => {
  const h = harness({
    getDownloadInfo: async (pkg) => ({ ...info, package: pkg, additionalFiles: [{ obb: 1 }] }),
  });
  const code = await run(['ir.divar', '--out', root], h);
  assert.equal(code, 0);
  assert.match(h.err.join('\n'), /warning: 1 additional file\(s\) not downloaded/);
  const metadata = JSON.parse(await readFile(join(root, 'ir.divar', '7-arm64-v8a', 'metadata.json'), 'utf8'));
  assert.deepEqual(metadata.additionalFiles, [{ obb: 1 }]);
});

test('reports whole-percent progress when a progress sink exists', async () => {
  const lines: string[] = [];
  const h = harness({
    progress: (line) => lines.push(line),
    downloadFile: async (options) => {
      options.onProgress?.(1, 4);
      options.onProgress?.(1, 4);
      options.onProgress?.(4, 4);
      await writeFile(options.dest, Buffer.alloc(options.size));
    },
  });
  await run(['ir.divar', '--out', root], h);
  assert.deepEqual(lines.slice(0, 2), ['ir.divar base.apk 25%', 'ir.divar base.apk 100%']);
});

test('with no link arguments, links come from readLinks', async () => {
  const h = harness({ readLinks: async () => ['https://cafebazaar.ir/app/ir.torob?l=en'] });
  const code = await run(['--out', root], h);
  assert.equal(code, 0);
  assert.deepEqual(h.out, [join(root, 'ir.torob', '7-arm64-v8a')]);
});

const usageErrors: [string, string[], RegExp][] = [
  ['no link at all', [], /no link given/],
  ['an unparseable link', ['ir.divar', 'https://example.com/x'], /not a Cafe Bazaar link/],
  ['an unknown ABI', ['ir.divar', '--abi', 'mips'], /unknown ABI: mips/],
  ['a non-numeric SDK', ['ir.divar', '--sdk', 'new'], /--sdk must be a positive integer/],
  ['an unknown option', ['ir.divar', '--fast'], /--fast/],
];

for (const [name, argv, message] of usageErrors) {
  test(`exits 2 without any network call on ${name}`, async () => {
    const h = harness();
    const code = await run([...argv, '--out', root], h);
    assert.equal(code, 2);
    assert.deepEqual(h.infoCalls, []);
    assert.match(h.err.join('\n'), message);
    assert.match(h.err.join('\n'), /usage: bazar-dl/);
  });
}

test('--help prints usage and exits 0', async () => {
  const h = harness();
  assert.equal(await run(['--help'], h), 0);
  assert.match(h.out.join('\n'), /usage: bazar-dl/);
});
