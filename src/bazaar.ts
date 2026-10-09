export const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'] as const;
export type Abi = (typeof ABIS)[number];

export type RemoteFile = { name: string; urls: string[]; size: number; sha1: string };

export type DownloadInfo = {
  package: string;
  appName: string;
  versionCode: number;
  files: RemoteFile[];
  additionalFiles: unknown[];
};

export type Fetch = typeof fetch;

export class AppNotFoundError extends Error {
  constructor() {
    super('not found on Cafe Bazaar');
    this.name = 'AppNotFoundError';
  }
}

export class StoreError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(`Cafe Bazaar error (HTTP ${status}): ${message}`);
    this.name = 'StoreError';
    this.status = status;
  }
}

const ENDPOINT = 'https://api.cafebazaar.ir/rest-v1/process/AppDownloadInfoRequest';

const CPU: Record<Abi, string> = {
  'arm64-v8a': 'arm64-v8a,armeabi-v7a,armeabi',
  'armeabi-v7a': 'armeabi-v7a,armeabi',
  x86_64: 'x86_64,x86',
  x86: 'x86',
};

type Json = Record<string, unknown>;

export async function getDownloadInfo(
  pkg: string,
  options: { abi: Abi; sdk: number; fetch?: Fetch },
): Promise<DownloadInfo> {
  const response = await (options.fetch ?? fetch)(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      properties: {
        language: 2,
        clientVersionCode: 1100301,
        clientVersion: '11.3.1',
        isKidsEnabled: false,
        androidClientInfo: { sdkVersion: options.sdk, cpu: CPU[options.abi] },
      },
      singleRequest: {
        appDownloadInfoRequest: { downloadStatus: 1, packageName: pkg, referrers: [] },
      },
    }),
  });

  let body: Json | null;
  try {
    body = asObject(JSON.parse(await response.text()));
  } catch {
    throw new StoreError(response.status, 'reply was not JSON');
  }
  if (response.status === 404) throw new AppNotFoundError();
  if (!response.ok) {
    const message = asObject(body?.properties)?.errorMessage;
    throw new StoreError(response.status, typeof message === 'string' ? message : 'no message');
  }

  const reply = asObject(asObject(body?.singleReply)?.appDownloadInfoReply);
  if (!reply) throw new StoreError(response.status, 'reply has no download info');
  const versionCode = Number(reply.versionCode);
  if (!Number.isInteger(versionCode)) throw new StoreError(response.status, 'reply has no versionCode');

  const fail = (message: string): never => {
    throw new StoreError(response.status, message);
  };
  const files = [remoteFile('base.apk', reply.fullPathUrls, reply.packageSize, reply.hashCode, fail)];
  for (const entry of asArray(reply.splits)) {
    const split = asObject(entry) ?? {};
    const token = String(split.token ?? '');
    if (!/^[A-Za-z0-9_-]+$/.test(token)) fail(`unsafe split token: ${token}`);
    files.push(remoteFile(`split-${token}.apk`, split.fullPathUrls, split.size, split.sha1hash, fail));
  }

  return {
    package: pkg,
    appName: typeof reply.appName === 'string' ? reply.appName : pkg,
    versionCode,
    files,
    additionalFiles: asArray(reply.additionalFiles),
  };
}

function remoteFile(
  name: string,
  urls: unknown,
  size: unknown,
  sha1: unknown,
  fail: (message: string) => never,
): RemoteFile {
  const list = asArray(urls).filter((url): url is string => typeof url === 'string' && url.startsWith('https://'));
  const bytes = Number(size);
  if (list.length === 0) fail(`no download URL for ${name}`);
  if (!Number.isInteger(bytes) || bytes <= 0) fail(`no size for ${name}`);
  if (typeof sha1 !== 'string' || !/^[0-9a-f]{40}$/i.test(sha1)) return fail(`no SHA-1 for ${name}`);
  return { name, urls: list, size: bytes, sha1: sha1.toLowerCase() };
}

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
