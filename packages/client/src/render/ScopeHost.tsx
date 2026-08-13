/**
 * @seg/client/render/ScopeHost — the PixiJS scope canvas.
 *
 * One full-window canvas per match, owned by Pixi and driven by Pixi's ticker: React renders
 * the HUD that floats over it, and never touches the render loop (planning/08 §11). The map's
 * geometry is built once per match into a static container and never re-tessellated; moving
 * the camera is a transform on that container, which is the whole point of building it that
 * way (08 §3, performance budget).
 *
 * The map is drawn in its own coordinate frame — x right, y up, metres — through a flipped
 * `world` container, so everything downstream of here is written in the game's unit of record
 * (map/types.ts) and never in pixels. Where the container lands is `camera.ts`'s answer.
 *
 * The canvas is also the primary command surface, and it carries two commands on one button:
 * a left-click **picks the boat under the cursor**, or orders the picked boat to the water if
 * there is none (`pick.ts`, planning/08 §5). The hit test is here rather than in the HUD because
 * it needs the zoom — the pick tolerance is a number of screen pixels — and because the boats it
 * tests against are the ones this loop drew, read through the same getter and never through a
 * React render.
 *
 * **Firing is the space bar, aimed with the mouse.** The shot still goes to the point under the
 * cursor — that never stopped being a mouse gesture — but the trigger is a key, so the hand that
 * is aiming is not also the hand pressing the button. That means the cursor has to be tracked
 * whether or not it is over the canvas: the player may well be resting it on a HUD panel, and the
 * water under it is still a perfectly good aim point.
 *
 * **The world container starts almost empty.** A player is sent a `MapChart` with no rock in it
 * at all (ADR 0002), so what `buildWorld` lays down is the frame — water, surface, seabed — and
 * everything inside it arrives square by square through `sonar.ts`. A spectator's chart carries
 * ground truth and is drawn dim, because they did not earn it.
 */

import {
  type BoatTransient,
  type EntityId,
  type MapChart,
  type MapExtents,
  type FieldMapView,
  type PingReachView,
  type TeamId,
  type ThrottleNotch,
  type TorpedoSnapshot,
  type Vec2,
  type WreckView,
  type ZoneStatusView,
} from '@seg/shared';
import { Application, Container, Graphics } from 'pixi.js';
import { useEffect, useRef, type MutableRefObject } from 'react';

import {
  DEFAULT_VIEW_HEIGHT_M,
  PAN_KEYS,
  ZOOM_KEYS,
  type Camera,
  type Rect,
  type View,
  clampCamera,
  clampViewHeight,
  coreViewport,
  endCamera,
  gridStepFor,
  panByKeys,
  panByPixels,
  placeWorld,
  scaleFor,
  screenToWorld,
  zoomAt,
  zoomFactorForKeys,
  zoomFactorForWheel,
} from './camera.js';
import { releaseAudio, type SoundPlacement } from '../audio/context.js';
import { TransientCues } from '../audio/cues.js';
import { playPing } from '../audio/ping.js';
import { hullWeight, PropellerVoices } from '../audio/propeller.js';
import { TorpedoVoices } from '../audio/torpedo.js';
import { playTransient } from '../audio/transients.js';
import { ownsKeyboard } from '../ui/hud/typing.js';
import { COLORS } from './palette.js';
import { BOAT_PICK_SLOP_PX, boatAt, type PickableBoat } from './pick.js';
import type { SonarPicture } from './picture.js';
import { HostilePings, LaunchAlerts, PingRings, type PingRing } from './pings.js';
import { friendlyWeaponLength, traceSilhouette, traceWeaponIcon } from './silhouette.js';
import { FieldLayer, fieldRampGradient, fieldRangeText, fieldScaleLabels } from './field.js';
import { drawReach } from './reach.js';
import { SonarLayers } from './sonar.js';
import { drawTrails, TorpedoTrails } from './trails.js';
import { zoneStyle } from './zones.js';

/** Length of the core viewport's corner ticks, CSS pixels. */
const CORNER_TICK = 18;
/** How far the scale bar sits in from the core viewport's bottom-right corner, CSS pixels. */
const SCALE_BAR_MARGIN = 28;
/** And how much air is left between it and the field key above it, when there is one. */
const SCALE_KEY_GAP = 14;
/**
 * How far a pointer may wander before a press stops being a click and becomes a drag, CSS
 * pixels. Orders live on the click, so a press that ends up a pan must never fire one.
 */
const CLICK_SLOP_PX = 4;

/**
 * How far outside the frame a sound can still be heard, in screen radii.
 *
 * The falloff is measured against what is *on screen* rather than against metres, so it holds
 * at every zoom: a sound at the edge of the picture always seems the same distance away
 * whether the player is looking at a chamber or at the whole map. Three screens out is silence,
 * which keeps a fleet on the far side of the map from being a noise the player cannot see the
 * cause of — and, with propellers now running continuously, keeps the mix down to the handful of
 * boats the player is actually looking at.
 */
const AUDIBLE_SCREENS = 3;

/**
 * One friendly boat as the scope needs it: where it is, which way, whose it is, and what it sounds
 * like.
 *
 * The identifying half is `PickableBoat`, shared with the hit test (`pick.ts`) — the boat a
 * click selects has to be described by the same fields the frame drew, or the two would
 * eventually disagree about which hull is where.
 *
 * The acoustic half is here rather than in a second source because the audio is driven from this
 * same render loop, on the same frame, from the same read. Two getters would be two moments.
 */
export interface ScopeBoat extends PickableBoat {
  /** The tick of its last active pulse. A change is a pulse, and a pulse is a ring. */
  readonly lastPingTick: number;
  /** m/s along `facing`. Pitches and levels the propeller voice (`audio/propeller.ts`). */
  readonly speed: number;
  readonly throttle: ThrottleNotch;
  /** Which propeller is heard — the quiet screw, or the hiss. The server's answer. */
  readonly cavitating: boolean;
  /** Noise events still ringing on it. A new one plays a cue (`audio/cues.ts`). */
  readonly transients: readonly BoatTransient[];
}

/** One friendly boat's route, as the scope draws it: the line out of the boat. */
export interface ScopeRoute {
  readonly boatId: EntityId;
  /** The boat's position now — the line starts where the boat is, not where it was. */
  readonly pos: Vec2;
  /** The waypoints in order. The waypoint line *is* the receipt for the orders (nav.ts). */
  readonly waypoints: readonly Vec2[];
  /**
   * Whether this is the boat the player is commanding. The one line drawn at full strength.
   *
   * The distinction is the whole reason the other routes can be on screen at all — see
   * `drawRoutes`.
   */
  readonly selected: boolean;
  /** Yours, or a teammate's. Decides the colour, the way it does for the hull it comes out of. */
  readonly mine: boolean;
}

/**
 * How the scope reads the fleet.
 *
 * A pair of getters rather than a prop, because a view frame must not trigger a React render
 * of anything on the hot path (planning/08 §1). The renderer polls `revision` from its own
 * ticker and only rebuilds the boat layer when it moves.
 */
export interface ScopeFleet {
  revision(): number;
  boats(): readonly ScopeBoat[];
  /**
   * The team's weapons in the water. Empty on almost every frame.
   *
   * Read on the same trigger as `boats` and drawn in the same pass, because a torpedo and the
   * boat that fired it have to be at the same moment on screen — one of them lagging a frame
   * behind the other is exactly the sort of thing a player judging a lead would notice.
   */
  torpedoes(): readonly TorpedoSnapshot[];
  /**
   * Every wreck worth its own drawing pass — everyone's, not gated on the sonar picture, minus
   * the recipient's own dead (already drawn where `boats` draws the rest of the fleet). See
   * `hud/rows.ts#scopeWrecks`.
   *
   * Read on the same trigger as `boats`, for the same reason a torpedo is: a hull dying and its
   * hulk appearing have to land on the same frame.
   */
  wrecks(): readonly WreckView[];
  /**
   * The team's accumulated sonar picture, or `null` before `match.state` lands.
   *
   * Polled like everything else here. The picture is mutated in place by the store as frames
   * arrive (`state/match.ts`), so this getter returns the same object for the life of a match
   * and the sonar layers hold onto it.
   */
  picture(): SonarPicture | null;
  /**
   * The debug acoustic field being drawn, or `null` — which is what every ordinary match returns,
   * since the payload only arrives for a connection that asked for it (`debug/console.ts`).
   */
  field(): FieldMapView | null;
  /**
   * A counter bumped whenever that field changes.
   *
   * Its own trigger rather than `revision`, because the two arrive at different rates: a field
   * lands at `FIELD_MAP_HZ` and repainting its texture on every 10 Hz view frame would be the most
   * expensive no-op in the render loop.
   */
  fieldRevision(): number;
  /**
   * The ping-reach rings, or empty — which is what every ordinary match returns, and also what a
   * debug session returns while nothing in the water has its sonar on (`debug/console.ts`).
   */
  reach(): readonly PingReachView[];
  /**
   * A counter bumped whenever those rings change.
   *
   * Its own trigger rather than `revision`, even though the two move together while the overlay is
   * on: with it off, `revision` moves on every view frame and this does not, so the ring layer is
   * not redrawn sixty times a second for a list that is permanently empty.
   */
  reachRevision(): number;
  /**
   * The capture zones as of the latest frame, or empty in deathmatch.
   *
   * Polled like the fleet, and for the same reason — they arrive on the view frame, which must
   * not re-render React (planning/08 §1). Read whole rather than diffed: there are three of
   * them, and every field of one can move, position included.
   */
  zones(): readonly ZoneStatusView[];
  /** The simulation tick of the latest view frame. What a contact's age is measured against. */
  tick(): number;
  /** The boat the player has picked to command, or `null` for none. */
  selected(): EntityId | null;
  /**
   * Every friendly boat that has somewhere to be — the team's, not only the player's own, and
   * not only the selected one. Empty when the whole fleet is holding station.
   *
   * Read on the same trigger as `boats`, because a route and the hull it comes out of have to be
   * at the same moment on screen; and re-read on a change of *selection* too, since which of
   * these lines is drawn at full strength is a local decision that must not wait for a frame.
   */
  routes(): readonly ScopeRoute[];
}

