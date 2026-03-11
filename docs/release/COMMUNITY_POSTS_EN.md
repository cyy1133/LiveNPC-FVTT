# Community Posts (EN)

## 1. Discord short post

I built a Windows desktop runtime that connects Foundry VTT, Discord, and an LLM so NPCs can respond in character and take more rules-aware combat turns.

Key points:
- EXE-based setup
- Discord + Foundry in one runtime
- target filtering for dead / 0 HP / inactive combatants
- DND5e-style action economy
- LOS / walls / pathing / difficult terrain / cover in first-pass tactical reasoning

Download / docs:
- GitHub Release: [paste release URL]
- README: [paste repo URL]

If you try it, I would especially like feedback on combat edge cases and Foundry module compatibility.

## 2. Reddit title options

- I built a desktop runtime that lets NPCs react on Discord and take rules-aware turns in Foundry VTT
- Release: FVTT AI NPC Runtime, a standalone NPC automation runtime for Discord + Foundry VTT
- I made a Windows runtime for AI-assisted NPC dialogue and combat turns in Foundry VTT

## 3. Reddit body

I built a Windows desktop runtime called `FVTT AI NPC Runtime`.

The goal is simple: reduce GM micromanagement when running multiple NPCs across both Discord and Foundry VTT.

What it currently does:
- connects Discord, Foundry VTT, and an LLM in one desktop app
- lets NPCs respond with per-character Markdown-based behavior and tone
- reads combat state before acting
- excludes dead, 0 HP, and out-of-combat targets from attack selection
- respects DND5e-style action economy
- uses LOS, walls, pathing, difficult terrain, and cover for first-pass tactical reasoning
- runs movement / action / bonus action / short dialogue in sequence, then ends the turn

This is aimed at GMs who run a lot of NPCs and want more consistency than a simple one-off chatbot.

Current release:
- Windows EXE
- Quick Setup for Discord / FVTT / LLM
- NPC panel with token thumbnails, collapsible cards, and Markdown doc links

Docs / download:
- Release: [paste release URL]
- Repo: [paste repo URL]

What I want feedback on:
- Foundry system/module compatibility
- combat edge cases
- UX friction during first-time setup
- how useful the Discord + combat combo feels in real sessions

## 4. X / Bluesky short version

Released `FVTT AI NPC Runtime`.
A Windows desktop runtime that connects Foundry VTT + Discord + an LLM so NPCs can answer in character and take more rules-aware combat turns.

EXE setup, target filtering, DND5e action economy, LOS / pathing / cover support.

Release: [paste release URL]

## 5. YouTube / demo description

FVTT AI NPC Runtime is a Windows desktop app that connects Foundry VTT, Discord, and an LLM so NPCs can talk and take combat turns with less manual GM micromanagement.

This video shows:
- Quick Setup
- NPC panel setup
- Diagnostics
- Discord response flow
- automatic combat turn execution

Download:
- [paste release URL]
