/**
 * @seg/shared/sim/weapons — step 5 of the tick (planning/04 §1), and the only part of the
 * simulation a player can point at something.
 *
 * `launch.ts` puts a weapon in the water and makes the boat loud about it, `kinematics.ts` is how
 * one moves — including the launch manoeuvre every load starts with and the pitch band that
 * decides what it can follow — `seeker.ts` is the small deaf active sonar in a standard
 * torpedo's nose, `decoy.ts` is the one thing that sees through an active decoy, and `phase.ts`
 * is the phase the runtime calls once per tick: arming, fuzing, detonating, and turning the
 * tubes over.
 *
 * Four loads are built, in two pairs. The design pairs the warheads against each other — a slow
 * homing weapon whose click is an enable point, and a fast unguided one whose click is an aim
 * point — and the utility loads against the picture: a drone that adds a listener where you are
 * not, and a decoy that adds a *you* where you are not. `content/weapons.ts` is where all four
 * are tuned and where the mine is marked unbuilt.
 */

export * from './decoy.js';
export * from './kinematics.js';
export * from './launch.js';
export * from './phase.js';
export * from './seeker.js';
