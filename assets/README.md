# Pulse assets

For any app that pairs with Pulse through PulseVault: the Pulse icon, to put
on the button that opens Pulse, the Pulse logo, for anywhere larger, and the
store badges, to link people who don't have Pulse yet to its listings.

| File                    | What it is                                                    |
| ----------------------- | ------------------------------------------------------------- |
| `pulse-logo.svg`        | Full colour, the Pulse red gradient. Use it on light or dark. |
| `pulse-logo-mono.svg`   | One colour, `currentColor` (black when used as an `<img>`).   |
| `badge-app-store.svg`   | Apple's "Download on the App Store" badge (black).            |
| `badge-google-play.png` | Google's "Get it on Google Play" badge.                       |

The logos are 87 × 100 (width × height) and scale to any size. The heartbeat
is cut out, so whatever is behind the logo shows through it.

## The icon, for buttons

A button's icon is square; the logo is 87 × 100. The icon is the logo itself,
centred in a square 24 × 24 box at its full height: the same drawing, so at
any size it is the logo at that height, and it sits level with the square
icons beside it without a host working out a width.

| File                   | What it is                                            |
| ---------------------- | ----------------------------------------------------- |
| `pulse-icon.svg`       | Full colour, the logo's red gradient.                 |
| `pulse-icon-mono.svg`  | One colour, `currentColor`.                           |
| `pulse-icon-white.svg` | White, for an `<img>` on a button filled with colour. |

One design serves every size. Use full colour on a plain light or dark
surface, `-white` on a filled button, and `-mono` where the icon should take
the text's colour.

```js
import pulseIcon from "@mieweb/pulsevault/assets/pulse-icon.svg";
import pulseIconWhite from "@mieweb/pulsevault/assets/pulse-icon-white.svg";

chip.innerHTML = `<img src="${pulseIcon}" alt="" width="20" height="20">`;
button.innerHTML = `<img src="${pulseIconWhite}" alt="" width="20" height="20"> Record with Pulse`;
```

The mono file used as an `<img>` is black. To colour it, inline its markup and
set CSS `color`, or use it as a mask over the colour:

```css
.pulse-icon {
  width: 1em;
  height: 1em;
  background: currentColor;
  mask: url("@mieweb/pulsevault/assets/pulse-icon-mono.svg") center / contain no-repeat;
}
```

Each file's ids carry its own name, so several can be inlined on one page.
The files are written from `pulse-logo.svg` by `scripts/gen-pulse-icons.mjs`:
change the logo and run `npm run icons`, don't edit them.

## The store badges

The badges are Apple's and Google's own artwork, used under their badge
guidelines: show them unaltered, at the same height side by side, and link
them to Pulse's listings:

- App Store: `https://apps.apple.com/us/app/pulse-cam/id6748621024`
- Google Play: `https://play.google.com/store/apps/details?id=com.mieweb.pulse`

They ship in the package, so a bundler can import them:

```js
import pulseLogo from "@mieweb/pulsevault/assets/pulse-logo.svg";

button.innerHTML = `<img src="${pulseLogo}" alt="" width="14" height="16"> Record with Pulse`;
```

Inline the mono file's markup to colour it with CSS `color`, or use it as a
CSS `mask-image` over any background.
