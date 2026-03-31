# FVTT AI NPC Runtime Release Template

Replace the placeholders below with the current release version before publishing.

## Title

`FVTT AI NPC Runtime v[version]`

## Body

FVTT AI NPC Runtime is a Windows desktop runtime that connects Foundry VTT, Discord, and an LLM so NPCs can talk, react, take combat turns, and keep light social scenes alive with less manual GM micromanagement.

## What it does

- Lets NPCs answer in Discord with character-specific tone and rules
- Reads combat state from Foundry before deciding actions
- Executes movement, action, bonus action, and short dialogue in sequence
- Adds a dedicated `Social` tab for Director and Ambient control
- Accepts `@NPC Name:` world-activity lines for scene setup
- Supports Scene Preset save, apply, export, and import workflows
- Supports multiple FVTT sessions for ownership routing or absent-player stand-ins
- Supports per-NPC Markdown files for soul, battle rules, and shared world lore

## Best fit

This tool is best for GMs who:

- run multiple NPCs in long campaigns
- want Discord + Foundry integration in one runtime
- want towns, taverns, and social scenes to feel less static
- want combat turns to reflect HP, status effects, concentration, and resource constraints
- want map-specific scene prep they can reuse with presets

## Included in this release

- `FVTT AI NPC Runtime Setup [version].exe`

## Quick start

1. Install the EXE
2. Open the app
3. Fill `Quick Setup`
4. Run `Install Prerequisites`
5. Run `Codex Login`
6. Configure `NPC` and `Social`
7. Run `Diagnostics`
8. Press `Start`

Detailed setup guide:

- `README.md`
- `QUICKSTART_KR.md`

## Highlight features for this release

- Dedicated Social tab
- Separate Director / Ambient toggles
- `@NPC` world-activity input
- Scene Preset `Capture / Apply / Export / Import`
- Multi-session FVTT ownership routing
- Existing combat automation and tactical reasoning retained

## Notes

- This is a standalone desktop runtime, not a full Foundry module.
- Stable Diffusion WebUI integration is optional.
- Non-combat lines are staged to feel conversational, but execution is still serialized internally for safety.

## Feedback

Please report bugs and feature requests through GitHub Issues.
