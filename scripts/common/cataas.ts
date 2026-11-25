import { parseLeadingJson } from 'common/parse-leading-json';

/**
 * cataas.com ("Cat as a service", https://cataas.com/doc.html) helpers, shared by the main menu's background selector
 * and the Cat HUD element. No auth; JSON from /api/*, images from /cat/{id}[/says/{text}] with optional ?format=
 * (png/jpeg), ?filter= / ?blur=, ?width= / ?height=. The JSON calls need `cataas.com` in domain_whitelist.kv3; image
 * display via SetImage isn't whitelist-gated.
 *
 * Panorama's Image can't decode GIF/WebP/AVIF from a URL. Asking cataas for a GIF as ?format=png|jpeg returns ONE image
 * with every frame stacked vertically (W x H*frames), and there is no single-frame option. Shown as-is that draws as
 * slices and a full-size strip (e.g. 350x15840) crashes the game. So:
 *  - Still cats are only the ones that are JPEG/PNG to begin with (CAT_STATIC_TYPE).
 *  - Animated GIF cats are requested as such a strip at a SMALL, explicit frame size (?width&height, so every frame is
 *    exactly that size) with the whole strip's height capped at GIF_MAX_STRIP, then played back one frame at a time
 *    (createGifPlayer). The frame count comes from a tiny probe: the same GIF at 10x10 per frame is 10 x 10*frames.
 *  - Strips load as JPEG by default: ~10x smaller than PNG (PNG strips of 1-4 MB took several seconds in-game).
 */

export const CATAAS = 'https://cataas.com';
export const CAT_STATIC_TYPE = /^image\/(jpeg|png)$/;
/** cataas rejects ?width / ?height above this */
export const CATAAS_MAX_SIZE = 1000;
/** px: cap on a whole frame strip's height (the crash was a ~16k px tall strip) */
export const GIF_MAX_STRIP = 8192;
/** s per frame by default (GIF frame delays aren't available) */
export const GIF_FRAME_TIME = 0.08;

/** 'step': move the strip inside a clipping panel. 'strip': Panorama's AnimatedImageStrip. */
export type GifMethod = 'step' | 'strip';

export interface CatInfo {
	id: string;
	mimetype: string;
}

export interface CatUrlOptions {
	/** Caption drawn on the image ("the cat says") */
	says?: string;
	/** 'png' | 'jpeg' conversion; empty = the original format */
	format?: string;
	/** 'mono' | 'negate' | 'blur'; empty = none */
	filter?: string;
	width?: number;
	/** With width, fixes every frame's size (needed for GIF strips) */
	height?: number;
}

/** Image URL for a cat. */
export function catImageUrl(id: string, opts: CatUrlOptions = {}): string {
	let url = `${CATAAS}/cat/${encodeURIComponent(id)}`;
	const params: string[] = [];
	const says = opts.says?.trim();
	if (says) {
		url += `/says/${encodeURIComponent(says)}`;
		params.push('fontSize=50', 'fontColor=white');
	}
	if (opts.format) params.push(`format=${opts.format}`);
	if (opts.filter === 'blur') params.push('blur=6');
	else if (opts.filter) params.push(`filter=${opts.filter}`);
	if (opts.width) params.push(`width=${Math.round(opts.width)}`);
	if (opts.height) params.push(`height=${Math.round(opts.height)}`);
	return params.length > 0 ? `${url}?${params.join('&')}` : url;
}

