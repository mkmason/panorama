import { PanelHandler } from 'util/module-helpers';
import * as MomMath from 'util/math';
import { rgbaStringLerp } from 'util/colors';
import { GamemodeCategory, GamemodeCategoryToGamemode } from 'common/web/enums/gamemode.enum';
import { CustomizerPropertyType, registerHUDCustomizerComponent } from 'common/hud-customizer';
import { ColorPair, SyncColors } from 'common/sync-colors';
import { rgbaStringToTuple } from 'util/colors';

// copied, since the customizer replaces its entries
const Colors: Record<string, ColorPair> = { ...SyncColors };

const DEFAULT_BUFFER_LENGTH = 10;
const DEFAULT_GRAPH_SAMPLES = 100;
const DEFAULT_GRAPH_LINE_COLOR = 'rgba(255, 255, 255, 0.5)' as color;
const DEFAULT_GRAPH_BOUND_COLOR = 'rgba(255, 255, 255, 0.5)' as color; // top/bottom edge lines, visible by default
// Graph background defaults to transparent — set in hud_default.kv3 and applied to the wrapper via the
// graphBackgroundColor color picker (styleProperty), so it's user-modifiable but off by default.
const GRAPH_MIN_SCALE = 1.05; // dynamic mode: scale at low speed (optimal line ~95%, near the top)
const GRAPH_DYN_MAX_SPEED = 2500; // dynamic mode: velocity at which the optimal line bottoms out
const GRAPH_DYN_FLOOR = 0.25; // dynamic mode: optimal line's lowest fraction (25%) at/above max speed
const GRAPH_SIZE_REFRESH = 60; // re-read the canvas size every N draws (layout reads aren't free)
const GRAPH_MIN_SLICE_PX = 0.5; // slices shorter than this aren't drawn (e.g. every sample while idle)
const GRAPH_MERGE_PX = 0.5; // neighbouring slices whose heights differ by less than this merge into one quad
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = 1 / RAD2DEG;

enum DisplayMode {
	HALF_WIDTH_THROTTLE = 'half_width',
	FULL_WIDTH_THROTTLE = 'full_width',
	STRAFE_INDICATOR = 'indicator',
	SYNCHRONIZER = 'synchronizer',
	GRAPH = 'graph'
}

// Graph display mode layout options (exposed in the HUD customizer).
enum GraphOrientation {
	HORIZONTAL = 'horizontal', // time runs left→right, value grows vertically
	VERTICAL = 'vertical' // time runs top→bottom, value grows horizontally
}
enum GraphOptimal {
	FLAT = 'flat', // optimal line is a constant reference (values are normalised to it)
	DYNAMIC = 'dynamic' // optimal line rises/falls with the optimal turn speed (values in real angles)
}

const SHOULD_INVERT_YAW_RATO = {
	[DisplayMode.HALF_WIDTH_THROTTLE]: false,
	[DisplayMode.FULL_WIDTH_THROTTLE]: true,
	[DisplayMode.STRAFE_INDICATOR]: true,
	[DisplayMode.SYNCHRONIZER]: true,
	[DisplayMode.GRAPH]: false
};

enum StatMode {
	OFF,
	ON,
	HIDE_BAR
}

@PanelHandler()
class StrafeTrainer {
	readonly panels = {
		wrapper: $('#BarWrapper'),
		segments: [$('#Segment0'), $('#Segment1'), $('#Segment2'), $('#Segment3'), $('#Segment4')],
		container: $('#Container'),
		needle: $('#Needle'),
		stats: [$<Label>('#StatsUpper'), $<Label>('#StatsLower')],
		graphWrapper: $('#GraphWrapper'),
		graphCanvas: $<UICanvas>('#GraphCanvas')
	};

	// Customizable
	displayMode: DisplayMode;
	indicatorPercentage = 90; // this value shows ~90% gain or better when strafe indicator touches needle
	syncGain = 10; // scale how fast the bars move
	// Graph mode
	graphOrientation: GraphOrientation = GraphOrientation.HORIZONTAL;
	graphOptimal: GraphOptimal = GraphOptimal.FLAT;
	graphSamples = DEFAULT_GRAPH_SAMPLES; // how many ticks of history the graph shows
	graphRange = 2; // headroom: axis top = graphRange × optimal (200% ⇒ optimal line at half height)
	graphLineColor: color = DEFAULT_GRAPH_LINE_COLOR; // colour of the "optimal" reference line
	graphBoundColor: color = DEFAULT_GRAPH_BOUND_COLOR; // colour of the top/bottom bound lines
	// Ring buffer of recent samples (fixed-size typed arrays, `graphHead` = index of the OLDEST sample, so
	// adding one is O(1) with no allocation). ratio = actual/optimal yaw (bar height vs the optimal line);
	// speed = horizontal velocity this tick (drives the dynamic scale); gain = gain ratio (bar colour).
	// Everything is scaled per-sample from these stored values, so old bars never rescale as new ticks
	// scroll in (a spike leaving the window doesn't shift the rest).
	graphRatio = new Float32Array(DEFAULT_GRAPH_SAMPLES);
	graphSpeed = new Float32Array(DEFAULT_GRAPH_SAMPLES);
	graphGain = new Float32Array(DEFAULT_GRAPH_SAMPLES);
	// Each sample's bar colour pair, resolved ONCE when the sample is recorded (getColorPair's lerps parse and
	// format rgba strings - far too slow to redo for every sample every frame).
	graphColors: [color, color][] = [];
	graphHead = 0;
	// Bumped whenever a colour setting changes, so the stored colour pairs get re-resolved once.
	colorVersion = 0;
	graphColorVersion = -1;
	// Cached canvas size in logical px (re-read every GRAPH_SIZE_REFRESH draws, or after a mode change).
	graphW = 0;
	graphH = 0;
	graphSizeAge = 0;
	// Scratch arrays reused for every draw call instead of allocating per slice.
	readonly polyPts: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
	readonly polyCols: string[] = ['', '', '', ''];
	readonly linePts: number[] = [0, 0, 0, 0];
	optPts: number[] = [];
	colorByGainEnable: boolean;
	dynamicEnable: boolean;
	flipEnable: boolean;
	interpFrames: number;
	minSpeed: number;
	showJumpCount: boolean;
	showTakeoffSpeed: boolean;
	showYawRatio: boolean;
	showGain: boolean;
	statColorEnable: boolean;
	strafeBarGradient = ['rgba(178, 178, 178, 1)', 'rgba(255, 255, 255, 1)'];
	// Both are always the same, this is so that colorStatsByGain can be simplified
	fontColor = ['rgba(255, 255, 255, 1)', 'rgba(255, 255, 255, 1)'];

