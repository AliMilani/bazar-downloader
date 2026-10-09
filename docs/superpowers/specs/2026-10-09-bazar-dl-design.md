# bazar-dl — design

Date: 2026-10-09

## Purpose

A command-line tool: paste a Cafe Bazaar app link, the APK is stored on disk.

The stored APKs are used four ways, and the design has to serve all of them:

- install on a real phone (arm64),
- install on an emulator (x86_64),
- keep an archive of every version downloaded,
- inspect / reverse engineer the files.

Success: `bazar-dl https://cafebazaar.ir/app/ir.divar` leaves a verified,
install-ready copy under `./apks/` and a rerun does no work.

## Scope

In scope: free apps that Cafe Bazaar serves without login.

Out of scope: paid apps, login, purchase handling, watching for updates,
search, parallel chunked download, any GUI.

## Command

```
bazar-dl [link-or-package...] [--abi <abi>] [--sdk <n>] [--out <dir>]
```

With no link argument, links are read from standard input: one prompted line
when standard input is a terminal, everything up to end of input when it is
piped. Either way the text is split on whitespace. This is the paste path —
it needs no shell quoting, and an unquoted `?` or `&` in a pasted link breaks
the command line in zsh. `--help` prints the usage text.

| Option  | Default      | Meaning                                              |
|---------|--------------|------------------------------------------------------|
| `--abi` | `arm64-v8a`  | Device ABI: `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86` |
| `--sdk` | `33`         | Android SDK level reported to the store              |
| `--out` | `./apks`     | Root of the store                                    |

Every argument is parsed before any network call; one unparseable argument
aborts the whole run with exit 2. After that, arguments are processed one
after another, and a store or download failure on one does not stop the rest.

Exit codes: `0` every argument stored or already present; `1` at least one
argument failed; `2` usage error (no link from arguments or standard input,
unknown option, unknown ABI, non-numeric SDK, unparseable link); `130` the
link prompt was cancelled with Ctrl-C or Ctrl-D (no message, no stack trace).

### Accepted inputs

- `https://cafebazaar.ir/app/<package>` — with or without `www.`, trailing
  slash, or extra query parameters such as `?l=en`
- `https://cafebazaar.ir/app/?id=<package>`
- the same without a scheme, e.g. `cafebazaar.ir/app/<package>`
- `bazaar://details?id=<package>`
- a bare package name, e.g. `ir.divar`

Invisible Unicode format characters (direction marks that chat apps put
around pasted links) are removed before parsing.

A package name must match `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$`.
Anything else is an invalid link.

## Store layout

```
<out>/<package>/<versionCode>-<abi>/
  base.apk
  split-<token>.apk     one per split, only when the app has splits
  metadata.json
```

- Versions and ABIs sit side by side. Nothing is ever overwritten.
- `metadata.json` is written last. A directory that has it is complete and is
  skipped on rerun. A directory without it is incomplete and is resumed.
- In-flight downloads are written as `<name>.part` and renamed on success.
- "Already stored" is only reported when the files the store offers now have
  the same SHA-1 values as the ones in `metadata.json`. If they differ, the
  argument fails with a message naming the `--sdk` the stored copy came from.
- An incomplete directory that holds an `.apk` which is not one of the
  expected files at its expected size is left untouched and the argument
  fails. Both rules exist so that nothing stored is overwritten or mixed.
- The store reply does not name splits, so they are named by their numeric
  store token. A split app installs with
  `adb install-multiple <dir>/*.apk`.

`metadata.json`:

```json
{
  "package": "ir.divar",
  "appName": "Divar",
  "versionCode": 260921010,
  "abi": "arm64-v8a",
  "sdk": 33,
  "source": "https://cafebazaar.ir/app/ir.divar",
  "downloadedAt": "2026-10-09T10:00:00.000Z",
  "files": [
    { "name": "base.apk", "size": 17085754, "sha1": "…" },
    { "name": "split-206683480734.apk", "size": 722030, "sha1": "…" }
  ],
  "additionalFiles": []
}
```

`additionalFiles` holds the raw entries from the store reply (see below).

## Store API

Observed on 2026-10-09; none of this is documented by Cafe Bazaar.

`POST https://api.cafebazaar.ir/rest-v1/process/AppDownloadInfoRequest`, JSON
body, no authentication:

```json
{
  "properties": {
    "language": 2,
    "clientVersionCode": 1100301,
    "clientVersion": "11.3.1",
    "isKidsEnabled": false,
    "androidClientInfo": { "sdkVersion": 33, "cpu": "arm64-v8a,armeabi-v7a,armeabi" }
  },
  "singleRequest": {
    "appDownloadInfoRequest": { "downloadStatus": 1, "packageName": "ir.divar", "referrers": [] }
  }
}
```

`--abi` maps to the `cpu` string:

| `--abi`       | `cpu`                              |
|---------------|------------------------------------|
| `arm64-v8a`   | `arm64-v8a,armeabi-v7a,armeabi`    |
| `armeabi-v7a` | `armeabi-v7a,armeabi`              |
| `x86_64`      | `x86_64,x86`                       |
| `x86`         | `x86`                              |

Success is HTTP 200 with `singleReply.appDownloadInfoReply`. Fields used:

- `appName`, `versionCode`
- `packageSize` (string, bytes), `hashCode` (SHA-1 hex of the base APK —
  verified against a real download)
- `fullPathUrls` — signed, expiring mirror URLs for the base APK; both
  mirrors answer `Range` requests with 206
- `hasSplits`, `splits[]` — each with `token`, `size`, `sha1hash`,
  `fullPathUrls`