/** What the HUD can ask of the camera. Populated while the scope is mounted. */
export interface ScopeControls {
  /** Centre on a world point, clamped like any other camera move. */
  lookAt(point: Vec2): void;
  /**
   * Whether a pointer is currently holding the scope in a drag.
   *
   * Asked before the *keyboard* jumps the camera. A drag is the player steering the camera by
   * hand, and a keypress that teleported it mid-gesture would leave the drag continuing from
   * a place the pointer was never put — the next pointer move would jerk the picture back by
   * however far the jump went. The mouse's own jumps do not ask, because a click on a HUD
   * panel cannot happen while the scope holds the pointer capture.
   */
  dragging(): boolean;
}

interface ScopeHostProps {
  readonly map: MapChart;
  /**
   * Whether the camera answers to the keyboard and the mouse. False while a modal owns the
   * screen: the Esc window is not a pause, but panning the scope from behind it is not what
   * a player pressing `S` for "settings" meant.
   */
  readonly inputEnabled?: boolean;
  /**
   * The side the viewer is on, or `null` for a spectator. Decides which way a capture blends
   * (`render/zones.ts`) and nothing else. Fixed for the match, but read through a ref like the
   * callbacks are, so it never rebuilds the Pixi scene.
   */
  readonly viewerTeam?: TeamId | null;
  readonly fleet?: ScopeFleet;
  /** Filled with the camera handle on mount, cleared on unmount. */
  readonly controls?: MutableRefObject<ScopeControls | null>;
  /**
   * A click on the water: send the selected boat to the world point under the cursor. The
   * shift flag is how a shift-click queues a leg on its route rather than replacing it.
   */
  readonly onOrder?: (to: Vec2, queue: boolean) => void;
  /**
   * **Space**: fire the selected boat's armed tubes at the point under the cursor.
   *
   * Aimed wherever the cursor is — over open water, over a wall, and over a hull. It does not
   * consult the hit test at all, which is the point: the shot a player most wants is the one at
   * something they can see, and a trigger that turned into a selection over a target would be
   * useless exactly when it mattered. Splitting the trigger off the mouse button is also what
   * lets the aim and the shot be two hands rather than one gesture.
   */
  readonly onFire?: (to: Vec2) => void;
  /**
   * A click on one of the player's own boats: pick it (planning/08 §5).
   *
   * Fired *instead of* `onOrder`, never as well — the two are the same gesture and the boat
   * wins. Ordering a boat to the water it is already sitting in is a command with no effect,
   * so nothing is lost by spending the click on the selection; the player who really wants
   * that order can click a hull's length away.
   */
  readonly onSelect?: (boat: EntityId) => void;
  /** A right-click on the water: cancel the selected boat's orders. */
  readonly onCancel?: () => void;
  /**
   * The debug console's `seg.spawn` has armed a placement: the *next* click on the viewport
   * spawns it here instead of picking or ordering. `MatchScreen` only supplies a callback while
   * one is armed, and clears the arm itself once this fires — so, like `onOrder`, this reports
   * the point and nothing else.
   */
  readonly onDebugSpawn?: ((at: Vec2) => void) | undefined;
}

