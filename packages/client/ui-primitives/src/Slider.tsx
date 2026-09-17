// Slider: a bounded numeric input. `label` is required and has no default, so a
// render site cannot ship the control without an accessible name.

import clsx from 'clsx'
import css from './Slider.module.css'

/**
 * Render a range slider. The value is always one the caller supplied, which is
 * what lets an owner clamp it against the space it is sizing.
 * @param props.min - lowest selectable value; the control refuses to move below it.
 * @param props.max - highest selectable value; callers keep it at or above `min`.
 * @param props.value - the current value; the control is fully controlled.
 * @param props.onChange - called with the value the input asks for, on every step of a drag.
 * @param props.label - localized accessible name, owned by the render site.
 * @param props.valueText - localized reading of the current value, when the number alone is not what the user sees.
 * @param props.className - extra class for layout placement.
 * @returns the slider element.
 */
export function Slider({ min, max, value, onChange, label, valueText, className }: {
  min: number
  max: number
  value: number
  onChange: (next: number) => void
  label: string
  valueText?: string | undefined
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      // One pixel per step: the control sizes a pixel width, so an interpolated
      // step would pick widths the owner never chose.
      step={1}
      value={value}
      aria-label={label}
      aria-valuetext={valueText}
      className={clsx(css.slider, className)}
      onChange={(event) => { onChange(Number(event.currentTarget.value)) }}
    />
  )
}
