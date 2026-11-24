import { Gamemode } from 'common/web/enums/gamemode.enum';
import { Style, styleEnglishName } from 'common/web/enums/style.enum';
import { GamemodeInfo } from 'common/gamemode';
import { getRankGroupEnds } from 'common/web/consts/rank-groups.const';

/**
 * Standalone version of the Stats page's leaderboard popup (top 10 + group cutoffs + where you place), for pages
 * that aren't the Stats page (the CS:S map selector). Always the local player and the CS:S look; no link to the
 * Stats rank cache. The host layout provides the markup (ids below, classes .statslb / .statslb--css from
 * styles/pages/css-stats.scss) and calls open() / close() / refresh().
 */

const API = 'https://api.momentum-mod.org';

const WR_COLOR = '#f2c14e';
const T10_COLOR = '#6fe0d0';
const GROUP_COLORS = ['#d8c26a', '#e0a86f', '#8fd694', '#7fb0e0', '#9aa3af', '#6f7885'];
const LAST_COLOR = '#c56b6b';

// Text colours on the grey CS:S list
const C_TEXT = '#ecece3';
const C_DIM = '#c2c2b5';
const C_MUTED = '#b4b3aa';
const C_DIFF = '#f3c98a';
const C_AHEAD = '#ffb0a6';
const C_BEHIND = '#c6f5b0';

const W_BADGE = 56;
const W_RANK = 48;
const W_TIME = 104;
const W_DIFF = 88;
const W_YOU = 88;

interface Row {
	rank: number;
	time: number;
	userID: number;
	alias: string;
	steamID: string | null;
}

interface Cutoff {
	group: number; // 1..6, 0 = the board's last place
	rank: number;
	row: Row | null;
	fetched: boolean;
}

interface Board {
	rows: Row[];
	total: number;
	cutoffs: Cutoff[];
}

interface Standing {
	rank: number | null;
	time: number | null;
}

export class MapLeaderboardPopup {
	private gen = 0;
	private cache: Record<string, Board> = {};
	private standingCache: Record<string, Standing> = {};
	private cutoffRefs: { rank: number; panel: Panel }[] = [];
	private current: { mapID: number; gm: Gamemode; style: Style; name: string; images: string[] } | null = null;

	/** `prefix` is the id prefix of the host layout's popup elements: <prefix>Popup, Title, Subtitle, Status,
	 *  List, Images. */
	private readonly prefix: string;

	constructor(prefix: string) {
		this.prefix = prefix;
	}

	private el<T extends GenericPanel = Panel>(name: string): T | null {
		return $<T>(`#${this.prefix}${name}`);
	}

	async open(mapID: number, gm: Gamemode, style: Style, name: string, images: string[], force = false) {
		const popup = this.el('Popup');
		if (!popup) return;
		const gen = ++this.gen;
		this.current = { mapID, gm, style, name, images };

		try {
			popup.style.visibility = 'visible';
		} catch {}
		const title = this.el<Label>('Title');
		if (title) title.text = name;
		const sub = this.el<Label>('Subtitle');
		if (sub) {
			const gmName = $.Localize(GamemodeInfo.get(gm)?.i18n ?? '') || `Mode ${gm}`;
			sub.text = `${gmName} - ${styleEnglishName(style)} - Top 10 and group cutoffs`;
		}
		this.renderImages(images);
		this.el('List')?.RemoveAndDeleteChildren();
		this.cutoffRefs = [];

		const key = `${mapID}|${gm}|${style}`;
		if (force) {
			delete this.cache[key];
			delete this.standingCache[key];
		}
		let board = this.cache[key];
		let standing: Standing;
		if (board) {
			standing = await this.getStanding(mapID, gm, style, key);
		} else {
			this.setStatus(force ? 'Refreshing leaderboard...' : 'Loading leaderboard...');
			const [top, st] = await Promise.all([this.fetchTop(mapID, gm, style), this.getStanding(mapID, gm, style, key)]);
			if (gen !== this.gen) return;
			if (top == null) {
				this.setStatus('Could not load the leaderboard. Try again.');
				return;
			}
			const cutoffs: Cutoff[] = this.groupCutoffs(top.total).map((c) => ({ ...c, row: null, fetched: false }));
			if (top.total > 10 && !cutoffs.some((c) => c.rank === top.total))
				cutoffs.push({ group: 0, rank: top.total, row: null, fetched: false });
			board = { rows: top.rows, total: top.total, cutoffs };
			this.cache[key] = board;
			standing = st;
		}
		if (gen !== this.gen) return;

		if (board.rows.length === 0) {
			this.setStatus('No times on this leaderboard yet.');
			return;
		}
		this.setStatus('');
		this.render(board, standing);
		void this.fetchCutoffs(board, mapID, gm, style, gen, standing.time);
	}