export function ScopeHost({
  map,
  inputEnabled = true,
  viewerTeam = null,
  fleet,
  controls,
  onOrder,
  onFire,
  onSelect,
  onCancel,
  onDebugSpawn,
}: ScopeHostProps) {
  const mount = useRef<HTMLDivElement | null>(null);
  // Held keys, the input gate, and the fleet source live outside the Pixi effect: they change
  // far more often than the map does, and rebuilding the scene to learn that a menu opened —
  // or that a boat moved — would be absurd.
  const held = useRef<Set<string>>(new Set());
  const enabled = useRef(inputEnabled);
  const source = useRef<ScopeFleet | undefined>(fleet);
  /** The order callbacks, read by the mount's own listeners. Latest-wins, like `source`. */
  const order = useRef(onOrder);
  const shoot = useRef(onFire);
  const pick = useRef(onSelect);
  const cancel = useRef(onCancel);
  const debugSpawn = useRef(onDebugSpawn);
  const viewer = useRef(viewerTeam);
  /** The scale bar. Owned by the render loop, which writes to it directly. */
  const readout = useRef<HTMLDivElement | null>(null);
  /** The overlay's colour key, shown only while an overlay itself is. */
  const legend = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    enabled.current = inputEnabled;
    // A key still down when the menu opened would otherwise pan forever: its keyup lands on a
    // gate that ignores it, and nothing else ever clears it.
    if (!inputEnabled) held.current.clear();
  }, [inputEnabled]);

  useEffect(() => {
    source.current = fleet;
  }, [fleet]);

  // No dependency array: these are fresh closures every render, and the effect exists only to
  // keep the refs pointed at the latest ones without re-registering the canvas listeners.
  useEffect(() => {
    order.current = onOrder;
    shoot.current = onFire;
    pick.current = onSelect;
    cancel.current = onCancel;
    debugSpawn.current = onDebugSpawn;
    viewer.current = viewerTeam;
  });

  useEffect(() => {
    const host = mount.current;
    if (host === null) return;
    const el: HTMLElement = host;

    let disposed = false;
    let app: Application | null = null;
    let world: Container | null = null;
    let frame: Graphics | null = null;
    let grid: Graphics | null = null;
    let zones: Graphics | null = null;
    /**
     * The debug ping-reach rings (`render/reach.ts`). Empty on every ordinary match, and built
     * with the canvas rather than lazily for the reason the field overlay is: a developer typing
     * `seg.reach(true)` mid-match should not be waiting on a layer to be inserted.
     */
    let reachRings: Graphics | null = null;
    let route: Graphics | null = null;
    let boats: Graphics | null = null;
    /**
     * The wrecks everyone can see (`ScopeFleet#wrecks`) — under the fleet layer, over the water,
     * so a live hull drawn on top of one still reads as the thing worth looking at.
     */
    let wrecks: Graphics | null = null;
    /** The team's weapons in the water, and the run-out line each is flying. */
    let weapons: Graphics | null = null;
    /** The dotted track each of them has left behind it (`render/trails.ts`). */
    let trails: Graphics | null = null;
    const tracks = new TorpedoTrails();
    /** The track revision and the zoom the trail layer was last drawn at. Both move it. */
    let tracksAt = -1;
    let trailScale = 0;
    /** The expanding rings friendly pulses draw. Animated per frame, not per view frame. */
    let pings: Graphics | null = null;
    /** And the alarm a hostile tube firing draws, which is the same shape and a louder colour. */
    let alarms: Graphics | null = null;
    /**
     * The pulses the *enemy* fired that lit one of ours — the same ring as `pings`, in the hostile
     * colour (`render/pings.ts#HostilePings`). Its own layer rather than a second pass over
     * `pings`, because the two are cleared on their own triggers: a frame can have a friendly ring
     * on it and no hostile one, and sharing a `Graphics` would make each redraw wipe the other.
     */
    let lit: Graphics | null = null;
    const rings = new PingRings();
    /**
     * The seeker pulses friendly torpedoes make, tracked separately from the boats'.
     *
     * Two trackers rather than one list, because `PingRings` keys on entity id and a boat and a
     * weapon are different objects with different lifetimes — a weapon that detonates and leaves
     * would otherwise sit in the boat tracker's map for the rest of the match.
     */
    const seekerRings = new PingRings();
    const alerts = new LaunchAlerts();
    /**
     * And the hostile pulses. Driven off the vision frame rather than off the fleet, because a
     * pulse somebody else fired is not a state on the wire — the server sends the event of having
     * been lit by one (`match/vision.ts#HeardPing`).
     */
    const hostilePings = new HostilePings();
    /**
     * The fleet's propellers. A continuous voice per boat, steered from this loop rather than from
     * a view frame, because where a sound sits in the picture depends on where the camera is and
     * the camera moves under the player's hand between frames.
     */
    const propellers = new PropellerVoices();
    /** And the weapons' whines. Same lifecycle, a very different sound (`audio/torpedo.ts`). */
    const torpedoVoices = new TorpedoVoices();
    /** Which of the bangs on the wire have already been played (`audio/cues.ts`). */
    const cues = new TransientCues();
    /**
     * The last fleet read, kept for the audio.
     *
     * The boats only change on a view frame, so re-reading the getter every display frame would
     * allocate a fresh array sixty times a second to learn nothing. The renderer already knows when
     * the fleet moved — that is what `revision` is — so it hands the read over.
     */
    let audible: readonly ScopeBoat[] = [];
    /** The same, for the weapons. Read on the view frame, steered every display frame. */
    let running: readonly TorpedoSnapshot[] = [];
    /**
     * The debug acoustic overlay, at the very bottom of the world (`render/field.ts`).
     *
     * Built with the canvas rather than lazily like `sonar`, because it needs no payload to
     * exist — it is an empty, hidden sprite until a frame arrives, and a developer typing
     * `seg.field('noise')` mid-match should not be waiting on a layer to be inserted.
     */
    let overlay: FieldLayer | null = null;
    /** The field revision the overlay was last repainted at. `-1` forces the first paint. */
    let fieldAt = -1;
    /** Which field the colour key is currently labelled for, so it is only relabelled on a change. */
    let keyKind: string | null = null;
    /** Built on the first frame that has a picture to draw, and torn down with the app. */
    let sonar: SonarLayers | null = null;
    /** Which picture those layers are drawing. A different one means a different match. */
    let sonarFor: SonarPicture | null = null;
    /** The fleet revision the boat layer was last drawn at. `-1` forces a first draw. */
    let drawnAt = -1;
    /** The selection the route layer was last drawn for. A new pick redraws without a frame. */
    let drawnSelected: EntityId | null = null;
    /** The zoom the grid was last drawn at. Its line width is in metres, so it is zoom-bound. */
    let gridScale = 0;
    /** Where the distance scale's top edge landed, which is what the field key sits above. */
    let scaleTop = 0;
    /** The fleet revision and the zoom the zone layer was last drawn at. Both move it. */
    let zonesAt = -1;
    let zoneScale = 0;
    /** The reach revision and the zoom the ring layer was last drawn at. Both move it. */
    let reachAt = -1;
    let reachScale = 0;

    let core: Rect = coreViewport({ width: el.clientWidth, height: el.clientHeight });
    // Zoom is held as a world height and pixels-per-metre is derived, so a resize changes how
    // big the picture is and never how much ocean is in it.
    let viewHeight = clampViewHeight(DEFAULT_VIEW_HEIGHT_M, map.extents, core);
    let scale = scaleFor(core, viewHeight);
    // Open on the middle of the map. With no fleet to follow yet there is no better anchor,
    // and the centre is the one position from which every part of the map is a pan away.
    let camera: Camera = clampCamera(
      { x: map.extents.width / 2, y: map.extents.height / 2 },
      map.extents,
      core,
      scale,
    );

    /** Push the current view onto the world container. The y flip is the scale's sign. */
    function apply(): void {
      if (world === null) return;
      const placement = placeWorld(camera, core, scale);
      world.scale.set(placement.scale, -placement.scale);
      world.position.set(placement.originX, placement.originY);
    }

    /**
     * Redraw the distance grid and its scale bar for the current zoom.
     *
     * The grid itself is in world space, so panning moves it with the water for free and this
     * is only needed when the *zoom* changes — but it is needed on every zoom frame, not only
     * when the interval steps, because the line width is in metres and has to be divided back
     * out to stay a hairline on screen.
     *
     * The scale bar is a DOM element rather than anything on the canvas. It is a few words of
     * text, it wants the same type as the rest of the HUD, and drawing text in Pixi means
     * living with its texture cache — which, for a string that changes as the zoom crosses a
     * threshold, is a lifecycle problem in exchange for nothing.
     */
    function refreshGrid(): void {
      const step = gridStepFor(scale);
      if (grid !== null && scale !== gridScale) {
        gridScale = scale;
        drawGrid(grid, map.extents, step, scale);
      }
      scaleTop = placeScaleBar(readout.current, core, step, scale);
      placeFieldScale(legend.current, core, scaleTop);
    }

    /**
     * Redraw the objectives, when the frame moved them or the zoom changed what a line is worth.
     *
     * Two triggers rather than one because they are genuinely independent: a capture arrives on
     * a view frame, and the ring's width is in metres so it thickens seventeen-fold across the
     * zoom range without any frame arriving at all. Three circles is nothing to rebuild — the
     * guard is here so it is not rebuilt sixty times a second for nothing.
     */
    function refreshZones(): void {
      if (zones === null) return;
      const revision = source.current?.revision() ?? 0;
      if (revision === zonesAt && scale === zoneScale) return;
      zonesAt = revision;
      zoneScale = scale;
      drawZones(zones, source.current?.zones() ?? [], viewer.current ?? null, scale);
    }

    /**
     * Redraw the ping-reach rings, on the same two triggers the objectives have.
     *
     * A new list arrives on the view frame while the overlay is on, and the dashes are cut in
     * screen pixels, so the zoom moves them without any frame arriving at all. Both guards matter
     * here more than they do for the zones: with the overlay *off* the list never changes, and
     * this has to cost one comparison a frame rather than a cleared layer a frame.
     */
    function refreshReach(): void {
      if (reachRings === null) return;
      const revision = source.current?.reachRevision() ?? 0;
      if (revision === reachAt && scale === reachScale) return;
      reachAt = revision;
      reachScale = scale;
      drawReach(reachRings, source.current?.reach() ?? [], scale, viewer.current ?? null);
    }

    /**
     * The one road to a new view. Every input goes through here, so the "map always covers the
     * core viewport" invariant holds for all of them at once rather than being re-argued per
     * handler — and zoom is clamped before the camera, since how far out the camera may sit
     * depends on how much it can see.
     */
    function show(next: View): void {
      viewHeight = clampViewHeight(next.viewHeight, map.extents, core);
      scale = scaleFor(core, viewHeight);
      camera = clampCamera(next.camera, map.extents, core, scale);
      apply();
      refreshGrid();
    }

    /** Move the camera, keeping the zoom. */
    function moveTo(next: Camera): void {
      show({ camera: next, viewHeight });
    }

    /** Recompute everything that depends on the window size, then re-clamp: a window that
     * grows can reveal void past a map edge, and the camera has to give ground for it. */
    function layout(): void {
      core = coreViewport({ width: el.clientWidth, height: el.clientHeight });
      if (frame !== null) drawFrame(frame, core);
      show({ camera, viewHeight });
    }

    // Pixi's resize plugin only defines `_cancelResize` once `init()` has resolved, so
    // `destroy()` on an Application whose init is still pending throws. Boot keeps the app
    // reference private until init settles, and cleanup only destroys a settled app — every
    // interleaving ends in exactly one destroy, after init.
    async function boot(): Promise<void> {
      const fresh = new Application();
      await fresh.init({
        background: COLORS.background,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio,
        width: el.clientWidth,
        height: el.clientHeight,
      });
      if (disposed) {
        fresh.destroy(true);
        return;
      }
      app = fresh;
      el.appendChild(fresh.canvas);

      world = buildWorld(map);
      // The acoustic overlay under everything the world holds — including the rock, which is what
      // the debug overlay is for: a field the player is not supposed to see, with the whole
      // ordinary picture drawn on top of it and none of it obscured. Index 1 is immediately over
      // the water box, which is the only thing `buildWorld` lays down before the terrain.
      overlay = new FieldLayer(map.extents);
      world.addChildAt(overlay.container, Math.min(1, world.children.length));
      // The distance grid sits over the terrain rather than under it. Under would be tidier —
      // rock is meant to read as a solid silhouette (09 §2) — but on a dense map most of the
      // picture is rock, and a grid that broke into fragments wherever it met a wall would be
      // useless for the one thing it is for: tracing a distance across the picture.
      grid = new Graphics();
      world.addChild(grid);
      // The objectives, low in the stack: a capture zone is a *place*, like the water and the
      // grid, rather than something the fleet's sensors produced (08 §3, layers 1–2). Under the
      // sonar products, so a shimmer of returns crossing one still reads as the returns; over
      // the grid, because a circle broken into arcs by grid lines would not read as a circle.
      zones = new Graphics();
      world.addChild(zones);
      // The debug rings above the objectives and below everything the fleet does: they are
      // annotations *about* hulls, so they must not be drawn over the hulls themselves — a ring
      // is read by where its edge falls, and the middle of it is where the boat has to stay
      // legible (`render/reach.ts`).
      reachRings = new Graphics();
      world.addChild(reachRings);
      // The fleet's routes, over the water and under the hulls: a route is a plan, and the boat
      // carrying it out sits on top of it (layer 4, planning/08 §3).
      route = new Graphics();
      world.addChild(route);
      // The tracks weapons have left, beside the route line and for the same reason: both are
      // lines *about* something that is drawn elsewhere, and neither may end up over the thing it
      // describes. Everything still happening — wrecks, hulls, weapons, the sonar picture — goes
      // on top, which is the correct loss. A trail is the one mark on the scope that reports
      // nothing about the present, so it is also the one that should give way to everything that
      // does (`render/trails.ts`).
      trails = new Graphics();
      world.addChild(trails);
      // Wrecks under the living fleet: a hulk is a place now, closer to the terrain and the
      // objectives than to a boat under command, and drawing it first means a live hull that
      // happens to sit over one is still what the eye lands on.
      wrecks = new Graphics();
      world.addChild(wrecks);
      // Own forces on top of both, still in the world container so they pan and zoom with the
      // terrain rather than being re-placed every frame (08 §3, layer 4).
      boats = new Graphics();
      world.addChild(boats);
      // Weapons over the hulls, because a torpedo passing a boat has to be seen passing it — and
      // because at any zoom where they overlap, the seven-metre object is the one that would
      // disappear underneath.
      weapons = new Graphics();
      world.addChild(weapons);
      // Over everything: a ring is emitted *by* a hull and has to be seen leaving it. In the
      // world container like everything else, so it pans and zooms with the water and its
      // radius stays a distance in metres rather than a number of pixels.
      pings = new Graphics();
      world.addChild(pings);
      // A hostile pulse's ring immediately over the friendly ones: it is the same mark, and when
      // the two overlap — which is exactly the moment a duel is decided — the one that says
      // *somebody has found you* is the one worth reading.
      lit = new Graphics();
      world.addChild(lit);
      // The launch alarm on top of even that. It is the one mark on the scope that means "react
      // now", and nothing may cover it.
      alarms = new Graphics();
      world.addChild(alarms);
      fresh.stage.addChild(world);

      // The core viewport's frame is drawn in screen space, on top of the water — it is part
      // of the instrument housing, not part of the world (08 §3).
      frame = new Graphics();
      fresh.stage.addChild(frame);

      fresh.ticker.add((ticker) => {
        // Polled, not subscribed: a 10 Hz view frame must not re-render React on the hot
        // path (08 §1), so the store bumps a counter and the renderer reads it from here.
        const revision = source.current?.revision() ?? 0;
        // A selection is local, not a view frame, so it gets its own trigger: a number key
        // must redraw the route line without waiting for the next 10 Hz frame to arrive.
        const selected = source.current?.selected() ?? null;
        if (revision !== drawnAt || selected !== drawnSelected) {
          drawnAt = revision;
          drawnSelected = selected;
          const fleet = source.current?.boats() ?? [];
          const shots = source.current?.torpedoes() ?? [];
          audible = fleet;
          running = shots;
          if (boats !== null) drawFleet(boats, fleet);
          if (wrecks !== null) drawWrecks(wrecks, source.current?.wrecks() ?? []);
          if (weapons !== null) drawWeapons(weapons, shots, scale);
          // Sampled on the view frame, which is the only moment a weapon can have moved. The
          // *drawing* is below and has its own trigger — a trail also changes when the zoom does,
          // because its dashes are sized in screen pixels.
          tracks.observe(shots);
          if (route !== null) drawRoutes(route, source.current?.routes() ?? []);
          // Pulses are read on the view frame that reports them, because that is the only
          // moment `lastPingTick` can have moved. The *drawing* of a ring is per display
          // frame, below — the two rates are different and deliberately not tied.
          for (const at of rings.observe(
            fleet.map((boat) => ({
              id: boat.id,
              pos: boat.pos,
              lastPingTick: boat.lastPingTick,
              destroyed: boat.status === 'destroyed',
            })),
            ticker.lastTime,
          )) {
            playPing(soundFor(at, camera, core, scale));
          }
          // A seeker's pulse gets the same ring and the same cue as a boat's. It is a weaker
          // pulse from a smaller transducer, but it is the same event and the player reads it
          // the same way — *that thing is looking, right now*.
          for (const at of seekerRings.observe(
            shots.map((torpedo) => ({
              id: torpedo.id,
              pos: torpedo.pos,
              lastPingTick: torpedo.lastPingTick,
              destroyed: torpedo.phase === 'spent',
            })),
            ticker.lastTime,
          )) {
            playPing(soundFor(at, camera, core, scale));
          }
          // And the bangs, for the same reason: a transient can only have appeared on the frame
          // that reports it. Boats and weapons through one tracker, because a launch and a
          // detonation reach the client in exactly the same shape (`audio/cues.ts`). Scaled by
          // the size of the hull that made it, because a Light hitting a wall is not a Heavy
          // hitting one — which is what the acoustic model says too.
          for (const cue of cues.observe([
            ...fleet,
            ...shots.map((torpedo) => ({
              id: torpedo.id,
              pos: torpedo.pos,
              hull: null,
              transients: torpedo.transients,
            })),
          ])) {
            playTransient(cue.kind, soundFor(cue.at, camera, core, scale), hullWeight(cue.hull));
          }
          // The alarm. Read off the accumulated picture rather than off a view frame, because
          // the picture is where the vision half of a frame lands — and played as the enemy's
          // own launch transient, which is precisely what the player just heard.
          for (const at of alerts.observe(
            source.current?.picture()?.launches ?? [],
            ticker.lastTime,
          )) {
            playTransient('torpedo-launch', soundFor(at, camera, core, scale));
          }
          // And the pulses that lit one of ours, off the same picture. The cue is the pulse's own
          // — it is the sound the crew actually heard, arriving from where it was fired — so a
          // player looking at another part of the map hears the ping before they see the ring.
          for (const at of hostilePings.observe(
            source.current?.picture()?.pings ?? [],
            ticker.lastTime,
          )) {
            playPing(soundFor(at, camera, core, scale));
          }
        }

        // The propellers and the whines, on the other hand, are steered every frame — see
        // `propellers` on why placement cannot wait for a view frame.
        propellers.update(
          audible.map((boat) => ({
            id: boat.id,
            pos: boat.pos,
            hull: boat.hull,
            speed: boat.speed,
            cavitating: boat.cavitating,
            destroyed: boat.status === 'destroyed',
          })),
          (at) => soundFor(at, camera, core, scale),
        );
        torpedoVoices.update(running, (at) => soundFor(at, camera, core, scale));

        refreshZones();
        refreshReach();

        // Two triggers, the same pair `refreshZones` has and for the same reason: a track gains a
        // point on a view frame, and its dash period is in screen pixels so it has to be recut
        // whenever the camera zooms. Neither happens per display frame, and the layer is a few
        // hundred segments — worth not rebuilding sixty times a second for nothing.
        if (trails !== null && (tracks.revision !== tracksAt || scale !== trailScale)) {
          tracksAt = tracks.revision;
          trailScale = scale;
          drawTrails(trails, tracks, scale);
        }

        // Redrawn while anything is live, and once more on the frame after the last ring dies
        // so the layer is left clear rather than holding a stale circle.
        if (pings !== null && (rings.active || seekerRings.active)) {
          drawPings(
            pings,
            [...rings.rings(ticker.lastTime), ...seekerRings.rings(ticker.lastTime)],
            scale,
          );
        }
        if (lit !== null && hostilePings.active) {
          drawPings(lit, hostilePings.rings(ticker.lastTime), scale, COLORS.hostile);
        }
        if (alarms !== null && alerts.active) {
          drawAlarms(alarms, alerts.rings(ticker.lastTime), scale);
        }

        // The overlay, on its own revision: a field arrives at `FIELD_MAP_HZ` rather than with
        // the view frame, and repainting a texture on every frame that did not carry one would be
        // the most expensive thing this loop does for no change at all.
        const fieldRevision = source.current?.fieldRevision() ?? 0;
        if (overlay !== null && fieldRevision !== fieldAt) {
          fieldAt = fieldRevision;
          const field = source.current?.field() ?? null;
          overlay.update(field);
          // The key goes with the overlay, both ways, and carries whatever the payload says it is
          // measuring — the fields have different units and domains, so the labels are relabelled
          // rather than fixed. Only on a change of field: this runs at the display rate.
          const key = legend.current;
          if (key !== null) {
            if (field !== null && field.kind !== keyKind) labelFieldScale(key, field);
            keyKind = field?.kind ?? null;
            if (key.hidden === (field !== null)) {
              key.hidden = field === null;
              // Placed on the way *in* rather than once at mount, because a `hidden` element
              // measures zero and the placement needs its height.
              if (field !== null) placeFieldScale(key, core, scaleTop);
            }
          }
        }

        // The sonar layers are built lazily because the picture arrives with `match.state`,
        // which lands after the canvas does. Once built they own their own update cadence —
        // the chart appends, the transients fade on a throttle, the contacts redraw on change.
        const picture = source.current?.picture() ?? null;
        if (picture !== null && world !== null) {
          if (sonar === null || sonarFor !== picture) {
            // A different picture object is a different match. The chart layer is append-only
            // and has no way to un-draw the last one, so it is replaced rather than reset.
            sonar?.destroy();
            sonar = new SonarLayers(picture);
            sonarFor = picture;
            // A new picture is a new match, and entity ids restart with it. Tracks keyed on the
            // old match's ids would otherwise be adopted by whatever weapon inherits the number.
            tracks.clear();
            // Under the fleet, over the water: `boats` is the last child, so inserting at its
            // index puts the acoustic layers immediately beneath it.
            world.addChildAt(sonar.container, Math.max(0, world.children.length - 1));
          }
          sonar.update(ticker.lastTime, source.current?.tick() ?? 0, scale);
        }

        if (!enabled.current || held.current.size === 0) return;
        // `deltaMS` is wall time since the last frame, so a held key pans and zooms at the
        // same rate whatever the frame rate is doing.
        const seconds = ticker.deltaMS / 1000;

        // Zoom first: panning a screenful per second means something different afterwards,
        // and the player pressing both expects the pan they can see, not the one they had.
        const zoomFactor = zoomFactorForKeys(held.current, seconds);
        const zoomed =
          zoomFactor === 1
            ? { camera, viewHeight }
            : zoomAt({ camera, viewHeight }, zoomFactor, null, map.extents, core);

        show({
          camera: panByKeys(
            zoomed.camera,
            held.current,
            seconds,
            core,
            scaleFor(core, zoomed.viewHeight),
          ),
          viewHeight: zoomed.viewHeight,
        });
      });

      layout();
    }
    void boot();

    // ── pointer: click to pick or command, drag to pan, right-click to cancel ───
    // Bound to the host rather than the canvas because the canvas does not exist until init
    // resolves, and because pointer capture on the host survives the pointer crossing a HUD
    // panel mid-drag — a drag that dies when the cursor clips the fleet list feels broken.
    let dragging: number | null = null;
    let lastX = 0;
    let lastY = 0;
    /** Where the press began, so a click can be told from a drag by how far it wandered. */
    let downX = 0;
    let downY = 0;
    /** Whether the press was shifted — the queue modifier, carried to the click. */
    let downShift = false;
    /** Whether the press is still a click. False the moment it becomes a drag. */
    let clickEligible = false;
    /**
     * Where the cursor last was, in client coordinates, or `null` before it has moved at all.
     *
     * Tracked on the *window* rather than on the host, because the space bar aims with it and a
     * cursor parked over the fleet list is still pointing at water. The host's own `pointermove`
     * cannot see those moves: the HUD panels sit on top of the canvas and swallow them.
     */
    let aimX: number | null = null;
    let aimY: number | null = null;

    function onAimMove(event: PointerEvent): void {
      aimX = event.clientX;
      aimY = event.clientY;
    }

    function onPointerDown(event: PointerEvent): void {
      if (!enabled.current || dragging !== null) return;

      // Right-click cancels the selected boat's orders, on the press so the gesture reads
      // instantly and so a right-drag cannot accidentally fire it on release.
      if (event.button === 2) {
        event.preventDefault();
        cancel.current?.();
        return;
      }
      if (event.button !== 0) return;

      dragging = event.pointerId;
      lastX = downX = event.clientX;
      lastY = downY = event.clientY;
      downShift = event.shiftKey;
      clickEligible = true;
      el.setPointerCapture(event.pointerId);
      el.classList.add('scope-host--dragging');
    }

    function onPointerMove(event: PointerEvent): void {
      if (dragging !== event.pointerId) return;
      // A press is a click until it has moved more than the slop. The pointer is captured, so
      // the cursor leaving the host does not make it a drag — it makes it a click on nothing.
      if (
        clickEligible &&
        Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX
      ) {
        clickEligible = false;
      }
      if (clickEligible) return;
      moveTo(panByPixels(camera, event.clientX - lastX, event.clientY - lastY, scale));
      lastX = event.clientX;
      lastY = event.clientY;
    }

    function onPointerUp(event: PointerEvent): void {
      if (dragging !== event.pointerId) return;
      dragging = null;
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      el.classList.remove('scope-host--dragging');

      // A clean press is a command on the point under the cursor. The bounds are read here
      // rather than cached because the HUD can move the host around the window, and a stale
      // offset would aim it through the lens of an old layout.
      if (!clickEligible) return;
      const bounds = el.getBoundingClientRect();
      const world = screenToWorld(
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        camera,
        core,
        scale,
      );

      // A debug spawn armed by the console takes the click outright — it is not a pick or an
      // order, and skipping the hit test means a click on a hull places the spawn under it
      // rather than selecting the hull, which is what a player pointing at "here" actually means.
      if (debugSpawn.current !== undefined) {
        debugSpawn.current(world);
        return;
      }

      // A boat under the cursor takes the click and becomes the selection; the water under it
      // gets the order. The fleet is read from the getter for the same reason the renderer
      // reads it there — the last view frame is the truth about where the hulls are, and it
      // moved without React hearing about it.
      const hit = boatAt(source.current?.boats() ?? [], world, BOAT_PICK_SLOP_PX / scale);
      if (hit !== null) {
        pick.current?.(hit.id);
        return;
      }
      order.current?.(world, downShift);
    }

    /** The context menu is ours, not the browser's: right-click is a command. */
    function onContextMenu(event: Event): void {
      if (!enabled.current) return;
      event.preventDefault();
    }

    // The camera handle the HUD steers with: a mini-map click and a fleet-list row both mean
    // "look here" (08 §11). Exposed as a ref rather than a prop callback so pressing it
    // cannot re-render the tree that owns the canvas. It sits below the drag state because it
    // reports it — the handle is the only way anything outside the canvas can know the
    // pointer is busy.
    if (controls !== undefined) {
      controls.current = {
        lookAt: (point) => moveTo(point),
        dragging: () => dragging !== null,
      };
    }

    /**
     * Wheel to zoom, about the cursor: the water under the pointer stays under the pointer,
     * so zooming doubles as pointing at the thing you want to look at.
     */
    function onWheel(event: WheelEvent): void {
      if (!enabled.current) return;
      // The gesture is ours, not the browser's. Without this the page scrolls under the fixed
      // match screen, and a trackpad pinch — which arrives as ctrl+wheel — zooms the whole UI.
      event.preventDefault();

      const bounds = el.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const factor = zoomFactorForWheel(event.deltaY, event.deltaMode);

      show(zoomAt({ camera, viewHeight }, factor, anchor, map.extents, core));
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointermove', onAimMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('wheel', onWheel, { passive: false });

    // ── keyboard: WASD to pan, arrows to zoom, Home/End to the ends, space to fire ──
    // On the window, not the canvas: the scope is never the focused element, and a camera you
    // have to click into first is a camera that ignores you at the worst moment.
    function onKeyDown(event: KeyboardEvent): void {
      if (!enabled.current || event.ctrlKey || event.metaKey || event.altKey) return;
      // Every binding on this surface is a bare key, so all of them have to stand down when
      // something else is taking keystrokes: the chat box, or a panel that has focus and binds
      // keys of its own (`ui/hud/typing.ts`). Space would put a torpedo in the water between
      // two typed words, and the arrows would zoom the scope while the load picker is using
      // them to walk its list.
      if (ownsKeyboard(document.activeElement)) return;

      // ── space: fire at the cursor ─────────────────────────────────────────────
      // `code` rather than `key`, since the character a space bar produces is a space on every
      // layout but not every layout calls it one.
      if (event.code === 'Space') {
        // The browser scrolls the page on space, and — because a fleet row and a throttle
        // button stay focused after a click — activates whatever was last pressed. Taken on
        // the way down, which is early enough to stop both.
        event.preventDefault();
        // Auto-repeat is not a stream of shots. A held space would otherwise empty every tube
        // on the boat into the same point at the keyboard's repeat rate.
        if (event.repeat) return;
        const bounds = el.getBoundingClientRect();
        // With the mouse untouched since the match opened there is no cursor to aim by, so the
        // shot goes down the middle of the picture. It is a worse shot than the player meant,
        // and it is much better than a trigger that silently does nothing.
        const at =
          aimX === null || aimY === null
            ? { x: core.x + core.width / 2, y: core.y + core.height / 2 }
            : { x: aimX - bounds.left, y: aimY - bounds.top };
        shoot.current?.(screenToWorld(at, camera, core, scale));
        return;
      }

      // Pan and zoom are held rather than fired: the ticker reads the set each frame, which
      // is what makes a diagonal one gesture instead of two competing repeat streams.
      const key = event.key.toLowerCase();
      if (PAN_KEYS[key] !== undefined || ZOOM_KEYS[key] !== undefined) {
        held.current.add(key);
        // The arrows would otherwise scroll the page out from under the match.
        if (ZOOM_KEYS[key] !== undefined) event.preventDefault();
        return;
      }

      if (event.key !== 'Home' && event.key !== 'End') return;
      // Otherwise the browser scrolls the page under the fixed match screen.
      event.preventDefault();
      moveTo(endCamera(camera, map.extents, event.key === 'Home' ? 'left' : 'right', core, scale));
    }

    /** Releases are unconditional: a key that went down before the gate closed still comes up. */
    function onKeyUp(event: KeyboardEvent): void {
      held.current.delete(event.key.toLowerCase());
    }

    /** Alt-tabbing away eats the keyup, so the window losing focus counts as letting go. */
    function onBlur(): void {
      held.current.clear();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    const observer = new ResizeObserver(() => {
      if (app === null) return;
      app.renderer.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio);
      layout();
    });
    observer.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointermove', onAimMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      held.current.clear();
      if (controls !== undefined) controls.current = null;
      // The audio device goes with the scope. Holding an `AudioContext` open behind the main
      // menu is a hardware resource claimed for a screen with no sound in it, and on some
      // platforms it is visible to the player as an app that is "playing audio".
      //
      // The continuous voices first, and the order matters: they are the only ones that outlive
      // the sound that started them, so they hold nodes on a context that is about to be closed.
      propellers.release();
      torpedoVoices.release();
      releaseAudio();
      // Before the app, because the overlay owns a texture built off a canvas of its own and
      // `Application.destroy` only reaches what is in the scene graph.
      overlay?.destroy();
      if (app !== null) app.destroy(true);
    };
  }, [map, controls]);

  return (
    <>
      <div ref={mount} className="scope-host" aria-hidden="true" />
      {/*
        A sibling of the canvas rather than a child, so the scope stays `aria-hidden` — a
        field of terrain says nothing to a screen reader — while the one piece of the
        instrument that carries a *number* is announced. It is placed and labelled from the
        render loop; React only puts it on the page.
      */}
      <div ref={readout} className="scope-scale" role="img" aria-label="Scale">
        <span className="scope-scale__label" />
        <span className="scope-scale__bar" aria-hidden="true" />
      </div>
      {/*
        The acoustic overlay's colour key, immediately above the distance scale — the two are the
        only readings on the scope that answer "what is this worth", so they belong together in
        the same corner. A skeleton, not content: the ramp never changes, but the name, the unit,
        and the five numbers are the *payload's* (`labelFieldScale`), because each field is
        measuring something else. React puts the boxes on the page and the loop fills them.

        `hidden` until the first field lands, which is the ordinary state — nobody outside a debug
        session ever sees it.
      */}
      <div ref={legend} className="scope-field-scale" role="img" aria-label="Field scale" hidden>
        <span className="scope-field-scale__label" />
        <span
          className="scope-field-scale__bar"
          aria-hidden="true"
          style={{ backgroundImage: fieldRampGradient() }}
        />
        <span className="scope-field-scale__ticks" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((slot) => (
            <span key={slot} className="scope-field-scale__tick" />
          ))}
        </span>
      </div>
    </>
  );
}

