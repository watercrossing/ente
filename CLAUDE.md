# CLAUDE.md

Instructions for `watercrossing/ente`, a personal fork of `ente/ente`. This
file is fork-only: it never goes upstream, and it gets rebased along with every
other fork commit.

## Working agreements

- **Work on `main`.** No feature branches — commit straight to `main`.
- **Fix by amending, not appending.** A fix to something this fork already does
  is squashed into the commit that added it, so the history stays one commit per
  piece of behaviour and every commit is independently droppable at rebase time.
  A new commit is only for a new feature or an unrelated task. If a feature
  turns out to be several independent pieces, split them into — or move them
  between — separate commits rather than letting one commit grow.
- **No AI co-author trailers.** Never add `Co-Authored-By: Claude …`, or any
  equivalent line, to a commit message.
- **Confirm before pushing.** Pushes to `main` trigger CI that publishes public
  container images.
- **Keep the README fork note current.** The block above the centred banner in
  `README.md` is the reader-facing version of *What this fork changes* below:
  it tracks the behaviour this fork adds on top of `ente/ente`. A change that
  alters, adds or removes user-visible behaviour updates those bullets in the
  same commit, and a fork commit dropped at rebase time loses its bullet. Build
  and CI work stays out of the list — the closing sentence covers it.

## Upstream and rebasing

Remotes: `origin` → `watercrossing/ente`, `upstream` → `ente/ente`.

Upstream is fetched regularly and every fork commit is **rebased on top**. We
do not merge. That single fact should shape how changes are made here:

- **Keep each fork commit small and single-purpose.** A commit that mixes a
  feature with unrelated cleanup is painful to rebase and impossible to drop.
- **Prefer adding a file to editing an upstream one.** A new file next to the
  code, plus a one-line change to reach it, rebases cleanly forever; a new
  devDependency and the `package-lock.json` churn that comes with it does not.
- **Never reformat, reorder, or tidy upstream code opportunistically.** Every
  such line is a future conflict for no gain.
- **Avoid lockfile churn** (`package-lock.json`, `Cargo.lock`) unless the
  change genuinely requires it.
- **Drop fork commits that upstream makes redundant** during the rebase rather
  than carrying a duplicate — `git rebase --skip` at the conflict. This has
  happened once already: our "Build the Cast WASM package on Windows too" was
  dropped when upstream landed the equivalent "Fix Cast WASM build on Windows",
  which moves the same flag into the same `.cargo/config.toml`.
- **Don't cite fork commit hashes in tracked files** — they change on every
  rebase. Refer to commits by subject line.

## What this fork changes

**Video / HLS** — store lossless-copy videos as their HLS stream alone (web,
server and desktop); remux SDR H.264 at any bitrate and copy AAC-LC audio
(desktop); use native video fullscreen on touch devices, and scale videos to
fit the viewer (web).

**Build automation for a fork without Ente's credentials** — unsigned Windows
desktop builds with the update feed repointed here and installers published as
a GitHub release; server and web images retargeted to this fork's GHCR
namespace.

## CI

| Workflow | Fires on | Produces |
| --- | --- | --- |
| Publish GHCR (Server) | push to `main` touching `server/**` | `ghcr.io/watercrossing/ente-server:{latest,<sha>}`, amd64 + arm64 |
| Publish GHCR (Web) | push to `main` touching `web/**` or `rust/**` | `ghcr.io/watercrossing/ente-web:{latest,<sha>}`, amd64 |
| Build (Photos desktop) | push to `main` touching `desktop/**`, `web/**`, `rust/**` or its own scripts; manual dispatch | GitHub release: x64, arm64 and combined `.exe`, plus `latest.yml` and blockmaps |

Every push that reaches the desktop app therefore **ships an auto-update**: the
release is stable, `makeLatest`, and electron-updater follows GitHub's latest
pointer, so installed clients take the newest green build of `main`. Builds are
`cancel-in-progress`, so a push landing during one supersedes it and only the
tip gets an installer. Releases accumulate at ~400 MB each — prune old
`wc-photos-desktop-v*` releases by hand when they pile up.

**Desktop builds carry a CalVer version, not upstream's** — `YYYY.MMDD.N`, the
month unpadded because semver rejects leading zeros in a numeric component. CI
numbers `N` from the tags it has already published that day, starting at 1;
**local builds take `.0`**, which sorts below every CI build of the same day, so
the next release supersedes a local install rather than being masked by an equal
version. This is electron-updater's constraint rather than taste: it derives
`allowPrerelease` from the app's own version, and upstream's `1.7.28-beta` turns
it on, which makes it skip every release whose tag is not valid semver — ours
are all `wc-photos-desktop-v*`. A build left at upstream's number can never
update itself, and cannot identify itself in `ente.log` either.

