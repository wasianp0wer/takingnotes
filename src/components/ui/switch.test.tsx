// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Switch } from "./switch"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function mount(props: { checked?: boolean; disabled?: boolean; onChange?: (v: boolean) => void }) {
  act(() => {
    root.render(
      <Switch
        checked={props.checked ?? false}
        onCheckedChange={props.onChange ?? (() => {})}
        offLabel="Off side"
        onLabel="On side"
        aria-label="Mode"
        disabled={props.disabled}
      />
    )
  })
  return host.querySelector('[role="switch"]') as HTMLButtonElement
}

describe("Switch", () => {
  it("renders role=switch with aria-checked=false", () => {
    expect(mount({}).getAttribute("aria-checked")).toBe("false")
  })
  it("calls back with true on click", () => {
    const fn = vi.fn()
    const el = mount({ onChange: fn })
    act(() => el.click())
    expect(fn).toHaveBeenCalledWith(true)
  })
  it("is a native button (the browser supplies Space and Enter activation)", () => {
    const el = mount({})
    expect(el.tagName).toBe("BUTTON")
    expect(el.type).toBe("button")
  })
  it("when checked, reports aria-checked=true and click calls back with false", () => {
    const fn = vi.fn()
    const el = mount({ checked: true, onChange: fn })
    expect(el.getAttribute("aria-checked")).toBe("true")
    act(() => el.click())
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(false)
  })
  it("keeps a focus-visible ring", () => {
    expect(mount({}).className).toContain("focus-visible:ring-2")
  })
  it("does not call back when disabled", () => {
    const fn = vi.fn()
    const el = mount({ disabled: true, onChange: fn })
    act(() => el.click())
    expect(fn).not.toHaveBeenCalled()
  })
  it("renders both labels", () => {
    mount({})
    expect(host.textContent).toContain("Off side")
    expect(host.textContent).toContain("On side")
  })
})