/**
 * The static world — built once, shared by every frame.
 *
 * For a player that is the *frame* and nothing else: the water box, its surface, and its
 * seabed. Where the rock is inside it is the question the whole match is about, and the answer
 * accumulates through `sonar.ts` rather than arriving here (ADR 0002).
 *
 * A spectator's chart carries ground truth, and it is drawn in `terrain-charted` — the dim
 * token — rather than `terrain`. Both are honest about their provenance: the crisp tone means a
 * team confirmed it, the dim tone means it was simply given.
 */
function buildWorld(map: MapChart): Container {
  const world = new Container();
  const { width, height } = map.extents;

  // Opaque, not tinted: at 40% over the void the water composited *darker* than `rock-fill`,
  // which inverts 09 §2 — rock has to sit slightly warmer than the water for the eye to parse
  // open space as figure against ground.
  const water = new Graphics();
  water.rect(0, 0, width, height);
  water.fill({ color: COLORS.water });
  water.stroke({ color: COLORS.frame, width: 4, alpha: 0.9 });
  world.addChild(water);

  if (map.terrain === null) return world;

  // Rock as a filled silhouette with a thin stroked edge, not glowing contours (09 §2): the
  // water reads as figure against ground, and glow stays reserved for sensor readings. Each
  // obstacle is one closed ring in map metres, so it goes straight into the y-up world frame.
  const rock = new Graphics();
  for (const obstacle of map.terrain.obstacles) {
    const [first, ...rest] = obstacle.vertices;
    if (first === undefined) continue;
    rock.moveTo(first.x, first.y);
    for (const vertex of rest) rock.lineTo(vertex.x, vertex.y);
    rock.closePath();
  }
  rock.fill({ color: COLORS.rockFill });
  rock.stroke({ color: COLORS.rockCharted, width: 3, alpha: 0.9 });
  world.addChild(rock);

  return world;
}