Stamp it with `.github/scripts/photos-desktop-version.mjs set <version>`
**before building the renderer**, the order CI uses. Two things read the
version: electron-builder, for the installer name, `latest.yml` and
`app.getVersion()`; and `web/packages/base/next.config.base.js`, which bakes it
into the renderer bundle, which sends it as `X-Client-Version` and
`io.ente.photos.desktop/<version>` on every API call. Stamping at packaging time
instead — electron-builder's `--config.extraMetadata.version`, which is right
for a repackage that skips the renderer — leaves the bundle reporting upstream's
number. `.github/scripts/photos-desktop-calver.mjs` prints the version a local
build should carry, and `set` refuses any build number but `0` unless `CI` is
set. `desktop/package.json` and `desktop/package-lock.json` are upstream's
files: `git checkout` both when the build ends, successful or not.

Fourteen inherited workflows (Crowdin sync, Cloudflare deploys, the mobile /
auth / locker / ensu builds, warm caches, stale PRs) are **disabled through the
Actions API rather than by editing their files** — deliberately, so the fork
carries no diff for them and rebases stay clean. They need Ente's secrets;
don't re-enable or try to repair them. `gh workflow enable <id>` reverses it.

**Deployment takes both images.** `ente-server` is museum alone — the web apps
live in `ente-web`, and `web-templates` inside the server image is just two
account-recovery pages. `ENTE_API_ORIGIN` is applied at container start, so
changing the endpoint needs no rebuild.

## This machine (Windows 11, x64)

| Tool | How to invoke |
| --- | --- |
| node 24 / npm | on `PATH` in both PowerShell and Bash (fnm multishell) |
| cargo, wasm-pack | on `PATH` from `~/.cargo/bin` |
| go 1.26.5 | **not** on `PATH` in shells started before 2026-08-16; call `"C:\Program Files\Go\bin\go.exe"` |

The worktree is **LF**: `core.autocrlf` is `false` in `.git/config`, overriding
the `true` that the Git for Windows installer writes to the system config. A
fresh clone needs it set again — `git clone -c core.autocrlf=false …`, or once
globally with `git config --global core.autocrlf false`. On a CRLF worktree
prettier flags every file whether touched or not. The desktop version script is
written to cope with either, since CI builds on a Windows runner where the
system default still applies, but nothing else here is.

### Server (Go)

Museum does not build natively on Windows: `server/pkg/utils/file/file.go`
calls `syscall.Statfs`, which is Unix-only. A bare `go build` reports a
misleading `undefined: syscall.Statfs` rather than a real problem with the
edit. Cross-compile instead — no cgo is involved, since `server/Dockerfile`
sets `CGO_ENABLED=0` and there are no cgo dependencies:

```powershell
$env:GOOS='linux'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
& "C:\Program Files\Go\bin\go.exe" build -C server -o museum ./cmd/museum
& "C:\Program Files\Go\bin\go.exe" vet -C server ./...
```

`server/RUNNING.md` documents only the macOS/Homebrew path, so this gap is
recorded nowhere upstream.

### Web and desktop

- Type-check and lint **per workspace**: `npx tsc`, `npx eslint
  --max-warnings 0 <files>`, run from `web/apps/photos`,
  `web/packages/gallery`, `desktop`, and so on. `npm exec --workspaces -- tsc`
  also works, but fails in the `space` app on a missing `ente-space-wasm` pkg
  build — a pre-existing local gap, not a regression.
- **Prettier is configured per workspace** (`web/`, `desktop/`, `docs/`,
  `infra/*`), and `npm run lint` in `web/` runs `prettier --check .` over that
  workspace — clean, now the worktree is LF; under CRLF it flagged every file.
  Never point prettier at `mobile/`, `server/` or `cli/`, which have no
  prettier config: reformatting them is pure rebase conflict.

### Rust

- Set `CARGO_BUILD_JOBS=4` when memory is tight. Unconstrained parallelism has
  crashed rustc on this box with `STATUS_ACCESS_VIOLATION` on unrelated crates.
- The Cast wasm package pins a nightly toolchain and needs `-Z build-std`;
  rustup fetches it on first use. Its `-Ctarget-feature=-reference-types` lives
  in `rust/bindings/wasm/cast/.cargo/config.toml`, which works because
  wasm-pack runs with that directory as its cwd.

### Desktop app

`BUILD-windows.md` in the repo root — **untracked, local to this machine** —
has the full build sequence, the dependency list, and a log of the environment
traps hit along the way (arm64 linker, ffmpeg-static's silent corruption,
memory-pressure segfaults). Read it before attempting a desktop build.

The bundled ffmpeg for manual experiments is at
`desktop/node_modules/ffmpeg-static/ffmpeg.exe` (6.0, static).
