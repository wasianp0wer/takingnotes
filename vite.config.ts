import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// transformers.js points onnxruntime-web at the jsdelivr CDN at runtime (it sets
// wasmPaths whenever unset, in @huggingface/transformers/src/backends/onnx.js), so the
// 26.8 MB ort-wasm-simd-threaded.asyncify-*.wasm that Vite emits - because of a
// `new URL(...)` fallback in the onnxruntime-web bundle - is never fetched. Stripping it
// also avoids exceeding Cloudflare Pages' 25 MiB per-file limit.
function stripOrtWasm(): Plugin {
  return {
    name: "strip-ort-wasm",
    generateBundle(_, bundle) {
      for (const fileName of Object.keys(bundle)) {
        // Not anchored to the start: emitted names are prefixed with the assets dir (e.g. "assets/ort-wasm-...").
        if (/ort-wasm.*\.wasm$/.test(fileName)) delete bundle[fileName];
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), stripOrtWasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-ui': ['@radix-ui/react-dialog', '@radix-ui/react-scroll-area', '@radix-ui/react-slider', '@radix-ui/react-select', '@radix-ui/react-tooltip', '@radix-ui/react-separator'],
        },
      },
    },
  },
});