/**
 * The distance grid: a square mesh in map metres, redrawn per zoom.
 *
 * It replaces the fixed 200 m depth rules that were here. They were the same family of lines
 * measured differently — depth is linear in `y`, so a horizontal line every 100 m of `y` is
 * also one every `100 · depthScale` of depth — and having two overlapping horizontal families
 * at slightly different spacings on every map size but medium was noise. **The interval this
 * draws and the number on the scale bar are distances, not depths**; labelled depths belong to
 * the depth scale up the left edge, which is still to come (planning/08 §3, layer 2).
 *
 * Drawn across the whole map rather than only the visible part: even 100 m on a large map is
 * about 93 segments, which is cheaper to emit than it would be to cull, and it means panning
 * needs no redraw at all.
 */
function drawGrid(graphics: Graphics, extents: MapExtents, step: number, scale: number): void {
  graphics.clear();

  for (let x = step; x < extents.width; x += step) {
    graphics.moveTo(x, 0);
    graphics.lineTo(x, extents.height);
  }
  for (let y = step; y < extents.height; y += step) {
    graphics.moveTo(0, y);
    graphics.lineTo(extents.width, y);
  }

  // The container is scaled by `scale`, so a one-pixel line on screen is `1 / scale` metres
  // wide here. Without this the grid would thicken by 17× across the zoom range.
  graphics.stroke({ color: COLORS.grid, width: 1 / scale, alpha: 0.7 });
}

