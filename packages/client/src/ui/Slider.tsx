import { type ReactNode, useId } from 'react';

interface SliderProps {
  label: string;
  /** The formatted current value, shown beside the label. */
  display: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Read-only for everyone who is not the host. */
  disabled?: boolean;
  /** Marks this value as changed from the saved one. */
  dirty?: boolean;
  onChange: (value: number) => void;
}

/**
 * A settings slider.
 *
 * Everyone in the lobby sees every setting and its current value; only the host gets a
 * working control. Disabled rather than hidden, deliberately — a player deciding whether to
 * stay needs to see the point budget and the player cap, and hiding them from non-hosts
 * would make the lobby feel like it has secrets.
 */
export function Slider({
  label,
  display,
  value,
  min,
  max,
  step,
  disabled,
  dirty,
  onChange,
}: SliderProps) {
  const id = useId();

  return (
    <div className="setting" data-dirty={dirty === true}>
      <div className="setting__head">
        <label className="setting__label" htmlFor={id}>
          {label}
        </label>
        <output className="setting__value" htmlFor={id}>
          {display}
          {/* Shape as well as colour, per 08 §7 — the dot is not the only signal. */}
          {dirty === true && (
            <span className="setting__dirty" aria-label="unsaved change">
              {' '}
              •
            </span>
          )}
        </output>
      </div>
      <input
        id={id}
        className="setting__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  disabled?: boolean;
  dirty?: boolean;
  onChange: (value: T) => void;
}

/**
 * A small set of named options — game mode, visibility.
 *
 * A radio group rather than a `<select>`: there are two or three choices, they matter, and
 * a group of buttons shows the alternatives without a click. Non-hosts get the same control
 * disabled, so the selected value is still legible.
 */
export function Choice<T extends string>({
  label,
  value,
  options,
  disabled,
  dirty,
  onChange,
}: ChoiceProps<T>) {
  const name = useId();

  return (
    <div className="setting" data-dirty={dirty === true}>
      <div className="setting__head">
        <span className="setting__label" id={`${name}-label`}>
          {label}
        </span>
        {dirty === true && (
          <span className="setting__value setting__dirty" aria-label="unsaved change">
            •
          </span>
        )}
      </div>
      <div className="choice" role="radiogroup" aria-labelledby={`${name}-label`}>
        {options.map((option) => (
          <label key={option.value} className="choice__option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
