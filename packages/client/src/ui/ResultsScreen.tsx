/**
 * The battle results screen (planning/06 §5, 08 §8).
 *
 * The first screen in the game that is allowed to tell the truth about both sides. Everything
 * else a player sees is narrowed to what their fleet earned; this is built from `MatchResults`,
 * which is the same object for everyone (`@seg/shared/match/results`), and that is the whole
 * point — thirty minutes of not knowing, answered at once.
 *
 * ## The shape
 *
 * The outcome across the top: both teams' scores, who won, and what ended it. Then two columns —
 * **yours on the left, theirs on the right** — each a list of that side's players with their
 * boats under them. A spectator has no side, so they get team 1 on the left and the reading is
 * unchanged; nobody's column moves depending on who is looking except the viewer's own.
 *
 * Per boat: what it had left, whether it went down, how long it lasted, what it sank, what it
 * dealt, what it captured, and what it fired. That is deliberately the set that can be checked
 * against a memory of the match — a player who watched a boat die knows how long it lasted and
 * will notice if this disagrees.
 *
 * ## What is not here yet
 *
 * The Reveal, the acoustic report, the awards, and Rematch / Save Replay (planning/06 §5). They
 * need a replay buffer and the detection tracking that `secondsDetected` is waiting on, and none
 * of it is invented here: a panel showing a zero for time detected would be a lie in the largest
 * type on the screen. Leaving for the main menu is the one action, through the same Esc window
 * the match has.
 */

import {
  describeGameMode,
  describeTeam,
  describeWinReason,
  getHull,
  TEAM_IDS,
  type BoatResult,
  type MatchResults,
  type PlayerResult,
  type TeamId,
  type TeamResult,
} from '@seg/shared';
import { useState } from 'react';

import { useLobby } from '../state/lobby.js';
import { activeSetup, useMatch } from '../state/match.js';
import { EscMenu } from './EscMenu.js';
import { HullIcon } from './HullIcon.js';
import { useEscape } from './escape.js';
import { formatClock, scoreOf } from './hud/rows.js';

export function ResultsScreen() {
  const results = useMatch((s) => s.results);
  // Only for *which side is the viewer on* — every name and number on this screen comes off the
  // results themselves, so a tab that reconnected after the end (and was never sent a setup)
  // still renders the whole thing, just without a side of its own.
  const you = useMatch(activeSetup)?.you.team ?? null;
  const leaveMatch = useLobby((s) => s.leaveMatch);

  const [menuOpen, setMenuOpen] = useState(false);
  useEscape(() => setMenuOpen(true), !menuOpen);

  // The store navigates here on `match.results` and clears both together, so this is a frame at
  // most — and it beats rendering an empty scoreboard.
  if (results === null) {
    return (
      <main className="screen screen--results">
        <p className="match__loading" role="status">
          Loading results…
        </p>
      </main>
    );
  }

  const sides = orderedSides(results, you);

  return (
    <main className="screen screen--results">
      <Outcome results={results} you={you} />

      <div className="results__columns">
        {sides.map((team) => (
          <TeamColumn key={team.team} results={results} team={team} yours={team.team === you} />
        ))}
      </div>

      <footer className="results__foot">
        <button type="button" className="match__menu" onClick={() => setMenuOpen(true)}>
          MENU <span className="match__menu-key">ESC</span>
        </button>
        <p className="match__meta match__meta--id">MATCH {results.matchId.slice(0, 8)}</p>
      </footer>

      {menuOpen && (
        <EscMenu context="results" onResume={() => setMenuOpen(false)} onLeave={leaveMatch} />
      )}
    </main>
  );
}

// ── the outcome ─────────────────────────────────────────────────────────────────────

/**
 * Who won, and how.
 *
 * The verdict is written from the *viewer's* side when they have one — VICTORY or DEFEAT, which
 * is the thing they actually want to know — with the team that won named underneath either way,
 * so a spectator and a player read the same fact.
 */
