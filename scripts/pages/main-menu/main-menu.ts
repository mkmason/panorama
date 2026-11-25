import { OnPanelLoad, PanelHandler } from 'util/module-helpers';
import AuthenicationResult = MomentumAPI.AuthenicationResult;
import { Role } from 'common/web/enums/role.enum';
import {
	CATAAS,
	CAT_STATIC_TYPE,
	CatInfo,
	GifMethod,
	GIF_MAX_STRIP,
	catImageUrl,
	createGifPlayer,
	probeGifFrames
} from 'common/cataas';

/** CS:S menu pages shown as popup windows over the menu (each has a backdrop that closes it). */
const CSS_POPUP_PAGES = new Set<string>(['CssMapSelector', 'CssLobbyList', 'CssSettings', 'Stats']);

export enum Page {
	MAP_SELECTOR = 'MapSelection',
	LEARN = 'Learn',
	SETTINGS = 'Settings',
	CONTROLS_LIBRARY = 'ControlsLibrary'
}

// Values stored in persistent `settings.mainMenuBackground`.
enum BackgroundMode {
	LIGHT = 0,
	DARK = 1,
	CSS = 2 // custom static background01 (no video variant)
}

// Persistent key holding a user-picked background FILE NAME (with extension) that overrides the themed
// default. Empty / absent = no override. `.webm` → played from videos/backgrounds; any image extension →
// shown from images/backgrounds.
const BG_OVERRIDE_KEY = 'settings.mainMenuBackgroundOverride';

// Image file extensions the selector accepts (Panorama can't list a folder, so we route by extension).
const BG_IMAGE_EXTS = ['dds', 'png', 'tga', 'jpg', 'jpeg', 'vtex'];

// Known files shipped in videos/backgrounds and images/backgrounds, offered as quick-pick buttons.
// NOT exhaustive — the name input accepts any file present in those folders. Keep in sync if you add art.
const KNOWN_BACKGROUNDS: string[] = [
	'MomentumLight.webm',
	'MomentumDark.webm',
	'MomentumXmas.webm',
	'background01.dds',
	'background_triple.png',
	'MomentumNeutral_4K.png'
];

// nekos.best anime-image API — powers the background selector's image search. No auth (the engine's
// default User-Agent satisfies it) and PNG images (which render as a background, unlike webp APIs). The
// `/search?query=&type=1` endpoint does keyword search; the 4 PNG categories browse random images (the
// ~58 GIF categories are skipped — a static background wants a still image). The JSON call needs
// `nekos.best` in domain_whitelist.kv3; the image display via SetImage is not whitelist-gated. See §6d.
const NEKOS_BEST_API = 'https://nekos.best/api/v2';
const NEKO_CATEGORIES = ['neko', 'waifu', 'husbando', 'kitsune'];
const NEKO_RESULT_COUNT = 15; // results per search / browse (API max is 20)

// cataas.com cats for the background selector: still JPEG/PNG cats, or animated GIFs played from a frame strip.
// The API helpers, the GIF strip player and why GIFs need it are in common/cataas.ts.
const CAT_RESULT_COUNT = 15;
type CatKind = 'still' | 'gif';
const CAT_KINDS: [CatKind, string][] = [
	['still', 'Still (JPEG/PNG)'],
	['gif', 'Animated GIF (experimental)']
];
const GIF_METHODS: [GifMethod, string][] = [
	['step', 'Stepped strip'],
	['strip', 'AnimatedImageStrip']
];
const GIF_RESULT_COUNT = 8;
// Timing logs for the cat GIF loading (console, prefix [CatGif +ms]): API call, each frame-count probe and each
// strip image load, measured from when Load cats was pressed. Set to false to silence them.
const CAT_GIF_DEBUG = false;
// Background override value for an animated cat: `catgif:<method>:<frames>:<strip url>`
const CAT_GIF_OVERRIDE = /^catgif:(step|strip):(\d+):(.+)$/;
// One-time cleanup flag: drops a cataas background saved before GIFs were excluded (it may be a crashing frame strip).
const CAT_GIF_CLEANUP_KEY = 'settings.mainMenuBackgroundCatGifCleanup';
const CAT_FORMATS: [string, string][] = [
	['', 'Original'],
	['png', 'PNG'],
	['jpeg', 'JPEG']
];
const CAT_FILTERS: [string, string][] = [
	['', 'None'],
	['mono', 'Mono'],
	['negate', 'Negate'],
	['blur', 'Blur']
];

@PanelHandler()
class MainMenuHandler implements OnPanelLoad {
	readonly panels = {
		cp: $.GetContextPanel<MainMenu>(),
		pageContent: $<Panel>('#PageContent'),
		homeContent: $<Panel>('#HomeContent'),
		contentBlur: $<BaseBlurTarget>('#MainMenuContentBlur'),
		backgroundBlur: $<BaseBlurTarget>('#MainMenuBackgroundBlur'),
		movie: null as Movie,
		image: $<Image>('#MainMenuBackground'),
		model: $<ModelPanel>('#MainMenuModel'),
		mapSelectorBackground: $<Image>('#MainMenuBackgroundMapSelectorImage'),
		topButtons: $<Panel>('#MainMenuTopButtons'),
		homeButton: $<RadioButton>('#HomeButton'),
		quitButtonIcon: $<Image>('#QuitButtonImage'),
		legal: $<Panel>('#LegalConsent')
	};

	activePage: Page | null = null;

	// File name currently being validated on the hidden probe Image (background selector).
	pendingBackground: string | null = null;

	// Bumped on each nekos.best request so a slower earlier one that resolves late is discarded.
	nekoGen = 0;

	// Online-image source shown in the background selector, and the cataas.com test options
	bgSource: 'neko' | 'cat' = 'neko';
	catFormat = '';
	catFilter = '';
	catGen = 0;
	catKind: CatKind = 'still';
	gifMethod: GifMethod = 'step';
	catGifs: CatInfo[] | null = null; // the gif-tagged cats (one page of up to 100), fetched once
	catT0 = 0; // Date.now() when the current cat batch started loading (CAT_GIF_DEBUG timings)
	catCount: number | null = null; // total cats (/api/count), for a random page offset

