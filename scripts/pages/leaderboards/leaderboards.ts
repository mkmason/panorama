import { exposeToPanelContext, PanelHandler } from 'util/module-helpers';
import {
	LeaderboardListType,
	LeaderboardRecord,
	LeaderboardRecordsFilter,
	LeaderboardStatusType,
	LeaderboardType,
	LEADERBOARD_RECORDS_PER_PAGE
} from 'common/leaderboard';
import { TrackType } from 'common/web/enums/track-type.enum';
import { Style } from 'common/web/enums/style.enum';
import { Gamemode } from 'common/web/enums/gamemode.enum';
import { CompletionGroup } from 'common/web/enums/completion-group.enum';
import { getRankGroupEnds, getCompletionGroup } from 'common/web/consts/rank-groups.const';

// Keep in sync with entry.scss (new / Classic row heights)
const ENTRY_HEIGHT = 32;
const ENTRY_HEIGHT_CLASSIC = 30;
// The new style's framed list sits 2px below the pill layer; Classic's list has no frame
const PILL_VERTICAL_ADJUSTMENT = 2;
const PILL_VERTICAL_ADJUSTMENT_CLASSIC = 0;

/**
 * persistentStorage key for the Interface > Leaderboard Style setting.
 * 0 = new (upstream's reworked leaderboard), 1 = classic (this fork's pre-merge 0.10 leaderboard: Global/Local/Lobby
 * tabs with Top 10/Around/Friends sub-tabs, a Rank/Player/Time/Date header, striped 30px rows, no group pills).
 * Classic is a second set of tabs + header in leaderboards.xml plus CSS; both styles use the same paginated
 * getLeaderboardRecords requests, so the page controls stay in both.
 */
const LEADERBOARD_STYLE_KEY = 'settings.leaderboardStyle';
const LEADERBOARD_STYLE_CLASSIC = 1;

/**
 * Rows per shown page in the Classic map selector (the old 300px / 10-row box). Each 20-record page from the
 * engine is shown as two of these; the tab menu and the new style show whole records pages.
 */
const CLASSIC_ROWS = 10;

type ClassicTab = 'global' | 'local' | 'lobby';
type ClassicSubtype = 'top10' | 'around' | 'friends';

/** "just now" / "5 minutes ago" / "3 weeks ago" for a unix-seconds run date (the Classic Date column). */
function formatRunAge(date: string | number): string {
	const seconds = Number(date);
	if (!seconds) return '';
	const diff = Math.max(0, Date.now() / 1000 - seconds);
	const units: [number, string][] = [
		[365 * 24 * 3600, 'year'],
		[30 * 24 * 3600, 'month'],
		[7 * 24 * 3600, 'week'],
		[24 * 3600, 'day'],
		[3600, 'hour'],
		[60, 'minute']
	];
	for (const [size, name] of units) {
		const n = Math.floor(diff / size);
		if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
	}
	return 'just now';
}

// Offsets for the group pills
const GROUP_BORDER_LEFT_ALIGN = -10;
const GROUP_BORDER_TOP_ALIGN = -13;

// Show the loading spinner if the request takes longer than this in seconds
const LOADING_SPINNER_DELAY = 0.2;

exposeToPanelContext({ LeaderboardListType, LeaderboardType, LeaderboardRecordsFilter });
@PanelHandler({ exposeToPanel: true })
export class LeaderboardsHandler {
	selectedTimesList: LeaderboardListType;
	selectedGlobalListType: LeaderboardType;
	selectedLocalListType: LeaderboardType;

	readonly panels = {
		cp: $.GetContextPanel<Leaderboards>(),
		timesList: $<Panel>('#TimesList'),
		lobbyButton: $<Button>('#TimesListLobby'),
		timesContainer: $<Panel>('#LeaderboardTimesContainer'),
		groupPillsLayer: $<Panel>('#GroupPillsLayer'),
		emptyWarningText: $<Label>('#LeaderboardEmptyWarningText'),
		syncTrackButton: $<Button>('#SyncTrackButton'),
		aroundTooltip: $<TooltipPanel>('#AroundTooltip'),
		around: $<Button>('#Around'),
		tools: $<Panel>('#LeaderboardTools'),
		classic: {
			filters: $<Panel>('#ClassicFilters'),
			styleSlot: $<Panel>('#ClassicStyleSlot'),
			trackDropdown: $<DropDown>('#ClassicTrackDropdown'),
			syncTooltip: $<TooltipPanel>('#ClassicSyncTooltip'),
			subtypes: $<Panel>('#ClassicSubtypes'),
			header: $<Panel>('#ClassicHeader'),
			tabs: {
				global: $<RadioButton>('#ClassicGlobal'),
				local: $<RadioButton>('#ClassicLocal'),
				lobby: $<RadioButton>('#ClassicLobby')
			},
			subtypeTabs: {
				top10: $<RadioButton>('#ClassicTop10'),
				around: $<RadioButton>('#ClassicAround'),
				friends: $<RadioButton>('#ClassicFriends')
			}
		},
		radioButtons: {
			global: $<RadioButton>('#TimesListGlobal'),
			friends: $<RadioButton>('#TimesListFriends'),
			lobby: $<RadioButton>('#TimesListLobby'),
			local: $<RadioButton>('#TimesListLocal')
		},
		controls: {
			container: $<Panel>('#ControlsContainer'),
			pagePrev: $<Button>('#PagePrev'),
			pageNext: $<Button>('#PageNext'),
			groupPrev: $<Button>('#GroupPrev'),
			groupNext: $<Button>('#GroupNext'),
			pageSelect: $<TextEntry>('#PageSelect'),
			totalPages: $<Label>('#TotalPages')
		}
	};

