import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export type DownloadOptions = {
  urls: string[];
  dest: string;
  size: number;
  sha1: string;
  onProgress?: (received: number, total: number) => void;
};

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { urls, dest, size, sha1, onProgress } = options;
  const part = `${dest}.part`;
  const failures: string[] = [];

  if ((await sizeOf(part)) > size) await rm(part, { force: true });

  for (const url of urls) {
    const have = await sizeOf(part);
    if (have === size) break;
    try {
      await fetchInto(url, part, have, size, onProgress);
      break;
    } catch (error) {
      failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const got = await sizeOf(part);
  if (got !== size) {
    if (failures.length === urls.length) {
      throw new DownloadError(`all mirrors failed for ${dest}: ${failures.join('; ')}`);
    }
    await rm(part, { force: true });
    throw new DownloadError(`size mismatch for ${dest}: expected ${size} bytes, got ${got}`);
  }
  const actual = await sha1Of(part);
  if (actual !== sha1) {
    await rm(part, { force: true });
    throw new DownloadError(`SHA-1 mismatch for ${dest}: expected ${sha1}, got ${actual}`);
  }
  await rename(part, dest);
}

async function fetchInto(
  url: string,
  part: string,
  have: number,
  size: number,
  onProgress: DownloadOptions['onProgress'],
): Promise<void> {
  const response = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('empty response');
  const append = response.status === 206;
  let received = append ? have : 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      onProgress?.(received, size);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part, { flags: append ? 'a' : 'w' }));
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function sha1Of(path: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