	constructor() {
		$.RegisterForUnhandledEvent('ShowMainMenu', () => this.onShowMainMenu());
		$.RegisterForUnhandledEvent('HideMainMenu', () => this.onHideMainMenu());
		$.RegisterForUnhandledEvent('ShowPauseMenu', () => this.onShowPauseMenu());
		$.RegisterForUnhandledEvent('HidePauseMenu', () => this.onHidePauseMenu());
		$.RegisterForUnhandledEvent('MapSelector_OnLoaded', () => this.onMapSelectorLoaded());
		// The CS:S map selector plays/downloads through the main map selector's C++ panel (MomentumMapSelect handles
		// MapSelector_TryPlayMap / _DownloadMap), which only exists once that page is loaded -> load it hidden on request
		$.RegisterForUnhandledEvent('MainMenu_PreloadMapSelector', () => this.preloadMapSelector());
		$.RegisterForUnhandledEvent('ReloadMainMenuBackground', () => this.setMainMenuBackground());
		// Lets custom pages in their own script context (e.g. the CS:S map selector) close back to the menu.
		$.RegisterForUnhandledEvent('MainMenu_ClosePage', () => this.hideMainMenuPageContent());
		$.RegisterForUnhandledEvent('OnMomentumQuitPrompt', () => this.onQuitPrompt());
		$.RegisterForUnhandledEvent('MomAPI_Authenticated', (result) => this.onAuthenticated(result));
		$.RegisterEventHandler('Cancelled', $.GetContextPanel(), () => this.onEscapeKeyPressed());

		// Close the map selector when a map is loaded
		$.RegisterForUnhandledEvent('LevelInitPostEntity', () => this.hideMainMenuPageContent());

		$.DispatchEvent('HideIntroMovie');
	}

	async onPanelLoad() {
		// These aren't accessible until the page has loaded fully, find them now
		this.panels.movie = $('#MainMenuMovie');
		this.panels.model = $('#MainMenuModel');

		this.panels.model.SetModelRotation(0, 270, 0); // Get arrow logo facing to the right, looks better
		this.panels.model.SetModelRotationSpeedTarget(0, 0.2, 0);
		this.panels.model.SetMouseXRotationScale(0, 1, 0); // By default mouse X will rotate the X axis, but we want it to spin Y axis
		this.panels.model.SetMouseYRotationScale(0, 0, 0); // Disable mouse Y movement rotations

		this.panels.model.LookAtModel();
		this.panels.model.SetCameraOffset(-200, 0, 0);
		this.panels.model.SetCameraFOV(40);

		this.panels.model.SetDirectionalLightColor(0, 0.5, 0.5, 0.5);
		this.panels.model.SetDirectionalLightDirection(0, 1, 0, 0);

		if (GameInterfaceAPI.GetSettingBool('developer')) {
			$('#ControlsLibraryButton').RemoveClass('hide');
		}

		this.setMainMenuBackground();

		// Background selector: validate typed image names on a hidden probe. PanelLoaded ⇒ the file
		// exists (apply it); ImageFailedLoad ⇒ it doesn't (show a "not found" error). See §6d.
		const probe = $<Image>('#BackgroundProbe');
		if (probe) {
			$.RegisterEventHandler('PanelLoaded', probe, () => this.onBackgroundProbeLoaded());
			$.RegisterEventHandler('ImageFailedLoad', probe, () => this.onBackgroundProbeFailed());
		}

		await this.checkUserLegalConsent();

		this.showPlaytestWelcomePopup();

		$.DispatchEvent('MainMenuPageShown', null);

		// Pre-create the Stats page (hidden) shortly after the menu loads, so it scans the map cache
		// and pre-fetches leaderboard ranks in the background before the user ever opens it.
		// Opt-in only (off by default) — toggled from the Stats page and saved to persistent storage.
		if ($.persistentStorage.getItem('stats.preloadEnabled')) {
			$.Msg('[Stats] main-menu onPanelLoad: preload enabled, scheduling Stats pre-warm in 4s');
			$.Schedule(4, () => this.preloadStatsPage());
		} else {
			$.Msg('[Stats] main-menu onPanelLoad: Stats preload disabled (enable it on the Stats page)');
		}
	}

	/** Instantiate the Stats page hidden so its background scan starts on menu load, not first open. */
	preloadStatsPage() {
		const page = 'Stats' as Page;
		if (this.panels.cp.FindChildInLayoutFile(page)) {
			$.Msg('[Stats] preloadStatsPage: panel already exists, skipping pre-warm');
			return; // already created
		}

		$.Msg('[Stats] preloadStatsPage: creating hidden Stats panel + loading layout');
		const newPanel = $.CreatePanel('Panel', this.panels.pageContent, page);
		newPanel.LoadLayout('file://{resources}/layout/pages/stats/stats.xml', false, false);
		newPanel.RegisterForReadyEvents(true);
		$.RegisterEventHandler('PropertyTransitionEnd', newPanel, (panelName, propertyName) => {
			if (
				newPanel.id === panelName &&
				propertyName === 'opacity' &&
				newPanel.visible &&
				newPanel.IsTransparent()
			) {
				newPanel.visible = false;
				newPanel.SetReadyForDisplay(false);
				return true;
			}
			return false;
		});
		// Keep it hidden until the user actually navigates to it.
		newPanel.visible = false;
		newPanel.AddClass('mainmenu__page-container--hidden');
	}

	/**
	 * Fired by C++ whenever main menu is switched to.
	 */
	onShowMainMenu() {
		this.panels.movie = $('#MainMenuMovie');
		this.panels.image = $('#MainMenuBackground');

		this.panels.quitButtonIcon.SetImage('file://{images}/quit.svg');

		this.setMainMenuBackground();
	}

	/**
	 * Fired by C++ whenever main menu is switched from.
	 */
	onHideMainMenu() {
		UiToolkitAPI.CloseAllVisiblePopups();
	}

	/**
	 * Fired by C++ whenever pause menu (i.e. main menu when in a map) is switched to.
	 */
	onShowPauseMenu() {
		this.panels.cp.AddClass('MainMenuRootPanel--PauseMenuMode');

		this.panels.quitButtonIcon.SetImage('file://{images}/exit-door.svg');
	}

	/**
	 * Fired by C++ whenever pause menu is switched from.
	 */
	onHidePauseMenu() {
		this.panels.cp.RemoveClass('MainMenuRootPanel--PauseMenuMode');

		// Save to file whenever the settings page gets closed
		if (this.activePage === Page.SETTINGS) {
			$.DispatchEvent('SettingsSave');
		}
	}

