import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Guard the greyscale palette.
 *
 * The palette makes two promises that are easy to break with a one-character
 * edit, and neither is visible in a diff:
 *
 *   1. Every token is a true grey (R = G = B). A stray tint reintroduces hue
 *      to a design that deliberately has none.
 *   2. Every token clears WCAG contrast against both --bg and --surface:
 *      4.5:1 for the text tiers, 3:1 for the severity ramp, which is drawn as
 *      meter bars and icon strokes rather than as body text.
 *
 * Reads the stylesheet rather than a copy of the numbers, so the check cannot
 * drift from what ships. Run with `pnpm check:contrast`.
 */

const TEXT_TOKENS = ["fg", "muted", "faint"];
const GRAPHIC_TOKENS = [
  "sev-info",
  "sev-low",
  "sev-medium",
  "sev-high",
  "sev-critical",
];
const TEXT_MIN = 4.5;
const GRAPHIC_MIN = 3.0;

/** sRGB channel to linear light. */
function linear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG contrast ratio.
 *
 * The usual 0.2126R + 0.7152G + 0.0722B collapses to a single channel here
 * because every colour in this palette is grey, and the weights sum to 1.
 */
function contrast(a, b) {
  const [hi, lo] = [linear(a), linear(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull `--name: r g b;` declarations out of one CSS block. */
function parseBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`palette block not found: ${selector}`);
  const open = css.indexOf("{", start);
  const block = css.slice(open + 1, css.indexOf("}", open));

  const tokens = {};
  for (const match of block.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    const [, name, r, g, b] = match;
    tokens[name] = [Number(r), Number(g), Number(b)];
  }
  return tokens;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = await readFile(join(root, "app", "globals.css"), "utf8");

const themes = [
  ["dark", parseBlock(css, ":root {")],
  ["light", parseBlock(css, ':root[data-theme="light"] {')],
];

const failures = [];

for (const [theme, tokens] of themes) {
  for (const [name, [r, g, b]] of Object.entries(tokens)) {
    if (r !== g || g !== b) {
      failures.push(`${theme}: --${name} is not a grey (${r} ${g} ${b})`);
    }
  }

  const bg = tokens.bg?.[0];
  const surface = tokens.surface?.[0];
  if (bg === undefined || surface === undefined) {
    failures.push(`${theme}: missing --bg or --surface`);
    continue;
  }

  const checks = [
    ...TEXT_TOKENS.map((t) => [t, TEXT_MIN]),
    ...GRAPHIC_TOKENS.map((t) => [t, GRAPHIC_MIN]),
  ];

  for (const [name, min] of checks) {
    const value = tokens[name]?.[0];
    if (value === undefined) {
      failures.push(`${theme}: missing --${name}`);
      continue;
    }
    // Text sits on both the page and on cards; the worse of the two governs.
    const worst = Math.min(contrast(value, bg), contrast(value, surface));
    if (worst < min) {
      failures.push(
        `${theme}: --${name} is ${worst.toFixed(2)}:1, needs ${min}:1`,
      );
    }
  }

  // The severity ramp must stay monotonic, or a "high" record can read as
  // less serious than a "medium" one.
  const ramp = GRAPHIC_TOKENS.map((t) => contrast(tokens[t][0], bg));
  for (let i = 1; i < ramp.length; i += 1) {
    if (ramp[i] <= ramp[i - 1]) {
      failures.push(
        `${theme}: severity ramp is not ascending at ${GRAPHIC_TOKENS[i]} ` +
          `(${ramp[i].toFixed(2)} after ${ramp[i - 1].toFixed(2)})`,
      );
    }
  }
}

if (failures.length) {
  console.error("Palette check failed:");
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `Palette OK - ${themes.length} themes, all tokens neutral, ` +
    `text >= ${TEXT_MIN}:1, severity ramp >= ${GRAPHIC_MIN}:1 and ascending.`,
);
