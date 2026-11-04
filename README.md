# Rust Academy — a DeepSeek Harness plugin

A DSH Web UI plugin that adds a **Rust Academy** entry to the left sidebar. Click
it and the main column opens a self-contained Rust course.

<p align="center">
  <img src="icon.svg" alt="Rust Academy crab" width="96" height="96">
</p>

## What it gives you

- **20 lessons across 7 stages** — from `fn main` to ownership, traits, async and
  lifetimes. Each lesson has a goal, short explanations, runnable code, and a
  hands-on exercise with a hint and a worked solution.
- **Progress tracking** — mark lessons complete; the header shows `done / 20` and
  a progress bar. Stored in the browser's `localStorage`.
- **Cheatsheet tab** — the syntax you reach for most: Cargo, bindings, control
  flow, ownership, collections, iterators, traits, concurrency, testing.
- **Ask in chat** — copies a ready-made tutor prompt for the current lesson and
  switches to the Conversation panel, so the agent can teach that lesson against
  your own Rust project.

## How it is wired

| Slot | Registration |
| --- | --- |
| `sidebar.panellist` | `id: rust-academy`, `order: 20`, localized `label` |
| `main` | `key: rust-academy` |

The Host half (`index.js`) is a no-op: the panel needs no Host capability.
Styles use only `--dsw-alias-*` theme tokens, so light and dark themes follow the
Harness automatically. The in-panel text is registered in the Client locale
service under the `rust-academy` namespace, and the display metadata lives in
`locale/en.json` with the artwork in `icon.svg`.

## Requirements

- DeepSeek Harness (Desktop or `dsh web`) with a Web GUI.
- No build step, no dependencies: the Client module is plain JavaScript loaded
  through the Harness module loader.

## Install

Clone this repository somewhere on disk, then install the directory as a bundle
into your Harness profile:

```bash
git clone https://github.com/ramanasai/dsh-rust-academy.git
```

Then, from a Harness session (the Plugin Manager needs Full access or approval):

```
plugin_manager install_bundle target=/absolute/path/to/dsh-rust-academy
```

The bundle is linked from the checkout, so editing `client.js` changes the source
the profile uses; reinstall or reload the page to pick up a new module
generation. The sidebar icon appears under the global panel icons, and the panel
opens in the main column.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Bundle manifest: patch, Client module, locale and icon exports |
| `cordis.patch.yml` | Inserts the `rust-academy` row into the profile |
| `index.js` | Host half (empty `apply`) |
| `client.js` | The sidebar icon and the full course panel |
| `locale/en.json` | Plugin Manager title and description |
| `icon.svg` | Original crab artwork for the plugin inventory |

## License

MIT — see [LICENSE](LICENSE).