	readonly state = {
		mapID: 0,
		gamemode: Gamemode.SURF,
		trackType: TrackType.MAIN,
		trackNum: 1,
		style: Style.NORMAL,
		filter: LeaderboardRecordsFilter.GLOBAL,
		page: 1,
		totalPages: 1
	};

	blockTextEntryEvent = false;
	totalCompletions: number = null;
	currentUserRank = null;
	groupEnds: number[];

	/** handles loading spinner for quick leaderboard requests */
	private loadingHandle: number = null;

	/** The only records request whose result gets shown; null while none is wanted. */
	private pendingRequestToken: number | null = null;
	/** The request whose result has already been shown, so the Loaded event and the fallback poll don't both render it. */
	private handledRequestToken: number | null = null;

	/** null until the first map is shown, so that the first {@link setLocalOnly} always applies. */
	localOnly: boolean | null = null;

	/** Whether the classic (pre-merge) look is active; mirrors settings.leaderboardStyle. */
	private classicStyle = false;
	/** Selected Classic tab / Global sub-tab. Derived from state.filter except Top 10 vs Around (both end up GLOBAL). */
	private classicTab: ClassicTab = 'global';
	private classicSubtype: ClassicSubtype = 'top10';

	/** The owner's StyleSelector, moved into the Classic tab row while Classic is on, and where it came from. */
	private styleSelectorPanel: StyleSelector | null = null;
	private styleSelectorHome: { parent: GenericPanel; before: GenericPanel | null } | null = null;
	/**
	 * Shown-page paging, layered over the engine's 20-record pages (state.page / state.totalPages): the Classic map
	 * selector shows CLASSIC_ROWS per page, so each records page is two shown pages. Elsewhere they're the same.
	 * The page box, total, buttons and group/PB jumps all work in shown pages.
	 */
	private viewPage = 1;
	private totalViews = 1;
	/** The last loaded records page, so switching between its halves doesn't need another request. */
	private loaded: { records: LeaderboardRecord[]; status: LeaderboardStatusType } | null = null;

	/** Classic track dropdown option ids -> TrackSelector track keys, and how to select one there. */
	private classicTrackKeys: string[] = [];
	private onClassicTrackPicked: ((key: string) => void) | null = null;

	constructor() {
		this.applyStyleSetting();
		$.RegisterForUnhandledEvent('LeaderboardsStyleChanged', () => {
			$.Msg(`[LBStyle] ${this.panels.cp?.id} got LeaderboardsStyleChanged`);
			this.applyStyleSetting();
		});

		$.RegisterEventHandler('LeaderboardRecords_Loaded', this.panels.cp, (requestToken) =>
			this.updateLeaderboardsWithToken(requestToken)
		);

		// Saved replays are read off disk asynchronously (CLeaderboards::AsyncGetLocalMapRuns), and
		// finish loading after we've already requested the page on map load. The engine signals that
		// via Leaderboards_LocalRunsLoaded -- it never re-fires LeaderboardRecords_Loaded -- so
		// re-request the page ourselves when it fires while local-only.
		$.RegisterEventHandler('Leaderboards_LocalRunsLoaded', this.panels.cp, () => {
			if (this.localOnly) this.updateLeaderboards();
		});

		$.RegisterForUnhandledEvent('EndOfRun_Result_RunUpload', () => {
			this.updateLeaderboards();
		});

		// The engine builds the lobby filter from the lobby's members at request time
		$.RegisterForUnhandledEvent('PanoramaComponent_SteamLobby_OnMemberStateChanged', () => {
			if (this.state.filter === LeaderboardRecordsFilter.LOBBY) this.updateLeaderboards();
		});

		$.RegisterForUnhandledEvent('SteamLobby_Exit', () => {
			if (this.state.filter !== LeaderboardRecordsFilter.LOBBY) return;

			this.panels.radioButtons.global.SetSelected(true);
			this.setFilter(LeaderboardRecordsFilter.GLOBAL);
		});

		// Note: Can't set radio button groups in the XML because it causes multiple leaderboard instances to interfere with eachother
		Object.entries(this.panels.radioButtons).forEach(([_, button]) => {
			button.group = this.panels.cp.id + 'Group';
		});
		this.panels.classic.trackDropdown.SetPanelEvent('oninputsubmit', () => {
			const id = this.panels.classic.trackDropdown.GetSelected()?.id ?? '';
			const key = this.classicTrackKeys[Number(id.replace('ClassicTrack_', ''))];
			if (key != null) this.onClassicTrackPicked?.(key);
		});
		Object.values(this.panels.classic.tabs).forEach(
			(button) => (button.group = this.panels.cp.id + 'ClassicGroup')
		);
		Object.values(this.panels.classic.subtypeTabs).forEach(
			(button) => (button.group = this.panels.cp.id + 'ClassicSubGroup')
		);

		this.panels.controls.pageSelect.SetPanelEvent('ontextentrychange', () => {
			if (this.blockTextEntryEvent) return;
			const text = this.panels.controls.pageSelect.text.trim();
			if (text === '') return;

			const parsed = +text;
			if (!Number.isNaN(parsed)) {
				this.selectPage(parsed);
			}
		});

		this.setToolsAvailable(false);
	}

