# IW8 FF Explorer

A local web viewer for legally installed **Modern Warfare 2019 1.20 Replay** files. Connect your own Replay installation, search its `.ff` files, extract a selected fastfile through ACTS, and inspect the resulting textures, models, materials, sounds, GSC source, JSON and binary data from a desktop or phone.

The repository contains no game executable, fastfile, XPak, extracted asset, account credential, cache, or local path.

## What it does

- Finds and browses `.ff` files below the selected Replay installation's `zone` directory, including language subdirectories.
- Uses the [IDARETW ACTS Replay fork](https://github.com/IDARETW/atian-cod-tools/tree/codex/mw2019-complete) to extract a selected file with all supported asset types and geometry sidecars.
- Applies matching Replay `.fp` and `.fc` files through ACTS, validates patch headers, and records each extraction separately.
- Shows DDS images, GLB/glTF/OBJ models, material-linked base-color and cutout textures, supported audio, structured records, hexadecimal data, and syntax-highlighted GSC source.
- Reconstructs applicable `gfx_map` scenes from Replay data: BSP surfaces are exported with positions, normals and UVs, while static XModels are instanced at their fixed-point game placements with packed rotations and scale.
- Runs entirely on the computer holding the game installation. It binds to `127.0.0.1`; an optional authenticated tunnel can make that local viewer reachable from a phone.

This is an inspection and export tool. It does not modify the game installation, inject into the game, run game code, or make unsigned fastfiles load in-game.

## Requirements

- Windows 10/11 with PowerShell.
- A legally installed MW2019 **1.20 Replay** build containing `game_dx12_ship_replay.exe`, `oo2core_7_win64.dll`, and a `zone` directory with fastfiles.
- A locally built ACTS executable from the linked Replay branch above. Point setup at `build/bin/Release/acts.exe`.
- Node.js 22.12+ or 24+ and Python 3.12+.

## First-time setup

Clone or download this repository, then build the browser files:

```powershell
npm ci
npm run build
```

Connect your own game build and ACTS executable. Setup finds the Replay executable, Oodle library, `zone` directory, XPaks, and `.ff` files automatically. It asks for a viewer-only password and saves only a Digest verifier, never the plaintext password.

```powershell
./scripts/configure-replay.ps1 `
  -ReplayRoot 'D:/Replay/Call of Duty Modern Warfare (1.20.4.7623265)' `
  -Acts 'E:/Tools/atian-cod-tools/build/bin/Release/acts.exe' `
  -Username viewer
```

The command creates these local, ignored files:

| File | Contents |
| --- | --- |
| `.local/viewer-access.json` | Viewer username and a Digest verifier. |
| `.local/extraction.json` | Paths to your ACTS build, Replay executable, Oodle library, zone directory, and local output cache. |
| `.local/library-roots.json` | The read-only fastfile search root. |

Start the local viewer:

```powershell
./scripts/start-local.ps1
```

Open `http://127.0.0.1:48120`, sign in with the credentials created during setup, choose **Browse server files**, then use the search box to find a fastfile. Selecting a `.ff` starts a local ACTS extraction automatically. The game files are read only; generated files go to `%LOCALAPPDATA%/MW19ReplayFastfileViewer/cache` unless you choose another `-Cache` path during setup.

## Open from a phone

The local viewer does not expose itself to the network. If you have `cloudflared`, this optional command creates an authenticated HTTPS tunnel to your local viewer:

```powershell
./scripts/start-preview.ps1
```

It prints a temporary URL. Sign in there using the viewer-only credentials from setup. Keep the tunnel process running while using the site; a later tunnel launch can use a different URL. Stop it with:

```powershell
./scripts/stop-preview.ps1
```

## Fastfile behavior and limits

ACTS uses the configured game executable and the populated v13 XPaks found in its `zone` directory. It supports the Replay revisions shipped in 1.20, including older unchanged zones and patched `0xff7` zones. Selecting a fastfile extracts all supported asset pools and writes geometry sidecars; it is not a sample-only or report-only pass.

An extraction can finish as **Partial** when some payloads are absent from the local archives, a stream is damaged, a layout remains unsupported, or a configured output limit is reached. The viewer preserves available output and shows the ACTS manifest and log. A partial result is not presented as a complete dump.

The model and scene previews apply available base-color and opacity/cutout textures. Scene manifests list missing streamed meshes and unsupported placement classes instead of filling them with guessed assets. Layered shaders, normal/specular packing, skinning, morphs, subdivision, dynamic/scripted entities and complete terrain or splined-model reconstruction remain outside the current viewer.

## Development and verification

```powershell
npm test
python -m unittest discover -s tests -p 'test_*.py' -v
```

`npm run dev` is for frontend work only. It cannot browse the local game files, extract fastfiles, or decompile compiled scripts because those features require the local Python service.

## Publishing notes

Before creating a public GitHub repository, review the source and choose the repository license you want to grant. Keep `.local/`, `dist/`, `node_modules/`, game files, extraction caches, logs, and test artifacts untracked. Third-party package notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
