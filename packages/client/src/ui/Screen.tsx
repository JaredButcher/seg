import type { ReactNode } from 'react';

import { useNav } from '../state/nav.js';

interface ScreenProps {
  /** Uppercase, letterspaced — the stencilled label on the panel (planning/09 §6). */
  title: string;
  subtitle?: string;
  /** Omitted on the home page, which has nowhere to go back to. */
  back?: boolean;
  children: ReactNode;
}

/**
 * The frame every menu screen sits in: masthead, a back affordance, one panel.
 *
 * Back is a real control rather than a reliance on browser history, because navigation is
 * in-memory (see state/nav.ts) and a Back button that silently leaves the app would be
 * worse than none.
 */
export function Screen({ title, subtitle, back = true, children }: ScreenProps) {
  const goHome = useNav((s) => s.goHome);

  return (
    <main className="screen">
      <header className="screen__header">
        <h1 className="screen__title">SEG</h1>
        <p className="screen__subtitle">Submarine fleet command</p>
      </header>

      <div className="panel">
        <div className="panel__head">
          {back ? (
            <button type="button" className="back" onClick={goHome}>
              <span aria-hidden="true">←</span> MAIN MENU
            </button>
          ) : (
            <span />
          )}
          <h2 className="panel__title">{title}</h2>
        </div>

        <div className="panel__body">
          {subtitle !== undefined && <p className="muted">{subtitle}</p>}
          {children}
        </div>
      </div>
    </main>
  );
}
