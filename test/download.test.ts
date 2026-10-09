import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DownloadError, downloadFile } from '../src/download.ts';

const content = randomBytes(200_000);
const sha1 = createHash('sha1').update(content).digest('hex');

let dir: string;
let dest: string;
const servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bazar-dl-'));
  dest = join(dir, 'base.apk');
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
});

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.apk`;
}

function ranged(log: string[]): RequestListener {
  return (request, response) => {
    log.push(request.headers.range ?? 'none');
    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
    if (!match) {
      response.writeHead(200, { 'Content-Length': content.length }).end(content);
      return;
    }
    const start = Number(match[1]);
    response
      .writeHead(206, {
        'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}`,
        'Content-Length': content.length - start,
      })
      .end(content.subarray(start));
  };
}

test('downloads a file, verifies it and leaves no .part', async () => {
  const log: string[] = [];
  const progress: number[] = [];
  const url = await serve(ranged(log));
  await downloadFile({ urls: [url], dest, size: content.length, sha1, onProgress: (received) => progress.push(received) });
  assert.deepEqual(await readFile(dest), content);
  assert.equal(existsSync(`${dest}.part`), false);
  assert.deepEqual(log, ['none']);
  assert.equal(progress.at(-1), content.length);
});

test('resumes from an existing .part with a Range request', async () => {
  const log: string[] = [];
  const url = await serve(ranged(log));
  await writeFile(`${dest}.part`, content.subarray(0, 50_000));
  await downloadFile({ urls: [url], dest, size: content.length, sha1 });
  assert.deepEqual(log, ['bytes=50000-']);
  assert.deepEqual(await readFile(dest), content);
});

test('restarts from zero when the server ignores Range', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { 'Content-Length': content.length }).end(content);
  });
  await writeFile(`${dest}.part`, Buffer.alloc(50_000, 1));
  await downloadFile({ urls: [url], dest, size: content.length, sha1 });
  assert.deepEqual(await readFile(dest), content);
});

test('continues on the next mirror after a dropped connection', async () => {
  const log: string[] = [];
  const broken = await serve((_request, response) => {
    response.writeHead(200, { 'Content-Length': content.length });
    response.write(content.subarray(0, 60_000), () => response.destroy());
  });
  const good = await serve(ranged(log));
  await downloadFile({ urls: [broken, good], dest, size: content.length, sha1 });
  assert.equal(log.length, 1);
  assert.deepEqual(await readFile(dest), content);
});

test('falls through to the next mirror on an HTTP error', async () => {
  const log: string[] = [];
  const forbidden = await serve((_request, response) => {
    response.writeHead(403).end('no');
  });
  const good = await serve(ranged(log));
  await downloadFile({ urls: [forbidden, good], dest, size: content.length, sha1 });
  assert.deepEqual(await readFile(dest), content);
});

test('fails and keeps the .part when every mirror fails', async () => {
  const broken = await serve((_request, response) => {
    response.writeHead(200, { 'Content-Length': content.length });
    response.write(content.subarray(0, 60_000), () => response.destroy());
  });
  const forbidden = await serve((_request, response) => {
    response.writeHead(403).end('no');
  });
  await assert.rejects(
    downloadFile({ urls: [broken, forbidden], dest, size: content.length, sha1 }),
    (error: unknown) => error instanceof DownloadError && /all mirrors failed/.test(error.message) && /HTTP 403/.test(error.message),
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), true);
});

test('fails and deletes the .part on a size mismatch', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200).end(content.subarray(0, 1000));
  });
  await assert.rejects(downloadFile({ urls: [url], dest, size: content.length, sha1 }), /size mismatch/);
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

test('fails and deletes the .part on a SHA-1 mismatch', async () => {
  const url = await serve(ranged([]));
  await assert.rejects(downloadFile({ urls: [url], dest, size: content.length, sha1: '0'.repeat(40) }), /SHA-1 mismatch/);
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

test('verifies a full-size .part without any request', async () => {
  const log: string[] = [];
  const url = await serve(ranged(log));
  await writeFile(`${dest}.part`, content);
  await downloadFile({ urls: [url], dest, size: content.length, sha1 });
  assert.deepEqual(log, []);
  assert.deepEqual(await readFile(dest), content);
});

test('restarts when the .part is larger than the expected size', async () => {
  const log: string[] = [];
  const url = await serve(ranged(log));
  await writeFile(`${dest}.part`, Buffer.alloc(content.length + 10, 1));
  await downloadFile({ urls: [url], dest, size: content.length, sha1 });
  assert.deepEqual(log, ['none']);
  assert.deepEqual(await readFile(dest), content);
});