	/**
	 * Read settings.leaderboardStyle and switch between the new and Classic looks. Also re-checked on every
	 * leaderboard request, so an instance that missed the change event (e.g. the HUD tab menu) catches up on its
	 * next load.
	 *
	 * Every affected panel gets its own modifier class rather than relying on one root class: the root Leaderboards
	 * panel is declared by the map selector / tab menu layouts, and Panorama didn't apply `.root-class .child`
	 * rules across that layout boundary in-game.
	 * @param redraw Re-request the page to rebuild the rows (skipped when a request is about to happen anyway)
	 */
	applyStyleSetting(redraw = true) {
		const classic = Number($.persistentStorage.getItem(LEADERBOARD_STYLE_KEY) ?? 0) === LEADERBOARD_STYLE_CLASSIC;
		if (classic === this.classicStyle && this.panels.cp.HasClass('leaderboards--classic') === classic) return;

		this.classicStyle = classic;
		const c = this.panels.classic;
		this.panels.cp.SetHasClass('leaderboards--classic', classic);
		c.filters.SetHasClass('leaderboard-classic-filters--shown', classic);
		c.header.SetHasClass('leaderboard-classic-header--shown', classic);
		this.panels.radioButtons.global.GetParent()?.SetHasClass('leaderboard-radio--hidden', classic);
		this.panels.timesContainer.SetHasClass('leaderboard-times--classic', classic);
		this.panels.tools.GetParent()?.SetHasClass('leaderboard-bottom--classic', classic);
		this.applyContextClasses();
		this.moveStyleSelector();
		this.updateClassicBottomVisibility();
		this.syncTabSelection();
		// Rows per shown page differ between the styles, so start from the top
		this.resetPage();
		$.Msg(`[LBStyle] ${this.panels.cp.id} classic=${classic}`); // DEBUG(leaderboard-style): remove once confirmed

		if (redraw && this.state.mapID) this.updateLeaderboards();
	}

	/** Classic main tab clicked. Local / Lobby map straight to a filter; Global uses the selected sub-tab. */
	setClassicTab(tab: ClassicTab) {
		this.classicTab = tab;
		this.updateClassicSubtypesVisibility();
		this.setClassicFilter();
	}

	/** Classic Global sub-tab clicked. */
	setClassicSubtype(subtype: ClassicSubtype) {
		this.classicSubtype = subtype;
		this.setClassicFilter();
	}

	/**
	 * Request page 1 for the Classic tab selection. Always re-requests (unlike setFilter): Top 10 and Around share the
	 * GLOBAL filter once Around has resolved, so the filter alone can't tell whether anything changed.
	 * Around uses the backend's AROUND filter, which picks the page holding the player's PB (or reports NO_PB_SET);
	 * updateLeaderboardsWithToken then turns it back into ordinary GLOBAL paging from that page.
	 */
	private setClassicFilter() {
		let filter: LeaderboardRecordsFilter;
		if (this.classicTab === 'local') filter = LeaderboardRecordsFilter.SAVED_REPLAYS;
		else if (this.classicTab === 'lobby') filter = LeaderboardRecordsFilter.LOBBY;
		else if (this.classicSubtype === 'friends') filter = LeaderboardRecordsFilter.FRIENDS;
		else if (this.classicSubtype === 'around') filter = LeaderboardRecordsFilter.AROUND;
		else filter = LeaderboardRecordsFilter.GLOBAL;

		this.state.filter = filter;
		this.resetPage();
		this.updateLeaderboards();
	}

	/**
	 * The Classic classes that depend on where this leaderboard lives (map selector vs tab menu). Re-applied on every
	 * request, not just when the style changes: the map selector's `leaderboards--in-map-selector` class isn't on the
	 * panel yet when the constructor first applies the style, which left the map selector with the tab menu's 600px
	 * list (in-game: the box filled the whole column and hid the map info).
	 */
	private applyContextClasses() {
		const classic = this.classicStyle;
		const inMapSelector = this.isInMapSelector();
		// Tab menu: full 20-row pages; map selector: the 300px / 10-row box
		this.panels.timesContainer.SetHasClass('leaderboard-times--classic-paged', classic && !inMapSelector);
		// The row holding this leaderboard: map selector .mapselector__right-center / tab menu
		// .tab-menu-center__main-container. Its stylesheet collapses the track selector column and widens ours.
		this.panels.cp.GetParent()?.GetParent()?.SetHasClass('leaderboards-classic-row', classic);
		// Syncing your timer to the viewed track only makes sense in-game (the old map selector had none either)
		this.panels.classic.syncTooltip.visible = !inMapSelector;
	}

	private isInMapSelector() {
		return this.panels.cp.HasClass('leaderboards--in-map-selector');
	}

	/** Rows per shown page: 10 in the Classic map selector, a whole records page everywhere else. */
	private rowsPerView() {
		return this.classicStyle && this.isInMapSelector() ? CLASSIC_ROWS : LEADERBOARD_RECORDS_PER_PAGE;
	}

	private viewsPerPage() {
		return Math.max(1, Math.round(LEADERBOARD_RECORDS_PER_PAGE / this.rowsPerView()));
	}

	/** Back to the first page (records page 1, shown page 1). */
	private resetPage() {
		this.state.page = 1;
		this.viewPage = 1;
		this.setTextEntry(1);
	}

