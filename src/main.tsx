import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppShell } from '@/app/AppShell'
import { registerTabPresence } from '@/backup/tabPresence'
import { CaptureProvider } from '@/capture/CaptureContext'
import { createCaptureEngine } from '@/capture/engine'
import { TabletProvider, useHuionDevice } from '@/device/TabletProvider'
import { ThemeProvider } from '@/themes/ThemeProvider'
import { applyMirroredThemeEarly } from '@/themes/themeStore'

/**
 * Exists only to read the controller out of `TabletProvider` and build the one
 * capture engine from it. `useState`'s initializer rather than a module-level
 * `createCaptureEngine(...)`: the engine needs the controller, and the
 * controller is itself created inside the provider.
 *
 * The engine is deliberately never disposed. StrictMode mounts twice in
 * development, so an unmount-time `dispose()` would tear down the engine the
 * rest of the app keeps using.
 */
function CaptureRoot() {
  const { controller } = useHuionDevice()
  const [engine] = useState(() => createCaptureEngine({ controller }))

  return (
    <CaptureProvider engine={engine}>
      <AppShell />
    </CaptureProvider>
  )
}

// Paint the last-used theme before React mounts so there is no flash of Light.
try {
  applyMirroredThemeEarly(window.localStorage)
} catch {
  // localStorage can throw when blocked; the stylesheet defaults apply.
}

// Lets backup import see other open tabs. A no-op without Web Locks.
try {
  registerTabPresence()
} catch {
  // Presence is advisory; never block startup on it.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TabletProvider>
        <CaptureRoot />
      </TabletProvider>
    </ThemeProvider>
  </StrictMode>,
)
