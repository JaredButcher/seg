import { useState } from 'react';

import { LoginForm } from './LoginForm.js';
import { SignUpForm } from './SignUpForm.js';

type Tab = 'signIn' | 'create';

export function AuthScreen() {
  const [tab, setTab] = useState<Tab>('signIn');

  return (
    <main className="auth">
      <header className="auth__header">
        <h1 className="auth__title">SEG</h1>
        <p className="auth__subtitle">Submarine fleet command</p>
      </header>

      <div className="panel">
        {/*
          A real tablist rather than styled buttons: arrow-key navigation between tabs is
          expected behaviour, and screen readers announce position ("1 of 2").
        */}
        <div className="tabs" role="tablist" aria-label="Account">
          <TabButton id="signIn" current={tab} onSelect={setTab}>
            SIGN IN
          </TabButton>
          <TabButton id="create" current={tab} onSelect={setTab}>
            CREATE ACCOUNT
          </TabButton>
        </div>

        <div
          className="panel__body"
          role="tabpanel"
          id={`${tab}-panel`}
          aria-labelledby={`${tab}-tab`}
        >
          {tab === 'signIn' ? <LoginForm /> : <SignUpForm />}
        </div>
      </div>
    </main>
  );
}

interface TabButtonProps {
  id: Tab;
  current: Tab;
  onSelect: (tab: Tab) => void;
  children: React.ReactNode;
}

function TabButton({ id, current, onSelect, children }: TabButtonProps) {
  const selected = current === id;

  return (
    <button
      type="button"
      role="tab"
      id={`${id}-tab`}
      className="tab"
      aria-selected={selected}
      aria-controls={`${id}-panel`}
      // Roving tabindex: only the active tab is in the tab order, and the arrow keys move
      // between them. This is what `role="tablist"` promises.
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          onSelect(id === 'signIn' ? 'create' : 'signIn');
        }
      }}
    >
      {children}
    </button>
  );
}