	/**
	 * Switch main menu page
	 */
	navigateToPage(page: Page, layoutFile: string, hasBlur = true) {
		this.panels.mapSelectorBackground.SetHasClass('mapselector__background--hidden', page !== Page.MAP_SELECTOR);

		this.panels.contentBlur.visible = hasBlur;

		if (this.activePage === page) {
			$.DispatchEvent('Activated', this.panels.homeButton, PanelEventSource.MOUSE);
			return;
		}

		this.ensurePage(page, layoutFile);

		// If we have an active tab and it is different from the selected tab, hide it.
		// Then show the selected tab.
		if (this.activePage !== page) {
			// If the tab exists then hide it
			if (this.activePage) {
				const pagePanel = this.panels.cp.FindChildInLayoutFile(this.activePage);
				pagePanel.visible = false;
				pagePanel.AddClass('mainmenu__page-container--hidden');
				$.DispatchEvent('MainMenuPageHidden', this.activePage);
			}

			// Show selected page
			this.activePage = page;
			const activePanel = this.panels.cp.FindChildInLayoutFile(page);
			activePanel.RemoveClass('mainmenu__page-container--hidden');
			$.DispatchEvent('MainMenuPageShown', page);

			// Force a reload of any resources since we're about to display the panel
			activePanel.visible = true;
			activePanel.SetReadyForDisplay(true);
		}

		this.showMainMenuPageContent();
	}

	mapSelectorLoaded = false;

	/** Load the main map selector page without showing it, then tell the CS:S map selector it can play maps. */
	preloadMapSelector() {
		if (this.mapSelectorLoaded) {
			$.DispatchEvent('MainMenu_MapSelectorReady');
			return;
		}
		if (this.ensurePage(Page.MAP_SELECTOR, 'map-selector/wrapper')) {
			const panel = this.panels.cp.FindChildInLayoutFile(Page.MAP_SELECTOR);
			panel.visible = false;
			panel.AddClass('mainmenu__page-container--hidden');
		}
		// MainMenu_MapSelectorReady follows from onMapSelectorLoaded
	}

	/** Create a page's panel and load its layout if it doesn't exist yet. Returns true if it was just created. */
	ensurePage(page: Page, layoutFile: string): boolean {
		// Check to see if page to show exists. If not load the xml file.
		if (!this.panels.cp.FindChildInLayoutFile(page)) {
			const newPanel = $.CreatePanel('Panel', this.panels.pageContent, page);

			newPanel.LoadLayout(`file://{resources}/layout/pages/${layoutFile}.xml`, false, false);
			newPanel.RegisterForReadyEvents(true);

			// Handler that catches PropertyTransitionEndEvent event for this panel.
			// Check if the panel is transparent then collapse it.
			$.RegisterEventHandler('PropertyTransitionEnd', newPanel, (panelName, propertyName) => {
				// Panel is visible and fully transparent
				if (
					newPanel.id === panelName &&
					propertyName === 'opacity' &&
					newPanel.visible &&
					newPanel.IsTransparent()
				) {
					// Set visibility to false and unload resources
					newPanel.visible = false;
					newPanel.SetReadyForDisplay(false);
					return true;
				}
				return false;
			});
			return true;
		}
		return false;
	}

	/**
	 * Show the main menu page container and retract the drawer.
	 */
	showMainMenuPageContent() {
		this.panels.pageContent.RemoveClass('mainmenu__page-container--hidden');

		$.DispatchEvent('RetractDrawer');

		// The CS:S pages are popup windows over the CS:S menu, which stays visible behind them
		// (Stats also opens from the normal menu's nav, where it's a full page)
		const popup = this.panels.cp.HasClass('mainmenu--css') && CSS_POPUP_PAGES.has(this.activePage);
		this.panels.homeContent.SetHasClass('home--hidden', !popup);
	}

	/**
	 * Hide the main menu page container and active page, and display the home page content.
	 */
	hideMainMenuPageContent() {
		this.panels.pageContent.AddClass('mainmenu__page-container--hidden');
		this.panels.mapSelectorBackground.AddClass('mapselector__background--hidden');

		// Uncheck the active button in the main menu navbar.
		const activeButton = this.panels.topButtons.Children().find((panel) => panel.IsSelected());
		if (activeButton && activeButton.id !== 'HomeButton') {
			activeButton.checked = false;
		}

		// If the tab exists then hide it
		if (this.activePage) {
			const panelToHide = this.panels.cp.FindChildInLayoutFile(this.activePage);
			if (panelToHide) panelToHide.AddClass('mainmenu__page-container--hidden');

			$.DispatchEvent('MainMenuPageHidden', this.activePage);
		}

		$.DispatchEvent('MainMenuPageShown', null);
		this.activePage = null;
		this.panels.homeContent.RemoveClass('home--hidden');
	}

	/**
	 * Temporary method to show the playtest welcome thingy
	 */
	showPlaytestWelcomePopup() {
		if (!$.persistentStorage.getItem('mainMenu.playtestWelcomeShown')) {
			UiToolkitAPI.ShowCustomLayoutPopup('', 'file://{resources}/layout/modals/popups/playtest-welcome.xml');
		}
	}

	/**
	 * Set the video background based on persistent storage settings
	 */
	setMainMenuBackground() {
		if (!this.panels.movie?.IsValid() || !this.panels.image?.IsValid()) return;

		let useVideo = $.persistentStorage.getItem<boolean>('settings.mainMenuMovie');

		if (useVideo === null) {
			// Enable video by default
			useVideo = true;
			$.persistentStorage.setItem('settings.mainMenuMovie', true);
		}

		let backgroundVar = Number.parseInt($.persistentStorage.getItem('settings.mainMenuBackground'));

		if (Number.isNaN(backgroundVar)) {
			// Set color mode by system preference
			backgroundVar = $.SystemInDarkMode() ? 1 : 0;
			$.persistentStorage.setItem('settings.mainMenuBackground', backgroundVar);
		}

		// The CSS mode gets a CS:S-style menu: the class drives all the show/hide via CSS (hides the top
		// nav, spinning logo, news, and the other bottombar buttons; shows #CssMenu), scoped so the
		// pause-menu nav is left alone. The lobby drawer is untouched. Independent of any background override.
		const cssMode = backgroundVar === BackgroundMode.CSS;
		if (this.panels.cp?.IsValid()) this.panels.cp.SetHasClass('mainmenu--css', cssMode);
		this.setNavBarBlur(!cssMode);

		// 1) A user-chosen background override (picked in the background selector) wins over the themed
		//    default. A full http(s) URL (e.g. a nekos.best image) is shown directly; a `.webm` name → video;
		//    any other image name → static image from images/backgrounds.
		let override = $.persistentStorage.getItem<string>(BG_OVERRIDE_KEY);
		// A cataas background saved before GIFs were excluded may be a converted GIF: an all-frames strip that crashes
		// the game. Drop any saved cataas background once (it can't be told apart from a still one by its URL).
		if (!$.persistentStorage.getItem(CAT_GIF_CLEANUP_KEY)) {
			$.persistentStorage.setItem(CAT_GIF_CLEANUP_KEY, true);
			if (override?.startsWith(CATAAS)) {
				$.persistentStorage.setItem(BG_OVERRIDE_KEY, '');
				override = '';
			}
		}
		if (override) {
			const gif = CAT_GIF_OVERRIDE.exec(override);
			if (gif) this.showBackgroundGif(gif[1] as GifMethod, Number(gif[2]), gif[3]);
			else if (this.isRemoteUrl(override)) this.showBackgroundImageUrl(override);
			else if (this.isVideoFile(override)) this.showBackgroundVideo(override);
			else this.showBackgroundImage(override);
			return;
		}

		// 2) CSS mode's default is the custom static background01 (no video variant).
		if (cssMode) {
			this.showBackgroundImage('background01.dds');
			return;
		}

		// 3) Otherwise the themed Momentum background (seasonal swap near Christmas), video or static.
		let name: string;
		const date = new Date();
		if (date.getMonth() === 11 && date.getDate() >= 18) {
			name = 'MomentumXmas';
		} else {
			name = backgroundVar === BackgroundMode.DARK ? 'MomentumDark' : 'MomentumLight';
		}

		if (useVideo) this.showBackgroundVideo(`${name}.webm`);
		else this.showBackgroundImage(`${name}.dds`);
	}

