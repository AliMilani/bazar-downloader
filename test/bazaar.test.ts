import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ABIS, AppNotFoundError, getDownloadInfo, StoreError, type Fetch } from '../src/bazaar.ts';

type Call = { url: string; init: RequestInit };

function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function reply(status: number, body: string, calls: Call[] = []): Fetch {
  return async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  };
}

function withReply(change: (reply: Record<string, unknown>) => void, source: string): string {
  const body = JSON.parse(source);
  change(body.singleReply.appDownloadInfoReply);
  return JSON.stringify(body);
}

const cpus = {
  'arm64-v8a': 'arm64-v8a,armeabi-v7a,armeabi',
  'armeabi-v7a': 'armeabi-v7a,armeabi',
  x86_64: 'x86_64,x86',
  x86: 'x86',
};

for (const abi of ABIS) {
  test(`sends the device profile for ${abi}`, async () => {
    const calls: Call[] = [];
    await getDownloadInfo('ir.torob', { abi, sdk: 30, fetch: reply(200, await fixture('reply-single.json'), calls) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.cafebazaar.ir/rest-v1/process/AppDownloadInfoRequest');
    assert.equal(calls[0].init.method, 'POST');
    const sent = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(sent.properties.androidClientInfo, { sdkVersion: 30, cpu: cpus[abi] });
    assert.deepEqual(sent.singleRequest.appDownloadInfoRequest, {
      downloadStatus: 1,
      packageName: 'ir.torob',
      referrers: [],
    });
  });
}

test('parses a single-APK reply', async () => {
  const info = await getDownloadInfo('ir.torob', {
    abi: 'arm64-v8a',
    sdk: 33,
    fetch: reply(200, await fixture('reply-single.json')),
  });
  assert.deepEqual(info, {
    package: 'ir.torob',
    appName: 'Torob',
    versionCode: 2100261,
    files: [
      {
        name: 'base.apk',
        urls: [
          'https://appcdn2.cafebazaar.ir/apks/111111111111.apk?expire=1&token=redacted&a=.apk',
          'https://arvancdn.cafebazaar.ir/arvan/apks/111111111111.apk?hash=redacted&expires=1&a=.apk',
        ],
        size: 6943744,
        sha1: 'cfe40e3999f1218598e9958a186fce0742b1ba0f',
      },
    ],
    additionalFiles: [],
  });
});

test('parses a split reply: base first, splits named by token', async () => {
  const info = await getDownloadInfo('ir.divar', {
    abi: 'arm64-v8a',
    sdk: 33,
    fetch: reply(200, await fixture('reply-split.json')),
  });
  assert.equal(info.versionCode, 260921010);
  assert.deepEqual(
    info.files.map((file) => [file.name, file.size, file.sha1, file.urls.length]),
    [
      ['base.apk', 17085754, '4aed57bb34bd4272c66d6ca8d9fce9924f4abe10', 2],
      ['split-206683480734.apk', 722030, '10a85e788268b1743b961ff37474e745d9811dab', 2],
      ['split-274556363204.apk', 609768, 'bd67efe71d2e17f5589139bc9297543879c84c2d', 1],
    ],
  );
});

test('keeps raw additional files', async () => {
  const body = withReply((r) => {
    r.additionalFiles = [{ anything: 1 }];
  }, await fixture('reply-single.json'));
  const info = await getDownloadInfo('ir.torob', { abi: 'arm64-v8a', sdk: 33, fetch: reply(200, body) });
  assert.deepEqual(info.additionalFiles, [{ anything: 1 }]);
});

test('throws AppNotFoundError on 404', async () => {
  await assert.rejects(
    getDownloadInfo('no.such.app', { abi: 'arm64-v8a', sdk: 33, fetch: reply(404, await fixture('reply-not-found.json')) }),
    (error: unknown) => error instanceof AppNotFoundError && error.message === 'not found on Cafe Bazaar',
  );
});

test('throws StoreError with the status and server message on other errors', async () => {
  const body = JSON.stringify({ properties: { statusCode: 403, errorMessage: 'خرید لازم است' }, singleReply: null });
  await assert.rejects(
    getDownloadInfo('ir.paid', { abi: 'arm64-v8a', sdk: 33, fetch: reply(403, body) }),
    (error: unknown) =>
      error instanceof StoreError && error.status === 403 && error.message === 'Cafe Bazaar error (HTTP 403): خرید لازم است',
  );
});

test('throws StoreError when the reply is not JSON', async () => {
  await assert.rejects(
    getDownloadInfo('ir.torob', { abi: 'arm64-v8a', sdk: 33, fetch: reply(502, '<html>Bad Gateway</html>') }),
    (error: unknown) => error instanceof StoreError && error.status === 502 && /not JSON/.test(error.message),
  );
});

test('throws StoreError when a 200 reply carries no download info', async () => {
  await assert.rejects(
    getDownloadInfo('ir.torob', { abi: 'arm64-v8a', sdk: 33, fetch: reply(200, '{"properties":null,"singleReply":null}') }),
    /no download info/,
  );
});

test('throws StoreError when a 200 reply carries no usable URL', async () => {
  const body = withReply((r) => {
    r.fullPathUrls = ['ftp://example.com/x.apk'];
  }, await fixture('reply-single.json'));
  await assert.rejects(
    getDownloadInfo('ir.torob', { abi: 'arm64-v8a', sdk: 33, fetch: reply(200, body) }),
    /no download URL for base\.apk/,
  );
});

test('throws StoreError when the hash is missing', async () => {
  const body = withReply((r) => {
    delete r.hashCode;
  }, await fixture('reply-single.json'));
  await assert.rejects(
    getDownloadInfo('ir.torob', { abi: 'arm64-v8a', sdk: 33, fetch: reply(200, body) }),
    /no SHA-1 for base\.apk/,
  );
});

test('rejects a split token that is not a plain file name', async () => {
  const body = withReply((r) => {
    (r.splits as { token: string }[])[0].token = '../../evil';
  }, await fixture('reply-split.json'));
  await assert.rejects(
    getDownloadInfo('ir.divar', { abi: 'arm64-v8a', sdk: 33, fetch: reply(200, body) }),
    (error: unknown) => error instanceof StoreError && /unsafe split token/.test(error.message),
  );
});
