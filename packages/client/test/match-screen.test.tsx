/**
 * @vitest-environment jsdom
 *
 * The match screen: it hands the map to the scope host and the HUD names the mode and map.
 * ScopeHost is mocked — the Pixi canvas is a WebGL concern these tests have no business
 * opening, and the render loop is covered in the browser, not in jsdom.
 */
import { generateMap } from '@seg/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: ({ map }: { map: { mapType: string } }) => (
    <div data-testid="scope" data-map-type={map.mapType} />
  ),
}));

afterEach(() => {
  useMatch.setState({ matchId: null, states: {} });
  cleanup();
});

describe('MatchScreen', () => {
  it('renders a splash while the start event has arrived but the payload has not', () => {
    useMatch.setState({ matchId: 'm1', states: {} });

    render(<MatchScreen />);

    expect(screen.getByText(/loading match/i)).toBeTruthy();
    expect(screen.queryByTestId('scope')).toBeNull();
  });

  it('mounts the scope with the map once the payload lands', () => {
    const map = generateMap('empty', { seed: 42, mapSize: 'large' });
    useMatch.setState({
      matchId: 'm1',
      states: { m1: { t: 'match.state', matchId: 'm1', mode: 'deathmatch', map } },
    });

    render(<MatchScreen />);

    expect(screen.getByTestId('scope').getAttribute('data-map-type')).toBe('empty');
  });

  it('names the mode and the map in the HUD', () => {
    const map = generateMap('empty', { seed: 42, mapSize: 'medium' });
    useMatch.setState({
      matchId: 'm1',
      states: { m1: { t: 'match.state', matchId: 'm1', mode: 'objective-capture', map } },
    });

    render(<MatchScreen />);

    // Shared describe helpers, so the labels can never drift from the wire vocabulary.
    expect(screen.getByText(/objective capture/i)).toBeTruthy();
    expect(screen.getByText(/empty/i)).toBeTruthy();
    expect(screen.getByText(/medium/i)).toBeTruthy();
  });
});