	/**
	 * Called by the TrackSelector once it knows both its leaderboard and its StyleSelector. Classic moves that
	 * StyleSelector into its tab row (as the old leaderboard had its style dropdown there); the new style puts it
	 * back where the layout declared it. The selector keeps its own handler and callbacks either way.
	 */
	attachStyleSelector(styleSelector: StyleSelector) {
		if (this.styleSelectorPanel === styleSelector) return;
		this.styleSelectorPanel = styleSelector;

		const parent = styleSelector.GetParent();
		if (!parent) return;
		const siblings = parent.Children();
		const before = siblings[siblings.indexOf(styleSelector) + 1] ?? null;
		this.styleSelectorHome = { parent, before };
		this.moveStyleSelector();
	}

	private moveStyleSelector() {
		const panel = this.styleSelectorPanel;
		const home = this.styleSelectorHome;
		if (!panel?.IsValid() || !home) return;

		const target = this.classicStyle ? this.panels.classic.styleSlot : home.parent;
		if (panel.GetParent() !== target) {
			panel.SetParent(target);
			if (!this.classicStyle && home.before?.IsValid()) home.parent.MoveChildBefore(panel, home.before);
		}
		panel.SetHasClass('style-selector--in-leaderboard', this.classicStyle);
		// Its dark outlined theme (.style-selector__dropdown) is for its standalone spot; in the Classic row it takes
		// the plain .dropdown look like the track dropdown beside it. Toggled on the dropdown itself, since rules
		// keyed off the selector root don't reach into its own layout file.
		panel.FindChildTraverse('StyleDropdown')?.SetHasClass('style-selector__dropdown', !this.classicStyle);
	}

	/**
	 * Fill the Classic track dropdown from the TrackSelector's tracks. `onPick` selects that track's row in the
	 * TrackSelector, which loads it here through the usual setTrack path.
	 */
	setClassicTracks(
		tracks: { key: string; label: string }[],
		selectedKey: string | null,
		onPick: (key: string) => void
	) {
		const dropdown = this.panels.classic.trackDropdown;
		this.onClassicTrackPicked = onPick;
		this.classicTrackKeys = tracks.map((track) => track.key);

		dropdown.RemoveAllOptions();
		tracks.forEach((track, index) => {
			const option = $.CreatePanel('Label', dropdown, `ClassicTrack_${index}`);
			option.text = track.label;
			dropdown.AddOption(option);
		});
		dropdown.enabled = tracks.length > 1;
		this.setClassicSelectedTrack(selectedKey);
	}

	/** Reflect the TrackSelector's selected track in the Classic dropdown (programmatic; doesn't fire oninputsubmit). */
	setClassicSelectedTrack(key: string | null) {
		const index = key == null ? -1 : this.classicTrackKeys.indexOf(key);
		if (index !== -1) this.panels.classic.trackDropdown.SetSelected(`ClassicTrack_${index}`);
	}

	/** Classic sync button (tab menu): switch your own timer to the viewed track and style. */
	syncTrackAndStyle() {
		GameInterfaceAPI.ConsoleCommand(`mom_style ${this.state.style}`);
		if (this.state.trackType === TrackType.MAIN) GameInterfaceAPI.ConsoleCommand('mom_main');
		else if (this.state.trackType === TrackType.STAGE)
			GameInterfaceAPI.ConsoleCommand(`mom_stage ${this.state.trackNum}`);
		else if (this.state.trackType === TrackType.BONUS)
			GameInterfaceAPI.ConsoleCommand(`mom_bonus ${this.state.trackNum}`);
	}

	/** Classic hides the page bar when there's only one page; the new style always shows it. */
	private updateClassicBottomVisibility() {
		const hide = this.classicStyle && this.totalViews <= 1;
		this.panels.tools.GetParent()?.SetHasClass('leaderboard-bottom--collapsed', hide);
	}

	private updateClassicSubtypesVisibility() {
		this.panels.classic.subtypes.SetHasClass(
			'leaderboard-classic-filters__subtypes--hidden',
			this.classicTab !== 'global'
		);
	}

	/** Select the tabs (of both styles) that match state.filter, e.g. after switching style or going local-only. */
	private syncTabSelection() {
		const { filter } = this.state;
		const r = this.panels.radioButtons;
		const c = this.panels.classic;

		let newTab = r.global;
		if (filter === LeaderboardRecordsFilter.FRIENDS) newTab = r.friends;
		else if (filter === LeaderboardRecordsFilter.LOBBY) newTab = r.lobby;
		else if (filter === LeaderboardRecordsFilter.SAVED_REPLAYS) newTab = r.local;
		newTab.SetSelected(true);

		if (filter === LeaderboardRecordsFilter.SAVED_REPLAYS) {
			this.classicTab = 'local';
		} else if (filter === LeaderboardRecordsFilter.LOBBY) {
			this.classicTab = 'lobby';
		} else {
			this.classicTab = 'global';
			if (filter === LeaderboardRecordsFilter.FRIENDS) this.classicSubtype = 'friends';
			else if (filter === LeaderboardRecordsFilter.AROUND) this.classicSubtype = 'around';
			else if (this.classicSubtype === 'friends') this.classicSubtype = 'top10';
		}
		c.tabs[this.classicTab].SetSelected(true);
		c.subtypeTabs[this.classicSubtype].SetSelected(true);
		this.updateClassicSubtypesVisibility();
	}

