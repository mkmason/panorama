import { PanelHandler } from 'util/module-helpers';
import { CustomizerPropertyType, registerHUDCustomizerComponent } from 'common/hud-customizer';
import {
	CAT_STATIC_TYPE,
	CATAAS_MAX_SIZE,
	CatInfo,
	GifMethod,
	catImageUrl,
	cataasGet,
	createGifPlayer,
	gifFrameSize,
	probeGifFrames
} from 'common/cataas';

/**
 * Cat
 * ===
 * A pure-Panorama HUD element (no C++ panel type, same Frame pattern as Jokes / Affirmations) showing a random cat
 * from cataas.com: a still JPEG/PNG, or an animated GIF played from a frame strip (see common/cataas.ts for why GIFs
 * need that). A new cat loads every N seconds (0 = keep the current one) or from the "New Cat" button in its settings.
 * The new cat is drawn over the old one, which is removed once the new one has loaded, so there's no blank gap.
 *
 * Customizer options: type (GIF / still), GIF playback method, filter, change interval, GIF frame time, background
 * colour, and a drag-resizable size (GIF frames are requested at the element's aspect, up to its size).
 *
 * NOTE: cataas.com must be in domain_whitelist.kv3 (startup-only allowlist, a full game RESTART applies it).
 */

const DEFAULT_INTERVAL = 30; // s between cats
const DEFAULT_FRAME_TIME_MS = 80;
const TICK = 1; // s: how often the loop checks whether a new cat is due
const LOAD_TIMEOUT = 20; // s to wait for a cat image before giving up on it
const FALLBACK_SIZE = { w: 240, h: 160 }; // when the element hasn't been laid out yet
// Console timing logs for each cat load (prefix [CatHud +ms]): API call, GIF frame probe, strip / image load.
const CAT_HUD_DEBUG = false;

type CatKind = 'gif' | 'still';

@PanelHandler()
class CatHudHandler {
	readonly panels = {
		root: $<Panel>('#CatHud')!,
		view: $<Panel>('#CatHudView')!,
		status: $<Label>('#CatHudStatus')!,
		probeHost: $<Panel>('#CatHudProbeHost')!
	};

	// Settings (set by the customizer callbackFuncs, on init and on change)
	private kind: CatKind = 'gif';
	private method: GifMethod = 'step';
	private filter = '';
	private intervalSeconds = DEFAULT_INTERVAL;
	private frameTimeMs = DEFAULT_FRAME_TIME_MS;

	private inFlight = false; // a cat is loading - don't start another
	private hasCat = false;
	private lastLoad = 0; // Date.now() of the last load start
	private wantNewCat = true; // load a new cat on the next tick, regardless of the interval
	private catCount: number | null = null; // total cats (/api/count), for a random page offset
	private gifs: CatInfo[] | null = null; // the gif-tagged cats (one page of up to 100), fetched once
	private loadT0 = 0; // Date.now() when the current load started (CAT_HUD_DEBUG)