	/** True if `file` is a video (webm) rather than a static image, by extension. */
	isVideoFile(file: string): boolean {
		return file.split('.').pop()?.toLowerCase() === 'webm';
	}

	/** Show `file` (in videos/backgrounds) as the animated movie background. */
	showBackgroundVideo(file: string) {
		this.clearGifBackground();
		this.panels.movie.visible = true;
		this.panels.movie.SetReadyForDisplay(true);
		this.panels.image.visible = false;
		this.panels.image.SetReadyForDisplay(false);
		this.panels.movie.SetMovie(`file://{resources}/videos/backgrounds/${file}`);
		this.panels.movie.Play();
	}

	/** Show `file` (in images/backgrounds) as the static image background. */
	showBackgroundImage(file: string) {
		this.clearGifBackground();
		this.panels.movie.visible = false;
		this.panels.movie.SetReadyForDisplay(false);
		this.panels.image.visible = true;
		this.panels.image.SetReadyForDisplay(true);
		this.panels.image.SetImage(`file://{images}/backgrounds/${file}`);
	}

	/** Play an animated cat (a vertical frame strip) as the background. */
	showBackgroundGif(method: GifMethod, frames: number, url: string) {
		this.panels.movie.visible = false;
		this.panels.movie.SetReadyForDisplay(false);
		this.panels.image.visible = false;
		this.panels.image.SetReadyForDisplay(false);
		const host = $('#MainMenuGifBackground');
		if (!host) return;
		host.RemoveAndDeleteChildren();
		host.visible = true;
		this.catT0 = Date.now();
		this.createGifPlayer(host, url, frames, method, undefined, `background ${frames} frames`);
	}

	clearGifBackground() {
		const host = $('#MainMenuGifBackground');
		if (!host) return;
		host.RemoveAndDeleteChildren();
		host.visible = false;
	}

	/** True if `s` is a remote http(s) URL (e.g. a nekos.best image) rather than a local file name. */
	isRemoteUrl(s: string): boolean {
		return /^https?:\/\//i.test(s);
	}

	/** Show a remote image `url` (e.g. a nekos.best search result) as the static background. SetImage takes
	 *  a CDN url directly and, unlike $.AsyncWebRequest, is NOT domain-whitelist-gated. */
	showBackgroundImageUrl(url: string) {
		this.clearGifBackground();
		this.panels.movie.visible = false;
		this.panels.movie.SetReadyForDisplay(false);
		this.panels.image.visible = true;
		this.panels.image.SetReadyForDisplay(true);
		this.panels.image.SetImage(url);
	}

	// --- Background selector (name input + quick-picks) -------------------------------------------------
	// Panorama can't enumerate a folder from JS, so the selector is a name input: type a file name (with
	// extension) from videos/backgrounds or images/backgrounds. Image names are validated on the preview
	// Image (ImageFailedLoad ⇒ "not found"); webm names can't be probed, so they're applied directly.

	/** Open the selector overlay (reachable from the bottombar and the CS:S menu). */
	openBackgroundSelector() {
		const sel = $('#BackgroundSelector');
		if (!sel) return;
		sel.AddClass('bgselector--open'); // show first, so the preview Image below actually renders/loads
		this.populateBackgroundPresets();
		this.setBackgroundStatus('', false);
		const current = $.persistentStorage.getItem<string>(BG_OVERRIDE_KEY) ?? '';
		const input = $<TextEntry>('#BackgroundNameInput');
		const isGif = CAT_GIF_OVERRIDE.test(current);
		// don't dump a long URL (or an animated cat's catgif: value) into the name box
		if (input) input.text = this.isRemoteUrl(current) || isGif ? '' : current;
		// Preview the current image (the probe's PanelLoaded fires but pendingBackground is null → no-op).
		const probe = $<Image>('#BackgroundProbe');
		// (no preview for an animated cat: its image is a strip of every frame, and it isn't a local file)
		if (probe && current && !isGif) {
			if (this.isRemoteUrl(current)) probe.SetImage(current);
			else if (!this.isVideoFile(current)) probe.SetImage(`file://{images}/backgrounds/${current}`);
		}

		// Anime-image search: build the category quick-picks and load a first batch so the grid isn't empty.
		this.populateNekoCategories();
		this.setNekoStatus('', false);
		const nekoInput = $<TextEntry>('#NekoSearchInput');
		if (nekoInput) nekoInput.text = '';
		this.browseNekoCategory('neko');

		// Cat images: build the option chips; cats load when that source is first shown.
		this.populateCatOptions();
		this.setCatStatus('', false);
		this.showBgSource(this.bgSource);
	}

	/** Show one online-image source (nekos.best or cataas.com) and highlight its switch button. */
	showBgSource(src: 'neko' | 'cat') {
		this.bgSource = src;
		$('#BgSourceNeko')?.SetHasClass('bgselector__source--hidden', src !== 'neko');
		$('#BgSourceCat')?.SetHasClass('bgselector__source--hidden', src !== 'cat');
		$('#BgSrc_neko')?.SetHasClass('bgselector__preset--active', src === 'neko');
		$('#BgSrc_cat')?.SetHasClass('bgselector__preset--active', src === 'cat');
		if (src === 'cat' && !$('#CatResults')?.GetChildCount()) void this.loadCats();
	}

	closeBackgroundSelector() {
		const sel = $('#BackgroundSelector');
		if (sel) sel.RemoveClass('bgselector--open');
	}