	setMapID(mapID: number) {
		this.state.mapID = mapID;
		this.resetPage();
	}

	setTrack(trackType: TrackType, trackNum: number) {
		this.resetPage();

		this.state.trackType = trackType;
		this.state.trackNum = trackNum;
		this.updateLeaderboards();
	}

	setGamemode(gamemode: Gamemode) {
		this.state.gamemode = gamemode;
	}

	setStyle(style: Style) {
		if (this.state.style === style) return;

		this.state.style = style;
		this.resetPage();
		this.updateLeaderboards();
	}

	setTotalCompletions(completions: number) {
		this.totalCompletions = completions;
	}

	setFilter(filter: LeaderboardRecordsFilter) {
		if (this.state.filter === filter) return;

		this.state.filter = filter;
		this.resetPage();
		this.updateLeaderboards();
	}

	/**
	 * Restrict the leaderboard to locally saved replays, for maps with no online data. The other
	 * categories are all served by the backend, which knows nothing about such a map, so they're
	 * disabled rather than left to come back empty.
	 *
	 * Lobby is left to the engine (CLeaderboards tracks lobby membership and toggles it itself), and
	 * it re-runs on every SetMap so it'll be right for the map we're on either way -- so we only
	 * force it off when going local-only, and never force it back on.
	 */
	setLocalOnly(localOnly: boolean) {
		if (this.localOnly === localOnly) return;
		this.localOnly = localOnly;

		const { global, friends, lobby, local } = this.panels.radioButtons;
		global.enabled = !localOnly;
		friends.enabled = !localOnly;
		this.panels.classic.tabs.global.enabled = !localOnly;

		if (localOnly) {
			lobby.enabled = false;
			local.SetSelected(true);
			this.setFilter(LeaderboardRecordsFilter.SAVED_REPLAYS);
		} else {
			global.SetSelected(true);
			this.classicSubtype = 'top10';
			this.setFilter(LeaderboardRecordsFilter.GLOBAL);
		}
		this.syncTabSelection();
	}

	setCurrentUserRank(rank: number) {
		this.currentUserRank = rank;
		this.updateAroundButton();
	}

	showLobbyTooltip() {
		if (!this.panels.lobbyButton.enabled) {
			UiToolkitAPI.ShowTextTooltip(this.panels.lobbyButton.id, $.Localize('#Leaderboards_JoinLobbyTooltip'));
		}
	}
	private updateEmptyState(isEmpty: boolean, status = LeaderboardStatusType.NO_TIMES_RETURNED) {
		this.cancelLoadingSchedule();

		this.panels.timesContainer.RemoveClass('leaderboard-times--loading');
		this.panels.timesContainer.SetHasClass('leaderboard-times--empty', isEmpty);
		if (isEmpty) {
			this.panels.cp.SetDialogVariable('empty-warning', $.Localize(this.getEmptyWarningText(status)));
		}
	}

	private getEmptyWarningText(status: LeaderboardStatusType) {
		switch (status) {
			case LeaderboardStatusType.SERVER_ERROR:
				return '#Leaderboards_Error_ServerError';
			case LeaderboardStatusType.NO_FRIENDS:
				return '#Leaderboards_Error_NoFriends';
			case LeaderboardStatusType.UNAUTHORIZED_FRIENDS_LIST:
				return '#Leaderboards_Error_FriendsPrivate';
			case LeaderboardStatusType.NO_PB_SET:
				return '#Leaderboards_Error_NoPB';
		}

		switch (this.state.filter) {
			case LeaderboardRecordsFilter.GLOBAL:
				return '#Leaderboards_Error_NoCompletions';
			case LeaderboardRecordsFilter.FRIENDS:
				return '#Leaderboards_Error_NoFriendTimes';
			case LeaderboardRecordsFilter.LOBBY:
				return '#Leaderboards_Error_NoLobbyTimes';
			case LeaderboardRecordsFilter.SAVED_REPLAYS:
				return '#Leaderboards_Error_NoLocalReplays';
		}
	}

	private beginLoading() {
		this.panels.timesContainer.RemoveClass('leaderboard-times--empty');
		this.cancelLoadingSchedule();
		this.loadingHandle = $.Schedule(LOADING_SPINNER_DELAY, () => {
			this.loadingHandle = null; // fired naturally, nothing left to cancel
			this.panels.timesContainer.AddClass('leaderboard-times--loading');
		});
	}

	private cancelLoadingSchedule() {
		if (this.loadingHandle !== null) {
			$.CancelScheduled(this.loadingHandle);
			this.loadingHandle = null;
		}
	}