	refresh() {
		const c = this.current;
		if (c) void this.open(c.mapID, c.gm, c.style, c.name, c.images, true);
	}

	close() {
		this.gen++;
		this.current = null;
		const popup = this.el('Popup');
		try {
			if (popup) popup.style.visibility = 'collapse';
		} catch {}
		this.el('Images')?.RemoveAndDeleteChildren();
	}

	isOpen(): boolean {
		return this.current != null;
	}

	//#region data

	private webGet(url: string): Promise<string> {
		return new Promise((resolve, reject) => {
			$.AsyncWebRequest(url, {
				type: 'GET',
				complete: (d) => (d.statusText === 'success' ? resolve(d.responseText) : reject(d.statusText))
			});
		});
	}

	private sleep(sec: number): Promise<void> {
		return new Promise((res) => $.Schedule(sec, () => res()));
	}

	/** GET + parse with a few jittered retries (the API throttles bursts). */
	private async fetchJson(url: string, tries = 6): Promise<any> {
		for (let i = 0; i < tries; i++) {
			try {
				return this.parseLeadingJson(await this.webGet(url));
			} catch {
				if (i < tries - 1) await this.sleep(0.3 * (i + 1) + Math.random() * 0.4);
			}
		}
		return null;
	}

	/** AsyncWebRequest appends a stray NUL after the body, which trips JSON.parse: parse the leading value only. */
	private parseLeadingJson(txt: string): any {
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		// Index loop on purpose: `end` slices by UTF-16 index, which a code-point iteration (emoji aliases) would skew
		// eslint-disable-next-line unicorn/no-for-loop
		for (let i = 0; i < txt.length; i++) {
			const c = txt[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === '\\') esc = true;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === '{' || c === '[') depth++;
			else if (c === '}' || c === ']') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		return JSON.parse(end >= 0 ? txt.slice(0, end + 1) : txt);
	}

	private boardUrl(mapID: number, gm: Gamemode, style: Style): string {
		return `${API}/v1/maps/${mapID}/leaderboard?gamemode=${gm}&trackType=0&trackNum=1&style=${style}`;
	}

	private rowFrom(e: any): Row {
		return {
			rank: e.rank,
			time: e.time,
			userID: e.userID,
			alias: e.user?.alias ?? `Player ${e.userID}`,
			steamID: e.user?.steamID ?? null
		};
	}

	private async fetchTop(mapID: number, gm: Gamemode, style: Style): Promise<{ rows: Row[]; total: number } | null> {
		const j = await this.fetchJson(`${this.boardUrl(mapID, gm, style)}&take=10`);
		if (j == null || !Array.isArray(j.data)) return null;
		return { rows: j.data.map((e: any) => this.rowFrom(e)), total: j.totalCount || 0 };
	}

	private async fetchAtRank(mapID: number, gm: Gamemode, style: Style, rank: number): Promise<Row | null> {
		const j = await this.fetchJson(`${this.boardUrl(mapID, gm, style)}&skip=${rank - 1}&take=1`);
		if (j == null || !Array.isArray(j.data) || !j.data[0]) return null;
		return this.rowFrom(j.data[0]);
	}

	private localUser(): { id: number; alias: string; steamID: string | null } {
		try {
			const u = MomentumAPI.GetLocalUserData();
			return { id: Number(u.id) || 0, alias: u.alias ?? 'You', steamID: u.steamID ?? null };
		} catch {
			return { id: 0, alias: 'You', steamID: null };
		}
	}

	private async getStanding(mapID: number, gm: Gamemode, style: Style, key: string): Promise<Standing> {
		const cached = this.standingCache[key];
		if (cached) return cached;
		const uid = this.localUser().id;
		if (!uid) return { rank: null, time: null };
		const j = await this.fetchJson(`${this.boardUrl(mapID, gm, style)}&userIDs=${uid}`);
		if (j == null) return { rank: null, time: null }; // failed: don't cache, retry next open
		const e = j.data && j.data[0] ? j.data[0] : null;
		const standing = { rank: e ? e.rank : null, time: e ? e.time : null };
		this.standingCache[key] = standing;
		return standing;
	}

	/** Rank of the last person in each group G1..G6 (below the Top 10; empty groups skipped). */
	private groupCutoffs(total: number): { group: number; rank: number }[] {
		const out: { group: number; rank: number }[] = [];
		let prev = 10;
		getRankGroupEnds(total).forEach((end, i) => {
			if (end > prev) {
				out.push({ group: i + 1, rank: end });
				prev = end;
			}
		});
		return out;
	}

	private groupOf(rank: number, total: number): number {
		const ends = getRankGroupEnds(total);
		for (let i = 0; i < ends.length; i++) if (rank <= ends[i]) return i + 1;
		return 0;
	}

