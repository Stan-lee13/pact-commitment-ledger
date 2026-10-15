# PACT architecture references

These diagrams are Mermaid source files and PNG renderings for review:

- `architecture.mmd` / `architecture.png`: working single-process prototype and production gates.
- `data-model.mmd` / `data-model.png`: recommended normalized production schema; **not** the current JSON persistence format.
- `state-machines.mmd` / `state-machines.png`: agreement and payment lifecycles kept separate.

The app at the project root is a synthetic-data prototype. The browser demo now includes amendment diffs, partial delivery tracking, an outstanding-obligations view, search/filter, local evidence attachments, JSON/CSV export, and opt-in reminders that work only while the page is open. These features do not add accounts, shared persistence, background notification delivery, public AI, or live payment infrastructure. The dashed architecture components are not implemented. See the root README for exact limitations and credential setup.
