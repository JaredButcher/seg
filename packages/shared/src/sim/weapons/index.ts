/**
 * @seg/shared/sim/weapons — step 5 of the tick (planning/04 §1), and the only part of the
 * simulation a player can point at something.
 *
 * `launch.ts` puts a weapon in the water and makes the boat loud about it, `kinematics.ts` is how
 * one moves and what its pitch band will and will not let it follow, `seeker.ts` is the small
 * deaf active sonar in a standard torpedo's nose, and `phase.ts` is the phase the runtime calls
 * once per tick — arming, fuzing, detonating, and turning the tubes over.
 *
 * The two loads that are built are the two the design pairs against each other: a slow homing
 * weapon whose click is an enable point, and a fast unguided one whose click is an aim point.
 * `content/weapons.ts` is where both are tuned and where the other four are marked unbuilt.
 */

export * from './kinematics.js';
export * from './launch.js';
export * from './phase.js';
export * from './seeker.js';
