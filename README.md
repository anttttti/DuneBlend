# DuneBlend

A browser-based blend editor for **Dune: Imperium** and **Dune: Imperium – Uprising**.

**[anttttti.github.io/DuneBlend](https://anttttti.github.io/DuneBlend/)** · **[dune-blend.vercel.app](https://dune-blend.vercel.app)**

---

## What is a blend?

A *blend* is a custom mix of cards and components drawn from multiple Dune: Imperium expansions, played together as a single game. Blends let you combine the mechanics of **Uprising** with cards from the base game, **Rise of Ix**, **Immortality**, and **Bloodlines** — creating a more varied and balanced experience than any single expansion on its own.

The idea originates on BoardGameGeek — [Merakon's House Blend](https://boardgamegeek.com/thread/3213458/merakons-house-blend) is the blend that started it all.

## Features

- **Full browser editor** — works on desktop and mobile, no install needed
- **Tabs for every resource type** — Imperium cards, Intrigue cards, Tleilax cards, Reserve cards, Tech tiles, Contracts, Leaders, Conflict cards, Starter decks, Sardaukar, Agents, and Boards
- **Live statistics** — cost, access symbol, and faction-affiliation distributions update as you select, so you can check balance at a glance
- **Pre-built blends** — load Merakon's House Blend, Antti's House Blend, TragicJonson's Blend, or the base-game and Uprising defaults to get started immediately
- **Markdown blend files** — blends are saved as human-readable `.md` files that are easy to share, diff, and read without the app
- **AI agent** — chat with an AI assistant that can build or edit blends for you, answer rules questions, look up card details and community ratings, fetch official rulebooks, search the web, and render charts; supports Google Gemini/Gemma and Mistral AI models with your own API key
- **OCR resource detection** — use your device camera to scan cards and add or remove them from the blend
- **Self-hostable** — run the included Python server locally, or serve the single `index.html` from anywhere

## Getting started

Open **[anttttti.github.io/DuneBlend](https://anttttti.github.io/DuneBlend/)** in any browser.

To load an example blend, click **Load Blend** and pick one of the pre-built options (e.g. *Merakon's House Blend* or *Antti's Basic House Blend*). From there you can browse each resource tab, adjust selections, and watch the statistics update.

To save your blend, click **Export** — you'll get a `.md` file you can share or reload later.

### Running locally

```bash
git clone https://github.com/anttttti/DuneBlend.git
cd DuneBlend
pip install -r requirements.txt
python server.py
```

Then open `http://localhost:8000` in your browser. For HTTPS (needed for camera/OCR), use `run_server_https.sh`.

## Included blends

| Blend | Description |
|---|---|
| `Anttis_Basic_House_Blend.md` | Beginner-friendly mix of Imperium, Uprising, Bloodlines and Ix |
| `Anttis_House_Blend.md` | Advanced version of the above with additional components |
| `Merakons_House_Blend.md` | The community classic that started the blending scene |
| `TragicJonsons_House_Blend.md` | Blend from the original browser editor |
| `Uprising_Bloodlines_Community.md` | Community blend focused on Uprising + Bloodlines |
| `Base_Imperium.md` | Unmodified base Dune: Imperium |
| `Base_Uprising.md` | Unmodified Dune: Imperium – Uprising |

## Community & links

- [Dune: Imperium – Uprising on BoardGameGeek](https://boardgamegeek.com/boardgame/397598/dune-imperium-uprising)
- [Dune: Imperium on BoardGameGeek](https://boardgamegeek.com/boardgame/316554/dune-imperium)
- [r/DuneImperium on Reddit](https://www.reddit.com/r/DuneImperium/)
- [Merakon's House Blend thread (BGG)](https://boardgamegeek.com/thread/3213458/merakons-house-blend)
- Inspired by [TragicJonson's browser editor](https://observablehq.com/@mrcorvus/dune-imperium-deck-builder)