- `hasAdditionalFiles`, `additionalFiles[]`

Failure is a non-200 status with `properties.statusCode` and
`properties.errorMessage` (Persian text). An unknown package returns 404.

Observed behaviour worth knowing (4 apps, SDK levels 19 to 34, 2026-10-09):
at low SDK levels the store serves an older version of the app, often as one
universal APK instead of a split bundle. Under one `versionCode` and ABI the
files never differed between SDK levels, which is why the SDK level is not
part of the directory name and a difference is treated as an error.

### Additional files (OBB)

No app with `hasAdditionalFiles: true` was observed, so the entry shape is
unknown. Version 1 does not download them: it prints a warning and records the
raw entries in `metadata.json`.

## Modules

TypeScript run directly by Node 22 (native type stripping, no build step).
No runtime dependencies. `typescript` and `@types/node` are dev dependencies
for type checking only. Erasable syntax only; relative imports carry the `.ts`
extension. `engines.node` is `>=22.18`.

| File              | Responsibility                                                    | Depends on            |
|-------------------|-------------------------------------------------------------------|-----------------------|
| `src/link.ts`     | `parsePackage(input)` → package name, or throws `InvalidLinkError`. Pure. | —              |
| `src/bazaar.ts`   | `getDownloadInfo(pkg, { abi, sdk })` → `DownloadInfo`. Builds the request, parses the reply, throws `AppNotFoundError` on 404 and `StoreError` (status + server message) on anything else. | `fetch` |
| `src/download.ts` | `downloadFile({ urls, dest, size, sha1, onProgress })`. Streams to `dest.part`, resumes with `Range`, falls through mirrors, verifies, renames. | `fetch`, `node:fs`, `node:crypto` |
| `src/store.ts`    | Directory path for a version, completeness check, metadata write. | `node:fs`             |
| `src/cli.ts`      | `run(argv, deps)` → exit code. Argument parsing (`node:util` `parseArgs`), reading links from standard input, the per-argument loop, progress output. Its collaborators are injected so tests need no network. | all of the above |
| `src/main.ts`     | Executable entry: calls `run` with `process.argv` and sets the exit code. | `src/cli.ts` |

`DownloadInfo` is the tool's own shape, not the raw reply:

```ts
type RemoteFile = { name: string; urls: string[]; size: number; sha1: string };

type DownloadInfo = {
  package: string;
  appName: string;
  versionCode: number;
  files: RemoteFile[];          // base.apk first, then splits
  additionalFiles: unknown[];   // raw, not downloaded
};
```

The command is exposed through `package.json` `bin` (pointing at
`src/main.ts`) and installed globally with `npm link`.

## Flow for one argument

1. `parsePackage` → package name.
2. `getDownloadInfo` → `DownloadInfo`. Always fetched fresh, because the URLs
   expire.
3. Resolve `<out>/<package>/<versionCode>-<abi>/`. If `metadata.json` exists
   and lists the same files, report "already stored" and stop; if it lists
   different files, fail. If the directory is incomplete and holds foreign
   APK files, fail.
4. For each file in order: skip it if it already exists with the right size;
   otherwise `downloadFile`.
5. Write `metadata.json`.

## Download behaviour

- If `dest.part` exists, request `Range: bytes=<its size>-`. A 206 appends; a
  200 restarts the file from zero.
- Mirrors are tried in the order given. A failure mid-stream keeps the `.part`
  and continues on the next mirror from where it stopped. When every mirror
  has failed, the download fails and the `.part` stays for the next run.
- After the last byte: size must equal the expected size and SHA-1 must equal
  the expected hash. On mismatch the `.part` is deleted and the download
  fails, so a rerun starts clean.
- Only a verified file is renamed into place.
- A mirror that sends no bytes for 30 seconds, including one that never
  answers, counts as failed and the next mirror is tried. The store request
  itself is abandoned after 30 seconds.

## Errors

| Situation                         | Result                                                   |
|-----------------------------------|----------------------------------------------------------|
| Unparseable link, bad option      | Message on stderr, exit 2, nothing downloaded            |
| Unknown package (404)             | "not found on Cafe Bazaar", argument failed              |
| Any other store error             | HTTP status plus the server's message, argument failed   |
| Store silent for 30 s             | "did not answer" message, argument failed                |
| Stored version has other files    | Message, nothing touched, argument failed                |
| All mirrors failed                | Message, `.part` kept, argument failed                   |
| Size or SHA-1 mismatch            | Message, `.part` deleted, argument failed                |

How the store answers for a paid app is not known. It falls under "any other
store error" and shows whatever the server says.

## Output

Progress goes to stderr: one updating line per file when stderr is a terminal,
one line per finished file otherwise. On success the directory path is printed
to stdout, one per argument, so the tool composes with other commands.

## Testing

`node --test`, no network:

- `link.ts` — every accepted input form; rejected inputs.
- `bazaar.ts` — request body per ABI; parsing of a non-split reply, a split
  reply, a 404 and a generic error. Fixtures are real replies with the signed
  URL tokens replaced. `fetch` is injected.
- `download.ts` — against a local `node:http` server: full download, resume
  from a `.part`, server that ignores `Range`, mirror fallback after a
  dropped connection, size mismatch, SHA-1 mismatch.
- `store.ts` — path layout, completeness check, metadata content, in a
  temporary directory.
- `cli.ts` — exit codes and the skip-when-complete path, with the API and
  downloader stubbed.

One manual live check before calling it done:
`bazar-dl https://cafebazaar.ir/app/ir.torob` (a 7 MB non-split app), then
`bazar-dl ir.divar` (a split app), then a rerun of both to confirm the skip.
