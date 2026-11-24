import { getTrack } from './leaderboard';
import { checkDosa } from 'util/dont-show-again';
import type { MMap, MapCompletion } from './web/types/models/models';
import { MapStatuses } from './web/enums/map-status.enum';
import { MapCreditType } from './web/enums/map-credit-type.enum';
import { TrackType } from './web/enums/track-type.enum';
import { Style } from './web/enums/style.enum';

/**
 * A track's REST completion status plus per-track data the game adds from its map
 * cache, which the website deliberately doesn't return (it's only needed by the
 * front end):
 * - `tier`: Leaderboard.tier is null for submission maps, so the game sources it.
 * - `time`: the user's PB time, cached per track/style since it only changes when
 *   they submit a run (so it's not refetched on every map selection).
 */
export interface TrackCompletionInfo extends Omit<MapCompletion, 'totalCompletions'> {
	/** Absent until the map's completions have been fetched, as is `rank`. */
	totalCompletions?: number;
	/** Track tier, sourced game-side from the map cache. 0 for stages (no tier). */
	tier: number;
	/** The user's PB time, from the map cache. null if not completed. */
	time: number | null;
}

/**
 * The local user's per-track completions for a map, in a single gamemode + style.
 * Read from the map cache via `MapCacheAPI.GetCompletions` and pushed to the map selector /
 * tab menu via the `MapCache_CompletionsUpdate` event.
 *
 * This is a game-only wrapper around the website's `MapCompletion[]` (the REST API
 * returns a bare array), so it lives here rather than in the web-synced `common/web`.
 */
export interface MapUserCompletions {
	mapID: number;
	gamemode: Gamemode;
	style: Style;
	tracks: TrackCompletionInfo[];
	/** The latest fetch failed, so `tracks` is only what was cached before it. */
	fetchFailed: boolean;
}

/**
 * Download or launch a map, show missing games popup first if required games are not mounted
 */
export function handlePlayMap(mapData: MapCacheAPI.MapData, gamemodeOverride: Gamemode = null) {
	if (!mapData.mapFileExists) {
		// Not downloaded yet - always autoplay once it finishes.
		$.DispatchEvent('MapSelector_TryPlayMap', mapData.staticData.id);
		return;
	}

	const requiredGames = mapData.staticData.info?.requiredGames;
	const mountedGames = GameInterfaceAPI.GetMountedSteamApps();
	const missingGames = requiredGames?.filter((game) => !mountedGames.includes(game));

	if (missingGames?.length > 0 && !checkDosa('requiredGames')) {
		let params = `mapID=${mapData.staticData.id}&games=${requiredGames.join(',')}&dosaKey=requiredGames&dosaNameToken=Dosa_RequiredGames`;
		if (gamemodeOverride !== null) {
			params += `&gamemodeOverride=${gamemodeOverride}`;
		}

		UiToolkitAPI.ShowCustomLayoutPopupParameters(
			'RequiredGames',
			'file://{resources}/layout/modals/popups/required-games.xml',
			params
		);
	} else {
		if (gamemodeOverride !== null) {
			$.DispatchEvent('MapSelector_TryPlayMap_GameModeOverride', mapData.staticData.id, gamemodeOverride);
		} else {
			$.DispatchEvent('MapSelector_TryPlayMap', mapData.staticData.id);
		}
	}
}

// Play/download requests (MapSelector_TryPlayMap / _DownloadMap) are handled by the main map selector's C++ panel,
// which only exists once that page has loaded. Pages that play maps without it (the CS:S map selector, Stats) ask
// the main menu to load it hidden (MainMenu_PreloadMapSelector) and send the request once it answers
// (MainMenu_MapSelectorReady). Per script context, like all module state.
let mapSelectorReady = false;
let listeningForReady = false;
let heldPlay: (() => void) | null = null;
let heldPlayTimeout: uuid | null = null;
const MAP_SELECTOR_READY_TIMEOUT = 5; // seconds before trying anyway

function releaseHeldPlay() {
	if (heldPlayTimeout != null) {
		try {
			$.CancelScheduled(heldPlayTimeout);
		} catch {}
		heldPlayTimeout = null;
	}
	const play = heldPlay;
	heldPlay = null;
	play?.();
}

/**
 * handlePlayMap, but safe to call before the main map selector has ever been opened: the request is held until
 * the selector has loaded (it's loaded hidden on demand), then sent. Uses fresh cache data, since a caller's
 * snapshot can still say "not downloaded" for a map that has since been installed.
 */
export function handlePlayMapWhenReady(mapData: MapCacheAPI.MapData, gamemodeOverride: Gamemode = null) {
	if (!listeningForReady) {
		listeningForReady = true;
		$.RegisterForUnhandledEvent('MainMenu_MapSelectorReady', () => {
			mapSelectorReady = true;
			releaseHeldPlay();
		});
	}

	const play = () => {
		let fresh: MapCacheAPI.MapData | null = null;
		try {
			fresh = MapCacheAPI.GetMapData(mapData.staticData.id);
		} catch {
			fresh = null;
		}
		if (fresh) mapData.mapFileExists = fresh.mapFileExists;
		handlePlayMap(fresh ?? mapData, gamemodeOverride);
	};

	if (mapSelectorReady) {
		play();
		return;
	}
	heldPlay = play;
	$.DispatchEvent('MainMenu_PreloadMapSelector');
	heldPlayTimeout ??= $.Schedule(MAP_SELECTOR_READY_TIMEOUT, () => {
		heldPlayTimeout = null;
		releaseHeldPlay();
	});
}

export enum MapListType {
	APPROVED = 0,
	SUBMISSIONS = 1
}

/** Get the tier of a track, used a suggested tier if the map is in submission */
export function getTier(
	staticData: MMap,
	gamemode: Gamemode,
	trackType = TrackType.MAIN,
	trackNum = 1
): number | undefined {
	return MapStatuses.IN_SUBMISSION.includes(staticData.status)
		? staticData.submission.suggestions.find(
				(s) => s.gamemode === gamemode && s.trackType === trackType && s.trackNum === trackNum
			)?.tier
		: getTrack(staticData, gamemode, trackType, trackNum)?.tier;
}

/** Simplified credit object, derived from either a regular credit or a placeholder suggestion */
export interface SimpleMapCredit {
	alias: string;
	steamID?: string;
}

/**
 * Get collection of simplified credits data, optionally filtered by type.
 * If the map is in submission, placeholders suggestions are included, with steamID omitted.
 */
export function getAllCredits(staticData: MMap, type?: MapCreditType): SimpleMapCredit[] {
	const credits = [];

	let normal = staticData.credits;
	if (normal) {
		if (type !== undefined) {
			normal = normal?.filter(({ type: t }) => t === type);
		}

		credits.push(...normal.map(({ user: { alias, steamID } }) => ({ alias, steamID })));
	}

	if (!MapStatuses.IN_SUBMISSION.includes(staticData.status)) {
		return credits;
	}

	let placeholders = staticData.submission.placeholders;
	if (placeholders) {
		if (type !== undefined) {
			placeholders = placeholders?.filter(({ type: t }) => t === type);
		}

		credits.push(...placeholders.map(({ alias }) => ({ alias })));
	}

	return credits;
}

export function getAuthorNames(staticData: MMap): string {
	return getAllCredits(staticData, MapCreditType.AUTHOR)
		.map(({ alias }) => alias)
		.join(', ');
}
