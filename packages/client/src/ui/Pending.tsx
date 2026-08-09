import type { ReactNode } from 'react';

interface PendingProps {
  /** The roadmap milestone that delivers this, e.g. "M5". */
  milestone: string;
  heading: string;
  /** What is missing and why, in one or two sentences. */
  what: ReactNode;
}

/**
 * A destination that exists in the menu but not yet in the product.
 *
 * The alternative — a dead button, or one that silently does nothing — is the worse
 * failure: a player cannot tell a missing feature from a broken one. Naming the milestone
 * makes it obviously deliberate.
 */
export function Pending({ milestone, heading, what }: PendingProps) {
  return (
    <section className="pending" aria-labelledby="pending-heading">
      <p className="pending__badge">Not built yet · {milestone}</p>
      <h3 className="pending__heading" id="pending-heading">
        {heading}
      </h3>
      <p className="pending__body">{what}</p>
    </section>
  );
}