	private async fetchCutoffs(board: Board, mapID: number, gm: Gamemode, style: Style, gen: number, you: number | null) {
		const wr = board.rows[0]?.time ?? null;
		const me = this.localUser().id;
		await Promise.all(
			board.cutoffs
				.filter((c) => !c.fetched)
				.map(async (c) => {
					const row = await this.fetchAtRank(mapID, gm, style, c.rank);
					if (gen !== this.gen) return;
					c.row = row;
					c.fetched = true;
					const ref = this.cutoffRefs.find((r) => r.rank === c.rank);
					if (ref?.panel.IsValid()) {
						const b = this.cutoffBadge(c.group);
						this.fillRow(ref.panel, b.badge, b.color, c.rank, row, wr, me, '-', you);
					}
				})
		);
	}

	//#endregion
	//#region rendering

	private setStatus(msg: string) {
		const s = this.el<Label>('Status');
		if (!s) return;
		s.text = msg;
		try {
			s.style.visibility = msg ? 'visible' : 'collapse';
		} catch {}
	}

	private renderImages(images: string[]) {
		const holder = this.el('Images');
		if (!holder) return;
		holder.RemoveAndDeleteChildren();
		try {
			holder.style.visibility = images.length > 0 ? 'visible' : 'collapse';
		} catch {}
		for (const url of images) {
			const image = $.CreatePanel('Image', holder, '', {
				style:
					'width: 240px; height: 135px; margin-bottom: 8px; horizontal-align: center; ' +
					'background-color: #00000040; border: 1px solid #00000073;'
			});
			(image as unknown as { SetImage(url: string): void }).SetImage(url);
		}
	}

	private cutoffBadge(group: number): { badge: string; color: string } {
		return group === 0 ? { badge: 'LAST', color: LAST_COLOR } : { badge: `G${group}`, color: GROUP_COLORS[group - 1] };
	}

	private fmtTime(t: number): string {
		if (t == null || !isFinite(t)) return '-';
		const m = Math.floor(t / 60);
		const s = (t - m * 60).toFixed(3).padStart(6, '0');
		return m > 0 ? `${m}:${s}` : s;
	}

	private fmtDiff(t: number): string {
		if (t < 60) return t.toFixed(3);
		const m = Math.floor(t / 60);
		return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
	}

	private rowStyle(): string {
		return 'flow-children: right; width: 100%; padding: 5px 10px; text-shadow: 0px 1px 0px #00000066;';
	}

	private render(board: Board, standing: Standing) {
		const list = this.el('List');
		if (!list) return;
		list.RemoveAndDeleteChildren();
		this.cutoffRefs = [];

		const me = this.localUser();
		const you = standing.time;
		const wr = board.rows[0]?.time ?? null;

		const head = $.CreatePanel('Panel', list, '', { style: 'flow-children: right; width: 100%; padding: 2px 10px 6px 10px;' });
		const hcol = (text: string, w: number | null, align = 'right') =>
			$.CreatePanel('Label', head, '', {
				text,
				style: `width: ${w == null ? 'fill-parent-flow(1)' : `${w}px`}; font-size: 12px; color: ${C_DIM}; text-align: ${align}; vertical-align: center;`
			});
		hcol('', W_BADGE, 'center');
		hcol('#', W_RANK, 'center');
		$.CreatePanel('Panel', head, '', { style: 'width: 40px; height: 1px;' });
		hcol('Player', null, 'left');
		hcol('Time', W_TIME);
		hcol('+ WR', W_DIFF);
		hcol('vs You', W_YOU);

		for (const r of board.rows) {
			const rp = $.CreatePanel('Panel', list, '', { style: this.rowStyle() });
			this.fillRow(rp, r.rank === 1 ? 'WR' : 'T10', r.rank === 1 ? WR_COLOR : T10_COLOR, r.rank, r, wr, me.id, '-', you);
		}

		const yr = standing.rank;
		const showYou = yr != null && you != null && yr > 10 && !board.cutoffs.some((c) => c.rank === yr);
		if (board.cutoffs.length === 0 && !showYou) return;

		$.CreatePanel('Label', list, '', {
			text: 'Group cutoffs - last place - where you place',
			style:
				`font-size: 12px; color: ${C_DIM}; text-transform: uppercase; letter-spacing: 1px; ` +
				'margin: 12px 10px 6px 10px; padding-top: 10px; border-top: 1px solid #00000073;'
		});

		const slots: { rank: number; cutoff?: Cutoff; you?: boolean }[] = board.cutoffs.map((c) => ({
			rank: c.rank,
			cutoff: c
		}));
		if (showYou) slots.push({ rank: yr as number, you: true });
		slots.sort((a, b) => a.rank - b.rank);

		for (const s of slots) {
			const rp = $.CreatePanel('Panel', list, '', { style: this.rowStyle() });
			if (s.you) {
				const g = this.groupOf(s.rank, board.total);
				const row: Row = { rank: s.rank, time: you as number, userID: me.id, alias: me.alias, steamID: me.steamID };
				this.fillRow(rp, g >= 1 ? `G${g}` : '-', g >= 1 ? GROUP_COLORS[g - 1] : C_MUTED, s.rank, row, wr, me.id, '-', you);
			} else {
				const c = s.cutoff as Cutoff;
				const b = this.cutoffBadge(c.group);
				this.fillRow(rp, b.badge, b.color, c.rank, c.row, wr, me.id, c.fetched ? '-' : '...', you);
				this.cutoffRefs.push({ rank: c.rank, panel: rp });
			}
		}
	}

