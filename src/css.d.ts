// CSS is imported for its side effect only; esbuild bundles it into dist/renderer.css.
// Kept apart from global.d.ts, whose imports make it a module, so this stays an ambient declaration.
declare module "*.css";
