import { type InputHTMLAttributes, type ReactNode, useId } from 'react';

/** A rule the field must satisfy, shown live as the player types. */
export interface Requirement {
  readonly label: string;
  readonly met: boolean;
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Shown below the field, and announced to screen readers. */
  error?: string | undefined;
  /** Persistent guidance, e.g. length requirements. */
  hint?: ReactNode;
  /** Checklist shown above the hint, ticking off as the player satisfies each rule. */
  requirements?: readonly Requirement[];
  /** Adds a show/hide toggle. On a game with no password recovery, being able to *see*
   *  what you typed is a real safeguard, not a convenience. */
  revealable?: boolean;
  revealed?: boolean;
  onToggleReveal?: () => void;
}

export function Field({
  label,
  error,
  hint,
  requirements,
  revealable,
  revealed,
  onToggleReveal,
  ...input
}: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const reqId = `${id}-requirements`;

  const hasRequirements = requirements !== undefined && requirements.length > 0;

  const describedBy = [hasRequirements ? reqId : null, hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>

      <div className="field__control">
        <input
          {...input}
          id={id}
          className="field__input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy.length > 0 ? describedBy : undefined}
        />
        {revealable && (
          <button
            type="button"
            className="field__reveal"
            onClick={onToggleReveal}
            aria-pressed={revealed}
            // The label changes with state so a screen reader announces the action, not
            // just an icon.
            aria-label={revealed ? 'Hide password' : 'Show password'}
          >
            {revealed ? 'HIDE' : 'SHOW'}
          </button>
        )}
      </div>

      {/*
        Deliberately NOT an aria-live region. Announcing a requirement flipping state on
        every keystroke is unusable with a screen reader. Instead the list is referenced by
        aria-describedby, so it is read when the field receives focus, and the submit-time
        error (role="alert") covers the failure case.
      */}
      {hasRequirements && (
        <ul className="requirements" id={reqId}>
          {requirements.map((requirement) => (
            <li key={requirement.label} className="requirements__item" data-met={requirement.met}>
              {/* Shape carries the state as well as colour — never colour alone. */}
              <span className="requirements__mark" aria-hidden="true">
                {requirement.met ? '✓' : '○'}
              </span>
              {requirement.label}
              <span className="visually-hidden">
                {requirement.met ? ' — met' : ' — not yet met'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {hint && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string | undefined;
  disabled?: boolean;
}

export function Checkbox({ label, checked, onChange, error, disabled }: CheckboxProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="checkbox">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      <label htmlFor={id}>{label}</label>
      {error && (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface ButtonProps {
  children: ReactNode;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
}

export function Button({
  children,
  type = 'button',
  variant = 'primary',
  disabled,
  busy,
  onClick,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`button button--${variant}`}
      disabled={disabled === true || busy === true}
      // Announces the pending state rather than leaving a screen reader in silence.
      aria-busy={busy}
      onClick={onClick}
    >
      {busy ? 'WORKING…' : children}
    </button>
  );
}

/** A form-level message — the failures that belong to no single field. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p className="form-error" role="alert">
      {children}
    </p>
  );
}