function Outcome({ results, you }: { results: MatchResults; you: TeamId | null }) {
  const draw = results.winner === 'draw';

  return (
    <header className="results__head">
      <p className="results__mode">{`${describeGameMode(results.mode)} · ${formatClock(results.durationSeconds)}`}</p>

      <h1 className={draw ? 'results__verdict' : 'results__verdict results__verdict--decided'}>
        {verdictFor(results, you)}
      </h1>

      <p className="results__reason">
        {draw
          ? `Nobody won — ${describeWinReason(results.reason).toLowerCase()}`
          : `${describeTeam(results.winner)} wins — ${describeWinReason(results.reason).toLowerCase()}`}
      </p>

      <div className="results__score" role="group" aria-label="Final score">
        {orderedSides(results, you).map((team) => (
          <ScoreBox key={team.team} results={results} team={team} yours={team.team === you} />
        ))}
      </div>
    </header>
  );
}

/**
 * The one word at the top.
 *
 * A player is told what happened *to them*; someone with no side in it is told which side took
 * it, because "VICTORY" would be a claim about nobody. The line under this names the winner
 * either way, so the two readings never disagree.
 */
function verdictFor(results: MatchResults, you: TeamId | null): string {
  if (results.winner === 'draw') return 'DRAW';
  if (you === null) return `${describeTeam(results.winner).toUpperCase()} WINS`;
  return you === results.winner ? 'VICTORY' : 'DEFEAT';
}

function ScoreBox({
  results,
  team,
  yours,
}: {
  results: MatchResults;
  team: TeamResult;
  yours: boolean;
}) {
  const objective = results.mode === 'objective-capture';

  return (
    <div
      className={
        team.team === results.winner
          ? 'results__score-box results__score-box--won'
          : 'results__score-box'
      }
    >
      <p className="results__score-team">
        {describeTeam(team.team)}
        {yours ? ' · YOU' : ''}
      </p>
      <p className="results__score-value">
        <strong>{Math.round(scoreOf(team, results.mode))}</strong>
        {/* The target is the other half of an Objective Capture score: 7 means nothing alone. */}
        {objective && (
          <span className="results__score-of">{`/ ${String(results.scoreTarget)}`}</span>
        )}
      </p>
      <p className="results__score-note">
        {objective ? 'OBJECTIVES CAPTURED' : 'SURVIVING FLEET POINTS'}
      </p>
      <p className="results__score-note">{`${String(team.boatsAlive)} / ${String(team.boatsTotal)} AFLOAT`}</p>
    </div>
  );
}

// ── the columns ─────────────────────────────────────────────────────────────────────

function TeamColumn({
  results,
  team,
  yours,
}: {
  results: MatchResults;
  team: TeamResult;
  yours: boolean;
}) {
  const players = results.players.filter((player) => player.team === team.team);
  const label = `${describeTeam(team.team)}${yours ? ' · your team' : ''}`;

  return (
    <section
      className={yours ? 'results__side results__side--you' : 'results__side'}
      aria-label={label}
    >
      <header className="results__side-head">
        <h2 className="results__side-title">
          {describeTeam(team.team)}
          {yours && <span className="results__side-you">YOUR TEAM</span>}
        </h2>
        <p className="results__side-note">
          {`${String(players.length)} ${players.length === 1 ? 'PLAYER' : 'PLAYERS'} · ` +
            `${String(team.boatsAlive)} / ${String(team.boatsTotal)} AFLOAT`}
        </p>
      </header>

      {players.length === 0 ? (
        <p className="results__empty">Nobody played for this side.</p>
      ) : (
        players.map((player) => (
          <PlayerBlock key={player.accountId} player={player} mode={results.mode} />
        ))
      )}
    </section>
  );
}

