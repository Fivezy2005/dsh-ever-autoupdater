window.__ModuleLoader__.load({
	id: "dsh-ever-autoupdater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-ever-autoupdater browser half — a first-level 「插件更新」 settings section:
		 * status, pending updates (update / skip per row), check and update-all
		 * buttons, the editable settings and the last run history.
		 *
		 * Pure DOM, text only (every value from the network goes through textContent,
		 * never as markup). Polls the local overview route only while mounted.
		 * @module dsh-ever-autoupdater/client
		 */
		const SECTION_ID = 'dsh-ever-autoupdater';
		const SECTION_ORDER = 153; // right below the hook section (152)
		const API = 'api/dsh-ever-autoupdater/';
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
			dailyTime: '每天检查时刻',
			dailyTimeHint: '24 小时制，如 03:30',
			maxUpdatesPerRun: '每轮最多更新',
			maxUpdatesHint: '填 0 表示不限个数（手动更新不受此限制）',
			allowPrerelease: '允许预发布版本',
			skipPackages: '不更新的插件',
			skipPackagesHint: '一行写一个插件名',
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
			dailyTime: 'Daily check time',
			dailyTimeHint: '24-hour clock, e.g. 03:30',
			maxUpdatesPerRun: 'Max updates per run',
			maxUpdatesHint: '0 means no limit (manual updates ignore it)',
			allowPrerelease: 'Allow prerelease versions',
			skipPackages: 'Never update these',
			skipPackagesHint: 'One plugin name per line',
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
		/**
		 * One settings row in the host's own shape: title + grey hint on the left,
		 * the control on the right. `desc` is a string or a list of strings /
		 * { text, cls } lines.
		 */
		function row(title, desc, control, extraClass) {
			const r = el('div', 'dau-row' + (extraClass ? ' ' + extraClass : ''));
			const text = el('div', 'dau-text');
			if (title) text.appendChild(el('div', 'dau-label', title));
			for (const line of Array.isArray(desc) ? desc : [desc]) {
				if (!line) continue;
				const item = typeof line === 'string' ? { text: line } : line;
				text.appendChild(el('div', 'dau-desc' + (item.cls ? ' ' + item.cls : ''), item.text));
			}
			if (text.childNodes.length > 0) r.appendChild(text);
			if (control) {
				const box = el('div', 'dau-control');
				if (Array.isArray(control)) for (const c of control) box.appendChild(c); else box.appendChild(control);
				r.appendChild(box);
			}
			return r;
		}
		function section(title, rows, footer) {
			const s = el('section', 'dau-section');
			s.appendChild(el('h3', 'dau-h', title));
			const list = el('div', 'dau-list');
			for (const r of rows) list.appendChild(r);
			if (footer) list.appendChild(footer);
			s.appendChild(list);
			return s;
		}
		function toggle(value, label) {
			const wrap = el('label', 'dau-switch');
			const input = el('input');
			input.type = 'checkbox';
			input.checked = value === true;
			input.setAttribute('aria-label', label);
			wrap.appendChild(input);
			wrap.appendChild(el('span', 'dau-slider'));
			return { wrap, input };
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

		/**
		 * Look: the host settings page's own — flat rows split by hairlines, label
		 * and grey hint on the left, control on the right. Colours come from the
		 * host's --dsw-alias-* variables (so light/dark follow it), with plain
		 * fallbacks. Only background-color / transform / opacity are animated.
		 */
		function ensureStyles() {
			for (const id of ['dsh-ever-autoupdater-styles', 'dsh-ever-autoupdater-styles-2']) {
				const old = document.getElementById(id);
				if (old) old.remove();
			}
			const style = document.createElement('style');
			style.id = 'dsh-ever-autoupdater-styles-2';
			style.textContent = [
				'.dau-root{--dau-fg:var(--dsw-alias-label-primary,currentColor);--dau-fg2:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 65%,transparent));--dau-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));--dau-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));--dau-fill:var(--dsw-alias-bg-layer-3,color-mix(in srgb,currentColor 6%,transparent));--dau-accent:var(--dsw-alias-state-business-primary,#2563eb);--dau-on-accent:var(--dsw-alias-state-business-on-primary,#fff);--dau-ok:var(--dsw-alias-state-success-primary,#10b981);--dau-bad:var(--dsw-alias-state-error-primary,#dc2626);--dau-warn:var(--dsw-alias-state-warn-primary,#d97706);--dau-base:var(--dsw-alias-bg-base,#fff);--dau-radius:var(--dsw-radius-md,10px);display:flex;flex-direction:column;gap:28px;width:100%;color:var(--dau-fg)}',
				'.dau-head{display:flex;flex-direction:column;gap:4px}',
				'.dau-title{font-size:1.9em;font-weight:700;line-height:1.2}',
				'.dau-sub{font-size:.85em;color:var(--dau-fg2)}',
				'.dau-toast{padding:8px 12px;border-radius:var(--dau-radius);background:var(--dau-fill);font-size:.9em;line-height:1.5;word-break:break-word}',
				'.dau-toast[hidden]{display:none}',
				'.dau-h{margin:0 0 2px;font-size:1.05em;font-weight:600;line-height:1.4}',
				'.dau-list{display:flex;flex-direction:column}',
				'.dau-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--dau-line)}',
				'.dau-row:first-child{border-top:0}',
				'.dau-row[hidden]{display:none}',
				'.dau-row-stack{flex-direction:column;align-items:stretch;gap:8px}',
				'.dau-text{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
				'.dau-label{line-height:1.5;word-break:break-word}',
				'.dau-desc{font-size:.82em;line-height:1.5;color:var(--dau-fg2);word-break:break-word}',
				'.dau-control{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-shrink:0;max-width:60%}',
				'.dau-row-stack .dau-control{max-width:none;justify-content:stretch}',
				'.dau-value{color:var(--dau-fg2);text-align:right;word-break:break-word}',
				'.dau-good{color:var(--dau-ok)}',
				'.dau-warn{color:var(--dau-warn)}',
				'.dau-bad{color:var(--dau-bad)}',
				'.dau-actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 0 0;border-top:1px solid var(--dau-line)}',
				'.dau-btn{border:0;background:var(--dau-fill);color:var(--dau-fg);border-radius:var(--dau-radius);padding:8px 12px;font:inherit;font-size:.9em;line-height:1.3;cursor:pointer;white-space:nowrap;transition:background-color .15s,opacity .15s}',
				'.dau-btn:hover{background:var(--dau-hover)}',
				'.dau-btn-primary{background:var(--dau-accent);color:var(--dau-on-accent)}',
				'.dau-btn-primary:hover{background:var(--dau-accent);opacity:.9}',
				'.dau-btn:active{opacity:.75}',
				'.dau-btn[disabled]{background:var(--dau-fill);color:var(--dau-fg2);opacity:.5;cursor:not-allowed;pointer-events:none}',
				'.dau-busy .dau-btn{opacity:.5;pointer-events:none}',
				'.dau-input{box-sizing:border-box;border:1px solid transparent;background:var(--dau-fill);color:inherit;border-radius:var(--dau-radius);padding:8px 12px;font:inherit;font-size:.9em;transition:border-color .15s}',
				'.dau-input-sm{width:84px;text-align:right}',
				'select.dau-input{min-width:150px}',
				'textarea.dau-input{width:100%;min-height:84px;resize:vertical;font-family:ui-monospace,monospace}',
				'.dau-switch{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0}',
				'.dau-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}',
				'.dau-slider{position:absolute;inset:0;border-radius:22px;background:color-mix(in srgb,currentColor 22%,transparent);transition:background-color .15s}',
				'.dau-slider:before{content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:var(--dau-base);box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s}',
				'.dau-switch input:checked~.dau-slider{background:var(--dau-fg)}',
				'.dau-switch input:checked~.dau-slider:before{transform:translateX(18px)}',
				'.dau-btn:focus-visible,.dau-input:focus-visible,.dau-switch input:focus-visible~.dau-slider{outline:2px solid var(--dau-accent);outline-offset:2px}',
				'.dau-input:focus-visible{border-color:var(--dau-accent);outline-offset:0}',
				'@media (prefers-reduced-motion:reduce){.dau-root *,.dau-root *:before{transition:none!important}}',
			].join('');
			document.head.appendChild(style);
		}

		function mountInto(node) {
			ensureStyles();
			const root = el('div', 'dau-root');
			const head = el('header', 'dau-head');
			head.appendChild(el('div', 'dau-title', t('title')));
			head.appendChild(el('div', 'dau-sub', t('sub')));
			const toastEl = el('div', 'dau-toast');
			toastEl.hidden = true;
			toastEl.setAttribute('role', 'status');
			// A fixed skeleton: each block is replaced on its own, and only when its data changed.
			const hosts = { status: el('div'), pending: el('div'), settings: el('div'), history: el('div') };
			root.appendChild(head);
			root.appendChild(toastEl);
			for (const host of Object.values(hosts)) root.appendChild(host);
			node.appendChild(root);

			let disposed = false;
			let busy = false;
			let timer = null;
			let toastTimer = null;
			let loadFailedShown = false;
			let editing = false; // a field of the settings form has focus → never replace it under the user
			let last = null;
			const signatures = {};

			/** Change the notice bar in place — never rebuilds the page. */
			function say(text, bad, sticky) {
				if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
				toastEl.textContent = text || '';
				toastEl.className = 'dau-toast' + (text ? (bad ? ' dau-bad' : ' dau-good') : '');
				toastEl.hidden = !text;
				if (text && !sticky) toastTimer = setTimeout(() => { toastTimer = null; say(''); }, 8000);
			}
			function setBusy(value) {
				busy = value;
				root.classList.toggle('dau-busy', value);
				root.setAttribute('aria-busy', String(value));
			}
			/** Replace one block only when its signature changed. */
			function paint(key, signature, build) {
				if (signatures[key] === signature) return;
				signatures[key] = signature;
				hosts[key].replaceChildren(build());
			}

			async function refresh() {
				if (disposed) return;
				try {
					last = await getJson('overview');
					if (disposed) return;
					if (loadFailedShown) { loadFailedShown = false; say(''); }
					update(last);
				} catch (error) {
					if (disposed) return;
					loadFailedShown = true;
					say(t('loadFailed') + (error && error.message ? error.message : error), true, true);
				}
			}

			async function act(body, timeout) {
				if (busy) return null;
				setBusy(true);
				say(t('working'), false, true);
				try {
					const result = await postJson('action', body, timeout || ACTION_TIMEOUT_MS);
					say('');
					return result;
				} catch (error) {
					say(error && error.message ? error.message : String(error), true);
					return null;
				} finally {
					setBusy(false);
				}
			}

			/** Run an update; if the host asks, confirm with the user and send it again. */
			async function runUpdate(names) {
				const count = names ? names.length : last.pending.length;
				if (!window.confirm(t('confirmAll', { n: count }))) return;
				let result = await act({ action: 'update', names });
				if (result && result.needsConfirmation) {
					if (!window.confirm(t('confirmBusy', { n: (result.runningAgents || []).length }))) { await refresh(); return; }
					result = await act({ action: 'update', names, confirmed: true });
				}
				if (result && result.report) say(t('updatedN', { n: (result.report.applied || []).length }), (result.report.failed || []).length > 0);
				await refresh();
			}

			function statusRows(d) {
				const rows = [];
				rows.push([t('host'), d.host && d.host.version ? d.host.version : t('hostUnknown'), '']);
				const at = d.lastRun && d.lastRun.at;
				rows.push([t('lastCheck'), at ? rel(at) : t('never'), '', at ? new Date(at).toLocaleString() : '']);
				rows.push([t('nextCheck'), d.nextCheckAt ? rel(d.nextCheckAt) : t('none'), '', d.nextCheckAt ? new Date(d.nextCheckAt).toLocaleString() : '']);
				const agents = d.runningAgents || [];
				rows.push([t('agents'), agents.length === 0 ? t('noAgents') : String(agents.length), agents.length > 0 ? 'dau-warn' : '']);
				if (d.running) rows.push(['', t('busyNow'), 'dau-warn']);
				return rows;
			}
			function statusSection(rows) {
				return section(t('status'), rows.map(([key, value, cls, hint]) => row(key, hint, el('span', 'dau-value' + (cls ? ' ' + cls : ''), value))));
			}

			function pendingSection(d) {
				const rows = [];
				if (d.pending.length === 0) {
					rows.push(row(t('noPending')));
				} else {
					for (const item of d.pending) {
						const version = item.to || item.target;
						rows.push(row(item.name, [(item.from || '?') + ' → ' + (item.to || '?'), item.note ? t('note') + '：' + item.note : ''], [
							button(t('update'), () => { void runUpdate([item.name]); }, 'dau-btn-primary'),
							button(t('skip'), async () => {
								const result = await act({ action: 'skip', name: item.name, version }, FETCH_TIMEOUT_MS);
								if (result) await refresh();
							}),
						]));
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
				return section(t('pending') + '（' + d.pending.length + '）', rows, actions);
			}

			function settingsSection(d) {
				const s = d.settings;
				const rows = [];
				const number = (value, label) => {
					const i = el('input', 'dau-input dau-input-sm');
					i.type = 'number';
					i.min = '0';
					i.value = String(value);
					i.setAttribute('aria-label', label);
					return i;
				};
				const autoApply = toggle(s.autoApply, t('autoApply'));
				rows.push(row(t('autoApply'), t('autoApplyHint'), autoApply.wrap));

				const scheduleMode = el('select', 'dau-input');
				scheduleMode.setAttribute('aria-label', t('scheduleMode'));
				for (const [value, label] of [['interval', t('modeInterval')], ['daily', t('modeDaily')], ['startup-only', t('modeStartup')]]) {
					const option = el('option', '', label);
					option.value = value;
					if (value === s.scheduleMode) option.selected = true;
					scheduleMode.appendChild(option);
				}
				rows.push(row(t('scheduleMode'), '', scheduleMode));

				const intervalHours = number(s.intervalHours, t('intervalHours'));
				const intervalRow = row(t('intervalHours'), '', intervalHours);
				rows.push(intervalRow);

				const dailyTime = el('input', 'dau-input dau-input-sm');
				dailyTime.type = 'text';
				dailyTime.value = s.dailyTime;
				dailyTime.maxLength = 5;
				dailyTime.setAttribute('aria-label', t('dailyTime'));
				const dailyRow = row(t('dailyTime'), t('dailyTimeHint'), dailyTime);
				rows.push(dailyRow);

				// Only the field that applies to the chosen mode is shown (toggled in place, no rebuild).
				const syncMode = () => { intervalRow.hidden = scheduleMode.value !== 'interval'; dailyRow.hidden = scheduleMode.value !== 'daily'; };
				scheduleMode.addEventListener('change', syncMode);
				syncMode();

				const maxUpdatesPerRun = number(s.maxUpdatesPerRun, t('maxUpdatesPerRun'));
				rows.push(row(t('maxUpdatesPerRun'), t('maxUpdatesHint'), maxUpdatesPerRun));

				const allowPrerelease = toggle(s.allowPrerelease, t('allowPrerelease'));
				rows.push(row(t('allowPrerelease'), '', allowPrerelease.wrap));

				const skipPackages = el('textarea', 'dau-input');
				skipPackages.value = (s.skipPackages || []).filter((n) => n !== 'dsh-ever-autoupdater').join('\n');
				skipPackages.setAttribute('aria-label', t('skipPackages'));
				rows.push(row(t('skipPackages'), t('skipPackagesHint'), skipPackages, 'dau-row-stack'));

				const actions = el('div', 'dau-actions');
				actions.appendChild(button(t('save'), async () => {
					const change = {
						autoApply: autoApply.input.checked,
						scheduleMode: scheduleMode.value,
						intervalHours: Number(intervalHours.value),
						dailyTime: dailyTime.value.trim(),
						maxUpdatesPerRun: Number(maxUpdatesPerRun.value),
						allowPrerelease: allowPrerelease.input.checked,
						skipPackages: skipPackages.value.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
					};
					if (busy) return;
					setBusy(true);
					try {
						await postJson('settings', change);
						say(t('saved'));
						editing = false;
						await refresh();
					} catch (error) {
						say(error && error.message ? error.message : String(error), true);
					} finally {
						setBusy(false);
					}
				}, 'dau-btn-primary'));
				return section(t('settings'), rows, actions);
			}

			function historySection(d) {
				const run = d.lastRun;
				const rows = [];
				if (!run) {
					rows.push(row(t('never')));
				} else {
					const arrow = (i) => i.name + ' ' + (i.from || '?') + ' → ' + (i.to || '?');
					const groups = [
						[t('applied'), run.applied || [], (i) => arrow(i) + (i.restartRequired ? '（' + t('restart') + '）' : ''), 'dau-good'],
						[t('failed'), run.failed || [], (i) => arrow(i) + '：' + i.error, 'dau-bad'],
						[t('rolledBack'), run.rolledBack || [], (i) => i.name + (i.ok === false && i.error ? '：' + i.error : ''), 'dau-warn'],
						[t('deferred'), run.deferred || [], (i) => i.name + '：' + i.reason, ''],
						[t('skipped'), run.skipped || [], (i) => i.name + '：' + i.reason, ''],
					];
					for (const [title, items, format, cls] of groups) {
						if (items.length === 0) continue;
						rows.push(row(title + '（' + items.length + '）', items.map((item) => ({ text: format(item), cls }))));
					}
					if (rows.length === 0) rows.push(row(t('nothing')));
				}
				const failedNames = Object.keys(d.failedVersions || {});
				if (failedNames.length > 0) {
					rows.push(row(t('failedMemory'), failedNames.map((name) => name + ' ' + d.failedVersions[name].target), button(t('clear'), async () => {
						const result = await act({ action: 'clearFailed' }, FETCH_TIMEOUT_MS);
						if (result) await refresh();
					})));
				}
				for (const name of Object.keys(d.skippedVersions || {})) {
					rows.push(row(t('skippedMemory'), name + ' ' + d.skippedVersions[name], button(t('unskip'), async () => {
						const result = await act({ action: 'unskip', name }, FETCH_TIMEOUT_MS);
						if (result) await refresh();
					})));
				}
				return section(t('history'), rows);
			}

			/** Per-block signatures: a poll that finds nothing new touches no DOM at all. */
			function update(d) {
				const lang = document.documentElement.lang || '';
				const rows = statusRows(d);
				paint('status', JSON.stringify([lang, rows]), () => statusSection(rows));
				paint('pending', JSON.stringify([lang, d.pending]), () => pendingSection(d));
				if (!editing) paint('settings', JSON.stringify([lang, d.settings]), () => settingsSection(d));
				paint('history', JSON.stringify([lang, d.lastRun, d.failedVersions, d.skippedVersions]), () => historySection(d));
			}

			// Do not replace the settings form while the user is typing in it.
			hosts.settings.addEventListener('focusin', () => { editing = true; });
			hosts.settings.addEventListener('focusout', () => { editing = false; });

			void refresh();
			timer = setInterval(() => { if (!busy) void refresh(); }, POLL_MS);
			return () => {
				disposed = true;
				if (timer) clearInterval(timer);
				if (toastTimer) clearTimeout(toastTimer);
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
