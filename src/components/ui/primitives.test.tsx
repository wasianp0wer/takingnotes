// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { Button, buttonVariants } from "./button"
import { HOVER_AFFORDANCE } from "./hover"
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
  it("carries the active underline and is not rounded-md", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() =>
      root.render(
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">A</TabsTrigger>
          </TabsList>
        </Tabs>
      )
    )
    const el = host.querySelector('[data-slot="tabs-trigger"]')!
    expect(el.getAttribute("data-state")).toBe("active")
    expect(el.className).toContain("data-[state=active]:shadow-[inset_0_-3px_0_hsl(var(--primary))]")
    expect(el.className).not.toContain("rounded-md")
    act(() => root.unmount())
    host.remove()
  })
})
