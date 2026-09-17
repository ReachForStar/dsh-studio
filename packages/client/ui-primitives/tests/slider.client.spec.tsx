// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Slider } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('Slider', () => {
  it('carries the bounds it was given and reports every chosen value', () => {
    const onChange = vi.fn()
    render(<Slider min={640} max={1424} value={920} label="Content width" onChange={onChange} />)
    const slider = screen.getByRole('slider', { name: 'Content width' }) as HTMLInputElement

    expect(slider.min).toBe('640')
    expect(slider.max).toBe('1424')
    expect(slider.step).toBe('1')
    expect(slider.value).toBe('920')

    fireEvent.change(slider, { target: { value: '1000' } })
    expect(onChange).toHaveBeenCalledWith(1000)
  })

  it('names the value for assistive technology when a number alone is not the reading', () => {
    render(
      <Slider
        min={0}
        max={10}
        value={4}
        label="Width"
        valueText="Content width 4 pixels"
        onChange={() => {}}
      />,
    )
    expect(screen.getByRole('slider', { name: 'Width' }).getAttribute('aria-valuetext'))
      .toBe('Content width 4 pixels')
  })

  it('forwards a placement class', () => {
    render(<Slider min={0} max={10} value={4} label="Width" className="placement" onChange={() => {}} />)
    expect(screen.getByRole('slider', { name: 'Width' }).classList.contains('placement')).toBe(true)
  })
})