/**
 * The scale bar, in the core viewport's bottom-right corner: one grid interval wide, labelled.
 *
 * A bar rather than a bare "1 px = 4 m" figure, because the question a player actually asks is
 * "how far apart are those two things", and a bar exactly one square wide answers it by being
 * held up against the grid. Its length therefore varies — between about 96 and 240 px as the
 * zoom moves within an interval, and wider than that only at maximum zoom-in, where 100 m is
 * the finest the ladder goes.
 */
function placeScaleBar(
  element: HTMLDivElement | null,
  core: Rect,
  step: number,
  scale: number,
): number {
  if (element === null) return core.y + core.height - SCALE_BAR_MARGIN;

  const length = step * scale;
  const top = core.y + core.height - SCALE_BAR_MARGIN - element.offsetHeight;
  element.style.width = `${String(length)}px`;
  element.style.left = `${String(core.x + core.width - SCALE_BAR_MARGIN - length)}px`;
  element.style.top = `${String(top)}px`;

  // Only on change: this runs on every zoom frame, and rewriting identical text still
  // invalidates layout.
  const label = `${String(step)} M`;
  if (element.dataset['step'] === label) return top;
  element.dataset['step'] = label;
  element.setAttribute('aria-label', `Scale: one grid square is ${String(step)} metres`);
  const text = element.firstElementChild;
  if (text !== null) text.textContent = label;
  return top;
}

/**
 * Write one field's name, unit, and five stops into the key.
 *
 * Called only when the *kind* changes rather than on every frame: the domains are fixed per field
 * (`match/field.ts`), so a payload of the same kind always carries the same numbers, and rewriting
 * identical text still invalidates layout.
 */
function labelFieldScale(element: HTMLDivElement, field: FieldMapView): void {
  element.setAttribute('aria-label', `${field.label} scale, ${fieldRangeText(field)}`);

  const label = element.querySelector('.scope-field-scale__label');
  if (label !== null) label.textContent = `${field.label} ${field.unit}`;

  const ticks = element.querySelectorAll('.scope-field-scale__tick');
  const labels = fieldScaleLabels(field, ticks.length);
  ticks.forEach((tick, i) => {
    tick.textContent = labels[i] ?? '';
  });
}

/**
 * The overlay's colour key, stacked directly above the distance scale.
 *
 * Right-aligned to the same margin so the two read as one instrument cluster in the corner, and
 * *above* rather than beside because the distance bar's width moves with the zoom — a key placed
 * to its left would slide about every time the player scrolled the wheel.
 *
 * Its own width is fixed in the stylesheet, so unlike the bar below it this only ever has to be
 * told where the corner is. A hidden element measures zero, which is why the caller places it on
 * the frame it is revealed rather than once at mount.
 */