	/** (Re)build the quick-pick buttons for the known files, highlighting the active one. */
	populateBackgroundPresets() {
		const holder = $('#BackgroundSelectorPresets');
		if (!holder) return;
		holder.RemoveAndDeleteChildren();
		const current = $.persistentStorage.getItem<string>(BG_OVERRIDE_KEY) ?? '';
		for (const file of KNOWN_BACKGROUNDS) {
			const btn = $.CreatePanel('Button', holder, `BgPreset_${file.replace(/\W/g, '_')}`, {
				class: 'bgselector__preset'
			});
			if (file === current) btn.AddClass('bgselector__preset--active');
			btn.SetPanelEvent('onactivate', () => {
				const input = $<TextEntry>('#BackgroundNameInput');
				if (input) input.text = file;
				this.applyBackgroundByName();
			});
			$.CreatePanel('Label', btn, '', { class: 'bgselector__preset-text', text: file });
		}
	}

	/** Apply the name typed in the input, validating image names and erroring if the file isn't found. */
	applyBackgroundByName() {
		const input = $<TextEntry>('#BackgroundNameInput');
		const name = (input?.text ?? '').trim();
		if (!name) {
			this.setBackgroundStatus('Enter a background file name.', true);
			return;
		}

		// A pasted remote image URL (e.g. from the anime search, or any direct link) is applied as-is.
		if (this.isRemoteUrl(name)) {
			this.commitBackgroundOverride(name);
			this.setBackgroundStatus('Applied image URL.', false);
			return;
		}

		const ext = name.split('.').pop()?.toLowerCase() ?? '';

		if (ext === 'webm') {
			// A movie can't be probed for existence, so apply it directly. If the file is missing the
			// background simply won't play (images below get real not-found detection).
			this.commitBackgroundOverride(name);
			this.setBackgroundStatus(`Applied "${name}".`, false);
			return;
		}

		if (!BG_IMAGE_EXTS.includes(ext)) {
			this.setBackgroundStatus('Add a file extension: .webm, .dds, .png, .tga or .jpg', true);
			return;
		}

		// Validate the image by loading it into the preview first; its PanelLoaded / ImageFailedLoad
		// handlers (registered in onPanelLoad) commit it or report "not found".
		const probe = $<Image>('#BackgroundProbe');
		if (!probe) {
			this.commitBackgroundOverride(name); // no preview available — apply without validating
			this.setBackgroundStatus(`Applied "${name}".`, false);
			return;
		}
		this.pendingBackground = name;
		this.setBackgroundStatus(`Checking "${name}"…`, false);
		probe.SetImage(`file://{images}/backgrounds/${name}`);
	}

	onBackgroundProbeLoaded() {
		if (!this.pendingBackground) return;
		const name = this.pendingBackground;
		this.pendingBackground = null;
		this.commitBackgroundOverride(name);
		this.setBackgroundStatus(`Applied "${name}".`, false);
	}

	onBackgroundProbeFailed() {
		if (!this.pendingBackground) return;
		const name = this.pendingBackground;
		this.pendingBackground = null;
		this.setBackgroundStatus(`"${name}" not found in images/backgrounds.`, true);
	}

