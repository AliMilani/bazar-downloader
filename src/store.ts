import { rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Abi, DownloadInfo } from './bazaar.ts';

const METADATA = 'metadata.json';

export type Metadata = {
  package: string;
  appName: string;
  versionCode: number;
  abi: Abi;
  sdk: number;
  source: string;
  downloadedAt: string;
  files: { name: string; size: number; sha1: string }[];
  additionalFiles: unknown[];
};

export function versionDir(out: string, pkg: string, versionCode: number, abi: Abi): string {
  return join(out, pkg, `${versionCode}-${abi}`);
}

export async function isComplete(dir: string): Promise<boolean> {
  return (await sizeOf(join(dir, METADATA))) !== null;
}

export async function hasFile(dir: string, name: string, size: number): Promise<boolean> {
  return (await sizeOf(join(dir, name))) === size;
}

export async function writeMetadata(
  dir: string,
  info: DownloadInfo,
  details: { abi: Abi; sdk: number; source: string; now: Date },
): Promise<void> {
  const metadata: Metadata = {
    package: info.package,
    appName: info.appName,
    versionCode: info.versionCode,
    abi: details.abi,
    sdk: details.sdk,
    source: details.source,
    downloadedAt: details.now.toISOString(),
    files: info.files.map(({ name, size, sha1 }) => ({ name, size, sha1 })),
    additionalFiles: info.additionalFiles,
  };
  const path = join(dir, METADATA);
  await writeFile(`${path}.part`, `${JSON.stringify(metadata, null, 2)}\n`);
  await rename(`${path}.part`, path);
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
