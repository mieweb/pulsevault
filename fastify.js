// Legacy-resolver fallback for the "./fastify" subpath export. Modern
// Node/bundlers resolve "@mieweb/pulsevault/fastify" via package.json's
// "exports" map straight to dist/fastify.js and never reach this file — it
// exists only for resolvers that don't understand "exports" subpath maps
// (see core.js for the same fallback on "./core").
export * from "./dist/fastify.js";
export { default } from "./dist/fastify.js";