/** One player, and the boats they commanded — the fleet order they were listed in all match. */
function PlayerBlock({ player, mode }: { player: PlayerResult; mode: MatchResults['mode'] }) {
  const afloat = player.boats.filter((boat) => !boat.sunk).length;
  const sank = player.boats.reduce((sum, boat) => sum + boat.sank.length, 0);
  const damage = player.boats.reduce((sum, boat) => sum + boat.damageDealt, 0);

  return (
    <article className="results__player">
      <header className="results__player-head">
        <h3 className="results__player-name">{player.username}</h3>
        <p className="results__player-line">
          {`${String(afloat)} / ${String(player.boats.length)} AFLOAT · ` +
            `${String(sank)} SUNK · ${String(Math.round(damage))} DMG`}
        </p>
      </header>

      {player.boats.length === 0 ? (
        <p className="results__empty">Brought no boats.</p>
      ) : (
        <ul className="results__boats">
          {player.boats.map((boat) => (
            <li key={boat.id}>
              <BoatCard boat={boat} mode={mode} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * One boat's match.
 *
 * The hit-point bar is the card's headline because it is the one number that reads without being
 * read — a sliver of green says "it nearly went" faster than "14 / 120" does. The figure is there
 * too, because "nearly" is not something to make a player estimate off a bar.
 */
function BoatCard({ boat, mode }: { boat: BoatResult; mode: MatchResults['mode'] }) {
  const hull = getHull(boat.hull);
  const integrity = boat.maxHp === 0 ? 0 : boat.hp / boat.maxHp;

  return (
    <div className={boat.sunk ? 'results-boat results-boat--sunk' : 'results-boat'}>
      <header className="results-boat__head">
        <HullIcon hull={boat.hull} width={72} className="results-boat__icon" />
        <div className="results-boat__id">
          <p className="results-boat__name">{boat.name}</p>
          <p className="results-boat__hull">{`${hull.name} · ${String(boat.cost)} PTS`}</p>
        </div>
        <p
          className={
            boat.sunk ? 'results-boat__fate results-boat__fate--sunk' : 'results-boat__fate'
          }
        >
          {boat.sunk ? 'SUNK' : 'AFLOAT'}
        </p>
      </header>

      <div className="results-boat__hp">
        <div
          className="results-boat__hp-bar"
          role="img"
          aria-label={`${String(Math.round(boat.hp))} of ${String(Math.round(boat.maxHp))} hit points remaining`}
        >
          <span
            className="results-boat__hp-fill"
            style={{ width: `${String(Math.max(0, Math.min(1, integrity)) * 100)}%` }}
          />
        </div>
        <p className="results-boat__hp-figure">{`${String(Math.round(boat.hp))} / ${String(Math.round(boat.maxHp))} HP`}</p>
      </div>

      <dl className="results-boat__stats">
        <Stat label="Alive" value={formatClock(boat.secondsAlive)} />
        <Stat label="Damage" value={String(Math.round(boat.damageDealt))} />
        <Stat label="Torpedoes" value={String(boat.torpedoesFired)} />
        {/* No objectives exist in deathmatch, so a row of zeroes would be noise rather than a
            statistic. The mode decides, exactly as it does for the score line. */}
        {mode === 'objective-capture' && <Stat label="Objectives" value={String(boat.captures)} />}
      </dl>

      <p className="results-boat__kills">
        <span className="results-boat__kills-label">SANK</span>
        {boat.sank.length === 0 ? (
          <span className="results-boat__kills-none">—</span>
        ) : (
          <span className="results-boat__kills-list">
            {boat.sank.map((victim) => victim.name).join(', ')}
          </span>
        )}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="results-boat__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// ── ordering ────────────────────────────────────────────────────────────────────────

/**
 * The two sides, the viewer's first.
 *
 * `TEAM_IDS` order for a spectator, which keeps team 1 on the left for everyone who is not on a
 * side — the same rule the HUD's score line uses, and the reason a player and the friend watching
 * over their shoulder are not reading mirrored screens.
 */
function orderedSides(results: MatchResults, you: TeamId | null): readonly TeamResult[] {
  const byId = new Map(results.teams.map((team) => [team.team, team]));
  const ordered = TEAM_IDS.flatMap((id) => {
    const team = byId.get(id);
    return team === undefined ? [] : [team];
  });
  if (you === null) return ordered;
  return [...ordered].sort((a, b) => (a.team === you ? -1 : b.team === you ? 1 : 0));
}