function placeFieldScale(element: HTMLDivElement | null, core: Rect, scaleTop: number): void {
  if (element === null || element.hidden) return;
  element.style.left = `${String(core.x + core.width - SCALE_BAR_MARGIN - element.offsetWidth)}px`;
  element.style.top = `${String(scaleTop - SCALE_KEY_GAP - element.offsetHeight)}px`;
}

/**
 * The capture zones: a filled circle whose colour is its progress, with a gauge round its rim.
 *
 * Both readings say the same thing on purpose, because they are read at different distances.
 * The **fill** answers "whose way is this going" from across the map at a glance, which is what
 * the colour blend in `zones.ts` is for. The **arc** answers "how long have I got" when the
 * player is actually looking at the fight, and it starts at twelve o'clock and sweeps clockwise
 * because that is the one convention every player already has for a timer.
 *
 * Drawn whether or not the water it sits in has been charted (planning/06 §2.2) — an objective
 * is the one thing on the scope that is not something the fleet earned.
 */
function drawZones(
  graphics: Graphics,
  zones: readonly ZoneStatusView[],
  you: TeamId | null,
  scale: number,
): void {
  graphics.clear();

  for (const zone of zones) {
    const style = zoneStyle(zone, you);
    // Widths are in metres like everything else in the world container, so they are divided by
    // the scale to stay a fixed number of pixels across the zoom range — same as the grid's.
    const hairline = 2 / scale;

    graphics.circle(zone.centre.x, zone.centre.y, zone.radius);
    graphics.fill({ color: style.body, alpha: style.arming ? 0.05 : 0.09 });
    graphics.stroke({ color: style.body, width: hairline, alpha: style.arming ? 0.45 : 0.85 });

    // Contested: a second ring just inside the first. Two lines where every other state has one
    // is the most legible way to say "this is stuck", and it needs no animation to say it.
    if (style.contested) {
      graphics.circle(zone.centre.x, zone.centre.y, zone.radius - hairline * 3);
      graphics.stroke({ color: COLORS.zone, width: hairline, alpha: 0.85 });
    }

    if (style.progress <= 0) continue;
    // From twelve o'clock, clockwise. The world container's y is flipped, so a clockwise sweep
    // on screen is a *counter-clockwise* one in these coordinates — hence the negative end
    // angle. Getting this backwards is invisible until someone watches the gauge unwind.
    const start = Math.PI / 2;
    // `arc` is a path command, not a shape: it draws a line from wherever the path cursor
    // happens to be to the arc's first point. Left alone that cursor is the origin, so the
    // gauge arrives with a stray line trailing back to the corner of the map. Seating the
    // cursor on the arc's own start point is the fix, and it is the same thing `drawRoute`
    // does before each waypoint dot — `circle` and `rect` do not need it because they open
    // their own sub-path, which is exactly why this one is easy to miss.
    graphics.moveTo(
      zone.centre.x + zone.radius * Math.cos(start),
      zone.centre.y + zone.radius * Math.sin(start),
    );
    graphics.arc(
      zone.centre.x,
      zone.centre.y,
      zone.radius,
      start,
      start - style.progress * Math.PI * 2,
      true,
    );
    graphics.stroke({
      color: style.accent,
      width: hairline * 2.5,
      alpha: style.contested ? 0.5 : 1,
    });
  }
}

/**
 * The team's routes: for each boat with somewhere to be, a line out of it through its waypoints,
 * with a dot on each.
 *
 * The line *is* the receipt for the orders (nav.ts) — there is no ack message, so this is what
 * tells the player the server took the route. It runs from the boat's position in the latest
 * frame rather than from the boat itself, so as the boat closes on a leg the line stays
 * attached to it; the popped waypoints fall away with the frame that carries the shorter route.
 *
 * **The whole team's, not only the selected boat's.** A submarine game is played by putting boats
 * in places, and a player who can only see the plan of the boat they are currently holding has to
 * reconstruct the other nine from memory — which means they either re-select each one in turn to
 * check, or they stop planning across the fleet at all. Teammates' routes for the same reason,
 * one level up: six players sharing an ocean need to be able to see where each other are going
 * without saying it in chat, and a friendly torpedo is not the way to find out.
 *
 * **And the unselected ones are drawn as background.** That is what makes this affordable rather
 * than the clutter it would otherwise be: ten routes at the old full strength would be a web of
 * bright lines across the sonar picture, with the one the player is actually commanding lost
 * somewhere in it. So the selected boat keeps exactly the line it had, and the rest are dropped to
 * a third of its alpha and a thinner stroke — legible when looked at, invisible when not. The
 * unselected pass is drawn *first* so the commanded line lies over any it crosses.
 *
 * Colour follows the hull the line comes out of — `own` for yours, `ally` for a teammate's, the
 * same split `drawFleet` makes — because the first question asked of a line on the water is whose
 * it is, and it should be answered by the same channel that answers it for the boats.
 */
function drawRoutes(graphics: Graphics, routes: readonly ScopeRoute[]): void {
  graphics.clear();

  for (const route of routes) if (!route.selected) strokeRoute(graphics, route);
  for (const route of routes) if (route.selected) strokeRoute(graphics, route);
}

/** One route's line and waypoint dots, at the weight its selection state earns. */
function strokeRoute(graphics: Graphics, route: ScopeRoute): void {
  const { pos, waypoints, selected, mine } = route;
  if (waypoints.length === 0) return;

  const color = mine ? COLORS.own : COLORS.ally;
  const alpha = selected ? 0.9 : 0.3;

  graphics.moveTo(pos.x, pos.y);
  for (const waypoint of waypoints) graphics.lineTo(waypoint.x, waypoint.y);
  graphics.stroke({ color, width: selected ? 2 : 1.5, alpha });

  // One open dot per waypoint: the line says "through here", and the dots say "to here",
  // which is the part the player is actually waiting for as the boat closes.
  const radius = selected ? ROUTE_WAYPOINT_RADIUS : ROUTE_WAYPOINT_RADIUS * 0.7;
  for (const waypoint of waypoints) {
    graphics.moveTo(waypoint.x + radius, waypoint.y);
    graphics.arc(waypoint.x, waypoint.y, radius, 0, Math.PI * 2);
  }
  graphics.fill({ color, alpha });
}

/** The radius of a route waypoint's dot, in map metres. */
const ROUTE_WAYPOINT_RADIUS = 6;

/**
 * Own forces: each boat as its authored side profile, at true position and true pitch.
 *
 * The silhouette is the same polygon the fleet editor draws, the acoustic model reflects sound
 * off, and a confirmed hostile contact is drawn as (planning/09 §11) — one asset, four jobs —
 * so the placement lives in `silhouette.ts` and every caller shares it.
 */
function drawFleet(graphics: Graphics, boats: readonly ScopeBoat[]): void {
  graphics.clear();

  for (const boat of boats) {
    if (!traceSilhouette(graphics, boat.hull, boat.pos, boat.facing)) continue;

    const colour = boat.status === 'destroyed' ? COLORS.lost : boat.mine ? COLORS.own : COLORS.ally;
    // Filled at low alpha with a bright edge: a hull reads as a solid object without
    // out-glowing the sensor products that will sit on top of it (09 §2).
    graphics.fill({ color: colour, alpha: boat.status === 'destroyed' ? 0.25 : 0.35 });
    graphics.stroke({ color: colour, width: 2, alpha: boat.status === 'destroyed' ? 0.5 : 1 });
  }
}

/**
 * A small fixed cluster of bubbles rising off a wreck, metres from its centre — air still
 * finding its way to the surface (planning/04 §8, revised). Fixed rather than animated: the
 * layer redraws on the view frame rather than on Pixi's own ticker, so an animation here would
 * stutter at 10 Hz. A little jitter in the offsets is what stops three identical wrecks reading
 * as stamped from the same die.
 */
const WRECK_BUBBLE_OFFSETS: readonly (readonly [number, number])[] = [
  [-4, 9],
  [3, 15],
  [-2, 21],
];
const WRECK_BUBBLE_RADIUS = 1.4;

/**
 * Every wreck worth its own drawing pass (`ScopeFleet#wrecks`) — grey rather than a team's
 * colour, and marked with the bubbles that say *destroyed* rather than *changed sides*
 * (planning/04 §8, revised).
 *
 * The silhouette is the same asset `drawFleet` uses for a friendly wreck; this layer gives an
 * enemy one the identical treatment, which is the whole point of a channel that does not care
 * whose hull it was.
 */