	/** Persist the override file name and repaint the background + preset highlights. */
	commitBackgroundOverride(file: string) {
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, file);
		this.setMainMenuBackground();
		this.populateBackgroundPresets();
		$.PlaySoundEvent('MenuThemeLight');
	}

	/** Clear the override and revert to the themed (light/dark/css) background. */
	resetBackgroundOverride() {
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, '');
		this.pendingBackground = null;
		this.setMainMenuBackground();
		const input = $<TextEntry>('#BackgroundNameInput');
		if (input) input.text = '';
		this.populateBackgroundPresets();
		this.setBackgroundStatus('Reverted to the theme background.', false);
	}

	setBackgroundStatus(msg: string, isError: boolean) {
		const status = $<Label>('#BackgroundSelectorStatus');
		if (!status) return;
		status.text = msg;
		status.SetHasClass('bgselector__status--error', isError && !!msg);
		status.SetHasClass('bgselector__status--hidden', !msg);
	}

	// --- Anime image search (nekos.best) --------------------------------------------------------------
	// No auth, PNG images. The keyword box hits `/search?query=&type=1`; the category quick-picks browse
	// `/{category}`. Clicking a result stores its remote URL as the background override (shown via SetImage,
	// which isn't domain-whitelist-gated). The JSON fetch DOES need `nekos.best` in domain_whitelist.kv3.

	/** Build the category quick-pick buttons (once, when the selector opens). */
	populateNekoCategories() {
		const holder = $('#NekoCategories');
		if (!holder) return;
		holder.RemoveAndDeleteChildren();
		for (const cat of NEKO_CATEGORIES) {
			const btn = $.CreatePanel('Button', holder, `NekoCat_${cat}`, { class: 'bgselector__preset' });
			btn.SetPanelEvent('onactivate', () => this.browseNekoCategory(cat));
			$.CreatePanel('Label', btn, '', { class: 'bgselector__preset-text', text: cat });
		}
	}

	/** Search box handler: keyword search, or (when empty) browse the default category. */
	searchNeko() {
		const input = $<TextEntry>('#NekoSearchInput');
		const q = (input?.text ?? '').trim();
		if (!q) {
			this.browseNekoCategory('neko');
			return;
		}
		void this.loadNeko(
			`${NEKOS_BEST_API}/search?query=${encodeURIComponent(q)}&type=1&amount=${NEKO_RESULT_COUNT}`,
			`No results for "${q}".`
		);
	}

	/** Browse random images from a nekos.best category. */
	browseNekoCategory(cat: string) {
		const input = $<TextEntry>('#NekoSearchInput');
		if (input) input.text = '';
		void this.loadNeko(`${NEKOS_BEST_API}/${cat}?amount=${NEKO_RESULT_COUNT}`, `No images in ${cat}.`);
	}

	/** Fetch a nekos.best endpoint and render the results grid. `emptyMsg` shows when it returns nothing. */
	async loadNeko(url: string, emptyMsg: string) {
		const gen = ++this.nekoGen; // supersede a slower earlier request that resolves late
		this.setNekoStatus('Searching…', false);
		try {
			const json = await this.nekoFetch(url);
			if (gen !== this.nekoGen) return; // superseded by a newer search
			const results: any[] = json?.results ?? [];
			const urls = results
				.map((r) => r?.url)
				.filter((u): u is string => typeof u === 'string' && this.isRemoteUrl(u));
			this.renderNekoResults(urls);
			this.setNekoStatus(urls.length ? `${urls.length} results — click one to apply.` : emptyMsg, !urls.length);
		} catch (e) {
			if (gen !== this.nekoGen) return;
			this.renderNekoResults([]);
			this.setNekoStatus('Search failed — is nekos.best reachable and whitelisted?', true);
			$.Msg(`[BgSelector] nekos.best request failed: ${String(e)}`);
		}
	}

	/** Render clickable thumbnails; clicking one applies it as the background. */
	renderNekoResults(urls: string[]) {
		const grid = $('#NekoResults');
		if (!grid) return;
		grid.RemoveAndDeleteChildren();
		for (const url of urls) {
			const thumb = $.CreatePanel('Image', grid, '', {
				class: 'bgselector__nekoresult',
				scaling: 'stretch-to-cover-preserve-aspect'
			});
			thumb.hittest = true; // Images default to hittest=false; ensure the click applies (not swallowed by the window)
			thumb.SetImage(url);
			thumb.SetPanelEvent('onactivate', () => this.applyNekoImage(url));
		}
	}

	/** Apply a chosen nekos.best image as the background (stored as a remote-URL override). */
	applyNekoImage(url: string) {
		this.commitBackgroundOverride(url);
		this.setNekoStatus('Applied.', false);
	}

	setNekoStatus(msg: string, isError: boolean) {
		const status = $<Label>('#NekoStatus');
		if (!status) return;
		status.text = msg;
		status.SetHasClass('bgselector__status--error', isError && !!msg);
		status.SetHasClass('bgselector__status--hidden', !msg);
	}

	// --- Cat images (cataas.com) ---------------------------------------------------------------------------

	/** (Re)build the Type / Format / Filter chips, highlighting the current choice of each. */
	populateCatOptions() {
		const build = (holderId: string, options: [string, string][], current: string, pick: (v: string) => void) => {
			const holder = $(holderId);
			if (!holder) return;
			holder.RemoveAndDeleteChildren();
			for (const [value, label] of options) {
				const btn = $.CreatePanel('Button', holder, '', { class: 'bgselector__preset' });
				btn.SetHasClass('bgselector__preset--active', value === current);
				btn.SetPanelEvent('onactivate', () => {
					pick(value);
					this.populateCatOptions();
					void this.loadCats();
				});
				$.CreatePanel('Label', btn, '', { class: 'bgselector__preset-text', text: label });
			}
		};
		build('#CatKinds', CAT_KINDS, this.catKind, (v) => (this.catKind = v as CatKind));
		build('#CatGifMethods', GIF_METHODS, this.gifMethod, (v) => (this.gifMethod = v as GifMethod));
		build('#CatFormats', CAT_FORMATS, this.catFormat, (v) => (this.catFormat = v));
		build('#CatFilters', CAT_FILTERS, this.catFilter, (v) => (this.catFilter = v));
	}

	/** Image URL for a cat with the current caption / format / filter options. `width` (and `height`, which fixes
	 *  every frame's size) shrink it; `format` overrides the chosen format (GIF strips are always PNG). */
	catImageUrl(id: string, width?: number, height?: number, format = this.catFormat): string {
		const says = $<TextEntry>('#CatSaysInput')?.text ?? '';
		return catImageUrl(id, { says, format, filter: this.catFilter, width, height });
	}

	/** Fetch a random batch of cats of the chosen type and render them as test thumbnails. */
	/** CAT_GIF_DEBUG timing log, in ms since the current batch started loading. */
	catLog(msg: string) {
		if (CAT_GIF_DEBUG) $.Msg(`[CatGif +${Date.now() - this.catT0}ms] ${msg}`);
	}

	async loadCats() {
		const gen = ++this.catGen;
		this.catT0 = Date.now();
		this.catLog(
			`--- loading ${this.catKind} cats (gif play: ${this.gifMethod}, format: ${this.catFormat || 'original'})`
		);
		this.setCatStatus('Loading cats...', false);
		try {
			let pool: CatInfo[];
			if (this.catKind === 'gif') {
				// /api/count has no tag filter, so take the first page of gif-tagged cats once and sample from it
				if (this.catGifs) this.catLog('gif list: cached');
				else {
					this.catLog('gif list: GET /api/cats?tags=gif');
					this.catGifs = await this.nekoFetch(`${CATAAS}/api/cats?tags=gif&limit=100`);
					this.catLog(`gif list: got ${this.catGifs?.length ?? 0}`);
				}
				pool = (this.catGifs ?? []).filter((c) => c?.mimetype === 'image/gif');
			} else {
				if (this.catCount == null)
					this.catCount = Number((await this.nekoFetch(`${CATAAS}/api/count`))?.count) || 0;
				const skip = Math.floor(Math.random() * Math.max(0, this.catCount - 100));
				const page: CatInfo[] = (await this.nekoFetch(`${CATAAS}/api/cats?limit=100&skip=${skip}`)) ?? [];
				// Still JPEG/PNG cats only (see CAT_STATIC_TYPE): a GIF here would be a full-size frame strip
				pool = page.filter((c) => CAT_STATIC_TYPE.test(c?.mimetype ?? ''));
			}
			if (gen !== this.catGen) return;

			const cats = pool
				.filter((c) => typeof c?.id === 'string')
				.sort(() => Math.random() - 0.5)
				.slice(0, this.catKind === 'gif' ? GIF_RESULT_COUNT : CAT_RESULT_COUNT);
			if (this.catKind === 'gif') this.renderGifResults(cats);
			else this.renderCatResults(cats);
			this.setCatStatus(
				cats.length > 0
					? this.catKind === 'gif'
						? `${cats.length} GIFs (${this.gifMethod === 'step' ? 'stepped strip' : 'AnimatedImageStrip'}) — click one to apply. GIF strips load as JPEG (much smaller) unless Format is PNG.`
						: `${cats.length} cats — click one to apply. A red tag means Panorama couldn't load that image.`
					: 'No cats found.',
				cats.length === 0
			);
		} catch (e) {
			if (gen !== this.catGen) return;
			this.renderCatResults([]);
			this.setCatStatus('Loading failed — is cataas.com reachable and whitelisted (needs a game restart)?', true);
			$.Msg(`[BgSelector] cataas.com request failed: ${String(e)}`);
		}
	}

	/** Thumbnails tagged with the source type (and any conversion); failed loads are marked red. */
	renderCatResults(cats: CatInfo[]) {
		const grid = $('#CatResults');
		if (!grid) return;
		grid.RemoveAndDeleteChildren();
		for (const cat of cats) {
			const type = (cat.mimetype ?? '').replace('image/', '') || '?';
			const url = this.catImageUrl(cat.id);
			const tile = $.CreatePanel('Button', grid, '', { class: 'bgselector__nekoresult bgselector__cattile' });
			const img = $.CreatePanel('Image', tile, '', {
				class: 'bgselector__catimg',
				scaling: 'stretch-to-cover-preserve-aspect'
			});
			img.hittest = false;
			const tag = $.CreatePanel('Label', tile, '', {
				class: 'bgselector__cattag',
				text: this.catFormat ? `${type} -> ${this.catFormat}` : type
			});
			$.RegisterEventHandler('ImageFailedLoad', img, () => {
				tag.text += ' (failed)';
				tag.AddClass('bgselector__cattag--failed');
			});
			img.SetImage(this.catImageUrl(cat.id, 240));
			tile.SetPanelEvent('onactivate', () => {
				this.commitBackgroundOverride(url);
				this.setCatStatus(`Applied ${url}`, false);
			});
		}
	}

	/** GIF thumbnails: probe each one's frame count, then play it from a small frame strip. */
	renderGifResults(cats: CatInfo[]) {
		const grid = $('#CatResults');
		if (!grid) return;
		grid.RemoveAndDeleteChildren();
		$('#CatProbeHost')?.RemoveAndDeleteChildren();
		const gen = this.catGen;
		const method = this.gifMethod;
		// Strip image format: JPEG unless PNG is chosen. Measured on 8 GIFs at 120x80 frames, PNG strips were
		// 0.04-3.8 MB and took up to 3.4 s (7 s in-game, where the largest files were the slowest); JPEG strips were
		// ~10x smaller and took 0.2-0.9 s. The GIFs have no transparency to lose.
		const stripFormat = this.catFormat === 'png' ? 'png' : 'jpeg';
		for (const [i, cat] of cats.entries()) {
			const name = `#${i + 1} ${cat.id}`;
			const tile = $.CreatePanel('Button', grid, '', { class: 'bgselector__nekoresult bgselector__cattile' });
			const tag = $.CreatePanel('Label', tile, '', { class: 'bgselector__cattag', text: 'gif: probing…' });
			const fail = (why: string) => {
				if (!tag.IsValid()) return;
				tag.text = `gif: ${why}`;
				tag.AddClass('bgselector__cattag--failed');
			};
			this.probeGifFrames(cat.id, name)
				.then((frames) => {
					if (gen !== this.catGen || !tile.IsValid()) return;
					// Thumbnail frames: 120x80 (stepped) or 80x80 (AnimatedImageStrip, which wants square frames),
					// shrunk if the strip would get too tall
					const h = Math.max(8, Math.min(80, Math.floor(GIF_MAX_STRIP / frames)));
					const w = method === 'strip' ? h : Math.round(h * 1.5);
					const player = this.createGifPlayer(
						tile,
						this.catImageUrl(cat.id, w, h, stripFormat),
						frames,
						method,
						fail,
						`${name} thumb ${w}x${h}x${frames} ${stripFormat}`
					);
					tile.MoveChildBefore(player, tag);
					tag.text = `gif: ${frames} frames`;

					// The background strip: 16:9 frames (square for AnimatedImageStrip), as big as the cap allows
					const bh = Math.max(8, Math.min(540, Math.floor(GIF_MAX_STRIP / frames)));
					const bw = method === 'strip' ? bh : Math.min(1000, Math.round((bh * 16) / 9));
					const bgUrl = this.catImageUrl(cat.id, bw, bh, stripFormat);
					tile.SetPanelEvent('onactivate', () => {
						this.commitBackgroundOverride(`catgif:${method}:${frames}:${bgUrl}`);
						this.setCatStatus(`Applied animated cat: ${frames} frames of ${bw}x${bh} (${bgUrl})`, false);
					});
				})
				.catch((e) => {
					fail('probe failed');
					$.Msg(`[BgSelector] gif frame probe failed for ${cat.id}: ${String(e)}`);
				});
		}
	}

	/** Frame count of a GIF cat (common/cataas.ts probeGifFrames), probed under the selector's hidden #CatProbeHost. */
	probeGifFrames(id: string, name = id): Promise<number> {
		const host = $('#CatProbeHost');
		if (!host) return Promise.reject('no probe host');
		return probeGifFrames(host, id, 'bgselector__catprobe', (msg) => this.catLog(`${name} ${msg}`));
	}

	/** Play a GIF frame strip filling `parent` (common/cataas.ts createGifPlayer), with CAT_GIF_DEBUG timing logs. */
	createGifPlayer(
		parent: GenericPanel,
		url: string,
		frames: number,
		method: GifMethod,
		onFail?: (why: string) => void,
		logName?: string
	): GenericPanel {
		return createGifPlayer(parent, url, frames, method, {
			onFail,
			log: logName ? (msg) => this.catLog(`${logName}: ${msg}`) : undefined
		});
	}

	setCatStatus(msg: string, isError: boolean) {
		const status = $<Label>('#CatStatus');
		if (!status) return;
		status.text = msg;
		status.SetHasClass('bgselector__status--error', isError && !!msg);
		status.SetHasClass('bgselector__status--hidden', !msg);
	}

	/** Promise-wrapped GET + JSON parse for nekos.best. */
	nekoFetch(url: string): Promise<any> {
		return new Promise((resolve, reject) => {
			$.AsyncWebRequest(url, {
				type: 'GET',
				complete: (d) => {
					if (d.statusText !== 'success') {
						reject(d.statusText);
						return;
					}
					try {
						resolve(this.parseLeadingJson(d.responseText));
					} catch (e) {
						reject(String(e));
					}
				}
			});
		});
	}

	/** Parse the leading top-level JSON value, ignoring trailing bytes — AsyncWebRequest appends a stray
	 *  NUL terminator after the body that trips a plain JSON.parse (same quirk the Stats page handles). */
	parseLeadingJson(txt: string): any {
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
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

	/**
	 * Toggles the custom CSS (background01) static background on/off. Turning it off always drops to the
	 * dark theme.
	 */
	toggleCssBackground() {
		const isCss =
			Number.parseInt($.persistentStorage.getItem('settings.mainMenuBackground')) === BackgroundMode.CSS;
		// Clear any background override so the toggle actually changes what's on screen.
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, '');
		$.persistentStorage.setItem('settings.mainMenuBackground', isCss ? BackgroundMode.DARK : BackgroundMode.CSS);
		this.setMainMenuBackground();
		$.PlaySoundEvent('MenuThemeDark');
	}

	/*
	 *	Toggles between dark and light mode in the main menu
	 */
	toggleBackgroundLightDark() {
		const isLightMode = $.persistentStorage.getItem('settings.mainMenuBackground') === 0;
		// Clear any background override so the light/dark toggle actually changes what's on screen.
		$.persistentStorage.setItem(BG_OVERRIDE_KEY, '');
		$.persistentStorage.setItem('settings.mainMenuBackground', isLightMode ? 1 : 0);
		this.setMainMenuBackground();
		$.PlaySoundEvent(isLightMode ? 'MenuThemeDark' : 'MenuThemeLight');
	}

	/**
	 * Handles the map selector load event to add blurs to some of the map selector panels.
	 * Necessary to handle in here because map selector background is a part of the main menu background section.
	 */
	navBarBlurred = true; // MainMenuBackgroundBlur's blurrects include the nav bar from the layout

	/**
	 * The background blur covers the top nav bar's area (blurrects in main-menu.xml). The CS:S menu hides the nav
	 * bar, but the blur still applied there, leaving a faint darker strip across the top: drop it in CS:S mode.
	 */
	setNavBarBlur(on: boolean) {
		if (on === this.navBarBlurred) return;
		const nav = $('#MainMenuNavBar');
		const blur = this.panels.backgroundBlur;
		if (!nav || !blur) return;
		if (on) blur.AddBlurPanel(nav);
		else blur.RemoveBlurPanel(nav);
		this.navBarBlurred = on;
	}

	onMapSelectorLoaded() {
		this.mapSelectorLoaded = true;
		$.DispatchEvent('MainMenu_MapSelectorReady');
		// for (const panel of ['MapSelectorLeft', 'MapDescription', 'MapInfoStats', 'Leaderboards'])
		for (const panel of ['MapSelectorLeft', 'Leaderboards'])
			this.panels.backgroundBlur?.AddBlurPanel($.GetContextPanel().FindChildTraverse(panel));
	}

	/**
	 * Handles quit button getting pressed, deciding whether to `disconnect` or `quit`
	 * based on if we're ingame or not.
	 */
	onQuitButtonPressed() {
		if (GameInterfaceAPI.GetGameUIState() === GameUIState.PAUSEMENU) {
			GameInterfaceAPI.ConsoleCommand('disconnect');
			this.hideMainMenuPageContent();
			return;
		}
		this.onQuitPrompt();
	}

	/** Handles when the quit button is shown, either from button getting pressed or event fired from C++. */
	onQuitPrompt(toDesktop = true) {
		if (!toDesktop) return; // currently don't handle disconnect prompts

		$.DispatchEvent('MainMenuPauseGame'); // make sure game is paused so we can see the popup if hit from a keybind in-game

		// CS:S main menu: its own "Quit game" dialog in the CS:S look
		if (this.panels.cp?.HasClass('mainmenu--css')) {
			UiToolkitAPI.ShowCustomLayoutPopup('CssQuit', 'file://{resources}/layout/modals/popups/css-quit.xml');
			return;
		}

		UiToolkitAPI.ShowGenericPopupTwoOptionsBgStyle(
			$.Localize('#Action_Quit'),
			$.Localize('#Action_Quit_Message'),
			'warning-popup',
			$.Localize('#Action_Quit'),
			this.quitGame,
			$.Localize('#Action_Return'),
			() => {},
			'blur'
		);
	}

	/** Quits the game. Bye! */
	quitGame() {
		GameInterfaceAPI.ConsoleCommand('quit');
	}

	onEscapeKeyPressed() {
		// If the background selector is open, close that first.
		const sel = $('#BackgroundSelector');
		if (sel?.HasClass('bgselector--open')) {
			this.closeBackgroundSelector();
			return;
		}

		// Resume game in pause menu mode, OTHERWISE close the active menu menu page
		if (GameInterfaceAPI.GetGameUIState() === GameUIState.PAUSEMENU) {
			$.DispatchEvent('MainMenuResumeGame');
		} else {
			this.hideMainMenuPageContent();
		}
	}

	onAuthenticated(result: MomentumAPI.AuthenicationResult) {
		if (result === MomentumAPI.AuthenicationResult.SUCCESS) {
			const handle = $.RegisterForUnhandledEvent('MomAPI_LocalUserUpdate', (user) => {
				if ((user.roles & Role.LIMITED) !== 0) {
					UiToolkitAPI.ShowGenericPopupTwoOptions(
						'#API_Auth_LimitedSteamAccount',
						'#API_Auth_LimitedSteamAccount_Info',
						'wide-popup',
						'#API_Auth_LimitedSteamAccount_Link',
						() => SteamOverlayAPI.OpenURL('https://help.steampowered.com/en/faqs/view/71D3-35C2-AD96-AA3A'),
						'#Common_OK',
						() => {}
					);
				}

				$.UnregisterForUnhandledEvent('MomAPI_LocalUserUpdate', handle);
			});

			return;
		}

		let token: string;
		switch (result) {
			case AuthenicationResult.FAILURE_LOCAL_STEAM_CONNECTION:
			case AuthenicationResult.FAILURE_BACKEND_STEAM_CONNECTION:
				token = '#API_Auth_SteamDown';
				break;
			case AuthenicationResult.FAILURE_SIGNUPS_DISABLED:
				token = '#API_Auth_SignupsDisabled';
				break;
			case AuthenicationResult.FAILURE_BACKEND_DOWN:
				token = '#API_Auth_BackendDown';
				break;
			default:
				token = '#API_Auth_Unauthorized';
		}

		UiToolkitAPI.ShowGenericPopupOk('#API_Auth_Failure', token, 'wide-popup', () => {});
	}

	checkUserLegalConsent(): Promise<void> {
		return new Promise((resolve) => {
			const consent = MomentumAPI.GetUserAuthConsent();
			if (consent === MomentumAPI.UserAuthConsent.VALID) {
				resolve();
				return;
			}

			this.toggleAnnounceMode(true);
			this.panels.legal.LoadLayoutSnippet(
				consent === MomentumAPI.UserAuthConsent.INVALID ? 'UserConsentInitial' : 'UserConsentOutdated'
			);

			this.panels.legal.FindChildTraverse('OKButton')!.SetPanelEvent('onactivate', () => {
				MomentumAPI.GrantUserAuthConsent();
				this.toggleAnnounceMode(false);
				resolve();
			});

			this.panels.legal.FindChildTraverse('DeclineButton')!.SetPanelEvent('onactivate', () => {
				GameInterfaceAPI.ConsoleCommand('quit');
			});
		});
	}

	/**
	 * Put the main menu into "announce" mode, when we want to show
	 * big fullscreen stuff on startup like legal consent
	 */
	toggleAnnounceMode(enable: boolean) {
		this.panels.cp.SetHasClass('--announce-mode', enable);
	}
}
