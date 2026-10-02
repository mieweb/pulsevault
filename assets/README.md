# Pulse logo

The Pulse logo, for any app that pairs with Pulse through PulseVault: put it
on the button that opens Pulse, so people know which app they're about to use.

| File                  | What it is                                                     |
| --------------------- | -------------------------------------------------------------- |
| `pulse-logo.svg`      | Full colour, the Pulse red gradient. Use it on light or dark.  |
| `pulse-logo-mono.svg` | One colour, `currentColor` (black when used as an `<img>`).    |

Both are 87 × 100 (width × height) and scale to any size. The heartbeat is
cut out, so whatever is behind the logo shows through it.

They ship in the package, so a bundler can import them:

```js
import pulseLogo from "@mieweb/pulsevault/assets/pulse-logo.svg";

button.innerHTML = `<img src="${pulseLogo}" alt="" width="14" height="16"> Record with Pulse`;
```

Inline the mono file's markup to colour it with CSS `color`, or use it as a
CSS `mask-image` over any background.
