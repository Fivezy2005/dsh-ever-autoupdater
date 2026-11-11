window.__ModuleLoader__.load({
	id: "dsh-autoupdater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-autoupdater browser half — a first-level 「插件更新」 settings section:
		 * status, pending updates (update / skip per row), check and update-all
		 * buttons, the editable settings and the last run history.
		 *
		 * Pure DOM, text only (every value from the network goes through textContent,
		 * never as markup). Polls the local overview route only while mounted.
		 * @module dsh-autoupdater/client
		 */
		const SECTION_ID = 'dsh-autoupdater';
		const SECTION_ORDER = 153; // right below the hook section (152)
		const API = 'api/dsh-autoupdater/';
		const POLL_MS = 15000;
		const FETCH_TIMEOUT_MS = 20000;
		const ACTION_TIMEOUT_MS = 15 * 60 * 1000; // an update can take minutes

		const zh = {
			title: '插件更新',
			sub: '自动检查插件新版本，也可以在这里手动更新',
			loadFailed: '读不到更新器的状态：',
			status: '状态',
			host: 'DSH 版本',
			hostUnknown: '未读取到',
			lastCheck: '上次检查',
			nextCheck: '下次检查',
			never: '还没有检查过',
			none: '没有安排',
			agents: '正在运行的会话',
			noAgents: '没有',
			busyNow: '正在检查或更新…',
			pending: '待更新',
			noPending: '所有插件都是最新的',
			update: '更新',
			skip: '跳过此版本',
			note: '备注',
			checkNow: '立即检查',
			updateAll: '全部更新',
			settings: '设置',
			autoApply: '自动安装更新',
			autoApplyHint: '关闭时只检查、不安装；有会话在运行时自动更新会推迟',
			scheduleMode: '检查方式',
			modeInterval: '每隔几小时',
			modeDaily: '每天固定时刻',
			modeStartup: '只在启动时',
			intervalHours: '间隔（小时）',
			dailyTime: '每天几点（24 小时制，如 03:30）',
			maxUpdatesPerRun: '每轮最多更新几个（0 = 不限）',
			allowPrerelease: '允许预发布版本',
			skipPackages: '不更新的插件（一行一个）',
			save: '保存设置',
			saved: '已保存',
			history: '上一轮结果',
			applied: '已更新',
			failed: '失败',
			rolledBack: '已回滚',
			skipped: '已跳过',
			deferred: '已推迟',
			nothing: '无',
			restart: '需要重启',
			failedMemory: '失败过的版本（不再重试）',
			clear: '清除',
			skippedMemory: '你跳过的版本',
			unskip: '取消跳过',
			confirmBusy: '现在有 {n} 个会话正在运行，更新可能打断它们。确定继续更新吗？',
			confirmAll: '确定更新这 {n} 个插件吗？',
			working: '处理中…',
			done: '完成',
			updatedN: '已更新 {n} 个',
			time: { now: '刚刚', min: '{n} 分钟前', hour: '{n} 小时前', day: '{n} 天前', in: '{t} 后' },
		};
		const en = {
			title: 'Plugin updates',
			sub: 'Checks for new plugin versions automatically; update by hand here too',
			loadFailed: 'Could not read the updater status: ',
			status: 'Status',
			host: 'DSH version',
			hostUnknown: 'unknown',
			lastCheck: 'Last check',
			nextCheck: 'Next check',
			never: 'never checked',
			none: 'not scheduled',
			agents: 'Running sessions',
			noAgents: 'none',
			busyNow: 'Checking or updating…',
			pending: 'Pending updates',
			noPending: 'Every plugin is up to date',
			update: 'Update',
			skip: 'Skip this version',
			note: 'Note',
			checkNow: 'Check now',
			updateAll: 'Update all',
			settings: 'Settings',
			autoApply: 'Install updates automatically',
			autoApplyHint: 'Off: only check. Automatic updates wait while a session is running',
			scheduleMode: 'Check schedule',
			modeInterval: 'Every few hours',
			modeDaily: 'Once a day',
			modeStartup: 'Only at startup',
			intervalHours: 'Interval (hours)',
			dailyTime: 'Time of day (24h, e.g. 03:30)',
			maxUpdatesPerRun: 'Max updates per run (0 = no limit)',
			allowPrerelease: 'Allow prerelease versions',
			skipPackages: 'Never update these (one per line)',
			save: 'Save settings',
			saved: 'Saved',
			history: 'Last run',
			applied: 'Updated',
			failed: 'Failed',
			rolledBack: 'Rolled back',
			skipped: 'Skipped',
			deferred: 'Deferred',
			nothing: 'none',
			restart: 'restart needed',
			failedMemory: 'Versions that failed (not retried)',
			clear: 'Clear',
			skippedMemory: 'Versions you skipped',
			unskip: 'Undo skip',
			confirmBusy: '{n} session(s) are running and an update may interrupt them. Update anyway?',
			confirmAll: 'Update these {n} plugin(s)?',
			working: 'Working…',
			done: 'Done',
			updatedN: '{n} updated',
			time: { now: 'just now', min: '{n} min ago', hour: '{n} h ago', day: '{n} d ago', in: 'in {t}' },
		};

		function dictionary() {
			const lang = typeof document !== 'undefined' ? document.documentElement.lang || 'zh' : 'zh';
			return lang.toLowerCase().startsWith('en') ? en : zh;
		}
		function t(key, params) {
			let text = dictionary()[key];
			if (typeof text !== 'string') return key;
			if (params) for (const [name, value] of Object.entries(params)) text = text.split('{' + name + '}').join(String(value));
			return text;
		}
		function rel(value) {
			const ms = typeof value === 'string' ? Date.parse(value) : NaN;
			if (!Number.isFinite(ms)) return '';
			const tt = dictionary().time;
			const diff = Math.round((ms - Date.now()) / 1000);
			const abs = Math.abs(diff);
			let text;
			if (abs < 60) text = tt.now;
			else if (abs < 3600) text = tt.min.replace('{n}', Math.floor(abs / 60));
			else if (abs < 86400) text = tt.hour.replace('{n}', Math.floor(abs / 3600));
			else text = tt.day.replace('{n}', Math.floor(abs / 86400));
			if (diff > 60) return tt.in.replace('{t}', text.replace(/ ?(ago|前)$/, ''));
			return text;
		}

		/** A DOM element with text only. */
		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined && text !== null) node.textContent = String(text);
			return node;
		}
		function button(label, onClick, extraClass) {
			const b = el('button', 'dau-btn' + (extraClass ? ' ' + extraClass : ''), label);
			b.type = 'button';
			b.addEventListener('click', onClick);
			return b;
		}

		async function getJson(path) {
			const response = await fetch(API + path, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (!response.ok) throw new Error(path + ' → ' + response.status);
			return await response.json();
		}
		async function postJson(path, body, timeout) {
			const response = await fetch(API + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeout || FETCH_TIMEOUT_MS),
			});
			let json = null;
			try { json = await response.json(); } catch { /* not JSON */ }
			if (!response.ok) throw new Error((json && json.error) || path + ' → ' + response.status);
			return json;
		}

		function ensureStyles() {
			if (document.getElementById('dsh-autoupdater-styles')) return;
			const style = document.createElement('style');
			style.id = 'dsh-autoupdater-styles';
			style.textContent = [
				'.dau-root{display:flex;flex-direction:column;gap:16px;width:100%}',
				'.dau-title{font-size:1.9em;font-weight:700;line-height:1.2}',
				'.dau-sub{font-size:.85em;opacity:.65}',
				'.dau-card{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:12px;overflow:hidden}',
				'.dau-card-head{padding:10px 16px;font-weight:600;background:color-mix(in srgb,currentColor 5%,transparent);display:flex;align-items:center;gap:8px}',
				'.dau-card-body{display:flex;flex-direction:column}',
				'.dau-row{display:flex;gap:10px;padding:10px 16px;border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);align-items:center;flex-wrap:wrap}',
				'.dau-row:first-child{border-top:0}',
				'.dau-key{min-width:150px;opacity:.65;font-size:.9em}',
				'.dau-main{flex:1;min-width:180px;display:flex;flex-direction:column;gap:3px;word-break:break-word}',
				'.dau-meta{font-size:.8em;opacity:.6}',
				'.dau-warn{color:#d97706}',
				'.dau-bad{color:#dc2626}',
				'.dau-good{color:#10b981}',
				'.dau-empty{padding:18px 16px;opacity:.7}',
				'.dau-btn{border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:0 0;color:inherit;border-radius:8px;padding:5px 12px;cursor:pointer;font-size:.85em;font-family:inherit}',
				'.dau-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
				'.dau-btn[disabled]{opacity:.4;cursor:default}',
				'.dau-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}',
				'.dau-btn-primary:hover{background:#1d4ed8}',
				'.dau-actions{display:flex;gap:8px;flex-wrap:wrap;padding:10px 16px}',
				'.dau-input{border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;border-radius:8px;padding:5px 8px;font-family:inherit;font-size:.9em}',
				'textarea.dau-input{min-width:260px;min-height:70px;font-family:ui-monospace,monospace}',
				'.dau-toast{padding:8px 16px;font-size:.9em}',
			].join('');
			document.head.appendChild(style);
		}

		function mountInto(node) {
			ensureStyles();
			const root = el('div', 'dau-root');
			node.appendChild(root);
			let disposed = false;
			let busy = false;
			let timer = null;
			let toast = { text: '', bad: false };
			let editing = false; // a field of the settings form has focus → do not rebuild under the user
			let last = null;

			function say(text, bad) {
				toast = { text, bad: bad === true };
				if (last) render(last);
			}

			async function refresh() {
				if (disposed) return;
				try {
					last = await getJson('overview');
					if (!editing) render(last);
				} catch (error) {
					if (disposed) return;
					root.textContent = '';
					root.appendChild(el('div', 'dau-empty dau-warn', t('loadFailed') + (error && error.message ? error.message : error)));
				}
			}

			async function act(body, timeout) {
				if (busy) return null;
				busy = true;
				say(t('working'));
				try {
					return await postJson('action', body, timeout || ACTION_TIMEOUT_MS);
				} catch (error) {
					say(error && error.message ? error.message : String(error), true);
					return null;
				} finally {
					busy = false;
				}
			}

			/** Run an update; if the host asks, confirm with the user and send it again. */
			async function runUpdate(names) {
				const count = names ? names.length : last.pending.length;
				if (!window.confirm(t('confirmAll', { n: count }))) return;
				let body = { action: 'update', names };
				let result = await act(body);
				if (result && result.needsConfirmation) {
					if (!window.confirm(t('confirmBusy', { n: (result.runningAgents || []).length }))) { say(''); await refresh(); return; }
					body = { action: 'update', names, confirmed: true };
					result = await act(body);
				}
				if (result && result.report) say(t('updatedN', { n: (result.report.applied || []).length }), (result.report.failed || []).length > 0);
				await refresh();
			}

			function statusCard(d) {
				const card = el('div', 'dau-card');
				card.appendChild(el('div', 'dau-card-head', t('status')));
				const body = el('div', 'dau-card-body');
				const add = (key, value, cls) => {
					const row = el('div', 'dau-row');
					row.appendChild(el('div', 'dau-key', key));
					row.appendChild(el('div', 'dau-main' + (cls ? ' ' + cls : ''), value));
					body.appendChild(row);
				};
				add(t('host'), d.host && d.host.version ? d.host.version : t('hostUnknown'));
				const at = d.lastRun && d.lastRun.at;
				add(t('lastCheck'), at ? rel(at) + '（' + new Date(at).toLocaleString() + '）' : t('never'));
				add(t('nextCheck'), d.nextCheckAt ? rel(d.nextCheckAt) + '（' + new Date(d.nextCheckAt).toLocaleString() + '）' : t('none'));
				const agents = d.runningAgents || [];
				add(t('agents'), agents.length === 0 ? t('noAgents') : String(agents.length), agents.length > 0 ? 'dau-warn' : '');
				if (d.running) add('', t('busyNow'), 'dau-warn');
				card.appendChild(body);
				return card;
			}

			function pendingCard(d) {
				const card = el('div', 'dau-card');
				card.appendChild(el('div', 'dau-card-head', t('pending') + ' (' + d.pending.length + ')'));
				const body = el('div', 'dau-card-body');
				if (d.pending.length === 0) {
					body.appendChild(el('div', 'dau-empty', t('noPending')));
				} else {
					for (const item of d.pending) {
						const row = el('div', 'dau-row');
						const main = el('div', 'dau-main');
						main.appendChild(el('div', '', item.name + '   ' + (item.from || '?') + ' → ' + (item.to || '?')));
						if (item.note) main.appendChild(el('div', 'dau-meta', t('note') + '：' + item.note));
						row.appendChild(main);
						const version = item.to || item.target;
						row.appendChild(button(t('update'), () => { void runUpdate([item.name]); }, 'dau-btn-primary'));
						row.appendChild(button(t('skip'), async () => {
							const result = await act({ action: 'skip', name: item.name, version }, FETCH_TIMEOUT_MS);
							if (result) await refresh();
						}));
						body.appendChild(row);
					}
				}
				const actions = el('div', 'dau-actions');
				actions.appendChild(button(t('checkNow'), async () => {
					const result = await act({ action: 'check' });
					if (result) say(t('done'));
					await refresh();
				}));
				const all = button(t('updateAll'), () => { void runUpdate(undefined); }, 'dau-btn-primary');
				if (d.pending.length === 0) all.disabled = true;
				actions.appendChild(all);
				body.appendChild(actions);
				card.appendChild(body);
				return card;
			}

			function settingsCard(d) {
				const s = d.settings;
				const card = el('div', 'dau-card');
				card.appendChild(el('div', 'dau-card-head', t('settings')));
				const body = el('div', 'dau-card-body');
				const fields = {};
				const addRow = (label, input, hint) => {
					const row = el('div', 'dau-row');
					row.appendChild(el('div', 'dau-key', label));
					const main = el('div', 'dau-main');
					main.appendChild(input);
					if (hint) main.appendChild(el('div', 'dau-meta', hint));
					row.appendChild(main);
					body.appendChild(row);
				};
				const checkbox = (value) => { const i = el('input'); i.type = 'checkbox'; i.checked = value === true; return i; };
				const number = (value) => { const i = el('input', 'dau-input'); i.type = 'number'; i.min = '0'; i.value = String(value); return i; };

				fields.autoApply = checkbox(s.autoApply);
				addRow(t('autoApply'), fields.autoApply, t('autoApplyHint'));

				fields.scheduleMode = el('select', 'dau-input');
				for (const [value, label] of [['interval', t('modeInterval')], ['daily', t('modeDaily')], ['startup-only', t('modeStartup')]]) {
					const option = el('option', '', label);
					option.value = value;
					if (value === s.scheduleMode) option.selected = true;
					fields.scheduleMode.appendChild(option);
				}
				addRow(t('scheduleMode'), fields.scheduleMode);

				fields.intervalHours = number(s.intervalHours);
				addRow(t('intervalHours'), fields.intervalHours);

				fields.dailyTime = el('input', 'dau-input');
				fields.dailyTime.type = 'text';
				fields.dailyTime.value = s.dailyTime;
				fields.dailyTime.maxLength = 5;
				addRow(t('dailyTime'), fields.dailyTime);

				fields.maxUpdatesPerRun = number(s.maxUpdatesPerRun);
				addRow(t('maxUpdatesPerRun'), fields.maxUpdatesPerRun);

				fields.allowPrerelease = checkbox(s.allowPrerelease);
				addRow(t('allowPrerelease'), fields.allowPrerelease);

				fields.skipPackages = el('textarea', 'dau-input');
				fields.skipPackages.value = (s.skipPackages || []).filter((n) => n !== 'dsh-autoupdater').join('\n');
				addRow(t('skipPackages'), fields.skipPackages);

				// Do not rebuild the form (poll) while the user is typing in it.
				for (const input of Object.values(fields)) {
					input.addEventListener('focus', () => { editing = true; });
					input.addEventListener('blur', () => { editing = false; });
				}

				const actions = el('div', 'dau-actions');
				actions.appendChild(button(t('save'), async () => {
					const change = {
						autoApply: fields.autoApply.checked,
						scheduleMode: fields.scheduleMode.value,
						intervalHours: Number(fields.intervalHours.value),
						dailyTime: fields.dailyTime.value.trim(),
						maxUpdatesPerRun: Number(fields.maxUpdatesPerRun.value),
						allowPrerelease: fields.allowPrerelease.checked,
						skipPackages: fields.skipPackages.value.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
					};
					editing = false;
					if (busy) return;
					busy = true;
					try {
						await postJson('settings', change);
						say(t('saved'));
						await refresh();
					} catch (error) {
						say(error && error.message ? error.message : String(error), true);
					} finally {
						busy = false;
					}
				}, 'dau-btn-primary'));
				body.appendChild(actions);
				card.appendChild(body);
				return card;
			}

			function listSection(title, items, format, cls) {
				const row = el('div', 'dau-row');
				row.appendChild(el('div', 'dau-key', title + ' (' + items.length + ')'));
				const main = el('div', 'dau-main' + (cls ? ' ' + cls : ''));
				if (items.length === 0) main.appendChild(el('div', 'dau-meta', t('nothing')));
				for (const item of items) main.appendChild(el('div', '', format(item)));
				row.appendChild(main);
				return row;
			}

			function historyCard(d) {
				const run = d.lastRun;
				const card = el('div', 'dau-card');
				card.appendChild(el('div', 'dau-card-head', t('history')));
				const body = el('div', 'dau-card-body');
				if (!run) {
					body.appendChild(el('div', 'dau-empty', t('never')));
				} else {
					const arrow = (i) => i.name + ' ' + (i.from || '?') + ' → ' + (i.to || '?');
					body.appendChild(listSection(t('applied'), run.applied || [], (i) => arrow(i) + (i.restartRequired ? '（' + t('restart') + '）' : ''), 'dau-good'));
					body.appendChild(listSection(t('failed'), run.failed || [], (i) => arrow(i) + '：' + i.error, 'dau-bad'));
					body.appendChild(listSection(t('rolledBack'), run.rolledBack || [], (i) => i.name + (i.ok === false && i.error ? '：' + i.error : ''), 'dau-warn'));
					body.appendChild(listSection(t('deferred'), run.deferred || [], (i) => i.name + '：' + i.reason));
					body.appendChild(listSection(t('skipped'), run.skipped || [], (i) => i.name + '：' + i.reason));
				}
				const failedNames = Object.keys(d.failedVersions || {});
				if (failedNames.length > 0) {
					const row = el('div', 'dau-row');
					row.appendChild(el('div', 'dau-key', t('failedMemory')));
					const main = el('div', 'dau-main');
					for (const name of failedNames) main.appendChild(el('div', '', name + ' ' + d.failedVersions[name].target));
					row.appendChild(main);
					row.appendChild(button(t('clear'), async () => {
						const result = await act({ action: 'clearFailed' }, FETCH_TIMEOUT_MS);
						if (result) await refresh();
					}));
					body.appendChild(row);
				}
				const skippedNames = Object.keys(d.skippedVersions || {});
				for (const name of skippedNames) {
					const row = el('div', 'dau-row');
					row.appendChild(el('div', 'dau-key', t('skippedMemory')));
					row.appendChild(el('div', 'dau-main', name + ' ' + d.skippedVersions[name]));
					row.appendChild(button(t('unskip'), async () => {
						const result = await act({ action: 'unskip', name }, FETCH_TIMEOUT_MS);
						if (result) await refresh();
					}));
					body.appendChild(row);
				}
				card.appendChild(body);
				return card;
			}

			function render(d) {
				if (disposed) return;
				root.textContent = '';
				const head = el('div');
				head.appendChild(el('div', 'dau-title', t('title')));
				head.appendChild(el('div', 'dau-sub', t('sub')));
				root.appendChild(head);
				if (toast.text) root.appendChild(el('div', 'dau-toast ' + (toast.bad ? 'dau-bad' : 'dau-good'), toast.text));
				root.appendChild(statusCard(d));
				root.appendChild(pendingCard(d));
				root.appendChild(settingsCard(d));
				root.appendChild(historyCard(d));
			}

			void refresh();
			timer = setInterval(() => { if (!busy) void refresh(); }, POLL_MS);
			return () => {
				disposed = true;
				if (timer !== null) clearInterval(timer);
				try { root.remove(); } catch { /* detached */ }
			};
		}

		/** React wrapper: hosts the imperative DOM; the ref callback with null unmounts it. */
		function UpdaterSection() {
			const react = require('react');
			let dispose = null;
			return react.createElement('div', {
				style: { width: '100%' },
				ref: (node) => {
					if (node) {
						if (dispose) return;
						dispose = mountInto(node);
					} else if (dispose) {
						try { dispose(); } catch { /* node already detached */ }
						dispose = null;
					}
				},
			});
		}

		/** Client plugin entry: DSH calls apply(ctx) on the browser half. */
		module.exports.apply = function apply(ctx) {
			ctx.slots.inject('settings.section', () => {
				try {
					const unregister = ctx.slots.register({
						name: 'settings.section',
						id: SECTION_ID,
						order: SECTION_ORDER,
						label: () => t('title'),
					}, UpdaterSection);
					return () => { try { unregister(); } catch { /* already gone */ } };
				} catch {
					return () => {};
				}
			});
		};
		module.exports.inject = ['slots'];
		// 🔴 必须返回 exports，否则渲染进程收到 undefined，启动失败。
		return module.exports;
	},
});
