/**
 * A small set of mutually exclusive choices, drawn as buttons.
 *
 * The app already renders such a group this way (`role="radiogroup"` with
 * `aria-checked` buttons, see the workbench settings), and a group of plain
 * buttons keeps the choice usable with no animation to run and no popup layer
 * to place.
 */
import type { ReactNode } from "react";

import { FEEDBACK_CLASS } from "./motion.ts";

export interface ChoiceGroupProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}

export function ChoiceGroup<T extends string>({ label, value, options, onChange }: ChoiceGroupProps<T>): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`rounded-full px-3 py-1 text-[12px] active:scale-[0.98] ${FEEDBACK_CLASS} transition-colors ${
              selected ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
