// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { Button, buttonVariants } from "./button"
import { HOVER_AFFORDANCE } from "./hover"
import { Input } from "./input"
import { Tabs, TabsList, TabsTrigger } from "./tabs"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const
const tokens = (s: string) => s.split(/\s+/).filter(Boolean)

describe("Button visual language", () => {
  for (const v of ["outline", "ghost"] as const) {
    it(`${v} has the hover affordance, no resting border or fill`, () => {
      const cls = tokens(buttonVariants({ variant: v }))
      for (const t of tokens(HOVER_AFFORDANCE)) expect(cls).toContain(t)
      expect(cls).not.toContain("border-input")
      expect(cls).not.toContain("border")
      expect(cls.filter((t) => t.startsWith("bg-"))).toEqual([])
    })
  }
  for (const v of variants) {
    it(`${v} keeps a focus-visible ring`, () => {
      expect(tokens(buttonVariants({ variant: v })).some((t) => t.startsWith("focus-visible:ring"))).toBe(true)
    })
  }
  it("renders through Button", () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    act(() => root.render(<Button variant="ghost">x</Button>))
    expect(host.querySelector("button")!.className).toContain("hover:bg-hover")
    act(() => root.unmount())
  })
})

describe("TabsTrigger", () => {
  function mountTabs() {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() =>
      root.render(
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">A</TabsTrigger>
            <TabsTrigger value="b">B</TabsTrigger>
          </TabsList>
        </Tabs>
      )
    )
    return { host, done: () => { act(() => root.unmount()); host.remove() } }
  }
  it("carries the active underline and is not rounded-md", () => {
    const { host, done } = mountTabs()
    const el = host.querySelector('[data-slot="tabs-trigger"]')!
    expect(el.getAttribute("data-state")).toBe("active")
    expect(el.className).toContain("data-[state=active]:shadow-[inset_0_-3px_0_hsl(var(--primary))]")
    expect(el.className).not.toContain("rounded-md")
    done()
  })
  it("an inactive trigger has no unconditional underline", () => {
    const { host, done } = mountTabs()
    const el = host.querySelectorAll('[data-slot="tabs-trigger"]')[1]
    expect(el.getAttribute("data-state")).toBe("inactive")
    const unconditional = el.className.split(/\s+/).filter((t) => /^shadow-/.test(t))
    expect(unconditional).toEqual([])
    done()
  })
  it("keeps a focus-visible ring", () => {
    const { host, done } = mountTabs()
    expect(host.querySelector('[data-slot="tabs-trigger"]')!.className).toContain("focus-visible:ring-2")
    done()
  })
})

describe("Input", () => {
  it("keeps a focus-visible ring", () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    act(() => root.render(<Input />))
    expect(host.querySelector("input")!.className).toContain("focus-visible:ring-2")
    act(() => root.unmount())
  })
})