	private fillRow(
		rp: Panel,
		badge: string,
		badgeColor: string,
		rank: number,
		row: Row | null,
		wr: number | null,
		meId: number,
		ph: string,
		you: number | null
	) {
		if (!rp?.IsValid()) return;
		rp.RemoveAndDeleteChildren();
		const mine = row != null && row.userID === meId;
		try {
			rp.style.backgroundColor = mine ? '#00000059' : rank % 2 === 0 ? '#0000001a' : '#00000000';
		} catch {}

		if (row) rp.SetPanelEvent('oncontextmenu', () => this.contextMenu(row));
		else rp.ClearPanelEvent('oncontextmenu');

		const label = (text: string, style: string) => $.CreatePanel('Label', rp, '', { text, style });
		label(badge, `width: ${W_BADGE}px; font-size: 12px; font-weight: bold; color: ${badgeColor}; text-align: center; vertical-align: center;`);
		label(
			`#${rank}`,
			`width: ${W_RANK}px; font-size: 14px; font-weight: bold; color: ${rank === 1 ? WR_COLOR : C_TEXT}; text-align: center; vertical-align: center;`
		);

		if (row?.steamID) {
			const av = $.CreatePanel('AvatarImage', rp, '', {
				style: 'width: 26px; height: 26px; margin-right: 14px; vertical-align: center;'
			});
			try {
				av.steamid = row.steamID as steamID;
			} catch {}
		} else {
			$.CreatePanel('Panel', rp, '', {
				style: 'width: 26px; height: 26px; margin-right: 14px; vertical-align: center; background-color: #0000004d;'
			});
		}

		label(
			row ? row.alias : ph,
			`width: fill-parent-flow(1); font-size: 14px; color: ${mine ? '#ffffff' : row ? C_TEXT : C_MUTED}; vertical-align: center; text-overflow: ellipsis;`
		);
		label(row ? this.fmtTime(row.time) : ph, `width: ${W_TIME}px; font-size: 14px; color: ${row ? C_TEXT : C_MUTED}; text-align: right; vertical-align: center;`);
		const wrDiff = row == null ? '' : rank === 1 || wr == null ? '-' : `+${this.fmtDiff(Math.max(0, row.time - wr))}`;
		label(wrDiff, `width: ${W_DIFF}px; font-size: 13px; color: ${rank === 1 ? C_MUTED : C_DIFF}; text-align: right; vertical-align: center;`);

		let youText = '';
		let youColor = C_MUTED;
		if (row != null && you != null) {
			if (mine) {
				youText = '-';
			} else {
				const delta = row.time - you;
				youText = (delta < 0 ? '-' : '+') + this.fmtDiff(Math.abs(delta));
				youColor = delta < 0 ? C_AHEAD : delta > 0 ? C_BEHIND : C_DIM;
			}
		}
		label(youText, `width: ${W_YOU}px; font-size: 13px; color: ${youColor}; text-align: right; vertical-align: center;`);
	}

	/** Right-click a run: the map on the website, or the player's Steam profile. */
	private contextMenu(row: Row) {
		const items: UiToolkitAPI.SimpleContextMenuItem[] = [];
		const frontend = GameInterfaceAPI.GetSettingString('mom_api_url_frontend');
		if (frontend && this.current) {
			const name = this.current.name;
			items.push({
				label: 'View map on Momentum',
				icon: 'file://{images}/movie-open-outline.svg',
				style: 'icon-color-white',
				jsCallback: () => SteamOverlayAPI.OpenURL(`${frontend}/maps/${name}`)
			});
		}
		if (row.steamID) {
			items.push({
				label: $.Localize('#Action_ShowSteamProfile') || 'Show Steam Profile',
				icon: 'file://{images}/social/steam.svg',
				style: 'icon-color-steam-online',
				jsCallback: () => SteamOverlayAPI.OpenToProfileID(row.steamID as steamID)
			});
		}
		if (items.length > 0) UiToolkitAPI.ShowSimpleContextMenu('', 'ControlsLibSimpleContextMenu', items);
	}

	//#endregion
}
