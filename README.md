# ioBroker.github-updater

ioBroker adapter to monitor and update manually installed adapters from GitHub.

---

## The Problem

Adapters installed directly from GitHub (`iobroker url user/repo`) are invisible to ioBroker's built-in update checker — it only queries the official repository index. There is no way to know whether a newer version has been released on GitHub, and no built-in mechanism to update them.

## What this Adapter Does

- Automatically detects all adapters that were installed from GitHub by reading the `installedFrom` field in each adapter's ioBroker object
- Queries the GitHub API for the latest release, tag, or commit for each detected adapter
- Compares versions using semver and exposes the result as ioBroker states
- Sends an ioBroker notification when an update is available
- Can trigger the update automatically or on demand via a button state

No manual configuration of adapter names or repository URLs is needed.

---

## Installation

Since this adapter is not in the official ioBroker repository, install it directly from GitHub:

```bash
cd /opt/iobroker
iobroker url https://github.com/d3vc0-de/ioBroker.github-updater
```

---

## Configuration

Open the adapter settings in the ioBroker admin UI.

| Field | Description |
|---|---|
| **GitHub Personal Access Token** | Optional. Increases the API rate limit from 60 to 5000 requests/hour. The token needs no permissions — it only accesses public repositories. Create one at [github.com/settings/tokens](https://github.com/settings/tokens). |
| **Check interval** | How often to check for updates, in seconds. Minimum 600 s (10 min), default 3600 s (1 h). |
| **Notify on update** | Sends an ioBroker notification when a newer version is found. |
| **Auto-update** | Automatically runs `iobroker url user/repo` when an update is detected. |
| **Exclude adapters** | Comma-separated list of adapter names to skip, e.g. `my-adapter,other-adapter`. |

---

## How Detection Works

When an adapter is installed via `iobroker url`, ioBroker stores the source in `common.installedFrom` inside the `system.adapter.<name>` object. This adapter scans all `system.adapter.*` objects on startup and on each scheduled check, and picks up any entry where `installedFrom` points to GitHub — either as a full URL (`https://github.com/user/repo`) or a shorthand (`user/repo`).

---

## States

```
github-updater.0.
├── info.connection           Boolean  — true when GitHub API is reachable
├── info.lastCheck            String   — ISO timestamp of the last completed check
├── info.updatesAvailable     Number   — count of adapters with an available update
├── actions.checkNow          Button   — set to true to trigger an immediate check
└── adapters.<adapterName>.
    ├── installedVersion      String   — version currently installed in ioBroker
    ├── latestVersion         String   — latest version found on GitHub
    ├── updateAvailable       Boolean  — true when latestVersion > installedVersion
    ├── githubRepo            String   — detected GitHub repository (user/repo)
    ├── releaseUrl            String   — URL to the GitHub release or tag page
    ├── lastChecked           String   — ISO timestamp of the last check for this adapter
    └── triggerUpdate         Button   — set to true to update this adapter immediately
```

---

## Update Mechanism

When an update is triggered (automatically or via `triggerUpdate`), the adapter runs:

```
node /opt/iobroker/node_modules/iobroker.js-controller/iobroker.js url <user/repo>
```

This is identical to running `iobroker url user/repo` on the command line. The adapter being updated will be briefly stopped and restarted by the js-controller.

The ioBroker root path is detected automatically by traversing up from the adapter directory. The fallback is `/opt/iobroker`.

---

## Changelog

### 0.2.0
- Auto-detect GitHub-installed adapters via `installedFrom` field — no manual configuration needed

### 0.1.0
- Initial release

---

## License

MIT License — Copyright (c) 2026 alex
