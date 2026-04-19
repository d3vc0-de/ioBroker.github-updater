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
 * Vergleicht zwei Versionen
 *
 * @param {string} installed - Installierte Version
 * @param {string} latest - Neueste Version
 * @returns {number} Ergebnis des Vergleichs
 */
function compareVersions(installed, latest) {
	const clean = v =>
		v
			.replace(/^v/, '')
			.split(/[.\-+]/)
			.slice(0, 3)
			.map(x => parseInt(x, 10) || 0);
	const [a1, b1, c1] = clean(installed);
	const [a2, b2, c2] = clean(latest);
	if (a2 !== a1) {
		return a2 - a1;
	}
	if (b2 !== b1) {
		return b2 - b1;
	}
	return c2 - c1;
}

/**
 * Extrahiert den Commit-Hash aus einer codeload.github.com-URL
 *
 * @param {string} resolved - Die resolved URL
 * @returns {string | null} Der Commit-Hash oder null
 */
function extractCommitFromUrl(resolved) {
	const match = resolved.match(/\/tar\.gz\/([a-f0-9]{7,40})$/i);
	return match ? match[1] : null;
}

/**
 * GitHub API GET-Request
 *
 * @param {string} apiPath - API-Pfad
 * @param {string} token - GitHub Token
 * @returns {Promise<any>} API-Antwort
 */
