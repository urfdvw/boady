# {{name}}

A {{type_label}} project developed with [boady](https://github.com/urfdvw/boady).

## Summary

<!-- One paragraph about what this project does. -->

## Versions and dependencies

- Runtime: {{type_label}} (see `boady.json`)
- Libraries: everything in `src/lib/` is committed; checking out any version gives the exact board contents.

## Developing with an agent

- Everything in `src/` is the board's root filesystem; the rest of the repo stays in git only.
- Edit the mirror (`src/`), then sync it to the board from boady (Device tab) or let the agent call `sync_to_device`.
- Hardware notes live in `src/CIRCUIT.md`, goals and architecture in `DESIGN.md`.
