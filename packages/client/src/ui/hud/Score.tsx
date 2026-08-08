/**
 * The score (planning/08 §11, element 4). Top-centre, mode-aware, both teams always.
 *
 * The two modes are scored on different things and the panel says which rather than showing a
 * bare pair of numbers: Objective Capture counts captured points toward a target, Deathmatch
 * counts surviving fleet points with a tick mark per boat still afloat, so a wipe reads
 * instantly. Under each team, boats alive.
 *
 * **The tiebreak stat is not here.** Time detected by the enemy decides a deathmatch tie
 * (06 §2.1), and it is revealed only when it can decide the match — which is after the match.
 * It is not in the view frame at all, which is the honest place to enforce that: showing a
 * player how long they have been heard is showing them the enemy's sonar picture.
 */

import { describeTeam, type MatchSetup, type MatchViewState } from '@seg/shared';

import { orderedTeams, scoreOf } from './rows.js';

interface ScoreProps {
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
}

export function Score({ setup, view }: ScoreProps) {
  const teams = orderedTeams(view, setup.you.team);
  const objective = setup.mode === 'objective-capture';

  return (
    <div className="hud-score" role="group" aria-label="Score">
      {teams.map((team) => {
        const value = scoreOf(team, setup.mode);
        const yours = team.team === setup.you.team;
        return (
          <div
            className={yours ? 'hud-score__team hud-score__team--you' : 'hud-score__team'}
            key={team.team}
          >
            <p className="hud-score__value">
              <span className="hud-score__label">
                {describeTeam(team.team)}
                {yours ? ' · YOU' : ''}
              </span>
              <strong>{Math.round(value)}</strong>
            </p>

            {objective ? (
              <progress
                className="hud-score__bar"
                max={setup.scoreTarget}
                value={Math.min(value, setup.scoreTarget)}
                aria-label={`${describeTeam(team.team)} progress to ${String(setup.scoreTarget)}`}
              />
            ) : (
              <p
                className="hud-score__hulls"
                aria-label={`${String(team.boatsAlive)} of ${String(team.boatsTotal)} boats afloat`}
              >
                {/* One mark per boat brought, filled while it is still in the water. */}
                {Array.from({ length: team.boatsTotal }, (_, i) => (
                  <span
                    className={i < team.boatsAlive ? 'hud-tick hud-tick--alive' : 'hud-tick'}
                    key={i}
                    aria-hidden="true"
                  />
                ))}
              </p>
            )}

            <p className="hud-score__alive">
              {team.boatsAlive} / {team.boatsTotal} AFLOAT
            </p>
          </div>
        );
      })}

      {objective && <p className="hud-score__target">FIRST TO {setup.scoreTarget}</p>}
    </div>
  );
}
