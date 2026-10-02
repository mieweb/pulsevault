# Pulse assets

For any app that pairs with Pulse through PulseVault: the Pulse logo, to put
on the button that opens Pulse, and the store badges, to link people who
don't have Pulse yet to its listings.

| File                    | What it is                                                    |
| ----------------------- | ------------------------------------------------------------- |
| `pulse-logo.svg`        | Full colour, the Pulse red gradient. Use it on light or dark. |
| `pulse-logo-mono.svg`   | One colour, `currentColor` (black when used as an `<img>`).   |
| `badge-app-store.svg`   | Apple's "Download on the App Store" badge (black).            |
| `badge-google-play.png` | Google's "Get it on Google Play" badge.                       |

The logos are 87 × 100 (width × height) and scale to any size. The heartbeat
is cut out, so whatever is behind the logo shows through it.

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
