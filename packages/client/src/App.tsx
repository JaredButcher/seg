import { useEffect } from 'react';

import { useAuth } from './state/auth.js';
import { AuthScreen } from './ui/AuthScreen.js';
import { SignedIn } from './ui/SignedIn.js';

export function App() {
  const status = useAuth((s) => s.status);
  const restore = useAuth((s) => s.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  // Showing the login form before we know whether the cookie is valid makes a signed-in
  // player watch the form flash and vanish, which reads as a bug.
  if (status === 'restoring') {
    return (
      <main className="auth">
        <p className="muted" role="status">
          Restoring session…
        </p>
      </main>
    );
  }

  return status === 'signedIn' ? <SignedIn /> : <AuthScreen />;
}
