import { PanelHandler } from 'util/module-helpers';
import { CustomizerPropertyType, registerHUDCustomizerComponent, getTextShadowFast } from 'common/hud-customizer';
import { parseLeadingJson } from 'common/parse-leading-json';

/**
 * Advice
 * ======
 * A pure-Panorama HUD element (NO new C++ panel type - see PANORAMA_NOTES 4 / 6g). It fetches a random slip of
 * advice from https://api.adviceslip.com/advice on a timer and posts it into a plain text HUD label. Same
 * pattern as the Affirmations element (6m) - see that file for the fetch-loop rationale.
 *
 * Customizer options: the update INTERVAL (the "time" customization, default 10s), the TEXT COLOR and the
 * background color, plus font size and a drag-resizable width (long advice wraps within it).
 *
 * NOTE 1: api.adviceslip.com must be in domain_whitelist.kv3 (startup-only allowlist - a full game RESTART is
 * needed to apply it) or $.AsyncWebRequest throws synchronously. It's been added there.
 * NOTE 2: the API caches per-IP for ~2s, so identical back-to-back calls repeat the same slip. We append a
 * cache-buster query (?t=<now>) each fetch to force a fresh one.
 */

// Seconds between advice fetches by default (customizer-controlled via `intervalSeconds`).
const DEFAULT_INTERVAL = 10;

// Returns `{ slip: { id, advice } }`. `?t=` cache-buster defeats the API's ~2s per-IP response cache.
const ADVICE_URL = 'https://api.adviceslip.com/advice';

@PanelHandler()
class AdviceHandler {
	readonly panels = {
		root: $<Panel>('#Advice')!,
		text: $<Label>('#AdviceText')!
	};

	private intervalSeconds = DEFAULT_INTERVAL; // updated by the customizer callbackFunc
	private fetchGen = 0; // guards against overlapping loops when the interval is re-armed
	private inFlight = false; // a request is outstanding - don't stack another

	constructor() {
		// Set the dialog variable up front so the label never shows the raw "{s:advice}" token before the first
		// fetch lands (an unset dialog var reads back as the bare token - PANORAMA_NOTES 6l).
		this.panels.root.SetDialogVariable('advice', '');

		registerHUDCustomizerComponent(this.panels.root, {
			name: 'Advice',
			resizeX: true, // width drives text wrapping; height fits the wrapped text
			resizeY: false,
			dynamicStyles: {
				// The "time" customization: seconds between fetches. Not a CSS property, so drive the JS field via
				// callbackFunc (runs on init AND change) and re-arm the loop so a shortened interval takes effect
				// promptly. min:1 keeps multi-digit entry usable (NumberEntry clamps to min per keystroke - 4).
				intervalSeconds: {
					name: 'Update Interval (s)',
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_panel, value) => {
						this.intervalSeconds = Math.max(1, Math.round((value as number) ?? DEFAULT_INTERVAL));
						this.scheduleLoop(0); // re-arm now so the new interval applies immediately
					},
					settingProps: { min: 1, max: 3600, increment: 1 }
				},
				fontSize: {
					name: 'Font Size',
					type: CustomizerPropertyType.NUMBER_ENTRY,
					targetPanel: '.advice__text',
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`,
					settingProps: { min: 1, max: 200 }
				},
				// The "color" customization.
				fontColor: {
					name: 'Text Color',
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.advice__text',
					styleProperty: 'color',
					callbackFunc: (panel, value) =>
						(panel.style.textShadowFast = getTextShadowFast(value as rgbaColor, 0.9))
				},
				// No targetPanel -> applies to the registered root (#Advice) itself.
				backgroundColor: {
					name: 'Background Color',
					type: CustomizerPropertyType.COLOR_PICKER,
					styleProperty: 'backgroundColor'
				}
			}
		});

		// Start the fetch loop. This supersedes the init-time scheduleLoop(0) fired by the interval callbackFunc
		// (the higher fetchGen wins), so exactly one loop runs.
		this.scheduleLoop(0);
	}

	/** Arm the next loop tick, cancelling any previously-scheduled one via the generation guard. */
	private scheduleLoop(delaySeconds: number): void {
		const gen = ++this.fetchGen;
		$.Schedule(delaySeconds, () => {
			if (gen === this.fetchGen) this.loop();
		});
	}

	/** One tick: fetch if the component is enabled, then reschedule at the current interval. */
	private loop(): void {
		if (!this.panels.root?.IsValid()) return;
		// The customizer toggles a component on/off via panel.enabled (customizer.ts). While it's off the element
		// is hidden, so skip the web request entirely - no point hitting an external service for a hidden panel.
		// It comes alive on the next tick after the user enables it.
		if (this.panels.root.enabled && !this.inFlight) this.fetch();
		this.scheduleLoop(Math.max(1, this.intervalSeconds));
	}

	/** GET one slip of advice and post it into the label. */
	private fetch(): void {
		this.inFlight = true;
		try {
			// Cache-buster: the API returns a cached slip for ~2s per IP otherwise, so consecutive ticks repeat.
			$.AsyncWebRequest(`${ADVICE_URL}?t=${Date.now()}`, {
				type: 'GET',
				complete: (data) => {
					this.inFlight = false;
					if (data.statusText !== 'success') return;
					// Response is `{ slip: { id, advice } }` - the advice is NESTED under `slip`.
					const json = parseLeadingJson<{ slip?: { advice?: string } }>(data.responseText);
					const text = typeof json?.slip?.advice === 'string' ? json.slip.advice : null;
					if (text && this.panels.root?.IsValid()) this.panels.root.SetDialogVariable('advice', text);
				}
			});
		} catch {
			// AsyncWebRequest throws SYNCHRONOUSLY when the host isn't whitelisted (the allowlist is read only at
			// startup, so it won't work until a full restart after adding the domain). Fail quietly, retry next tick.
			this.inFlight = false;
		}
	}
}
