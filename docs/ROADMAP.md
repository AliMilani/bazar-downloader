# bazar-dl roadmap

Date: 2026-10-09. Status: proposal, nothing here is built.

Version 0.1 does one thing: link in, verified APK files out. This document
plans what comes next. Every claim under "Verified" was checked against the
live store on the date above; everything else is marked as unverified.

## What the store offers without login

All calls are `POST https://api.cafebazaar.ir/rest-v1/process/<Name>` with the
same `properties` block the download call already sends. Roughly 140
sequential requests were made today, 150 ms apart, with no throttling and no
rate-limit headers.

| Call | Verified result | Use |
|------|-----------------|-----|
| `AppDownloadInfoRequest` | Already used. A paid app answers HTTP 403, `این برنامه برای دانلود باید خریداری شود`. | download, update check |
| `AppDetailsV2Request` `{ packageName, language }` | `meta` (name, author name and slug, `payment.price`, ratings), `package` (`versionCode`, `versionName`, `changeLog`, `permissions`, `signatures`, `hasAdditionalFiles`, `incompatibilityInfo`, `lastUpdated`), antivirus summary. | metadata, `info`, paid detection |
| `AppDetailsRequest` (v1) | Same data, flatter, plus `package.lastUpdatedTimeFromEpoch`. | machine-readable update date |
| `SearchV2Request` `{ query, scope: "app", cursor: "", language }` | 24 rows of `simpleAppItem.info`: `packageName`, `name`, `versionCode`, `minimumSdkVersion`, `paymentInfo`, `signatures`, `incompatible`. | `search` |
| `GetPageV2Request` `{ path: "developer_apps/?slug=<slug>", offset, language }` | 24 apps of one developer. Slug may be a name (`divar`) or a numeric id. | developer bulk |

Details that shape the design:

- `properties.language: 1` returns English names, Latin digits and readable
  dates (`Torob`, `0.18.6.1`, `2026 October 3`). `language: 2` returns Persian
  (`ترب`, `۰.۱۸.۶.۱`).
- The details reply depends on the device profile. With the same profile as
  the download call its `versionCode` matched the download (`260921010`);
  with a different profile it did not (`260921030`). Details must be fetched
  with the same profile and attached only when the version codes agree.
- Additional files are no longer a mystery. Two games carried one each
  (`com.tencent.ig`, 1.14 GB; `com.SandSprogrammingGroup.callOfDutyRtv`,
  225 MB). An entry is a split entry plus a `name`:
  `{ name: "main.21525.com.tencent.ig.obb", size, sha1hash, token, fullPathUrls }`.
- The `versionCode` inside a stored `base.apk` manifest equals the store's.
  Split manifests carry real split names (`config.xxhdpi`, `config.xxxhdpi`).
- The store hands out every density split, not only the device's, so a stored
  split set installs on any screen.
- `package.signatures` is a list of SHA-1 certificate hashes (two for
  `ir.divar`).

Not verified:

- Paging for search and developer pages. `hasMore` is true, but `offset`,
  `cursor` and `page` all returned the first page again. Only the first 24
  results are reliable.
- `GetUpgradableAppsRequest` answers 200 but stayed empty for five guessed
  body shapes.
- Whether the store serves clients outside Iran.
- Anything about Myket beyond: its API answers 401 without a token.
- Whether a phone or emulator is attached here. `adb` is installed;
  `apksigner`, `aapt2`, `java` and an emulator are not.

## Ideas dropped, with the reason

- **Parallel chunked download.** Measured on a 24 MB range of one file: one
  connection 11.8 and 14.6 MB/s, four connections 6.8 MB/s, eight 7.6 MB/s.
  It is slower here, despite the reply's `multiConnectionDownload: true`.
- **SDK level in the directory name.** Across 4 apps and 8 SDK levels the
  files under one `versionCode` and ABI never differed. The guard added in
  0.1 covers the case if it ever appears.
- **A version-history call.** `GetAppVersionsRequest` and
  `AppUpgradeInfoRequest` are 404. `--sweep` below is the substitute.
- **A bulk update call.** One download-info request per stored app is enough
  and already works.

## Groundwork shared by everything below

Small refactors that the first spec should carry, because every later feature
needs them:

