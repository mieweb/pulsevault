// Legacy-resolver fallback for the "./core" subpath export. Modern
// Node/bundlers resolve "@mieweb/pulsevault/core" via package.json's
// "exports" map straight to dist/core.js and never reach this file — it
// exists only for resolvers that don't understand "exports" subpath maps
// (e.g. Meteor's bundler as of Meteor 3.4 / modules@0.20.3), which fall back
// to plain relative-path resolution and need a real file at this path.
export * from "./dist/core.js";