/** GET a cataas JSON endpoint (`/api/...` or a full URL). Rejects on a failed request or unparsable body. */
export function cataasGet<T = any>(pathOrUrl: string): Promise<T> {
	const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${CATAAS}${pathOrUrl}`;
	return new Promise((resolve, reject) => {
		try {
			$.AsyncWebRequest(url, {
				type: 'GET',
				complete: (d) => {
					if (d.statusText !== 'success') {
						reject(d.statusText);
						return;
					}
					const json = parseLeadingJson<T>(d.responseText);
					if (json == null) reject('bad JSON');
					else resolve(json);
				}
			});
		} catch (e) {
			// AsyncWebRequest throws synchronously when the host isn't whitelisted (needs a full game restart)
			reject(String(e));
		}
	});
}

/**
 * Frame size for a GIF strip: the largest size with the given aspect (w/h) that fits maxW x maxH, cataas's limit, and
 * keeps the whole strip (h * frames) within GIF_MAX_STRIP.
 */
export function gifFrameSize(frames: number, aspect: number, maxW: number, maxH: number): { w: number; h: number } {
	let h = Math.min(maxH, Math.floor(GIF_MAX_STRIP / Math.max(1, frames)), CATAAS_MAX_SIZE);
	let w = h * aspect;
	if (w > Math.min(maxW, CATAAS_MAX_SIZE)) {
		w = Math.min(maxW, CATAAS_MAX_SIZE);
		h = w / aspect;
	}
	return { w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)) };
}

/**
 * Frame count of a GIF cat: loads it as a strip of 10x10 frames (10 x 10*frames) into an invisible Image under `host`
 * and reads its size. `host` must not squish its children (overflow: noclip) and the probe must be unsized
 * (`probeClass` should give it width/height fit-children), so its laid-out size is the texture's.
 */
export function probeGifFrames(
	host: GenericPanel,
	id: string,
	probeClass: string,
	log?: (msg: string) => void
): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = $.CreatePanel('Image', host, '', { class: probeClass });
		let done = false;
		const start = Date.now();
		const finish = (frames: number | null, why = '') => {
			if (done) return;
			done = true;
			log?.(`probe: ${frames ? `${frames} frames` : `FAILED (${why})`} after ${Date.now() - start}ms`);
			if (probe.IsValid()) probe.DeleteAsync(0);
			if (frames) resolve(frames);
			else reject(why);
		};
		const read = (tries: number) => {
			if (done) return;
			if (!probe.IsValid()) return finish(null, 'probe removed');
			// Layout size of an unsized Image is its texture size; desired / content size as fallbacks (only the
			// ratio matters, so mixing scaled and unscaled sizes between attempts is fine)
			const w = probe.actuallayoutwidth || probe.desiredlayoutwidth || probe.contentwidth;
			const h = probe.actuallayoutheight || probe.desiredlayoutheight || probe.contentheight;
			if (w > 0 && h > 0) return finish(Math.max(1, Math.round(h / w)));
			if (tries <= 0) {
				const sizes = `actual ${probe.actuallayoutwidth}x${probe.actuallayoutheight}, desired ${probe.desiredlayoutwidth}x${probe.desiredlayoutheight}, content ${probe.contentwidth}x${probe.contentheight}`;
				return finish(null, `probe timed out (${sizes})`);
			}
			$.Schedule(0.1, () => read(tries - 1));
		};
		$.RegisterEventHandler('ImageFailedLoad', probe, () => finish(null, 'image failed to load'));
		$.RegisterEventHandler('PanelLoaded', probe, () => log?.(`probe: PanelLoaded after ${Date.now() - start}ms`));
		log?.('probe: requested');
		probe.SetImage(`${CATAAS}/cat/${encodeURIComponent(id)}?format=png&width=10&height=10`);
		read(150); // up to ~15 s
	});
}

export interface GifPlayerOptions {
	/** s per frame; a function is re-read every frame (stepped method), so a speed setting applies live */
	frameTime?: number | (() => number);
	onLoaded?: () => void;
	onFail?: (why: string) => void;
	log?: (msg: string) => void;
}

/**
 * Play a vertical frame strip (`frames` frames of equal size, stacked top to bottom) inside `parent`, filling it.
 * The returned panel has class `gifplayer` (styles/pages/main-menu.scss: fills its parent, clips).
 *  - 'step': a clipping panel holding the whole strip as an Image, moved up one frame height every frame time.
 *  - 'strip': Panorama's AnimatedImageStrip (built for horizontal strips of square frames; it handles vertical too).
 * Stops by itself once the panel is deleted.
 */
export function createGifPlayer(
	parent: GenericPanel,
	url: string,
	frames: number,
	method: GifMethod,
	opts: GifPlayerOptions = {}
): GenericPanel {
	const frameTime = () =>
		Math.max(0.01, (typeof opts.frameTime === 'function' ? opts.frameTime() : opts.frameTime) ?? GIF_FRAME_TIME);
	const start = Date.now();
	const watch = (panel: GenericPanel) => {
		opts.log?.(`strip requested (${method})`);
		$.RegisterEventHandler('PanelLoaded', panel, () => {
			opts.log?.(`strip PanelLoaded after ${Date.now() - start}ms`);
			opts.onLoaded?.();
		});
		$.RegisterEventHandler('ImageFailedLoad', panel, () => {
			opts.log?.(`strip FAILED after ${Date.now() - start}ms`);
			opts.onFail?.('strip failed to load');
		});
	};

	if (method === 'strip') {
		const strip = $.CreatePanel('AnimatedImageStrip', parent, '', {
			class: 'gifplayer',
			src: url,
			frametime: `${Math.round(frameTime() * 1000)}ms`,
			defaultframe: '0',
			animating: 'true',
			scaling: 'stretch'
		});
		strip.hittest = false;
		watch(strip);
		return strip;
	}

	const clip = $.CreatePanel('Panel', parent, '', { class: 'gifplayer' });
	clip.hittest = false;
	const img = $.CreatePanel('Image', clip, '', { class: 'gifplayer__strip', scaling: 'stretch' });
	img.hittest = false;
	watch(img);
	img.SetImage(url);
	let frame = 0;
	const tick = () => {
		if (!clip.IsValid()) return; // player removed: stop
		const h = clip.actuallayoutheight / (clip.actualuiscale_y || 1);
		if (h > 0) {
			img.style.height = `${h * frames}px`;
			img.style.position = `0px ${-frame * h}px 0px`;
			frame = (frame + 1) % frames;
		}
		$.Schedule(frameTime(), tick);
	};
	tick();
	return clip;
}
