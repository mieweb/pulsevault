// The Pulse icon files in assets/: what scripts/gen-pulse-icons.mjs wrote is what is committed,
// the icon is the logo's own drawing, and each file is what a host can rely on (a square 24 × 24
// icon, self-contained, with ids of its own so two can be inlined on one page).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "assets");
const ICONS = ["pulse-icon.svg", "pulse-icon-mono.svg", "pulse-icon-white.svg"];
const read = (file) => fs.readFileSync(path.join(assets, file), "utf8");

test("the committed icon files are what the generator writes", () => {
  execFileSync(process.execPath, [path.join(root, "scripts", "gen-pulse-icons.mjs"), "--check"], { stdio: "pipe" });
});

test("there is one file for each colouring, and no other", () => {
  const present = fs.readdirSync(assets).filter((f) => f.startsWith("pulse-icon"));
  assert.deepEqual(present.sort(), [...ICONS].sort());
});

for (const file of ICONS) {
  test(`${file} is a square, self-contained, named icon`, () => {
    const svg = read(file);
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24" role="img" aria-label="Pulse">/);
    assert.match(svg, /<title>Pulse<\/title>/);
    // Nothing fetched or run: an icon is safe to inline from the package as it is.
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|href=|\son[a-z]+=|url\((?!#)/i);
    // Every id is used, and is the file's own.
    const name = file.replace(/\.svg$/, "");
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      assert.ok(id.startsWith(`${name}-`), `${id} doesn't carry the file's name`);
      assert.ok(svg.includes(`url(#${id})`), `${id} is never used`);
    }
  });
}

test("no two icon files share an id, so any of them can be inlined together", () => {
  const seen = new Map();
  for (const file of ICONS) {
    for (const [, id] of read(file).matchAll(/\sid="([^"]+)"/g)) {
      assert.equal(seen.get(id), undefined, `${id} is in ${seen.get(id)} and ${file}`);
      seen.set(id, file);
    }
  }
});

test("each colouring paints the shape as it says", () => {
  const fill = (file) => /<rect width="24" height="24" fill="([^"]+)"/.exec(read(file))?.[1];
  assert.equal(fill("pulse-icon.svg"), "url(#pulse-icon-red)");
  assert.equal(fill("pulse-icon-mono.svg"), "currentColor");
  assert.equal(fill("pulse-icon-white.svg"), "#fff");
});

test("the icon is the logo's own drawing: its shape and its colours, placed in the square", () => {
  const squeeze = (text) => text.replace(/\s+/g, " ").trim();
  const logo = read("pulse-logo.svg");
  const logoShape = squeeze(/<mask[^>]*>([\s\S]*?)<\/mask>/.exec(logo)[1]);
  const logoStops = squeeze(/<linearGradient[^>]*>([\s\S]*?)<\/linearGradient>/.exec(logo)[1]);
  for (const file of ICONS) {
    const placed = /<g transform="([^"]+)">([\s\S]*?)<\/g>\s*<\/mask>/.exec(read(file));
    assert.equal(squeeze(placed[2]), logoShape, `${file} doesn't draw the logo's shape`);
    // Scaled evenly (one factor), to the square's full height, centred across it.
    const [, tx, ty, scale] = /^translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\) /.exec(placed[1]).map(Number);
    const [, , width, height] = /viewBox="([-\d. ]+)"/.exec(logo)[1].split(" ").map(Number);
    assert.equal(ty, 0);
    assert.ok(Math.abs(height * scale - 24) < 0.01, "not the square's full height");
    assert.ok(Math.abs(tx - (24 - width * scale) / 2) < 0.01, "not centred");
  }
  assert.equal(squeeze(/<linearGradient[^>]*>([\s\S]*?)<\/linearGradient>/.exec(read("pulse-icon.svg"))[1]), logoStops);
});

test("both logo files draw one shape, and its heartbeat is one even line", () => {
  const shape = (file) => /<mask[^>]*>([\s\S]*?)<\/mask>/.exec(read(file))[1].replace(/\s+/g, " ").trim();
  assert.equal(shape("pulse-logo.svg"), shape("pulse-logo-mono.svg"));
  // A stroked centre line, not a traced outline: one width along its whole length, round ends
  // and joins, and level at both ends.
  const beat = /<path fill="none" stroke="#000" stroke-width="([\d.]+)" stroke-linecap="round" stroke-linejoin="round" d="([^"]+)"\/>/.exec(
    read("pulse-logo.svg"),
  );
  assert.ok(beat, "the heartbeat isn't a single stroked path");
  const points = [...beat[2].matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
  assert.equal(points.at(0)[1], points.at(-1)[1], "the two ends aren't level");
  assert.ok(points.at(-1)[0] > points.at(0)[0]);
});