function githubGet(apiPath, token) {
	return new Promise((resolve, reject) => {
		const options = {
			hostname: 'api.github.com',
			path: apiPath,
			headers: {
				'User-Agent': 'ioBroker-github-updater/0.2.0',
				Accept: 'application/vnd.github+json',
			},
		};
		if (token) {
			options.headers['Authorization'] = `Bearer ${token}`;
		}

		const req = https.get(options, res => {
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
 *
 * @param {string} source - Die Quelle
 * @returns {string | null} Das GitHub-Repo oder null
 */
function extractGithubRepo(source) {
	if (!source) {
		return null;
	}
	// https://github.com/user/repo  oder codeload.github.com/user/repo/tar.gz/hash
	const urlMatch = source.match(/github\.com[/:]([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
	if (urlMatch) {
		return urlMatch[1].replace(/\.git$/, '');
	}
	// github:user/repo  (npm Kurzform)
	if (source.startsWith('github:')) {
		return source
			.slice(7)
			.split('#')[0]
			.replace(/\.git$/, '');
	}
	// user/repo  (iobroker url Kurzform, kein npm-Scope)
	if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(source)) {
		return source;
	}
	return null;
}

/**
 * Sucht das ioBroker-Root-Verzeichnis
 *
 * @returns {string} Das ioBroker-Root-Verzeichnis
 */
function findIoBrokerRoot() {
	const candidates = [path.resolve(__dirname, '..', '..'), '/opt/iobroker'];
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, 'node_modules', 'iobroker.js-controller'))) {
			return dir;
		}
	}
	return '/opt/iobroker';
}

// ---------------------------------------------------------------------------

class GithubUpdater extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options]
	 */
	constructor(options) {
		super({ ...options, name: 'github-updater' });

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.pollTimer = null;
		this.iobRoot = findIoBrokerRoot();
		this.running = false;
		this.detected = {}; // adapterName -> githubRepo
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
			common: {
				name: 'Erkannte GitHub-Adapter',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
				def: '',
			},
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

	/**
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}

		if (id.endsWith('actions.checkNow') && state.val) {
			this.log.info('Manueller Check angefordert.');
			await this.checkAllAdapters();
			return;
		}

		const match = id.match(/adapters\.(.+)\.triggerUpdate$/);
		if (match && state.val) {
			const adapterName = match[1];
			const entry = this.detected[adapterName];
			if (entry) {
				this.log.info(`Manuelles Update für ${adapterName} angefordert.`);
				await this.doUpdate(adapterName, entry.githubRepo);
			}
		}
	}

	// -----------------------------------------------------------------------
	// sendTo-Handler: liefert erkannte Adapter für die Config-UI
	// -----------------------------------------------------------------------

	/**
	 * @param {ioBroker.Message} msg
	 */
	async onMessage(msg) {
		if (msg.command === 'getDetected') {
			// Frischer Scan damit die Config immer aktuell ist
			const adapters = await this.detectGithubAdapters();
			this.sendTo(
				msg.from,
				msg.command,
				{
					result: adapters.length
						? adapters.map(a => `${a.adapterName}  →  ${a.githubRepo}`).join('\n')
						: 'Keine GitHub-Adapter gefunden.\nPrüfe das Log (loglevel=debug) für Details.',
				},
				msg.callback,
			);
		}
	}

	// -----------------------------------------------------------------------

	/**
	 * @param {() => void} callback
	 */
	async onUnload(callback) {
		try {
			this.pollTimer && this.clearInterval(this.pollTimer);
		} finally {
			callback();
		}
	}

	// -----------------------------------------------------------------------
	// Erkennung
	// -----------------------------------------------------------------------

	/**
	 * Liest package-lock.json und extrahiert alle iobroker.*-Pakete
	 * deren resolved-URL auf github.com / codeload.github.com zeigt.
	 * npm 7+ schreibt _from/_resolved nicht mehr in package.json —
	 * package-lock.json ist die einzig zuverlässige Quelle.
	 *
	 * @returns {Promise<any[]>} Die erkannten Adapter
	 */
	async detectGithubAdapters() {
		const exclude = (this.config.excludeAdapters || '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);
		const lockPath = path.join(this.iobRoot, 'package-lock.json');
		const found = new Map();

		let lock;
		try {
			lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
		} catch (err) {
			this.log.error(`Kann package-lock.json nicht lesen (${lockPath}): ${err.message}`);
			return [];
		}

		// lockfileVersion 2/3: Pakete stehen unter lock.packages["node_modules/name"]
		const packages = lock.packages || {};

		for (const [key, meta] of Object.entries(packages)) {
			// Nur direkte node_modules-Einträge für iobroker.*
			if (!key.startsWith('node_modules/iobroker.')) {
				continue;
			}

			const adapterName = key.slice('node_modules/iobroker.'.length);
			// Keine verschachtelten node_modules (z.B. node_modules/x/node_modules/iobroker.y)
			if (adapterName.includes('/')) {
				continue;
			}
			if (exclude.includes(adapterName)) {
				continue;
			}

			const resolved = meta.resolved || '';
			this.log.debug(`${key}: resolved="${resolved}"`);

			const repo = extractGithubRepo(resolved);
			if (!repo) {
				continue;
			}

			const installedCommit = extractCommitFromUrl(resolved);
			found.set(adapterName, { githubRepo: repo, installedCommit });
		}

		const result = Array.from(found.entries()).map(([adapterName, { githubRepo, installedCommit }]) => ({
			adapterName,
			githubRepo,
			installedCommit,
		}));
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
		for (const { adapterName, githubRepo, installedCommit } of adapters) {
			this.detected[adapterName] = { githubRepo, installedCommit };
		}
		this.setState(
			'info.detectedAdapters',
			adapters.map(a => `${a.adapterName} (${a.githubRepo})`).join(', '),
			true,
		);

		let updatesFound = 0;
		let githubOk = true;

		for (const entry of adapters) {
			try {
				await this.ensureAdapterObjects(entry.adapterName);
				const hadUpdate = await this.checkAdapter(entry);
				if (hadUpdate) {
					updatesFound++;
				}
			} catch (err) {
				this.log.warn(`Fehler bei ${entry.adapterName}: ${err.message}`);
				if (err.message.includes('HTTP') || err.message.includes('timeout')) {
					githubOk = false;
				}
			}
		}

		this.setState('info.connection', githubOk, true);
		this.setState('info.lastCheck', new Date().toISOString(), true);
		this.setState('info.updatesAvailable', updatesFound, true);
		this.running = false;

		this.log.info(`Check abgeschlossen. ${updatesFound} Update(s) verfügbar.`);
	}

	/**
	 * @param {any} param0
	 */
	async checkAdapter({ adapterName, githubRepo, installedCommit }) {
		const token = this.config.githubToken || '';
		this.log.debug(`Prüfe ${adapterName} (${githubRepo})…`);

		// Version aus package.json lesen
		const pkgPath = path.join(this.iobRoot, 'node_modules', `iobroker.${adapterName}`, 'package.json');
		let installedVersion = null;
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
			installedVersion = pkg.version || null;
		} catch {
			// ignore
		}
		if (!installedVersion) {
			const obj = await this.getForeignObjectAsync(`system.adapter.${adapterName}`);
			installedVersion = obj && obj.common && obj.common.version;
		}
		if (!installedVersion) {
			this.log.warn(`Keine installierte Version für '${adapterName}' gefunden.`);
			return false;
		}

		const { latestVersion, latestSha, releaseUrl, isCommitBased } = await this.getLatestGithubVersion(
			githubRepo,
			token,
		);
		if (!latestVersion) {
			this.log.warn(`Keine GitHub-Version für ${githubRepo} gefunden.`);
			return false;
		}

		let updateAvailable;
		let displayInstalled = installedVersion;
		let displayLatest = latestVersion;

		if (isCommitBased && installedCommit) {
			// Commit-Hash-Vergleich: unterschiedliche Hashes = Update
			const shortInstalled = installedCommit.slice(0, 7);
			const shortLatest = (latestSha || latestVersion).slice(0, 7);
			updateAvailable = shortInstalled !== shortLatest;
			displayInstalled = `${installedVersion} (${shortInstalled})`;
			displayLatest = shortLatest;
		} else if (isCommitBased && !installedCommit) {
			// Kein installierter Hash bekannt → kein zuverlässiger Vergleich möglich
			updateAvailable = false;
			displayLatest = latestVersion;
		} else {
			// Semver-Vergleich
			updateAvailable = compareVersions(installedVersion, latestVersion) > 0;
		}

		this.log.info(
			`${adapterName}: installiert=${displayInstalled}, GitHub=${displayLatest}, update=${updateAvailable}`,
		);

		await this.setState(`adapters.${adapterName}.installedVersion`, displayInstalled, true);
		await this.setState(`adapters.${adapterName}.latestVersion`, displayLatest, true);
		await this.setState(`adapters.${adapterName}.updateAvailable`, updateAvailable, true);
		await this.setState(`adapters.${adapterName}.githubRepo`, githubRepo, true);
		await this.setState(`adapters.${adapterName}.releaseUrl`, releaseUrl || '', true);
		await this.setState(`adapters.${adapterName}.lastChecked`, new Date().toISOString(), true);

		if (updateAvailable && this.config.notifyOnUpdate) {
			const msg = `Update verfügbar: ${adapterName} ${installedVersion} → ${latestVersion} (${releaseUrl})`;
			this.log.info(msg);
			try {
				// @ts-expect-error method might not exist on all js-controller versions
				await this.sendNotificationAsync('github-updater', null, msg);
			} catch {
				// Falls sendNotificationAsync nicht existiert (ältere js-controller)
			}
		}

		if (updateAvailable && this.config.autoUpdate) {
			await this.doUpdate(adapterName, githubRepo);
		}

		return updateAvailable;
	}

	// -----------------------------------------------------------------------

	/**
	 * @param {string} repo
	 * @param {string} token
	 */
	async getLatestGithubVersion(repo, token) {
		const cleanRepo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');

		const release = await githubGet(`/repos/${cleanRepo}/releases/latest`, token);
		if (release && release.tag_name) {
			return {
				latestVersion: release.tag_name.replace(/^v/, ''),
				latestSha: null,
				releaseUrl: release.html_url || '',
				isCommitBased: false,
			};
		}

		const tags = await githubGet(`/repos/${cleanRepo}/tags?per_page=1`, token);
		if (tags && tags.length > 0) {
			return {
				latestVersion: tags[0].name.replace(/^v/, ''),
				latestSha: (tags[0].commit && tags[0].commit.sha) || null,
				releaseUrl: `https://github.com/${cleanRepo}/releases/tag/${tags[0].name}`,
				isCommitBased: false,
			};
		}

		// Kein Release, kein Tag → Commit-Hash-Vergleich
		const commits = await githubGet(`/repos/${cleanRepo}/commits?per_page=1`, token);
		if (commits && commits.length > 0) {
			const sha = commits[0].sha;
			return {
				latestVersion: sha.slice(0, 7),
				latestSha: sha,
				releaseUrl: `https://github.com/${cleanRepo}/commits`,
				isCommitBased: true,
			};
		}

		return { latestVersion: null, latestSha: null, releaseUrl: null, isCommitBased: false };
	}

	// -----------------------------------------------------------------------

	/**
	 * @param {string} adapterName
	 * @param {string} githubRepo
	 */
	async doUpdate(adapterName, githubRepo) {
		const cleanRepo = githubRepo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
		const iobScript = path.join(this.iobRoot, 'node_modules', 'iobroker.js-controller', 'iobroker.js');
		const cmd = `node "${iobScript}" url "${cleanRepo}"`;

		this.log.info(`Starte Update: ${adapterName} von ${cleanRepo}`);
		return new Promise(resolve => {
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

	/**
	 * @param {string} adapterName
	 */
	async ensureAdapterObjects(adapterName) {
		const base = `adapters.${adapterName}`;
		const defs = [
			{
				id: `${base}.installedVersion`,
				name: `${adapterName}: Installierte Version`,
				type: 'string',
				role: 'text',
			},
			{ id: `${base}.latestVersion`, name: `${adapterName}: Neueste Version`, type: 'string', role: 'text' },
			{
				id: `${base}.updateAvailable`,
				name: `${adapterName}: Update verfügbar`,
				type: 'boolean',
				role: 'indicator',
			},
			{ id: `${base}.githubRepo`, name: `${adapterName}: GitHub-Repo`, type: 'string', role: 'text' },
			{ id: `${base}.releaseUrl`, name: `${adapterName}: Release-URL`, type: 'string', role: 'url' },
			{ id: `${base}.lastChecked`, name: `${adapterName}: Zuletzt geprüft`, type: 'string', role: 'date' },
		];
		for (const o of defs) {
			await this.setObjectNotExistsAsync(o.id, {
				type: 'state',
				common: {
					name: o.name,
					type: o.type,
					role: o.role,
					read: true,
					write: false,
					def: o.type === 'boolean' ? false : '',
				},
				native: {},
			});
		}
		await this.setObjectNotExistsAsync(`${base}.triggerUpdate`, {
			type: 'state',
			common: {
				name: `Update ${adapterName} auslösen`,
				type: 'boolean',
				role: 'button',
				read: false,
				write: true,
				def: false,
			},
			native: {},
		});
	}
}

// ---------------------------------------------------------------------------

if (require.main !== module) {
	module.exports = options => new GithubUpdater(options);
} else {
	new GithubUpdater();
}