	// Not yet customizable
	isFirstPanelColored = true; // gets toggled in wrapValueToRange()
	maxSegmentWidth = 25; // percentage of total element width
	firstPanelWidth = this.maxSegmentWidth;

	// Unused, this is a highlight color for the strafe bar
	altColor = 'rgba(0,0,0,0)' as color;

	sampleWeight: number;
	gainRatioHistory: number[];
	yawRatioHistory: number[];

	constructor() {
		registerHUDCustomizerComponent($.GetContextPanel(), {
			name: $.Localize('#Customizer_Strafe_Trainer_Name'),
			resizeX: true,
			resizeY: true, // graph mode benefits from a taller panel (esp. the vertical layout)
			gamemode: [
				...GamemodeCategoryToGamemode.get(GamemodeCategory.SURF),
				...GamemodeCategoryToGamemode.get(GamemodeCategory.BHOP),
				...GamemodeCategoryToGamemode.get(GamemodeCategory.CLIMB)
			],
			events: { event: 'HudProcessInput', panel: $.GetContextPanel(), callbackFn: () => this.onUpdate() },
			unhandledEvents: { event: 'OnJumpStarted', callbackFn: () => this.updateStats() },
			dynamicStyles: {
				displayMode: {
					name: $.Localize('#Customizer_Strafe_Trainer_DisplayMode'),
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{
							label: 'Half Width',
							value: DisplayMode.HALF_WIDTH_THROTTLE
						},
						{
							label: 'Full Width',
							value: DisplayMode.FULL_WIDTH_THROTTLE
						},
						{
							label: 'Indicator',
							value: DisplayMode.STRAFE_INDICATOR
						},
						{
							label: 'Synchronizer',
							value: DisplayMode.SYNCHRONIZER
						},
						{
							label: 'Graph',
							value: DisplayMode.GRAPH
						}
					],
					children: [
						{
							styleID: 'indicatorPercentage',
							showWhen: DisplayMode.STRAFE_INDICATOR
						},
						{
							styleID: 'synchronizerSpeed',
							showWhen: DisplayMode.SYNCHRONIZER
						},
						{
							styleID: 'needleWidth',
							showWhen: [DisplayMode.HALF_WIDTH_THROTTLE, DisplayMode.STRAFE_INDICATOR]
						},
						{
							styleID: 'needleColor',
							showWhen: [DisplayMode.HALF_WIDTH_THROTTLE, DisplayMode.STRAFE_INDICATOR]
						},
						{
							styleID: 'graphOrientation',
							showWhen: DisplayMode.GRAPH
						},
						{
							styleID: 'graphOptimalLine',
							showWhen: DisplayMode.GRAPH
						},
						{
							styleID: 'graphSamples',
							showWhen: DisplayMode.GRAPH
						},
						{
							styleID: 'graphRange',
							showWhen: DisplayMode.GRAPH
						},
						{
							styleID: 'graphLineColor',
							showWhen: DisplayMode.GRAPH
						},
						{
							styleID: 'graphBoundColor',
							showWhen: DisplayMode.GRAPH
						},
						{
							styleID: 'graphBackgroundColor',
							showWhen: DisplayMode.GRAPH
						},
						// "Follow strafe direction" / "Flip directions" only steer the bar's left/right growth,
						// which is meaningless for the time-based graph — hide them there.
						{
							styleID: 'dynamicMode',
							showWhen: [
								DisplayMode.HALF_WIDTH_THROTTLE,
								DisplayMode.FULL_WIDTH_THROTTLE,
								DisplayMode.STRAFE_INDICATOR,
								DisplayMode.SYNCHRONIZER
							]
						},
						{
							styleID: 'flipDirections',
							showWhen: [
								DisplayMode.HALF_WIDTH_THROTTLE,
								DisplayMode.FULL_WIDTH_THROTTLE,
								DisplayMode.STRAFE_INDICATOR,
								DisplayMode.SYNCHRONIZER
							]
						}
					],
					callbackFunc: (_, value) => {
						this.updateDisplayMode(value as DisplayMode);
					}
				},
				indicatorPercentage: {
					name: $.Localize('#Customizer_Strafe_Trainer_IndicatorPercentage'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => (this.indicatorPercentage = value),
					onChanged: () => this.updateDisplayMode(this.displayMode),
					settingProps: { min: 80, max: 99 }
				},
				synchronizerSpeed: {
					name: $.Localize('#Customizer_Strafe_Trainer_SynchronizerSpeed'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => (this.syncGain = value),
					settingProps: { min: 1, max: 20 }
				},
				graphOrientation: {
					name: $.Localize('#Customizer_Strafe_Trainer_GraphOrientation'),
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{ label: 'Horizontal', value: GraphOrientation.HORIZONTAL },
						{ label: 'Vertical', value: GraphOrientation.VERTICAL }
					],
					callbackFunc: (_, value) => (this.graphOrientation = value as GraphOrientation)
				},
				graphOptimalLine: {
					name: $.Localize('#Customizer_Strafe_Trainer_GraphOptimalLine'),
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{ label: 'Flat', value: GraphOptimal.FLAT },
						{ label: 'Dynamic', value: GraphOptimal.DYNAMIC }
					],
					callbackFunc: (_, value) => (this.graphOptimal = value as GraphOptimal)
				},
				// min is kept at 1 (not the "real" minimum) because a NumberEntry clamps on every keystroke,
				// so a higher min makes multi-digit values impossible to type. The callbacks clamp to the
				// sensible range instead.
				graphSamples: {
					name: $.Localize('#Customizer_Strafe_Trainer_GraphSamples'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => this.updateGraphSamples(value),
					settingProps: { min: 1, max: 500, increment: 10 }
				},
				graphRange: {
					name: $.Localize('#Customizer_Strafe_Trainer_GraphRange'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) =>
						(this.graphRange = Number.isFinite(value) ? Math.max(1.05, value / 100) : 2),
					settingProps: { min: 1, max: 500, increment: 5 }
				},
				graphLineColor: {
					name: $.Localize('#Customizer_Strafe_Trainer_GraphLineColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					callbackFunc: (_, value) => (this.graphLineColor = value as color)
				},
				graphBoundColor: {
					name: $.Localize('#Customizer_Strafe_Trainer_GraphBoundColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					callbackFunc: (_, value) => (this.graphBoundColor = value as color)
				},
				graphBackgroundColor: {
					name: $.Localize('#Customizer_Strafe_Trainer_GraphBackgroundColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					// the graph area (behind the canvas) so the background only covers the graph, not the labels
					targetPanel: '.strafetrainer__graph-area',
					styleProperty: 'backgroundColor'
				},
				needleWidth: {
					name: $.Localize('#Customizer_Strafe_Trainer_NeedleWidth'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					targetPanel: '.strafetrainer__needle',
					styleProperty: 'width',
					valueFn: (value) => `${value}px`
				},
				needleColor: {
					name: $.Localize('#Customizer_Strafe_Trainer_NeedleColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.strafetrainer__needle',
					styleProperty: 'backgroundColor'
				},
				averagingWindow: {
					name: $.Localize('#Customizer_Strafe_Trainer_AveragingWindow'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => this.updateBufferLength(value),
					settingProps: { min: 1, max: 20 }
				},
				minSpeed: {
					name: $.Localize('#Customizer_Strafe_Trainer_MinSpeed'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					callbackFunc: (_, value) => (this.minSpeed = value)
				},
				dynamicMode: {
					name: $.Localize('#Customizer_Strafe_Trainer_DynamicMode'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => (this.dynamicEnable = value)
				},
				flipDirections: {
					name: $.Localize('#Customizer_Strafe_Trainer_FlipDirections'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => (this.flipEnable = value)
				},
				showLabels: {
					name: $.Localize('#Customizer_ShowLabels'),
					type: CustomizerPropertyType.NONE,
					expandable: true,
					children: [
						{ styleID: 'showJumpCount' },
						{ styleID: 'showTakeoffSpeed' },
						{ styleID: 'showYawRatio' },
						{ styleID: 'showGain' },
						{ styleID: 'colorStats' }
					]
				},
				showJumpCount: {
					name: $.Localize('#Customizer_Strafe_Trainer_ShowJumpCount'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => (this.showJumpCount = value),
					onChanged: () => this.updateStats()
				},
				showTakeoffSpeed: {
					name: $.Localize('#Customizer_ShowTakeoffSpeed'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => (this.showTakeoffSpeed = value),
					onChanged: () => this.updateStats()
				},
				showYawRatio: {
					name: $.Localize('#Customizer_ShowYawRatio'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => (this.showYawRatio = value),
					onChanged: () => this.updateStats()
				},
				showGain: {
					name: $.Localize('#Customizer_ShowGain'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => (this.showGain = value),
					onChanged: () => this.updateStats()
				},
				fontStyling: {
					name: $.Localize('#Customizer_FontStyling'),
					type: CustomizerPropertyType.NONE,
					expandable: true,
					children: [{ styleID: 'font' }, { styleID: 'fontSize' }, { styleID: 'fontColor' }]
				},
				font: {
					name: $.Localize('#Customizer_Font'),
					type: CustomizerPropertyType.FONT_PICKER,
					targetPanel: ['.strafetrainer__stats--upper', '.strafetrainer__stats--lower'],
					styleProperty: 'fontFamily',
					valueFn: (value) => `"${value}"`
				},
				fontSize: {
					name: $.Localize('#Customizer_FontSize'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					targetPanel: ['.strafetrainer__stats--upper', '.strafetrainer__stats--lower'],
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`
				},
				fontColor: {
					name: $.Localize('#Customizer_FontColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: ['.strafetrainer__stats--upper', '.strafetrainer__stats--lower'],
					styleProperty: 'color',
					callbackFunc: (_, value) => (this.fontColor = [value, value])
				},
				colors: {
					name: $.Localize('#Customizer_Colors'),
					type: CustomizerPropertyType.NONE,
					expandable: true,
					children: [
						{ styleID: 'backgroundColor' },
						{ styleID: 'needleColor' },
						{ styleID: 'colorStats' },
						{ styleID: 'colorByGain' }
					]
				},
				backgroundColor: {
					name: $.Localize('#Customizer_BackgroundColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: ['.strafetrainer__background', '.strafetrainer__container'],
					callbackFunc: (panel, value) => {
						const alpha = rgbaStringToTuple(value as rgbaColor)[3] / 255;
						if (panel.id === 'Container') {
							panel.style.boxShadow = `fill 0px 0px 12px -6px rgba(0, 0, 0, ${alpha})`;
							panel.style.backgroundColor =
								`gradient(linear, 0% 0%, 0% 100%, from(rgba(255, 255, 255, ${alpha * 0.02})), to(rgba(0, 0, 0, ${alpha * 0.5})))` as color;
						} else panel.style.backgroundColor = value as color;
					}
				},
				// TODO: It's annoying you can't see gainGradients when this changes. Not sure what to do about it
				colorStats: {
					name: $.Localize('#Customizer_Strafe_Trainer_ColorStats'),
					type: CustomizerPropertyType.CHECKBOX,
					callbackFunc: (_, value) => (this.statColorEnable = value),
					onChanged: () => this.updateStats()
				},

				colorByGain: {
					name: $.Localize('#Customizer_Strafe_Trainer_ColorByGain'),
					type: CustomizerPropertyType.CHECKBOX,
					children: [
						{ styleID: 'gainGradients', showWhen: true },
						{ styleID: 'strafeBarColor', showWhen: false }
					],
					callbackFunc: (_, value) => {
						this.colorByGainEnable = value;
						this.colorVersion++;
					}
				},
				strafeBarColor: {
					name: $.Localize('#Customizer_Strafe_Trainer_StrafeBarColor'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						this.strafeBarGradient = value;
						this.colorVersion++;
					}
				},
				gainGradients: {
					name: $.Localize('#Customizer_Strafe_Trainer_GainGradients'),
					type: CustomizerPropertyType.NONE,
					expandable: true,
					children: [
						{ styleID: 'gainExtra' },
						{ styleID: 'gainPerfect' },
						{ styleID: 'gainGood' },
						{ styleID: 'gainSlow' },
						{ styleID: 'gainNeutral' },
						{ styleID: 'gainLoss' },
						{ styleID: 'gainStop' }
					]
				},
				gainExtra: {
					name: $.Localize('#Customizer_Strafe_Trainer_GainExtra'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						Colors.EXTRA = value as [color, color];
						this.colorVersion++;
					}
				},
				gainPerfect: {
					name: $.Localize('#Customizer_Strafe_Trainer_GainPerfect'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						Colors.PERFECT = value as [color, color];
						this.colorVersion++;
					}
				},
				gainGood: {
					name: $.Localize('#Customizer_Strafe_Trainer_GainGood'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						Colors.GOOD = value as [color, color];
						this.colorVersion++;
					}
				},
				gainSlow: {
					name: $.Localize('#Customizer_Strafe_Trainer_GainSlow'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						Colors.SLOW = value as [color, color];
						this.colorVersion++;
					}
				},
				gainNeutral: {
					name: $.Localize('#Customizer_Neutral'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						Colors.NEUTRAL = value as [color, color];
						this.colorVersion++;
					}
				},
				gainLoss: {
					name: $.Localize('#Customizer_Loss'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						Colors.LOSS = value as [color, color];
						this.colorVersion++;
					}
				},
				gainStop: {
					name: $.Localize('#Customizer_Strafe_Trainer_GainStop'),
					type: CustomizerPropertyType.GRADIENT_PICKER,
					callbackFunc: (_, value) => {
						Colors.STOP = value as [color, color];
						this.colorVersion++;
					}
				}
			},
			postInit: () => this.updateStats()
		});
	}

	onUpdate() {
		const hudData = MomentumMovementAPI.GetMoveHudData();
		const lastTickStats = MomentumMovementAPI.GetLastTickStats();

		// zero buffers
		this.addToBuffer(this.gainRatioHistory, 0);
		this.addToBuffer(this.yawRatioHistory, 0);

		const bValidWishMove = MomMath.magnitude2D(hudData.wishVel) > 0.1;
		const strafeRight = (bValidWishMove ? 1 : 0) * lastTickStats.strafeRight;
		const direction = this.dynamicEnable ? strafeRight : 1;
		const flip = this.flipEnable ? -1 : 1;

		if (bValidWishMove && MomMath.sumOfSquares2D(MomentumPlayerAPI.GetVelocity()) > Math.pow(this.minSpeed, 2)) {
			this.gainRatioHistory[this.interpFrames - 1] =
				this.sampleWeight * this.NaNCheck(lastTickStats.speedGain / lastTickStats.idealGain, 0);

			const ratio = SHOULD_INVERT_YAW_RATO[this.displayMode]
				? 1 - lastTickStats.yawRatio
				: lastTickStats.yawRatio;
			this.yawRatioHistory[this.interpFrames - 1] = this.sampleWeight * this.NaNCheck(ratio, 0);
		}

		const gainRatio = this.getBufferedSum(this.gainRatioHistory);
		const yawRatio = this.getBufferedSum(this.yawRatioHistory);

		// The bar colour is only used by the bar modes - graph mode colours each sample itself.
		let color = '' as color;
		if (this.displayMode !== DisplayMode.GRAPH) {
			const colorTuple = this.colorByGainEnable
				? this.getColorPair(gainRatio, false) //strafeRight * yawRatio > 1
				: this.strafeBarGradient;
			color = `gradient(linear, 0% 0%, 0% 100%, from(${colorTuple[0]}), to(${colorTuple[1]}))` as color;
		}
		let flow;

		switch (this.displayMode) {
			case DisplayMode.HALF_WIDTH_THROTTLE:
				flow = direction * flip;
				this.panels.container.style.flowChildren = flow < 0 ? 'left' : 'right';
				this.panels.segments[0].style.backgroundColor = color;
				this.panels.segments[0].style.width = (yawRatio * 50).toFixed(3) + '%';
				break;
			case DisplayMode.FULL_WIDTH_THROTTLE: {
				const absRatio = Math.abs(gainRatio);
				flow = direction * (yawRatio > 1 ? -1 : 1) * flip;
				this.panels.container.style.flowChildren = flow < 0 ? 'left' : 'right';
				this.panels.segments[0].style.backgroundColor = color;
				this.panels.segments[0].style.width = (absRatio * 100).toFixed(3) + '%';
				break;
			}
			case DisplayMode.STRAFE_INDICATOR: {
				this.panels.container.style.flowChildren = flip < 0 ? 'left' : 'right';
				// const offset = Math.min(Math.max(0.5 - (0.5 * direction * syncDelta) / idealDelta, 0), 1);
				const offset = Math.min(Math.max(0.5 - 0.5 * direction * yawRatio, 0), 1);
				this.panels.segments[0].style.width = (offset * this.indicatorPercentage).toFixed(3) + '%';
				this.panels.segments[1].style.backgroundColor = color;
				break;
			}
			case DisplayMode.SYNCHRONIZER:
				this.panels.container.style.flowChildren = flip < 0 ? 'left' : 'right';
				this.firstPanelWidth += this.syncGain * direction * yawRatio * lastTickStats.idealGain;
				this.firstPanelWidth = this.wrapValueToRange(this.firstPanelWidth, 0, this.maxSegmentWidth, true);
				this.panels.segments[0].style.width =
					this.NaNCheck(this.firstPanelWidth.toFixed(3), this.maxSegmentWidth) + '%';
				for (const [i, segment] of this.panels.segments.entries()) {
					const index = i + (this.isFirstPanelColored ? 1 : 0);
					segment.style.backgroundColor = index % 2 ? color : this.altColor;
				}
				break;
			case DisplayMode.GRAPH: {
				// Record this tick's yaw ratio (actual/optimal turn — bar height vs the optimal line), the
				// current speed (drives the dynamic scale), and gain ratio (bar colour), then redraw.
				// yawRatio > 1 = turning too fast, so the bar goes over the optimal line.
				const speed = MomMath.magnitude2D(MomentumPlayerAPI.GetVelocity());
				this.pushGraphSample(yawRatio, speed, gainRatio);
				// Nothing to draw while the HUD element is disabled in the customizer (samples still record).
				if (!$.GetContextPanel().enabled) break;
				this.drawGraph();
				break;
			}
		}
	}

	// Happens onJump and whenever any setting related to stats is changed
	updateStats() {
		const lastJumpStats = MomentumMovementAPI.GetLastJumpStats();
		const statsTopText = [];
		if (this.showJumpCount) {
			const colon = this.showTakeoffSpeed || this.showYawRatio ? ': ' : '';
			statsTopText.push(`${lastJumpStats.jumpCount}${colon}`);
		}

		if (this.showTakeoffSpeed) {
			const takeoffSpeed = `${lastJumpStats.takeoffSpeed.toFixed(0)}`;
			statsTopText.push(this.showJumpCount ? takeoffSpeed.padStart(5, ' ') : takeoffSpeed);
		}

		if (this.showYawRatio) {
			const yaw = `${(lastJumpStats.yawRatio * 100).toFixed(2)}%`;
			statsTopText.push(this.showTakeoffSpeed ? `(${yaw})`.padStart(10, ' ') : yaw);
		}

		this.panels.stats[0].text = statsTopText.join(' ');
		this.panels.stats[1].text = this.showGain ? (lastJumpStats.speedGain * 100).toFixed(2) : ' ';

		const colorPair = this.statColorEnable
			? this.getColorPair(lastJumpStats.speedGain, lastJumpStats.yawRatio > 0)
			: this.fontColor;
		for (const stat of this.panels.stats) {
			stat.style.color = colorPair[1];
		}
	}

	getColorPair(ratio: number, overStrafing: boolean) {
		// cases where gain effectiveness is >90%
		if (ratio > 1.02) return Colors.EXTRA;
		else if (ratio > 0.99) return Colors.PERFECT;
		else if (ratio > 0.95) return Colors.GOOD;
		else if (ratio <= -5) return Colors.STOP;

		const lerpColorPairs = (c1: [color, color], c2: [color, color], alpha: number) => {
			return [rgbaStringLerp(c1[0], c2[0], +alpha.toFixed(3)), rgbaStringLerp(c1[1], c2[1], +alpha.toFixed(3))];
		};

		// cases where gain effectiveness is <90%
		if (!overStrafing) {
			if (ratio > 0.85) return lerpColorPairs(Colors.SLOW, Colors.GOOD, (ratio - 0.85) / 0.1);
			else if (ratio > 0.75) return Colors.SLOW;
			else if (ratio > 0.5) return lerpColorPairs(Colors.NEUTRAL, Colors.SLOW, (ratio - 0.5) / 0.25);
			else if (ratio > 0) return Colors.NEUTRAL;
			else if (ratio > -5) return lerpColorPairs(Colors.NEUTRAL, Colors.STOP, Math.abs(ratio) / 5);
		} else {
			if (ratio > 0.8) return lerpColorPairs(Colors.SLOW, Colors.GOOD, (ratio - 0.8) / 0.15);
			else if (ratio > 0) return lerpColorPairs(Colors.LOSS, Colors.SLOW, (ratio - 0.25) / 0.55);
			else if (ratio > -5) return lerpColorPairs(Colors.LOSS, Colors.STOP, Math.abs(ratio) / 5);
		}
	}

	wrapValueToRange(value: number, min: number, max: number, bShouldTrackWrap: boolean) {
		const range = max - min;
		while (value > max) {
			value -= range;
			if (bShouldTrackWrap) {
				this.isFirstPanelColored = !this.isFirstPanelColored; // less than clean way to track color flips
			}
		}
		while (value < min) {
			value += range;
			if (bShouldTrackWrap) {
				this.isFirstPanelColored = !this.isFirstPanelColored;
			}
		}
		return value;
	}

	findFastAngle(speed: number, maxSpeed: number, maxAccel: number) {
		const threshold = maxSpeed - maxAccel;
		return Math.acos(speed < threshold ? 1 : threshold / speed);
	}

	initializeBuffer(size: number): number[] {
		return Array.from({ length: size }).fill(0) as number[];
	}

	addToBuffer(buffer: number[], value: number) {
		buffer.push(value);
		buffer.shift();
	}

	getBufferedSum(history: number[]) {
		return history.reduce((sum, element) => sum + element, 0);
	}

	updateDisplayMode(newMode: DisplayMode) {
		this.displayMode = newMode;

		// Swap between the classic bar view and the graph canvas.
		const isGraph = newMode === DisplayMode.GRAPH;
		this.panels.wrapper.style.visibility = isGraph ? 'collapse' : 'visible';
		this.panels.graphWrapper.style.visibility = isGraph ? 'visible' : 'collapse';
		if (!isGraph) this.panels.graphCanvas?.Clear('#00000000');

		switch (this.displayMode) {
			case DisplayMode.HALF_WIDTH_THROTTLE:
				for (const segment of this.panels.segments) {
					segment.style.backgroundColor = this.altColor;
				}
				this.panels.needle.style.visibility = 'visible';
				break;
			case DisplayMode.FULL_WIDTH_THROTTLE:
				for (const segment of this.panels.segments) {
					segment.style.backgroundColor = this.altColor;
				}
				this.panels.needle.style.visibility = 'collapse';
				break;
			case DisplayMode.STRAFE_INDICATOR:
				this.panels.segments[1].style.width = 100 - this.indicatorPercentage + '%';
				this.panels.segments[2].style.width = 50 + '%';
				this.panels.segments[3].style.width = 50 + '%';
				for (const segment of this.panels.segments) {
					segment.style.backgroundColor = this.altColor;
				}
				this.panels.needle.style.visibility = 'visible';
				break;
			case DisplayMode.SYNCHRONIZER:
				for (const segment of this.panels.segments) {
					segment.style.width = this.maxSegmentWidth + '%';
				}
				this.panels.needle.style.visibility = 'collapse';
				break;
			case DisplayMode.GRAPH:
				this.panels.needle.style.visibility = 'collapse';
				// Start with a clean history + canvas so stale bars don't linger.
				this.resetGraphBuffer();
				this.panels.graphCanvas?.SetMaxDrawCommands(this.graphSamples * 8 + 64);
				this.graphSizeAge = 0; // the canvas just became visible - re-read its size
				this.drawGraph(); // draw the empty graph + optimal line immediately (e.g. in the customizer)
				break;
		}
	}

	updateBufferLength(newBufferLength: float) {
		this.interpFrames = newBufferLength ?? DEFAULT_BUFFER_LENGTH;
		this.sampleWeight = 1 / this.interpFrames;

		this.gainRatioHistory = this.initializeBuffer(this.interpFrames);
		this.yawRatioHistory = this.initializeBuffer(this.interpFrames);
	}

	updateGraphSamples(newLength: number) {
		this.graphSamples = Math.max(2, Math.round(newLength ?? DEFAULT_GRAPH_SAMPLES));
		this.resetGraphBuffer();
		// generous budget: a shaded quad may be several draw commands, so leave lots of headroom (dropping
		// commands would blank out slices at regular positions = static-looking vertical gaps).
		this.panels.graphCanvas?.SetMaxDrawCommands(this.graphSamples * 8 + 64);
	}

	/** Size the ring buffer to `graphSamples` and fill it with empty samples. */
	resetGraphBuffer() {
		const n = this.graphSamples;
		this.graphRatio = new Float32Array(n);
		this.graphSpeed = new Float32Array(n);
		this.graphGain = new Float32Array(n);
		const empty = this.sampleColor(0);
		this.graphColors = Array.from({ length: n }, () => empty);
		this.graphHead = 0;
		this.graphColorVersion = this.colorVersion;
		this.optPts = Array.from({ length: n * 2 }, () => 0);
	}

	/** Bar colour pair for a sample's gain ratio. */
	sampleColor(gain: number): [color, color] {
		const pair = this.colorByGainEnable ? this.getColorPair(gain, false) : this.strafeBarGradient;
		return (pair ?? this.strafeBarGradient) as [color, color];
	}

	/** Record one sample, overwriting the oldest. O(1), no allocation beyond a lerped colour pair. */
	pushGraphSample(ratio: number, speed: number, gain: number) {
		const n = this.graphRatio.length;
		if (n === 0) return;
		const i = this.graphHead;
		this.graphRatio[i] = ratio;
		this.graphSpeed[i] = speed;
		this.graphGain[i] = gain;
		this.graphColors[i] = this.sampleColor(gain);
		this.graphHead = (i + 1) % n;
	}

	/**
	 * Draws the strafe history onto the canvas: one slice per sample (the actual turn), coloured by that
	 * sample's speed gain, plus an "optimal" line and top/bottom bound lines. Turning too fast pushes the
	 * slice OVER the optimal line; too slow keeps it under.
	 *
	 * Each sample is scaled from its OWN stored values (never from a window aggregate), so old bars stay
	 * put as new ticks scroll in. Flat mode uses a fixed scale (`graphRange`) so the optimal line is level.
	 * Dynamic mode sets the scale per-tick from that tick's speed: ~GRAPH_MIN_SCALE at rest (optimal near
	 * the top) ramping to 1/GRAPH_DYN_FLOOR (optimal ~25%) at GRAPH_DYN_MAX_SPEED, then flat - so the
	 * optimal line falls as you speed up and bottoms out at max speed. Orientation just remaps coords.
	 *
	 * Performance (this runs every HudProcessInput): colours are pre-resolved per sample, buffers are reused
	 * (no per-slice allocation), zero-height slices are skipped, consecutive slices with the same height and
	 * colour are merged into one quad, and the flat-mode optimal line is a single segment.
	 */
	drawGraph() {
		const canvas = this.panels.graphCanvas;
		if (!canvas?.IsValid()) return;

		// Convert to logical pixels, accounting for UI scaling (see line-graph.ts). Layout reads aren't free,
		// so the size is cached and only re-read periodically (or when it was unknown).
		if (this.graphSizeAge <= 0 || !(this.graphW > 0) || !(this.graphH > 0)) {
			this.graphW = canvas.actuallayoutwidth / canvas.actualuiscale_x;
			this.graphH = canvas.actuallayoutheight / canvas.actualuiscale_y;
			this.graphSizeAge = GRAPH_SIZE_REFRESH;
		}
		this.graphSizeAge--;
		const W = this.graphW;
		const H = this.graphH;
		if (!(W > 0) || !(H > 0)) return;

		canvas.Clear('#00000000');

		const n = this.graphRatio.length;
		if (n === 0) return;

		// A colour setting changed since the samples were coloured - re-resolve them once.
		if (this.graphColorVersion !== this.colorVersion) {
			for (let k = 0; k < n; k++) this.graphColors[k] = this.sampleColor(this.graphGain[k]);
			this.graphColorVersion = this.colorVersion;
		}

		const horizontal = this.graphOrientation === GraphOrientation.HORIZONTAL;
		const dynamic = this.graphOptimal === GraphOptimal.DYNAMIC;
		const range = this.graphRange; // flat mode: the fixed scale

		const timeLen = horizontal ? W : H; // axis the samples march along (oldest -> newest)
		const valLen = horizontal ? H : W; // axis the value grows along

		const slot = timeLen / n; // width of one sample along the time axis
		// Slices tile edge-to-edge with a tiny overlap. A gap here would sit at a FIXED screen x while the
		// waveform scrolls through the slots, showing up as static vertical lines - so no gap, and the
		// overlap hides anti-aliased seams between the (opaque) slices.
		const overlap = 0.75;

		// This sample's scale = "axis top / optimal". Flat is a constant (graphRange). Dynamic ramps the
		// scale up with speed - from GRAPH_MIN_SCALE (optimal ~95%, at rest) to 1/GRAPH_DYN_FLOOR (optimal
		// ~25%) at GRAPH_DYN_MAX_SPEED, then flat - so the optimal line falls as you go faster.
		const dynMaxScale = 1 / GRAPH_DYN_FLOOR;
		const scaleOf = (speed: number) =>
			dynamic ? GRAPH_MIN_SCALE + (dynMaxScale - GRAPH_MIN_SCALE) * clamp01(speed / GRAPH_DYN_MAX_SPEED) : range;

		const pts = this.polyPts;
		const cols = this.polyCols;
		// One quad from time t0..t1 at value fraction f (canvas y grows downward), darker at the baseline.
		const drawSlice = (t0: number, t1: number, f: number, pair: [color, color]) => {
			if (horizontal) {
				const yTop = valLen - f * valLen;
				pts[0] = t0;
				pts[1] = valLen; // baseline
				pts[2] = t0;
				pts[3] = yTop; // tip
				pts[4] = t1;
				pts[5] = yTop;
				pts[6] = t1;
				pts[7] = valLen;
			} else {
				const x = f * valLen;
				pts[0] = 0;
				pts[1] = t0;
				pts[2] = x;
				pts[3] = t0;
				pts[4] = x;
				pts[5] = t1;
				pts[6] = 0;
				pts[7] = t1;
			}
			cols[0] = pair[0];
			cols[1] = pair[1];
			cols[2] = pair[1];
			cols[3] = pair[0];
			canvas.DrawShadedPoly(4, pts, cols);
		};

		// Slices: actual turn, coloured by gain. Walk oldest -> newest; consecutive samples with the same
		// height and colour extend one run instead of each drawing its own quad, and empty ones are skipped.
		let runStart = -1;
		let runF = 0;
		let runPair: [color, color] | null = null;
		const flush = (end: number) => {
			if (runStart >= 0 && runPair) drawSlice(runStart * slot - overlap, end * slot + overlap, runF, runPair);
			runStart = -1;
		};
		for (let i = 0; i < n; i++) {
			const k = (this.graphHead + i) % n;
			const f = clamp01(this.graphRatio[k] / scaleOf(this.graphSpeed[k]));
			const pair = this.graphColors[k];
			if (f * valLen < GRAPH_MIN_SLICE_PX) {
				flush(i); // nothing visible for this sample
				continue;
			}
			if (
				runStart >= 0 &&
				runPair !== null &&
				Math.abs(f - runF) * valLen < GRAPH_MERGE_PX &&
				(pair === runPair || (pair[0] === runPair[0] && pair[1] === runPair[1]))
			)
				continue; // same height + colour - extend the current run
			flush(i);
			runStart = i;
			runF = f;
			runPair = pair;
		}
		flush(n);

		// Bound lines along the top and bottom edges. Inset by HALF the line thickness so each line sits
		// flush against its edge (fully visible, not clipped) - the bottom line then covers the bar bases
		// instead of floating above them, so no slice colour peeks out below it.
		const edgeThick = 2;
		const lp = this.linePts;
		const line = (f: number, lineColor: color, thick: number) => {
			if (horizontal) {
				const y = valLen - f * valLen;
				lp[0] = 0;
				lp[1] = y;
				lp[2] = timeLen;
				lp[3] = y;
			} else {
				const x = f * valLen;
				lp[0] = x;
				lp[1] = 0;
				lp[2] = x;
				lp[3] = timeLen;
			}
			canvas.DrawLinePoints(2, lp, thick, lineColor);
		};
		const insetF = valLen > edgeThick ? edgeThick / 2 / valLen : 0;
		line(insetF, this.graphBoundColor, edgeThick); // baseline (flush with the bottom, over the bar bases)
		line(1 - insetF, this.graphBoundColor, edgeThick); // ceiling

		// Optimal line: level in flat mode (one segment), else a polyline through each sample's optimal fraction.
		if (!dynamic) {
			line(clamp01(1 / range), this.graphLineColor, 2);
			return;
		}
		const opt = this.optPts;
		for (let i = 0; i < n; i++) {
			const k = (this.graphHead + i) % n;
			const t = (i + 0.5) * slot;
			const f = clamp01(1 / scaleOf(this.graphSpeed[k]));
			if (horizontal) {
				opt[i * 2] = t;
				opt[i * 2 + 1] = valLen - f * valLen;
			} else {
				opt[i * 2] = f * valLen;
				opt[i * 2 + 1] = t;
			}
		}
		canvas.DrawLinePoints(n, opt, 2, this.graphLineColor);
	}

	NaNCheck(val: any, def: any) {
		return Number.isNaN(Number(val)) ? def : val;
	}
}
