/**
 * No-op stub for `react-native-body-highlighter`.
 *
 * The `@titan-design/react-ui` barrel eagerly imports `react-native-body-highlighter`
 * (via its BodyMap component). That package ships no web build, and its Node-targeted
 * ESM interop resolves `react` through a dynamic `require()` that throws in a browser
 * ESM context ("Dynamic require of 'react' is not supported"). BodyMap is a Phase 3
 * concern, not Phase 0, so the SPA's vite config aliases the package to this no-op
 * default purely so the barrel can load and svg-free components (Metric) render.
 *
 * Mirrors titan-design/packages/ui/specimen/stubs/react-native-body-highlighter.tsx.
 */
export default function BodyHighlighterStub(): null {
  return null;
}