- **Subcommands.** `bazar-dl <links>` stays the default. A first word without
  a dot (`info`, `list`, `update`, `verify`, `search`) cannot be a package
  name, so it is unambiguous as a command. `src/cli.ts` becomes dispatch and
  shared options; each command gets `src/commands/<name>.ts` with injected
  collaborators, as `run` has today.
- **One request helper** in `src/bazaar.ts` (`request(name, key, body,
  profile)`), with `Profile = { abi, sdk, language }`, so details, search and
  developer calls share timeout, error mapping and JSON checks.
- **Metadata grows, old files stay readable.** New fields are optional when
  read. `files[]` entries gain `kind: "base" | "split" | "obb"`.
- **An API drift check.** `npm run smoke` hits the real store for one known
  app and asserts the reply shape. The API is undocumented; this is how a
  change gets noticed before a user does.

## Milestone 2 — paste anything, know what you got

Two specs. Both are small and both fix things that will be hit soon.

### Spec A: input and details

1. **Pick links out of pasted text.** A line holding a single token is parsed
   strictly, as today. A line holding several tokens is searched for link
   patterns only (`cafebazaar.ir/app/…`, `bazaar://details?id=…`), because a
   bare word such as `v2.0` would otherwise pass as a package name. A line
   with no link is an error naming the line. At the prompt, lines arriving in
   one paste burst are collected before the run starts, so nothing is
   dropped silently.
2. **`getDetails(pkg, profile)`** in `src/bazaar.ts`, called with
   `language: 1` and the download's own profile. It is best effort: a failed
   details call prints a warning and never fails a download.
3. **Richer `metadata.json`**: `versionName`, `author { name, slug }`,
   `price`, `lastUpdated`, `changeLog`, `permissions`, `signatures`. Attached
   only when the details `versionCode` equals the downloaded one; otherwise
   omitted with a warning.
4. **Paid apps say so.** HTTP 403 from the download call triggers one details
   call; when `payment.price > 0` the message is
   `paid app (<price>), not supported`. Anything else stays a generic store
   error.
5. **`bazar-dl info <link>`** prints, without downloading: name, package,
   version name and code, download and install size, split count, additional
   files, price, last update, author, signatures, antivirus summary, and
   which versions are already stored. `--permissions` lists them; `--json`
   emits the raw structure.

Risk: details and download disagreeing on version for some apps. The rule in
item 3 keeps wrong data out of the archive at the cost of an occasional
missing `versionName`.

### Spec B: additional files, hardening, progress

6. **Download additional files.** Stored as `obb/<name>` inside the version
   directory, verified like every other file. `name` must match
   `^(main|patch)\.\d+\.[A-Za-z0-9_.]+\.obb$`. On by default, `--no-obb`
   skips them. Before a download starts, free space is compared with the
   total size and the argument fails early when it cannot fit.
7. **The eleven deferred review findings**, one pass:
   - a mirror that ends cleanly but short counts as that mirror's failure and
     no longer wipes resumed progress;
   - failure reasons survive (`cause.code`, first error of an
     `AggregateError`) in both the store and mirror messages;
   - a closed standard output ends the run quietly;
   - `versionCode` must be a positive integer;
   - server text is stripped of control characters and capped before it is
     printed;
   - mirror URLs are filtered with `URL.canParse`;
   - a transfer that exceeds the expected size is aborted;
   - `hasSplits` and `hasAdditionalFiles` must agree with their lists, and a
     repeated token is an error;
   - a lock file in the version directory stops two runs colliding;
   - an older, incomplete sibling version is mentioned once;
   - covered by item 1: lines pasted after the first.
8. **Progress worth reading**: megabytes done and total, speed, time left,
   `file 3 of 10`. Terminal only; piped output is unchanged.

## Milestone 3 — archive upkeep (Spec C)

The archive is the one use that goes stale on its own.

9. **`bazar-dl list`**: every stored app with versions, ABI, size, date.
   `--json` for scripts. It reads `<out>/*/*/metadata.json`; no index file.
10. **`bazar-dl verify [package…]`**: re-hash every stored file against its
    metadata. Reports corrupt or missing files, incomplete directories and
    leftover `.part` files. Exit 1 when anything is wrong.
11. **`bazar-dl update [package…]`**: for each stored package and ABI, reuse
    the profile of its newest stored version, ask the store, and download a
    version that is not on disk yet. `--dry-run` only reports. One request
    per app, sequential. The summary line counts updated, current and failed.
    The README gains a cron line and a systemd timer.
