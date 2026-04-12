'use strict';

const utils = require('@iobroker/adapter-core');
const https = require('node:https');
const { exec } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function compareVersions(installed, latest) {
    const clean = v => v.replace(/^v/, '').split(/[.\-+]/).slice(0, 3).map(x => parseInt(x, 10) || 0);
    const [a1, b1, c1] = clean(installed);
    const [a2, b2, c2] = clean(latest);
    if (a2 !== a1) return a2 - a1;
    if (b2 !== b1) return b2 - b1;
    return c2 - c1;
}

function githubGet(apiPath, token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: apiPath,
            headers: {
                'User-Agent': 'ioBroker-github-updater/0.2.0',
                'Accept': 'application/vnd.github+json',
            },
        };
        if (token) options.headers['Authorization'] = `Bearer ${token}`;

        const req = https.get(options, (res) => {
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
                } else if (res.statusCode === 404) {
                    resolve(null);
                } else {
                    reject(new Error(`GitHub API HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('GitHub API timeout')));
    });
}

/**
 * Extrahiert "user/repo" aus allen bekannten GitHub-Quellenformaten.
 * Gibt null zurück wenn kein GitHub-Bezug erkennbar ist.
 */
function extractGithubRepo(source) {
    if (!source) return null;
    // https://github.com/user/repo  oder codeload.github.com/user/repo/tar.gz/hash
    const urlMatch = source.match(/github\.com[/:]([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
    if (urlMatch) return urlMatch[1].replace(/\.git$/, '');
    // github:user/repo  (npm Kurzform)
    if (source.startsWith('github:')) return source.slice(7).split('#')[0].replace(/\.git$/, '');
    // user/repo  (iobroker url Kurzform, kein npm-Scope)
    if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(source)) return source;
    return null;
}

function findIoBrokerRoot() {
    const candidates = [path.resolve(__dirname, '..', '..'), '/opt/iobroker'];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'node_modules', 'iobroker.js-controller'))) return dir;
    }
    return '/opt/iobroker';
}

// ---------------------------------------------------------------------------

class GithubUpdater extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'github-updater' });

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message',     this.onMessage.bind(this));
        this.on('unload',      this.onUnload.bind(this));

        this.pollTimer = null;
        this.iobRoot   = findIoBrokerRoot();
        this.running   = false;
        this.detected  = {}; // adapterName -> githubRepo
    }

    // -----------------------------------------------------------------------

    async onReady() {
        this.setState('info.connection', false, true);

        await this.setObjectNotExistsAsync('actions.checkNow', {
            type: 'state',
            common: { name: 'Jetzt prüfen', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.detectedAdapters', {
            type: 'state',
            common: { name: 'Erkannte GitHub-Adapter', type: 'string', role: 'text', read: true, write: false, def: '' },
            native: {},
        });

        await this.subscribeStatesAsync('actions.checkNow');
        await this.subscribeStatesAsync('adapters.*.triggerUpdate');

        await this.checkAllAdapters();

        const interval = Math.max(600, this.config.checkInterval || 3600) * 1000;
        this.pollTimer = this.setInterval(() => this.checkAllAdapters(), interval);
        this.log.info(`GitHub Updater gestartet. Prüfintervall: ${interval / 1000}s, ioBroker-Root: ${this.iobRoot}`);
    }

    // -----------------------------------------------------------------------

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        if (id.endsWith('actions.checkNow') && state.val) {
            this.log.info('Manueller Check angefordert.');
            await this.checkAllAdapters();
            return;
        }

        const match = id.match(/adapters\.(.+)\.triggerUpdate$/);
        if (match && state.val) {
            const adapterName = match[1];
            const repo = this.detected[adapterName];
            if (repo) {
                this.log.info(`Manuelles Update für ${adapterName} angefordert.`);
                await this.doUpdate(adapterName, repo);
            }
        }
    }

    // -----------------------------------------------------------------------
    // sendTo-Handler: liefert erkannte Adapter für die Config-UI
    // -----------------------------------------------------------------------

    async onMessage(msg) {
        if (msg.command === 'getDetected') {
            // Frischer Scan damit die Config immer aktuell ist
            const adapters = await this.detectGithubAdapters();
            this.sendTo(msg.from, msg.command, {
                result: adapters.length
                    ? adapters.map(a => `${a.adapterName}  →  ${a.githubRepo}`).join('\n')
                    : 'Keine GitHub-Adapter gefunden.\nPrüfe das Log (loglevel=debug) für Details.',
            }, msg.callback);
        }
    }

    // -----------------------------------------------------------------------

    async onUnload(callback) {
        try { this.pollTimer && this.clearInterval(this.pollTimer); }
        finally { callback(); }
    }

    // -----------------------------------------------------------------------
    // Erkennung
    // -----------------------------------------------------------------------

    /**
     * Scannt node_modules auf iobroker.*-Pakete und prüft deren package.json
     * auf GitHub-Herkunft (_from / _resolved / repository).
     * Das ist derselbe Mechanismus den adapter-core für "(non-npm: ...)" nutzt.
     */
    async detectGithubAdapters() {
        const exclude    = (this.config.excludeAdapters || '').split(',').map(s => s.trim()).filter(Boolean);
        const modulesDir = path.join(this.iobRoot, 'node_modules');
        const found      = new Map();

        let entries;
        try {
            entries = fs.readdirSync(modulesDir);
        } catch (err) {
            this.log.error(`Kann node_modules nicht lesen (${modulesDir}): ${err.message}`);
            return [];
        }

        for (const dir of entries) {
            // Nur iobroker.*-Pakete
            if (!dir.startsWith('iobroker.')) continue;

            const pkgPath = path.join(modulesDir, dir, 'package.json');
            if (!fs.existsSync(pkgPath)) continue;

            let pkg;
            try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
            catch { continue; }

            // Adapter-Name: iobroker.name → name
            const adapterName = dir.slice('iobroker.'.length);
            if (exclude.includes(adapterName)) continue;

            // Quell-Felder die npm beim GitHub-Install setzt
            const from     = pkg._from     || '';
            const resolved = pkg._resolved || '';
            // Fallback: repository.url im package.json (immer gesetzt, aber für alle Adapter)
            const repoUrl  = (pkg.repository && typeof pkg.repository === 'object')
                ? (pkg.repository.url || '') : (pkg.repository || '');

            this.log.debug(`${dir}: _from="${from}" _resolved="${resolved}"`);

            // Priorität: _from → _resolved → (repository nur wenn Version kein semver ist)
            let repo = extractGithubRepo(from) || extractGithubRepo(resolved);

            // Wenn weder _from noch _resolved gesetzt: Version enthält Git-Hash → non-npm
            if (!repo && repoUrl.includes('github.com')) {
                const isSemver = /^\d+\.\d+\.\d+$/.test(pkg.version || '');
                if (!isSemver) {
                    repo = extractGithubRepo(repoUrl);
                }
            }

            if (!repo) continue;
            found.set(adapterName, repo);
        }

        const result = Array.from(found.entries()).map(([adapterName, githubRepo]) => ({ adapterName, githubRepo }));
        this.log.info(`Erkannte GitHub-Adapter: ${result.map(a => a.adapterName).join(', ') || 'keine'}`);
        return result;
    }

    // -----------------------------------------------------------------------

    async checkAllAdapters() {
        if (this.running) {
            this.log.debug('Check läuft bereits, überspringe.');
            return;
        }
        this.running = true;

        let adapters;
        try {
            adapters = await this.detectGithubAdapters();
        } catch (err) {
            this.log.error(`Fehler beim Ermitteln der Adapter: ${err.message}`);
            this.running = false;
            return;
        }

        if (!adapters.length) {
            this.log.warn('Keine manuell via GitHub installierten Adapter gefunden.');
            this.log.warn('Tipp: Setze Log-Level auf "debug" um zu sehen welche installedFrom-Werte gefunden wurden.');
            this.setState('info.detectedAdapters', '', true);
            this.setState('info.updatesAvailable', 0, true);
            this.setState('info.lastCheck', new Date().toISOString(), true);
            this.running = false;
            return;
        }

        this.log.info(`${adapters.length} GitHub-Adapter erkannt: ${adapters.map(a => a.adapterName).join(', ')}`);

        this.detected = {};
        for (const { adapterName, githubRepo } of adapters) {
            this.detected[adapterName] = githubRepo;
        }
        this.setState('info.detectedAdapters', adapters.map(a => `${a.adapterName} (${a.githubRepo})`).join(', '), true);

        let updatesFound = 0;
        let githubOk     = true;

        for (const entry of adapters) {
            try {
                await this.ensureAdapterObjects(entry.adapterName);
                const hadUpdate = await this.checkAdapter(entry);
                if (hadUpdate) updatesFound++;
            } catch (err) {
                this.log.warn(`Fehler bei ${entry.adapterName}: ${err.message}`);
                if (err.message.includes('HTTP') || err.message.includes('timeout')) githubOk = false;
            }
        }

        this.setState('info.connection',       githubOk,                true);
        this.setState('info.lastCheck',        new Date().toISOString(), true);
        this.setState('info.updatesAvailable', updatesFound,             true);
        this.running = false;

        this.log.info(`Check abgeschlossen. ${updatesFound} Update(s) verfügbar.`);
    }

    async checkAdapter({ adapterName, githubRepo }) {
        const token = this.config.githubToken || '';
        this.log.debug(`Prüfe ${adapterName} (${githubRepo})…`);

        // Version aus package.json lesen (zuverlässiger als Object-DB)
        const pkgPath = path.join(this.iobRoot, 'node_modules', `iobroker.${adapterName}`, 'package.json');
        let installedVersion = null;
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            installedVersion = pkg.version || null;
        } catch (_) {}
        // Fallback: Object-DB
        if (!installedVersion) {
            const obj = await this.getForeignObjectAsync(`system.adapter.${adapterName}`);
            installedVersion = obj && obj.common && obj.common.version;
        }
        if (!installedVersion) {
            this.log.warn(`Keine installierte Version für '${adapterName}' gefunden.`);
            return false;
        }

        const { latestVersion, releaseUrl } = await this.getLatestGithubVersion(githubRepo, token);
        if (!latestVersion) {
            this.log.warn(`Keine GitHub-Version für ${githubRepo} gefunden.`);
            return false;
        }

        const updateAvailable = compareVersions(installedVersion, latestVersion) > 0;
        this.log.info(`${adapterName}: installiert=${installedVersion}, GitHub=${latestVersion}, update=${updateAvailable}`);

        await this.setState(`adapters.${adapterName}.installedVersion`, installedVersion,         true);
        await this.setState(`adapters.${adapterName}.latestVersion`,    latestVersion,            true);
        await this.setState(`adapters.${adapterName}.updateAvailable`,  updateAvailable,          true);
        await this.setState(`adapters.${adapterName}.githubRepo`,       githubRepo,               true);
        await this.setState(`adapters.${adapterName}.releaseUrl`,       releaseUrl || '',         true);
        await this.setState(`adapters.${adapterName}.lastChecked`,      new Date().toISOString(), true);

        if (updateAvailable && this.config.notifyOnUpdate) {
            const msg = `Update verfügbar: ${adapterName} ${installedVersion} → ${latestVersion} (${releaseUrl})`;
            this.log.info(msg);
            try { await this.sendNotificationAsync('github-updater', null, msg); } catch (_) {}
        }

        if (updateAvailable && this.config.autoUpdate) {
            await this.doUpdate(adapterName, githubRepo);
        }

        return updateAvailable;
    }

    // -----------------------------------------------------------------------

    async getLatestGithubVersion(repo, token) {
        const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');

        const release = await githubGet(`/repos/${cleanRepo}/releases/latest`, token);
        if (release && release.tag_name) {
            return { latestVersion: release.tag_name.replace(/^v/, ''), releaseUrl: release.html_url || '' };
        }

        const tags = await githubGet(`/repos/${cleanRepo}/tags?per_page=1`, token);
        if (tags && tags.length > 0) {
            return {
                latestVersion: tags[0].name.replace(/^v/, ''),
                releaseUrl:    `https://github.com/${cleanRepo}/releases/tag/${tags[0].name}`,
            };
        }

        const commits = await githubGet(`/repos/${cleanRepo}/commits?per_page=1`, token);
        if (commits && commits.length > 0) {
            return { latestVersion: commits[0].sha.slice(0, 7), releaseUrl: `https://github.com/${cleanRepo}/commits` };
        }

        return { latestVersion: null, releaseUrl: null };
    }

    // -----------------------------------------------------------------------

    async doUpdate(adapterName, githubRepo) {
        const cleanRepo = githubRepo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
        const iobScript = path.join(this.iobRoot, 'node_modules', 'iobroker.js-controller', 'iobroker.js');
        const cmd       = `node "${iobScript}" url "${cleanRepo}"`;

        this.log.info(`Starte Update: ${adapterName} von ${cleanRepo}`);
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
        const defs = [
            { id: `${base}.installedVersion`, name: `${adapterName}: Installierte Version`, type: 'string',  role: 'text'      },
            { id: `${base}.latestVersion`,    name: `${adapterName}: Neueste Version`,       type: 'string',  role: 'text'      },
            { id: `${base}.updateAvailable`,  name: `${adapterName}: Update verfügbar`,      type: 'boolean', role: 'indicator' },
            { id: `${base}.githubRepo`,       name: `${adapterName}: GitHub-Repo`,           type: 'string',  role: 'text'      },
            { id: `${base}.releaseUrl`,       name: `${adapterName}: Release-URL`,           type: 'string',  role: 'url'       },
            { id: `${base}.lastChecked`,      name: `${adapterName}: Zuletzt geprüft`,       type: 'string',  role: 'date'      },
        ];
        for (const o of defs) {
            await this.setObjectNotExistsAsync(o.id, {
                type: 'state',
                common: { name: o.name, type: o.type, role: o.role, read: true, write: false, def: o.type === 'boolean' ? false : '' },
                native: {},
            });
        }
        await this.setObjectNotExistsAsync(`${base}.triggerUpdate`, {
            type: 'state',
            common: { name: `Update ${adapterName} auslösen`, type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
    }
}

// ---------------------------------------------------------------------------

if (require.main !== module) {
    module.exports = (options) => new GithubUpdater(options);
} else {
    new GithubUpdater();
}
