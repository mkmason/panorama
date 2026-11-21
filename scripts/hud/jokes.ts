import { PanelHandler } from 'util/module-helpers';
import { CustomizerPropertyType, registerHUDCustomizerComponent, getTextShadowFast } from 'common/hud-customizer';
import { parseLeadingJson } from 'common/parse-leading-json';

/**
 * Jokes
 * =====
 * A pure-Panorama HUD element (NO new C++ panel type - see PANORAMA_NOTES 4 / 6g). It fetches a random joke
 * from https://official-joke-api.appspot.com/random_joke on a timer and posts its setup + punchline into two
 * HUD labels. Same pattern as the Affirmations element (6m) - see that file for the fetch-loop rationale.
 *
 * Customizer options: the update INTERVAL (the "time" customization, default 10s), separate Setup / Punchline
 * text COLORS and a background color, plus font size and a drag-resizable width (long jokes wrap within it).
 *
 * NOTE: official-joke-api.appspot.com must be in domain_whitelist.kv3 (startup-only allowlist - a full game
 * RESTART is needed to apply it) or $.AsyncWebRequest throws synchronously. It's been added there.
 */

// Seconds between joke fetches by default (customizer-controlled via `intervalSeconds`).
const DEFAULT_INTERVAL = 10;

interface JokeSource {
	url: string;
	/** Pull setup + punchline out of the parsed response, or null if it isn't a usable two-part joke. */
	extract: (json: any) => { setup: string; punchline: string } | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

// Tried in order: if one fails (it can be down - official-joke-api returned 503 for a while), the next is used.
const JOKE_SOURCES: JokeSource[] = [
	{
		// Returns `{ type, setup, punchline, id }`.
		url: 'https://official-joke-api.appspot.com/random_joke',
		extract: (j) => (str(j?.setup) && str(j?.punchline) ? { setup: j.setup, punchline: j.punchline } : null)
	},
	{
		// JokeAPI: `{ error, type: 'twopart', setup, delivery, ... }`. safe-mode filters out offensive jokes.
		url: 'https://v2.jokeapi.dev/joke/Any?type=twopart&safe-mode',
		extract: (j) =>
			!j?.error && str(j?.setup) && str(j?.delivery) ? { setup: j.setup, punchline: j.delivery } : null
	}
];

@PanelHandler()
class JokesHandler {
	readonly panels = {
		root: $<Panel>('#Jokes')!,
		setup: $<Label>('#JokesSetup')!,
		punchline: $<Label>('#JokesPunchline')!
	};

	private intervalSeconds = DEFAULT_INTERVAL; // updated by the customizer callbackFunc
	private fetchGen = 0; // guards against overlapping loops when the interval is re-armed
	private inFlight = false; // a request is outstanding - don't stack another

	constructor() {
		// Set the dialog variables up front so the labels never show the raw "{s:...}" tokens before the first
		// fetch lands (an unset dialog var reads back as the bare token - PANORAMA_NOTES 6l).
		this.panels.root.SetDialogVariable('joke_setup', '');
		this.panels.root.SetDialogVariable('joke_punchline', '');

		registerHUDCustomizerComponent(this.panels.root, {
			name: 'Jokes',
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
					targetPanel: ['.jokes__setup', '.jokes__punchline'],
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`,
					settingProps: { min: 1, max: 200 }
				},
				// The "color" customization - setup and punchline are coloured independently.
				setupColor: {
					name: 'Setup Color',
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.jokes__setup',
					styleProperty: 'color',
					callbackFunc: (panel, value) =>
						(panel.style.textShadowFast = getTextShadowFast(value as rgbaColor, 0.9))
				},
				punchlineColor: {
					name: 'Punchline Color',
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.jokes__punchline',
					styleProperty: 'color',
					callbackFunc: (panel, value) =>
						(panel.style.textShadowFast = getTextShadowFast(value as rgbaColor, 0.9))
				},
				// No targetPanel -> applies to the registered root (#Jokes) itself.
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

	/** GET one joke and post its setup + punchline into the labels. */
	private fetch(sourceIndex = 0): void {
		const source = JOKE_SOURCES[sourceIndex];
		if (!source) {
			// Every source failed this tick - give up until the next one.
			this.inFlight = false;
			return;
		}
		const next = () => this.fetch(sourceIndex + 1);

		this.inFlight = true;
		try {
			$.AsyncWebRequest(source.url, {
				type: 'GET',
				complete: (data) => {
					if (!this.panels.root?.IsValid()) {
						this.inFlight = false;
						return;
					}
					// parseLeadingJson tolerates the trailing NUL byte.
					const joke = data.statusText === 'success' ? source.extract(parseLeadingJson(data.responseText)) : null;
					if (!joke) return next();
					this.inFlight = false;
					this.panels.root.SetDialogVariable('joke_setup', joke.setup);
					this.panels.root.SetDialogVariable('joke_punchline', joke.punchline);
				}
			});
		} catch {
			// AsyncWebRequest throws SYNCHRONOUSLY when the host isn't whitelisted (the allowlist is read only at
			// startup, so it won't work until a full restart after adding the domain). Try the next source.
			next();
		}
	}
}