12. **`--sweep`**: ask at SDK levels 34, 30, 26, 23, 22, 21 and 19 and keep
    each distinct version. Observed yield: `ir.divar` 3 versions,
    `com.digikala` 4, `com.whatsapp` 3, `ir.torob` 2. It is the only route to
    older versions found so far.
13. **`--on-new <command>`**: run a command once per newly stored version,
    with package, version and directory in the environment. This is the hook
    for a Telegram or ntfy notice without building one in.
14. **CI**: a GitHub Actions workflow running `npm ci`, `npm test` and
    `npm run typecheck` on push.

Later within this milestone, behind an explicit confirmation because it
deletes: `prune --keep <n>`, dry run by default.

## Milestone 4 — inspect and install

### Spec D: read the APK itself

15. **`src/apk.ts`**, no dependencies: read the zip central directory, inflate
    `AndroidManifest.xml` with `node:zlib`, parse the binary XML. Yields
    package, `versionCode`, `versionName`, `minSdkVersion`,
    `targetSdkVersion`, split name and permissions.
    - `versionName` no longer depends on the details call.
    - Each split's real name is recorded in metadata. Files are not renamed.
    - `verify --deep` checks that package and version in the manifest match
      the metadata.
16. **Signing certificate.** Step one is free: store the details call's
    `signatures` in metadata and warn when they change between versions of
    one app. Step two extracts the certificate hash from the APK (v1
    `META-INF/*.RSA`, then the v2/v3 signing block) and compares it with the
    store's list. Step two is the largest single item on this roadmap.
17. **`bazar-dl diff <package>`**: permissions, size and SDK changes between
    two stored versions.

### Spec E: devices

18. **`--install`**: `adb install -r` for one APK, `adb install-multiple -r`
    for a split set, and `adb push` of additional files to
    `/sdcard/Android/obb/<package>/`. `--serial` is passed through.
19. **`--device`**: read `ro.product.cpu.abilist` and `ro.build.version.sdk`
    over `adb` and use them as the profile.
20. **`--export apks`**: one uncompressed zip of base and splits for
    installers such as SAI, written next to the version directory.

Spec E needs a phone or emulator to check for real. None was found on this
machine beyond the `adb` binary.

## Larger bets

- **`bazar-dl search <words>`**: first 24 results, pick by number, download.
  Useful once paging is understood; fine without it.
- **`bazar-dl developer <slug or link>`**: every listed app of one developer.
  The same 24-item limit applies until paging is solved.
- **Proxy.** This Node has `--use-env-proxy` and honours
  `NODE_USE_ENV_PROXY=1`. Likely a README paragraph and one test, not code.
  Worth doing only if the store turns out to need an Iranian address.
- **Myket.** A second store behind the same command. It needs a token
  handshake first, so it starts with a `Store` interface extracted from
  `src/bazaar.ts`. Large.
- **A Telegram bot or local web page** over the same core.

## Order

| Step | Spec | Why here |
|------|------|----------|
| 1 | A: input and details | Fixes the paste path, which is the point of the tool, and produces the details data that `info`, `list` and `update` display. Carries the groundwork. |
| 2 | B: additional files, hardening, progress | Closes the last gap left open in 0.1 and clears the review backlog before more code lands on it. |
| 3 | C: archive upkeep | Largest practical gain; needs A's metadata to be worth reading. |
| 4 | D: read the APK | Makes the archive self-describing and independent of the details call. |
| 5 | E: devices | Needs hardware to test; smallest audience until then. |

Each spec is a separate design, plan and review cycle, about four to six
plan tasks each. D's signature step two is the exception and should be its
own cycle.

## Decisions that are yours

1. **Additional files on by default?** Recommended yes, with `--no-obb`. One
   of the two samples is 1.14 GB.
2. **Names in English or Persian?** Recommended English (`language: 1`) for
   file-system and terminal friendliness, one request per app. Storing both
   costs a second request.
3. **Should `update` follow each version's own profile, or one profile given
   on the command line?** Recommended each version's own, so an emulator
   build and a phone build of the same app both stay current.
4. **Is Myket wanted at all?** It decides whether the `Store` interface is
   worth extracting early.
