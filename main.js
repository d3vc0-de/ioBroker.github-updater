'use strict';

const utils = require('@iobroker/adapter-core');
const https = require('node:https');
const { exec } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Vergleicht zwei Semver-Versionsstrings.
 * @returns {number} > 0 wenn latest neuer als installed, 0 wenn gleich, < 0 wenn älter
 */
function compareVersions(installed, latest) {
    const clean = v => v.replace(/^v/, '').split(/[.\-+]/).slice(0, 3).map(x => parseInt(x, 10) || 0);
    const [a1, b1, c1] = clean(installed);
    const [a2, b2, c2] = clean(latest);
    if (a2 !== a1) return a2 - a1;
    if (b2 !== b1) return b2 - b1;
    return c2 - c1;
}

/**
 * GitHub API HTTPS-Request (kein externer Dependency nötig).
 * @param {string} apiPath  z.B. "/repos/user/repo/releases/latest"
 * @param {string} token    Optional GitHub PAT
 * @returns {Promise<object>}
 */
function githubGet(apiPath, token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: apiPath,
            headers: {
                'User-Agent': 'ioBroker-github-updater/0.1.0',
                'Accept': 'application/vnd.github+json',
            },
        };
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }
        const req = https.get(options, (res) => {
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error(`JSON parse error: ${e.message}`));
                    }
                } else if (res.statusCode === 404) {
                    resolve(null); // Nicht gefunden (z.B. kein Release)
                } else {
                    reject(new Error(`GitHub API HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('GitHub API timeout'));
        });
    });
}

/**
 * Ermittelt den ioBroker-Installationspfad ausgehend vom Adapter-Verzeichnis.
 */
function findIoBrokerRoot() {
    let dir = path.resolve(__dirname, '..', '..');
    const candidates = [dir, '/opt/iobroker'];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'node_modules', 'iobroker.js-controller'))) {
            return candidate;
        }
    }
    return '/opt/iobroker';
}

// ---------------------------------------------------------------------------
// Adapter-Klasse
// ---------------------------------------------------------------------------

class GithubUpdater extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'github-updater' });

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload',      this.onUnload.bind(this));

        this.pollTimer = null;
        this.iobRoot   = findIoBrokerRoot();
        this.running   = false; // Verhindert parallele Checks
    }

    // -----------------------------------------------------------------------

    async onReady() {
        this.setState('info.connection', false, true);

        // Statische Objekte für actions und info anlegen
        await this.setObjectNotExistsAsync('actions.checkNow', {
            type: 'state',
            common: { name: 'Jetzt prüfen', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
        await this.subscribeStatesAsync('actions.checkNow');

        // Adapter-spezifische Objekte anlegen
        const adapters = this.config.adapters || [];
        for (const entry of adapters) {
            if (!entry.adapterName) continue;
            await this.ensureAdapterObjects(entry.adapterName);

            // triggerUpdate-Button pro Adapter
            const triggerId = `adapters.${entry.adapterName}.triggerUpdate`;
            await this.setObjectNotExistsAsync(triggerId, {
                type: 'state',
                common: { name: `Update ${entry.adapterName} auslösen`, type: 'boolean', role: 'button', read: false, write: true, def: false },
                native: {},
            });
            await this.subscribeStatesAsync(triggerId);
        }

        // Initialer Check
        await this.checkAllAdapters();

        // Polling-Timer starten
        const interval = Math.max(600, this.config.checkInterval || 3600) * 1000;
        this.pollTimer = this.setInterval(() => this.checkAllAdapters(), interval);
        this.log.info(`GitHub Updater gestartet. Prüfintervall: ${interval / 1000}s, ioBroker-Root: ${this.iobRoot}`);
    }

    // -----------------------------------------------------------------------

    async onStateChange(id, state) {
        if (!state || !state.ack === false) return;
        if (state.ack) return; // Nur auf fremde Schreibzugriffe reagieren

        if (id.endsWith('actions.checkNow') && state.val) {
            this.log.info('Manueller Check angefordert.');
            await this.checkAllAdapters();
            return;
        }

        // Einzelnes triggerUpdate für einen Adapter
        const match = id.match(/adapters\.(.+)\.triggerUpdate$/);
        if (match && state.val) {
            const adapterName = match[1];
            const entry = (this.config.adapters || []).find(a => a.adapterName === adapterName);
            if (entry) {
                this.log.info(`Manuelles Update für ${adapterName} angefordert.`);
                await this.doUpdate(entry);
            }
        }
    }

    // -----------------------------------------------------------------------

    async onUnload(callback) {
        try {
            this.pollTimer && this.clearInterval(this.pollTimer);
        } finally {
            callback();
        }
    }

    // -----------------------------------------------------------------------
    // Kernlogik
    // -----------------------------------------------------------------------

    async checkAllAdapters() {
        if (this.running) {
            this.log.debug('Check läuft bereits, überspringe.');
            return;
        }
        this.running = true;

        const adapters = this.config.adapters || [];
        if (!adapters.length) {
            this.log.info('Keine Adapter konfiguriert. Bitte im Admin-UI Adapter hinzufügen.');
            this.running = false;
            return;
        }

        this.log.info(`Prüfe ${adapters.length} Adapter auf Updates…`);
        let updatesFound = 0;
        let githubOk = true;

        for (const entry of adapters) {
            if (!entry.adapterName || !entry.githubRepo) continue;
            try {
                const hadUpdate = await this.checkAdapter(entry);
                if (hadUpdate) updatesFound++;
            } catch (err) {
                this.log.warn(`Fehler bei ${entry.adapterName}: ${err.message}`);
                if (err.message.includes('HTTP') || err.message.includes('timeout')) {
                    githubOk = false;
                }
            }
        }

        this.setState('info.connection',     githubOk, true);
        this.setState('info.lastCheck',      new Date().toISOString(), true);
        this.setState('info.updatesAvailable', updatesFound, true);
        this.running = false;

        this.log.info(`Check abgeschlossen. ${updatesFound} Update(s) verfügbar.`);
    }

    /**
     * Prüft einen einzelnen Adapter.
     * @returns {boolean} true wenn Update verfügbar
     */
    async checkAdapter(entry) {
        const { adapterName, githubRepo, channel, autoUpdate: rowAutoUpdate } = entry;
        const token = this.config.githubToken || '';

        this.log.debug(`Prüfe ${adapterName} (${githubRepo}, Kanal: ${channel || 'release'})…`);

        // 1. Installierte Version lesen
        const installedVersion = await this.getInstalledVersion(adapterName);
        if (!installedVersion) {
            this.log.warn(`Adapter '${adapterName}' nicht in ioBroker gefunden – überspringe.`);
            await this.setState(`adapters.${adapterName}.installedVersion`, 'nicht installiert', true);
            return false;
        }

        // 2. GitHub-Version holen
        const { latestVersion, releaseUrl } = await this.getLatestGithubVersion(githubRepo, channel, token);
        if (!latestVersion) {
            this.log.warn(`Keine Version für ${githubRepo} gefunden.`);
            return false;
        }

        // 3. Vergleichen
        const diff = compareVersions(installedVersion, latestVersion);
        const updateAvailable = diff > 0;

        this.log.debug(`${adapterName}: installiert=${installedVersion} latest=${latestVersion} updateAvailable=${updateAvailable}`);

        // 4. States setzen
        await this.setState(`adapters.${adapterName}.installedVersion`, installedVersion,    true);
        await this.setState(`adapters.${adapterName}.latestVersion`,    latestVersion,       true);
        await this.setState(`adapters.${adapterName}.updateAvailable`,  updateAvailable,     true);
        await this.setState(`adapters.${adapterName}.releaseUrl`,       releaseUrl || '',    true);
        await this.setState(`adapters.${adapterName}.lastChecked`,      new Date().toISOString(), true);

        // 5. Benachrichtigung
        if (updateAvailable && this.config.notifyOnUpdate) {
            const msg = `Update verfügbar: ${adapterName} ${installedVersion} → ${latestVersion}`;
            this.log.info(msg);
            try {
                await this.sendNotificationAsync('github-updater', null, msg);
            } catch (_) {
                // Notification-System optional
            }
        }

        // 6. Auto-Update?
        const shouldAutoUpdate = rowAutoUpdate !== undefined ? rowAutoUpdate : this.config.autoUpdate;
        if (updateAvailable && shouldAutoUpdate) {
            await this.doUpdate(entry);
        }

        return updateAvailable;
    }

    // -----------------------------------------------------------------------

    async getInstalledVersion(adapterName) {
        try {
            const obj = await this.getForeignObjectAsync(`system.adapter.${adapterName}`);
            return (obj && obj.common && obj.common.version) ? obj.common.version : null;
        } catch (err) {
            this.log.debug(`getForeignObject für ${adapterName} fehlgeschlagen: ${err.message}`);
            return null;
        }
    }

    // -----------------------------------------------------------------------

    async getLatestGithubVersion(repo, channel, token) {
        const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');

        if (!channel || channel === 'release') {
            // Neuestes Release
            const data = await githubGet(`/repos/${cleanRepo}/releases/latest`, token);
            if (data && data.tag_name) {
                return {
                    latestVersion: data.tag_name.replace(/^v/, ''),
                    releaseUrl: data.html_url || '',
                };
            }
            // Fallback: Tags wenn kein Release existiert
        }

        // Tags (neuester Tag)
        const tags = await githubGet(`/repos/${cleanRepo}/tags?per_page=1`, token);
        if (tags && tags.length > 0) {
            return {
                latestVersion: tags[0].name.replace(/^v/, ''),
                releaseUrl: `https://github.com/${cleanRepo}/releases/tag/${tags[0].name}`,
            };
        }

        // Letzter Commit auf default branch (SHA)
        const commit = await githubGet(`/repos/${cleanRepo}/commits?per_page=1`, token);
        if (commit && commit.length > 0) {
            return {
                latestVersion: commit[0].sha.slice(0, 7),
                releaseUrl: `https://github.com/${cleanRepo}/commits`,
            };
        }

        return { latestVersion: null, releaseUrl: null };
    }

    // -----------------------------------------------------------------------

    async doUpdate(entry) {
        const { adapterName, githubRepo } = entry;
        const cleanRepo = githubRepo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
        const iobScript = path.join(this.iobRoot, 'node_modules', 'iobroker.js-controller', 'iobroker.js');

        const cmd = `node "${iobScript}" url "${cleanRepo}"`;
        this.log.info(`Starte Update: ${adapterName} von ${cleanRepo}`);
        this.log.debug(`Befehl: ${cmd}`);

        return new Promise((resolve) => {
            exec(cmd, { timeout: 180000, cwd: this.iobRoot }, (err, stdout, stderr) => {
                if (err) {
                    this.log.error(`Update ${adapterName} fehlgeschlagen: ${err.message}`);
                    this.log.debug(`stderr: ${stderr}`);
                } else {
                    this.log.info(`Update ${adapterName} erfolgreich: ${stdout.slice(0, 300)}`);
                }
                resolve(!err);
            });
        });
    }

    // -----------------------------------------------------------------------

    async ensureAdapterObjects(adapterName) {
        const base = `adapters.${adapterName}`;
        const objects = [
            { id: `${base}.installedVersion`, name: `${adapterName}: Installierte Version`, type: 'string', role: 'text' },
            { id: `${base}.latestVersion`,    name: `${adapterName}: Neueste Version`,      type: 'string', role: 'text' },
            { id: `${base}.updateAvailable`,  name: `${adapterName}: Update verfügbar`,     type: 'boolean', role: 'indicator' },
            { id: `${base}.releaseUrl`,        name: `${adapterName}: Release-URL`,         type: 'string', role: 'url' },
            { id: `${base}.lastChecked`,       name: `${adapterName}: Zuletzt geprüft`,     type: 'string', role: 'date' },
        ];
        for (const o of objects) {
            await this.setObjectNotExistsAsync(o.id, {
                type: 'state',
                common: { name: o.name, type: o.type, role: o.role, read: true, write: false, def: o.type === 'boolean' ? false : '' },
                native: {},
            });
        }
    }
}

// ---------------------------------------------------------------------------

if (require.main !== module) {
    module.exports = (options) => new GithubUpdater(options);
} else {
    new GithubUpdater();
}
