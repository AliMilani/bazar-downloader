# bazar-dl

Paste a Cafe Bazaar link, get the APK stored on disk. Free apps only.

## Install

Needs Node 22.18 or newer. No build step, no runtime dependencies.

    npm install   # type checker only, optional
    npm link      # puts `bazar-dl` on PATH

## Use

    bazar-dl                                  # prompts for a link; no quoting needed
    bazar-dl 'https://cafebazaar.ir/app/ir.divar?l=en'
    bazar-dl ir.divar ir.torob                # package names work too
    bazar-dl ir.divar --abi x86_64            # emulator build
    bazar-dl ir.divar --sdk 22                # older profile, often one universal APK
    bazar-dl ir.divar --out ~/apk-archive
    cat links.txt | bazar-dl

Quote links on the command line: `?` and `&` mean something to the shell.

| Option  | Default     | Values                                        |
|---------|-------------|-----------------------------------------------|
| `--abi` | `arm64-v8a` | `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`   |
| `--sdk` | `33`        | Android SDK level reported to the store       |
| `--out` | `./apks`    | Root of the store                             |

The directory of each stored version is printed on standard output; progress
and messages go to standard error. Exit code is 0 when everything is stored,
1 when an app failed, 2 on a usage error.

## What gets stored

    apks/<package>/<versionCode>-<abi>/
      base.apk
      split-<token>.apk     only for split apps
      metadata.json         name, version, ABI, source link, size and SHA-1 per file

Every version and ABI is kept side by side and nothing is overwritten. Every
file is checked against the size and SHA-1 the store reports. A version that
is already complete is skipped; an interrupted one resumes where it stopped.

Install a split app with:

    adb install-multiple apks/<package>/<versionCode>-<abi>/*.apk

## Limits

- Paid apps and anything needing login are not supported.
- Additional files (OBB) are not downloaded; they are listed in
  `metadata.json` and a warning is printed.
- The store API is undocumented and may change.

## Development

    npm test            # no network
    npm run typecheck