	updateLeaderboards() {
		this.applyStyleSetting(false);
		this.applyContextClasses();
		// The engine enables/disables the Lobby tab by id (#TimesListLobby); mirror it onto the Classic one
		this.panels.classic.tabs.lobby.enabled = this.panels.radioButtons.lobby.enabled;
		// When this request finishes it fires LeaderboardRecords_Loaded event
		// That event runs updateLeaderboardWithToken() using this data
		this.loaded = null;
		this.beginLoading();

		const token = this.panels.cp.getLeaderboardRecords(
			this.state.mapID,
			this.state.gamemode,
			this.state.trackType,
			this.state.trackNum,
			this.state.style,
			this.state.filter,
			this.state.page - 1
		);
		this.pendingRequestToken = token;
		this.handledRequestToken = null;
		// DEBUG(leaderboard-loading): remove once the stuck-loading report is confirmed fixed
		$.Msg(
			`[LB] ${this.panels.cp.id} request token=${token} map=${this.state.mapID} track=${this.state.trackType}:${this.state.trackNum} ` +
				`style=${this.state.style} filter=${this.state.filter} page=${this.state.page}`
		);

		// Safety net for the spinner sticking: if LeaderboardRecords_Loaded for this token already fired (e.g. it was
		// dispatched before pendingRequestToken was assigned) or never arrives, pick the result up from
		// getLoadedLeaderboardRecords directly once it holds this token.
		this.collectIfLoaded(token, 'immediate');
		$.Schedule(0.5, () => this.collectIfLoaded(token, '0.5s'));
		$.Schedule(2, () => this.collectIfLoaded(token, '2s'));
	}

	/** Process the loaded page for `token` if it's still the wanted request, it has landed and nothing handled it yet. */
	private collectIfLoaded(token: number, when: string) {
		if (!this.panels.cp?.IsValid()) return;
		if (token !== this.pendingRequestToken || this.handledRequestToken === token) return;
		const loadedToken = this.panels.cp.getLoadedLeaderboardRecords()?.requestToken;
		if (loadedToken !== token) return;
		$.Msg(`[LB] ${this.panels.cp.id} token=${token} picked up by fallback (${when}) - Loaded event was missed`);
		this.updateLeaderboardsWithToken(token);
	}

	/**
	 * Drop the shown records while there's no track to request them for, e.g. while a newly
	 * selected map's tracks are still loading. Shows the spinner for TIMES_LOADING, else the empty
	 * state with the message for `status`.
	 */
	clearRecords(status: LeaderboardStatusType) {
		this.pendingRequestToken = null;
		this.loaded = null;
		this.panels.timesList.RemoveAndDeleteChildren();
		this.panels.groupPillsLayer.RemoveAndDeleteChildren();

		if (status === LeaderboardStatusType.TIMES_LOADING) {
			this.beginLoading();
		} else {
			this.updateEmptyState(true, status);
		}
	}

	private updateLeaderboardsWithToken(requestToken: number) {
		const data = this.panels.cp.getLoadedLeaderboardRecords();
		// DEBUG(leaderboard-loading): remove once the stuck-loading report is confirmed fixed
		$.Msg(
			`[LB] ${this.panels.cp.id} loaded event token=${requestToken} pending=${this.pendingRequestToken} ` +
				`dataToken=${data?.requestToken} status=${data?.status} records=${data?.records?.length}`
		);
		if (requestToken !== this.pendingRequestToken) return; // superseded or cleared
		if (data.requestToken !== requestToken) return; //superseded by a newer request;
		if (this.handledRequestToken === requestToken) return; // already shown (event + fallback both fired)
		this.handledRequestToken = requestToken;

		this.state.totalPages = Math.max(data.totalPages, 1);

		// The backend always includes local player's run in the friends filter response
		// If only one run was returned and the local player has a PB remove it from the timesList
		const isOwnRunOnly =
			this.state.filter === LeaderboardRecordsFilter.FRIENDS &&
			data.totalPages === 1 &&
			data.records.length === 1 &&
			this.currentUserRank != null;

		const records = isOwnRunOnly ? [] : data.records;
		const rows = this.rowsPerView();
		const perPage = this.viewsPerPage();

		// Classic "Around": the engine resolved which page holds the PB. Carry on as normal GLOBAL paging from there
		// (AROUND ignores the page index, so next/previous wouldn't move otherwise), on the shown page with the PB.
		if (this.state.filter === LeaderboardRecordsFilter.AROUND) {
			this.state.filter = LeaderboardRecordsFilter.GLOBAL;
			this.state.page = data.page + 1;
			const pbIndex = records.findIndex((record) => record.rank === this.currentUserRank);
			this.viewPage = (this.state.page - 1) * perPage + Math.floor(Math.max(0, pbIndex) / rows) + 1;
		} else if (Math.ceil(this.viewPage / perPage) !== this.state.page) {
			this.viewPage = (this.state.page - 1) * perPage + 1;
		}

		// Shown-page count. Exact once the last records page is loaded; before that, from total completions where
		// they apply (GLOBAL), else assuming every records page is full.
		if (perPage === 1) {
			this.totalViews = this.state.totalPages;
		} else if (this.state.page >= this.state.totalPages) {
			this.totalViews = (this.state.totalPages - 1) * perPage + Math.max(1, Math.ceil(records.length / rows));
		} else if (this.state.filter === LeaderboardRecordsFilter.GLOBAL && this.totalCompletions) {
			this.totalViews = Math.max(this.state.page * perPage, Math.ceil(this.totalCompletions / rows));
		} else {
			this.totalViews = this.state.totalPages * perPage;
		}
		this.panels.controls.container.SetDialogVariableInt('total-pages', this.totalViews);
		this.setTextEntry(this.viewPage);

		this.groupEnds = getRankGroupEnds(this.totalCompletions);
		this.loaded = { records, status: data.status };
		this.renderView();
	}

