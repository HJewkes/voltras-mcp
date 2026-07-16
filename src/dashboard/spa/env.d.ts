/// <reference types="vite/client" />

// Teaches react-native's types about `className`, which nativewind adds and the ported
// live page uses for COLOUR (layout goes through `style` — see live-page/LivePage.tsx).
// Types only: nothing imports nativewind at runtime here, since this app has no
// nativewind babel transform and consumes titan's Tailwind CSS instead.
/// <reference types="nativewind/types" />

// Side-effect CSS imports (e.g. the titan-design theme) carry no types.
declare module '*.css';