	constructor() {
		this.setStatus('Loading cat…');

		registerHUDCustomizerComponent(this.panels.root, {
			name: 'Cat',
			resizeX: true,
			resizeY: true,
			dynamicStyles: {
				newCat: {
					name: 'New Cat',
					type: CustomizerPropertyType.NONE,
					render: (row: Panel) => this.renderNewCatButton(row)
				},
				kind: {
					name: 'Type',
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{ label: 'Animated GIF', value: 'gif' },
						{ label: 'Still image', value: 'still' }
					],
					callbackFunc: (_panel, value) => (this.kind = value === 'still' ? 'still' : 'gif'),
					onChanged: () => this.requestNewCat()
				},
				gifMethod: {
					name: 'GIF Playback',
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{ label: 'Stepped strip', value: 'step' },
						{ label: 'AnimatedImageStrip', value: 'strip' }
					],
					callbackFunc: (_panel, value) => (this.method = value === 'strip' ? 'strip' : 'step'),
					onChanged: () => this.requestNewCat()
				},
				filter: {
					name: 'Filter',
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{ label: 'None', value: 'none' },
						{ label: 'Mono', value: 'mono' },
						{ label: 'Negate', value: 'negate' },
						{ label: 'Blur', value: 'blur' }
					],
					callbackFunc: (_panel, value) => (this.filter = value === 'none' ? '' : (value ?? '')),
					onChanged: () => this.requestNewCat()
				},
				// Not CSS properties: drive the JS fields. min 0 keeps multi-digit entry usable (NumberEntry clamps
				// to min per keystroke).
				intervalSeconds: {
					name: 'New Cat Every (s, 0 = never)',
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_panel, value) =>
						(this.intervalSeconds = Math.max(0, Math.round((value as number) ?? DEFAULT_INTERVAL))),
					settingProps: { min: 0, max: 3600, increment: 5 }
				},
				frameTimeMs: {
					name: 'GIF Frame Time (ms)',
					tooltip: 'Time per GIF frame. AnimatedImageStrip playback picks a change up from the next cat.',
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_panel, value) =>
						(this.frameTimeMs = Math.max(10, Math.round((value as number) ?? DEFAULT_FRAME_TIME_MS))),
					settingProps: { min: 10, max: 1000, increment: 10 }
				},
				// No targetPanel -> applies to the registered root (#CatHud) itself.
				backgroundColor: {
					name: 'Background Color',
					type: CustomizerPropertyType.COLOR_PICKER,
					styleProperty: 'backgroundColor'
				}
			}
		});

		this.loop();
	}

	/** The "New Cat" settings row: a button that loads another cat now. */
	private renderNewCatButton(row: Panel) {
		const btn = $.CreatePanel('Button', row, 'CatHudNewCat', {
			class: 'button hud-customizer-settings__button px-2 py-1'
		});
		btn.style.horizontalAlign = 'right';
		btn.SetPanelEvent('onactivate', () => this.requestNewCat());
		$.CreatePanel('Label', btn, '', { class: 'button__text', text: 'New Cat' });
	}

	/** Load a new cat as soon as possible (now if nothing is loading, else on the tick after). */
	private requestNewCat() {
		this.wantNewCat = true;
		if (this.panels.root.enabled && !this.inFlight) void this.loadCat();
	}

	/**
	 * Self-scheduled check (a plain HUD panel gets no think event): while the element is enabled, load a cat when none
	 * is shown, when one was requested, or when the interval has passed. Never fetches while the element is off.
	 */
	private loop(): void {
		if (!this.panels.root?.IsValid()) return;
		if (this.panels.root.enabled && !this.inFlight) {
			const due =
				this.wantNewCat ||
				!this.hasCat ||
				(this.intervalSeconds > 0 && Date.now() - this.lastLoad >= this.intervalSeconds * 1000);
			if (due) void this.loadCat();
		}
		$.Schedule(TICK, () => this.loop());
	}

	/** CAT_HUD_DEBUG log, in ms since the current load started. */
	private log(msg: string) {
		if (CAT_HUD_DEBUG) $.Msg(`[CatHud +${Date.now() - this.loadT0}ms] ${msg}`);
	}

	private async loadCat() {
		this.inFlight = true;
		this.wantNewCat = false;
		this.lastLoad = Date.now();
		this.loadT0 = Date.now();
		this.log(`--- loading a ${this.kind} cat (playback ${this.method}, filter ${this.filter || 'none'})`);
		try {
			const cat = await this.pickCat();
			const { w, h } = this.viewSize();
			this.log(`picked ${cat.id} (${cat.mimetype}); element ${w}x${h}`);
			if (this.kind === 'gif') {
				const frames = await probeGifFrames(this.panels.probeHost, cat.id, 'cathud__probe', (m) => this.log(m));
				// Frames at the element's aspect, up to its size; JPEG strips (much smaller than PNG)
				const size = gifFrameSize(frames, w / h, w, h);
				const url = catImageUrl(cat.id, { format: 'jpeg', filter: this.filter, width: size.w, height: size.h });
				const method = this.method;
				this.log(`strip: ${frames} frames of ${size.w}x${size.h} ${url}`);
				await this.show(
					(parent, onLoaded, onFail) =>
						createGifPlayer(parent, url, frames, method, {
							frameTime: () => this.frameTimeMs / 1000,
							onLoaded,
							onFail,
							log: (m) => this.log(m)
						}),
					'strip'
				);
			} else {
				const url = catImageUrl(cat.id, { filter: this.filter, width: Math.min(CATAAS_MAX_SIZE, w) });
				await this.show((parent, onLoaded, onFail) => {
					const img = $.CreatePanel('Image', parent, '', {
						class: 'cathud__img',
						scaling: 'stretch-to-cover-preserve-aspect'
					});
					img.hittest = false;
					$.RegisterEventHandler('PanelLoaded', img, onLoaded);
					$.RegisterEventHandler('ImageFailedLoad', img, () => onFail('image failed to load'));
					img.SetImage(url);
					return img;
				}, 'still image');
			}
			this.hasCat = true;
			this.setStatus('');
			this.log('shown');
		} catch (e) {
			// Keep showing the previous cat if there is one; otherwise say why there's nothing
			if (!this.hasCat) this.setStatus('No cat - is cataas.com reachable?');
			$.Msg(`[CatHud] loading a cat failed after ${Date.now() - this.loadT0}ms: ${String(e)}`);
		} finally {
			this.inFlight = false;
		}
	}

	/** A random cat of the chosen type from cataas.com. */
	private async pickCat(): Promise<CatInfo> {
		let pool: CatInfo[];
		if (this.kind === 'gif') {
			// /api/count has no tag filter, so take the first page of gif-tagged cats once and sample from it
			this.gifs ??= await cataasGet<CatInfo[]>('/api/cats?tags=gif&limit=100');
			pool = (this.gifs ?? []).filter((c) => c?.mimetype === 'image/gif');
		} else {
			this.catCount ??= Number((await cataasGet<{ count: number }>('/api/count'))?.count) || 0;
			const skip = Math.floor(Math.random() * Math.max(0, this.catCount - 50));
			const page = await cataasGet<CatInfo[]>(`/api/cats?limit=50&skip=${skip}`);
			// Still JPEG/PNG cats only: a GIF here would be a full-size frame strip
			pool = (page ?? []).filter((c) => CAT_STATIC_TYPE.test(c?.mimetype ?? ''));
		}
		pool = pool.filter((c) => typeof c?.id === 'string');
		if (pool.length === 0) throw new Error('no cats returned');
		return pool[Math.floor(Math.random() * pool.length)];
	}

	/**
	 * Add a new cat panel (built by `make`) on top of the current one; once it has loaded, remove the old one(s). If it
	 * fails or takes longer than LOAD_TIMEOUT, remove it instead and keep the old cat.
	 */
	private show(
		make: (parent: GenericPanel, onLoaded: () => void, onFail: (why: string) => void) => GenericPanel,
		what: string
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let panel: GenericPanel | null = null;
			const onLoaded = () => {
				if (settled) return;
				settled = true;
				for (const child of this.panels.view.Children()) if (child !== panel) child.DeleteAsync(0);
				resolve();
			};
			const onFail = (why: string) => {
				if (settled) return;
				settled = true;
				if (panel?.IsValid()) panel.DeleteAsync(0);
				reject(why);
			};
			panel = make(this.panels.view, onLoaded, onFail);
			$.Schedule(LOAD_TIMEOUT, () => onFail(`${what} timed out after ${LOAD_TIMEOUT}s`));
		});
	}

	/** The element's size in layout px (fallback before it has been laid out). */
	private viewSize(): { w: number; h: number } {
		const root = this.panels.root;
		const w = Math.round(root.actuallayoutwidth / (root.actualuiscale_x || 1));
		const h = Math.round(root.actuallayoutheight / (root.actualuiscale_y || 1));
		return w > 0 && h > 0 ? { w, h } : FALLBACK_SIZE;
	}

	private setStatus(msg: string) {
		this.panels.status.text = msg;
		this.panels.status.SetHasClass('cathud__status--hidden', !msg);
	}
}