	/** Build the rows for the current shown page out of the loaded records page. */
	private renderView() {
		if (!this.loaded) return;
		const { records, status } = this.loaded;
		const rows = this.rowsPerView();
		const start = ((this.viewPage - 1) % this.viewsPerPage()) * rows;
		// pageIndex stays the record's position in the loaded page: playRecordReplay / setRecordComparisonRun /
		// deleteRecordReplay index into that
		const shown = records
			.map((record, pageIndex) => [pageIndex, record] as [number, LeaderboardRecord])
			.slice(start, start + rows);
		const shownRecords = shown.map(([, record]) => record);

		this.updateControlButtons();
		this.updateClassicBottomVisibility();

		this.panels.timesList.RemoveAndDeleteChildren();
		this.panels.groupPillsLayer.RemoveAndDeleteChildren();
		shown.forEach(([pageIndex, record], index) => {
			const lbEntry = $.CreatePanel('LeaderboardEntry', this.panels.timesList, '');
			if (this.classicStyle) {
				lbEntry.AddClass('leaderboard-entry--classic');
				lbEntry.AddClass(index % 2 === 0 ? 'leaderboard-entry--even' : 'leaderboard-entry--odd');
			}
			lbEntry.SetDialogVariable('achieved', formatRunAge(record.date));
			if (index === 0) {
				lbEntry.AddClass('leaderboard-entry--first');
			}
			if (shown.length < rows && index === shown.length - 1) {
				lbEntry.AddClass('leaderboard-entry--short-page-end');
			}
			lbEntry.SetDialogVariableInt('rank', record.rank);
			lbEntry.SetDialogVariable('player', record.playerName);
			lbEntry.SetDialogVariableFloat('time', record.runTime);

			if (
				this.state.filter === LeaderboardRecordsFilter.FRIENDS ||
				this.state.filter === LeaderboardRecordsFilter.LOBBY
			) {
				this.createMembershipGroupIndicators(shownRecords, record.rank, lbEntry, index);
			} else if (this.state.filter === LeaderboardRecordsFilter.GLOBAL) {
				const group = getCompletionGroup(record.rank, this.groupEnds);
				const matchedGroup = group !== getCompletionGroup(record.rank + 1, this.groupEnds) ? group : undefined;
				this.createBoundaryGroupIndicators(matchedGroup, lbEntry, index);
			}

			const avatar = lbEntry.FindChildTraverse<AvatarImage>('LeaderboardEntryAvatarPanel');
			avatar.steamid = record.steamID;

			lbEntry.SetPanelEvent('oncontextmenu', () => this.showEntryContextMenu(pageIndex, record));

			if (this.currentUserRank === record.rank) {
				lbEntry.AddClass('leaderboard-entry--localplayer');
			}
		});

		this.updateEmptyState(shown.length === 0, status);
	}

	/** Pixel Y of the border under the row at `index`, for the group pills. */
	private groupBorderY(index: number) {
		return this.classicStyle
			? (index + 1) * ENTRY_HEIGHT_CLASSIC + PILL_VERTICAL_ADJUSTMENT_CLASSIC
			: (index + 1) * ENTRY_HEIGHT + PILL_VERTICAL_ADJUSTMENT;
	}

	private showEntryContextMenu(index: number, record: LeaderboardRecord) {
		const items: UiToolkitAPI.SimpleContextMenuItem[] = [
			{
				label: $.Localize('#Action_WatchReplay'),
				icon: 'file://{images}/movie-open-outline.svg',
				style: 'icon-color-mid-blue',
				jsCallback: () => this.panels.cp.playRecordReplay(index)
			},
			{
				label: $.Localize('#Action_SetComparisonRun'),
				icon: 'file://{images}/chart-timeline.svg',
				style: 'icon-color-light-blue',
				jsCallback: () => this.panels.cp.setRecordComparisonRun(index)
			}
		];

		// Only saved replays live on disk and can be deleted.
		if (this.state.filter === LeaderboardRecordsFilter.SAVED_REPLAYS) {
			items.push({
				label: $.Localize('#Action_DeleteReplay'),
				icon: 'file://{images}/delete.svg',
				style: 'icon-color-red',
				jsCallback: () =>
					UiToolkitAPI.ShowGenericPopupOkCancel(
						$.Localize('#Action_DeleteReplay'),
						$.Localize('#Action_DeleteReplay_Confirm'),
						'ok-cancel-popup',
						() => this.deleteReplay(index),
						() => {}
					)
			});
		}

		items.push({
			label: $.Localize('#Action_ShowSteamProfile'),
			icon: 'file://{images}/social/steam.svg',
			style: 'icon-color-steam-online',
			jsCallback: () => SteamOverlayAPI.OpenToProfileID(record.steamID)
		});

		UiToolkitAPI.ShowSimpleContextMenu('', 'ControlsLibSimpleContextMenu', items);
	}

	private createBoundaryGroupIndicators(matchedGroup: CompletionGroup, lbEntry: LeaderboardEntry, index: number) {
		if (matchedGroup === undefined || matchedGroup === CompletionGroup.WORLD_RECORD) return;

		const groupName = CompletionGroup[matchedGroup];
		lbEntry.AddClass(`leaderboard-entry--group-${groupName}`);

		const borderY = this.groupBorderY(index); // pixel Y of the border line
		const pill = $.CreatePanel('GroupPill', this.panels.groupPillsLayer, '', {
			class: 'group-pill group-pill--leaderboards-pill group-pill--solid'
		});
		pill.style.transform = `translate3d(${GROUP_BORDER_LEFT_ALIGN}px, ${borderY}px, 0px) translateY(${GROUP_BORDER_TOP_ALIGN}px)`;
		pill.handler.setGroup(matchedGroup);
	}