function drawWrecks(graphics: Graphics, wrecks: readonly WreckView[]): void {
  graphics.clear();

  for (const wreck of wrecks) {
    if (!traceSilhouette(graphics, wreck.hull, wreck.pos, wreck.facing)) continue;
    graphics.fill({ color: COLORS.lost, alpha: 0.25 });
    graphics.stroke({ color: COLORS.lost, width: 2, alpha: 0.5 });

    for (const [dx, dy] of WRECK_BUBBLE_OFFSETS) {
      const x = wreck.pos.x + dx;
      const y = wreck.pos.y + dy;
      graphics.moveTo(x + WRECK_BUBBLE_RADIUS, y);
      graphics.arc(x, y, WRECK_BUBBLE_RADIUS, 0, Math.PI * 2);
    }
    graphics.fill({ color: COLORS.bubble, alpha: 0.5 });
  }
}

/**
 * The team's weapons: each as its own load's icon, with the line it is flying and the mark it is
 * flying at.
 *
 * **The four loads look different, and that is not decoration.** A player with several weapons in
 * the water is running several different plans at once — a torpedo that will hunt, a sprint that
 * will not turn, a decoy standing in for them somewhere else, a drone charting a corridor — and
 * before this they were four identical darts distinguishable only by remembering which tube went
 * where. The icons are authored in `content/weapons.ts` off `assets/weapons/*.svg`, sharp-nosed
 * for the two that carry a warhead and round for the two that do not, so the split that matters
 * most is also the one readable at the smallest size.
 *
 * **The aim point is drawn until the weapon reaches it.** A shot's whole skill is the lead, and
 * the only way a player learns whether they led far enough is by watching where they sent the
 * weapon against where the target actually went. Without the mark a miss teaches nothing; with
 * it, a miss is a measurement.
 *
 * But that is all true of a weapon *in transit*. Once it is `enabled` it has arrived: the point
 * has stopped being where it is going and become where it has been, and what happens next is the
 * load's business rather than the plan's (`match/torpedo.ts#TorpedoPhase`). Leaving the cross and
 * the line up past that moment is the layer's worst clutter — a screen with four weapons on it
 * carries four lines and four crosses that no longer describe anything, laid across the sonar
 * picture the player is trying to read. So arrival takes them both down, and the trail
 * (`render/trails.ts`) is what is left saying where the weapon has been.
 *
 * The icon is drawn at a **floor size in screen pixels**, unlike a hull. A torpedo is seven
 * metres long and a Heavy is a hundred and seventy, so at any zoom where the boat is legible the
 * weapon is a third of a pixel — and this is the object whose position the player most needs to
 * read. So it is honest about its length up close and becomes a symbol as the camera pulls out,
 * which is the same bargain the mini-map's chart marks make.
 *
 * A spent weapon is not drawn at all. It sits in the frames for the few seconds its detonation
 * rings so the bang can come from where it happened (`match/torpedo.ts`), but there is nothing
 * left to look at and an icon still on screen would read as a weapon still running.
 */
function drawWeapons(
  graphics: Graphics,
  torpedoes: readonly TorpedoSnapshot[],
  scale: number,
): void {
  graphics.clear();
  if (torpedoes.length === 0) return;

  // Never smaller than something a player can see and click past, and never larger than the mark
  // a *hostile* weapon gets — see `render/silhouette.ts`, where both rules live together.
  const length = friendlyWeaponLength(scale);

  for (const torpedo of torpedoes) {
    if (torpedo.phase === 'spent') continue;

    // `launch` and `running` are the two phases with somewhere still to be. See the header on
    // why arrival retires the plan rather than dimming it.
    if (torpedo.phase !== 'enabled') {
      // The run-out line, back to where it is headed. Dimmer than the weapon itself: it is a
      // plan, and the same layering the route line uses (a plan under the thing carrying it out).
      graphics.moveTo(torpedo.pos.x, torpedo.pos.y);
      graphics.lineTo(torpedo.aim.x, torpedo.aim.y);
      graphics.stroke({ color: COLORS.own, width: 1 / scale, alpha: 0.35 });

      // The aim point as an open cross rather than a dot, so it stays legible over a wall of
      // charted rock — which is exactly where a player aims when firing down a passage.
      const arm = TORPEDO_AIM_PX / scale;
      graphics.moveTo(torpedo.aim.x - arm, torpedo.aim.y);
      graphics.lineTo(torpedo.aim.x + arm, torpedo.aim.y);
      graphics.moveTo(torpedo.aim.x, torpedo.aim.y - arm);
      graphics.lineTo(torpedo.aim.x, torpedo.aim.y + arm);
      graphics.stroke({ color: COLORS.own, width: 1.5 / scale, alpha: 0.6 });
    }

    if (!traceWeaponIcon(graphics, torpedo.weapon, torpedo.pos, torpedo.facing, length)) continue;
    // Solid, unlike a hull's 35% fill: a weapon is small and it is the thing on the layer that
    // must not be missed. An enabled one is brighter still — its seeker is awake and the player
    // needs to know the difference between a weapon transiting and a weapon hunting.
    graphics.fill({ color: COLORS.own, alpha: torpedo.phase === 'enabled' ? 1 : 0.75 });
  }
}

/** Half the width of an aim-point cross, CSS pixels. */
const TORPEDO_AIM_PX = 6;

/**
 * The launch alarm: heavy rings in the hostile accent, chasing each other outward.
 *
 * The same geometry as a ping ring and deliberately none of its restraint. A pulse ring is a
 * faint 0.32 alpha because it marks a rhythm the player already knows about; this is the one
 * thing on the scope that means *somebody has fired at you*, and it is allowed to shout.
 */
function drawAlarms(graphics: Graphics, rings: readonly PingRing[], scale: number): void {
  graphics.clear();

  for (const ring of rings) {
    if (ring.radius <= 0) continue;
    graphics.circle(ring.x, ring.y, ring.radius);
    graphics.stroke({ color: COLORS.hostile, width: 3 / scale, alpha: ring.alpha });
  }
}

/**
 * The rings, as thin circles of water — the `sonar` accent for a pulse of ours, `hostile` for one
 * that was fired at us (`render/pings.ts#HostilePings`).
 *
 * Stroked and never filled: a filled disc would read as a thing occupying the water, and what
 * this is meant to say is "a sound left here just now". The width is divided by the scale for
 * the same reason the grid's is — it is a distance in metres, and without that it would thicken
 * seventeen-fold across the zoom range.
 *
 * Colour is the only parameter, and that is the whole design: the two rings are the same event and
 * differ in the one thing that changes what the player does about it.
 */
function drawPings(
  graphics: Graphics,
  rings: readonly PingRing[],
  scale: number,
  color: number = COLORS.sonar,
): void {
  graphics.clear();

  for (const ring of rings) {
    if (ring.radius <= 0) continue;
    graphics.circle(ring.x, ring.y, ring.radius);
    // One stroke per ring rather than one for all of them: each carries its own alpha, which
    // is the entire animation.
    graphics.stroke({ color, width: 2 / scale, alpha: ring.alpha });
  }
}

/**
 * Where a sound sits relative to the picture, as a pan and a level.
 *
 * Both are measured in *screen radii* — how far the sound is from the middle of the core
 * viewport as a fraction of the half-width and half-height on show. That is what makes the cue
 * hold at every zoom and on every monitor: the player hears where the thing is **in the picture
 * they are looking at**, which is the only frame of reference they actually have.
 *
 * One function for every voice in the game — the pulse, the propellers, the bangs — so that a boat
 * off the left edge of the screen is heard on the left whatever kind of noise it is making.
 */
function soundFor(at: Vec2, camera: Camera, core: Rect, scale: number): SoundPlacement {
  const halfWidth = core.width / 2 / scale;
  const halfHeight = core.height / 2 / scale;
  const dx = halfWidth <= 0 ? 0 : (at.x - camera.x) / halfWidth;
  const dy = halfHeight <= 0 ? 0 : (at.y - camera.y) / halfHeight;

  const distance = Math.hypot(dx, dy);
  return {
    pan: Math.min(1, Math.max(-1, dx)),
    level: Math.max(0, 1 - distance / AUDIBLE_SCREENS),
  };
}

/**
 * The core viewport, drawn as instrument housing: a hairline box with brighter corner ticks.
 *
 * It earns its place twice. It is the frame the fixed markings will hang off, and it makes the
 * camera limit legible — when panning stops, the player can see the map edge resting against
 * this line rather than wondering whether the controls dropped an input.
 */
function drawFrame(graphics: Graphics, core: Rect): void {
  const { x, y, width, height } = core;

  graphics.clear();
  graphics.rect(x, y, width, height);
  graphics.stroke({ color: COLORS.frame, width: 1, alpha: 0.4 });

  for (const [cx, cy, sx, sy] of [
    [x, y, 1, 1],
    [x + width, y, -1, 1],
    [x, y + height, 1, -1],
    [x + width, y + height, -1, -1],
  ] as const) {
    graphics.moveTo(cx + CORNER_TICK * sx, cy);
    graphics.lineTo(cx, cy);
    graphics.lineTo(cx, cy + CORNER_TICK * sy);
  }
  graphics.stroke({ color: COLORS.frame, width: 2, alpha: 0.9 });
}
