import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppShell } from '@/app/AppShell'
import { CaptureProvider } from '@/capture/CaptureContext'
import { createCaptureEngine } from '@/capture/engine'
import { TabletProvider, useHuionDevice } from '@/device/TabletProvider'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TabletProvider>
      <CaptureRoot />
    </TabletProvider>
  </StrictMode>,
)
