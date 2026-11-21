import { PanelHandler } from 'util/module-helpers';
import { CustomizerPropertyType, registerHUDCustomizerComponent, getTextShadowFast } from 'common/hud-customizer';
import { parseLeadingJson } from 'common/parse-leading-json';

/**
 * Affirmations
 * ============
 * A pure-Panorama HUD element (NO new C++ panel type - see PANORAMA_NOTES 4 / 6g). It fetches a positive
 * affirmation from https://www.affirmations.dev on a timer and posts it into a plain text HUD label.
 *
 * Customizer options: the update INTERVAL (the "time" customization, default 10s), the TEXT COLOR and the
 * background color, plus font size and a drag-resizable width (long affirmations wrap within it).
 *
 * Placed in hud.xml via a <Frame> and registered with the JS HUD customizer like any other component. A plain
 * panel doesn't receive HudProcessInput, so the fetch cadence is a self-scheduled $.Schedule loop.
 *
 * NOTE: www.affirmations.dev must be in domain_whitelist.kv3 (startup-only allowlist - a full game RESTART is
 * needed to apply it) or $.AsyncWebRequest throws synchronously. It's been added there.
 */

// Seconds between affirmation fetches by default (customizer-controlled via `intervalSeconds`).
const DEFAULT_INTERVAL = 10;

// affirmations.dev returns `{ "affirmation": "..." }`. Trailing slash keeps the host exact for the whitelist.
const AFFIRMATIONS_URL = 'https://www.affirmations.dev/';

@PanelHandler()
class AffirmationsHandler {
	readonly panels = {
		root: $<Panel>('#Affirmations')!,
		text: $<Label>('#AffirmationsText')!
	};

	private intervalSeconds = DEFAULT_INTERVAL; // updated by the customizer callbackFunc
	private fetchGen = 0; // guards against overlapping loops when the interval is re-armed
	private inFlight = false; // a request is outstanding - don't stack another

	constructor() {
		// Set the dialog variable up front so the label never shows the raw "{s:affirmation}" token before the
		// first fetch lands (an unset dialog var reads back as the bare token - PANORAMA_NOTES 6l).
		this.panels.root.SetDialogVariable('affirmation', '');

		registerHUDCustomizerComponent(this.panels.root, {
			name: 'Affirmations',
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
					targetPanel: '.affirmations__text',
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`,
					settingProps: { min: 1, max: 200 }
				},
				// The "color" customization.
				fontColor: {
					name: 'Text Color',
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.affirmations__text',
					styleProperty: 'color',
					callbackFunc: (panel, value) =>
						(panel.style.textShadowFast = getTextShadowFast(value as rgbaColor, 0.9))
				},
				// No targetPanel -> applies to the registered root (#Affirmations) itself.
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

	/** GET one affirmation and post it into the label. */
	private fetch(): void {
		this.inFlight = true;
		try {
			$.AsyncWebRequest(AFFIRMATIONS_URL, {
				type: 'GET',
				complete: (data) => {
					this.inFlight = false;
					if (data.statusText !== 'success') return;
					// Response is `{ "affirmation": "..." }`. parseLeadingJson tolerates the trailing NUL byte.
					const json = parseLeadingJson<{ affirmation?: string }>(data.responseText);
					const text = typeof json?.affirmation === 'string' ? json.affirmation : null;
					if (text && this.panels.root?.IsValid()) this.panels.root.SetDialogVariable('affirmation', text);
				}
			});
		} catch {
			// AsyncWebRequest throws SYNCHRONOUSLY when the host isn't whitelisted (the allowlist is read only at
			// startup, so it won't work until a full restart after adding the domain). Fail quietly, retry next tick.
			this.inFlight = false;
		}
	}
}
