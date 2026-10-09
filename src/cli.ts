import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ABIS, getDownloadInfo, type Abi, type DownloadInfo } from './bazaar.ts';
import { downloadFile, type DownloadOptions } from './download.ts';
import { InvalidLinkError, parsePackage } from './link.ts';
import { foreignFiles, hasFile, readMetadata, versionDir, writeMetadata } from './store.ts';

export type Deps = {
  getDownloadInfo: (pkg: string, options: { abi: Abi; sdk: number }) => Promise<DownloadInfo>;
  downloadFile: (options: DownloadOptions) => Promise<void>;
  readLinks: () => Promise<string[]>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  progress?: (line: string) => void;
  now: () => Date;
};

type Target = { source: string; pkg: string };
type Settings = { abi: Abi; sdk: number; out: string };

const USAGE = `usage: bazar-dl [link-or-package...] [--abi ${ABIS.join('|')}] [--sdk 33] [--out ./apks]
With no link, links are read from standard input.`;

export async function run(argv: string[], deps: Deps = defaultDeps()): Promise<number> {
  const usage = (message: string): number => {
    deps.stderr(`bazar-dl: ${message}`);
    deps.stderr(USAGE);
    return 2;
  };

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usage(describe(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout(USAGE);
    return 0;
  }
  const abi = values.abi;
  const sdk = Number(values.sdk);
  if (!isAbi(abi)) return usage(`unknown ABI: ${abi}`);
  if (!Number.isInteger(sdk) || sdk < 1) return usage(`--sdk must be a positive integer: ${values.sdk}`);

  let inputs = positionals;
  if (inputs.length === 0) {
    try {
      inputs = await deps.readLinks();
    } catch (error) {
      // Ctrl-C or Ctrl-D at the prompt.
      if (error instanceof Error && error.name === 'AbortError') return 130;
      throw error;
    }
  }
  if (inputs.length === 0) return usage('no link given');

  const targets: Target[] = [];
  for (const source of inputs) {
    try {
      targets.push({ source, pkg: parsePackage(source) });
    } catch (error) {
      if (error instanceof InvalidLinkError) return usage(error.message);
      throw error;
    }
  }

  let failed = false;
  for (const target of targets) {
    try {
      deps.stdout(await storeOne(target, { abi, sdk, out: values.out }, deps));
    } catch (error) {
      failed = true;
      deps.stderr(`${target.pkg}: ${describe(error)}`);
    }
  }
  return failed ? 1 : 0;
}

async function storeOne(target: Target, settings: Settings, deps: Deps): Promise<string> {
  const info = await deps.getDownloadInfo(target.pkg, { abi: settings.abi, sdk: settings.sdk });
  const dir = versionDir(settings.out, info.package, info.versionCode, settings.abi);
  const stored = await readMetadata(dir);
  if (stored) {
    const have = stored.files.map((file) => file.sha1).sort();
    const want = info.files.map((file) => file.sha1).sort();
    if (have.join() !== want.join()) {
      throw new Error(
        `version ${info.versionCode} (${settings.abi}) is already stored with different files (stored with --sdk ${stored.sdk}); use another --out to keep both`,
      );
    }
    deps.stderr(`${target.pkg}: already stored (version ${info.versionCode}, ${settings.abi})`);
    return dir;
  }
  const foreign = await foreignFiles(dir, info.files);
  if (foreign.length > 0) {
    throw new Error(
      `${dir} holds files from a different download (${foreign.join(', ')}); remove them or use another --out`,
    );
  }

  await mkdir(dir, { recursive: true });
  for (const file of info.files) {
    if (await hasFile(dir, file.name, file.size)) continue;
    await deps.downloadFile({
      urls: file.urls,
      dest: join(dir, file.name),
      size: file.size,
      sha1: file.sha1,
      onProgress: progressFor(`${target.pkg} ${file.name}`, deps),
    });
    deps.stderr(`${target.pkg}: ${file.name} (${file.size} bytes)`);
  }
  if (info.additionalFiles.length > 0) {
    deps.stderr(
      `${target.pkg}: warning: ${info.additionalFiles.length} additional file(s) not downloaded, listed in metadata.json`,
    );
  }
  await writeMetadata(dir, info, { abi: settings.abi, sdk: settings.sdk, source: target.source, now: deps.now() });
  return dir;
}

function progressFor(label: string, deps: Deps): DownloadOptions['onProgress'] {
  const show = deps.progress;
  if (!show) return undefined;
  let last = -1;
  return (received, total) => {
    const percent = Math.floor((received / total) * 100);
    if (percent === last) return;
    last = percent;
    show(`${label} ${percent}%`);
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      abi: { type: 'string', default: 'arm64-v8a' },
      sdk: { type: 'string', default: '33' },
      out: { type: 'string', default: './apks' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
}

function isAbi(value: string): value is Abi {
  return (ABIS as readonly string[]).includes(value);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

function defaultDeps(): Deps {
  const tty = process.stderr.isTTY;
  const clear = tty ? '\r\x1b[2K' : '';
  return {
    getDownloadInfo,
    downloadFile,
    readLinks,
    stdout: (line) => console.log(line),
    stderr: (line) => process.stderr.write(`${clear}${line}\n`),
    progress: tty ? (line) => process.stderr.write(`${clear}${line}`) : undefined,
    now: () => new Date(),
  };
}

async function readLinks(): Promise<string[]> {
  let text = '';
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      text = await prompt.question('Cafe Bazaar link: ');
    } catch (error) {
      process.stderr.write('\n');
      throw error;
    } finally {
      prompt.close();
    }
  } else {
    for await (const chunk of process.stdin.setEncoding('utf8')) text += chunk;
  }
  return text.split(/\s+/).filter(Boolean);
}
