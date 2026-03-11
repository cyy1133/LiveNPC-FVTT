# FVTT AI NPC Runtime v0.1.0

FVTT AI NPC Runtime is a Windows desktop runtime that connects Foundry VTT, Discord, and an LLM so NPCs can talk, react, and take combat turns with less manual GM micromanagement.

## What it does

- Lets NPCs answer in Discord with character-specific tone and rules
- Reads combat state from Foundry before deciding actions
- Executes movement, action, bonus action, and short dialogue in sequence
- Excludes dead, 0 HP, and out-of-combat targets from attack selection
- Applies DND5e-style action economy constraints
- Uses line of sight, walls, pathing, difficult terrain, and cover for first-pass tactical reasoning
- Supports per-NPC Markdown files for soul, battle rules, and shared world lore

## Best fit

This tool is best for GMs who:

- run multiple NPCs in long campaigns
- want Discord + Foundry integration in one runtime
- want NPCs to feel more consistent than simple one-shot chat bots
- want combat turns to reflect HP, status effects, concentration, and resource constraints

## Included in this release

- `FVTT AI NPC Runtime Setup 0.1.0.exe`

## Quick start

1. Install the EXE
2. Open the app
3. Fill `Quick Setup`
4. Run `Install Prerequisites`
5. Run `Codex Login`
6. Run `Diagnostics`
7. Press `Start`

Detailed setup guide:

- `README.md`
- `QUICKSTART_KR.md`

## Highlights in 0.1.0

- Desktop EXE packaging for Windows
- Quick Setup for Discord / FVTT / LLM
- NPC panel with token thumbnails and collapsible cards
- Auto combat turn execution and turn handoff
- Rules-aware target filtering for dead / 0 HP / inactive combatants
- Tactical pathing with LOS, walls, difficult terrain, diagonal cost, and cover
- Runtime stop-race fix for queued FVTT work
- Launch-ready documentation set and publish assets

## Notes

- This is a standalone desktop runtime, not a full Foundry module
- A Foundry companion bridge module is a future expansion path, not part of this release
- Stable Diffusion WebUI integration is optional

## Feedback

Please report bugs and feature requests through GitHub Issues.