	private createMembershipGroupIndicators(
		records: LeaderboardRecord[],
		rank: number,
		lbEntry: LeaderboardEntry,
		index: number
	) {
		const currentGroup = getCompletionGroup(rank, this.groupEnds);
		if (currentGroup == null || currentGroup === CompletionGroup.WORLD_RECORD) return;

		const nextRecord = records[index + 1];

		if (nextRecord && getCompletionGroup(nextRecord.rank, this.groupEnds) === currentGroup) {
			return;
		}

		const groupName = CompletionGroup[currentGroup];

		lbEntry.AddClass(`leaderboard-entry--group-${groupName}`);

		const borderY = this.groupBorderY(index);

		const pill = $.CreatePanel('GroupPill', this.panels.groupPillsLayer, '', {
			class: 'group-pill group-pill--leaderboards-pill group-pill--solid'
		});

		pill.style.transform = `translate3d(${GROUP_BORDER_LEFT_ALIGN}px, ${borderY}px, 0px) translateY(${GROUP_BORDER_TOP_ALIGN}px)`;
		pill.handler.setGroup(currentGroup);
	}

	previousPage() {
		this.selectPage(this.viewPage - 1);
	}

	nextPage() {
		this.selectPage(this.viewPage + 1);
	}

	previousGroup() {
		if (!this.groupEnds) return;

		this.selectPage(this.getPreviousGroupPage());
	}

	nextGroup() {
		if (!this.groupEnds) return;

		this.selectPage(this.getNextGroupPage());
	}

	/** Page the "previous group" button would jump to, or the current page if there's none. */
	private getPreviousGroupPage(): number {
		const pastPages = this.getBoundaryPages().filter((page) => page < this.viewPage);

		return pastPages.length > 0 ? Math.max(...pastPages) : 1;
	}

	/** Page the "next group" button would jump to, or the current page if there's none. */
	private getNextGroupPage(): number {
		// Group boundaries are derived from total completions and routinely fall beyond the last
		// page of records (the min group sizes are large), so ignore any that aren't reachable.
		const futurePages = this.getBoundaryPages().filter((page) => page > this.viewPage && page <= this.totalViews);

		return futurePages.length > 0 ? Math.min(...futurePages) : this.totalViews;
	}

	private getBoundaryPages(): number[] {
		if (!this.groupEnds) return [];

		const pages = this.groupEnds.map((rank) => Math.ceil(rank / this.rowsPerView()));

		return Array.from(new Set(pages)).sort((a, b) => a - b);
	}

	/** Disable page/group navigation buttons that wouldn't move anywhere from the current page. */
	private updateControlButtons() {
		const { pagePrev, pageNext, groupPrev, groupNext } = this.panels.controls;

		pagePrev.enabled = this.viewPage > 1;
		pageNext.enabled = this.viewPage < this.totalViews;

		groupPrev.enabled = this.getPreviousGroupPage() !== this.viewPage;
		groupNext.enabled = this.getNextGroupPage() !== this.viewPage;

		this.updateAroundButton();
	}

	/** Page holding the player's own run, or null if they have no run on this track. */
	private getPersonalBestPage(): number | null {
		return this.currentUserRank ? Math.ceil(this.currentUserRank / this.rowsPerView()) : null;
	}

	private updateAroundButton() {
		const pbPage = this.getPersonalBestPage();
		const enabled =
			pbPage !== null && pbPage !== this.viewPage && this.state.filter === LeaderboardRecordsFilter.GLOBAL;

		this.panels.around.enabled = enabled;

		// Toggle tooltip display on hover
		this.panels.aroundTooltip.hittest = enabled;
		this.panels.aroundTooltip.hittestchildren = enabled;
	}

	/**
	 * Go to a shown page. Within the loaded records page (the other half of a Classic map selector page) it just
	 * re-renders; otherwise it requests the records page that holds it.
	 */
	selectPage(page: number) {
		const clamped = Math.min(Math.max(1, page), Math.max(1, this.totalViews));
		this.viewPage = clamped;

		if (this.panels.controls.pageSelect.text !== `${clamped}`) {
			this.setTextEntry(clamped);
		}

		const recordsPage = Math.ceil(clamped / this.viewsPerPage());
		if (recordsPage === this.state.page && this.loaded) {
			this.renderView();
			return;
		}

		this.state.page = recordsPage;
		this.updateLeaderboards();
	}

	showAroundPage() {
		const pbPage = this.getPersonalBestPage();
		if (pbPage === null || pbPage === this.viewPage) return;

		this.selectPage(pbPage);
	}

	setToolsAvailable(available: boolean) {
		this.panels.tools.visible = available;
	}

	openZoneEditor() {
		GameInterfaceAPI.ConsoleCommand('mom_zoning_enable 1');
		$.DispatchEvent('HudTabMenu_ForceClose');
	}

	openHudCustomizer() {
		GameInterfaceAPI.ConsoleCommand('mom_hudcustomizer_enable 1');
		$.DispatchEvent('HudTabMenu_ForceClose');
	}

	private setTextEntry(val: number) {
		this.blockTextEntryEvent = true;
		this.panels.controls.pageSelect.text = `${val}`;
		this.blockTextEntryEvent = false;
	}

	private deleteReplay(index: number) {
		this.panels.cp.deleteRecordReplay(index);
		this.updateLeaderboards();
	}
}
