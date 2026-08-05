# Documentation

Read these in order for full context.

## Plans

1. **`aliro_matter_investigation.md`** — evidence ledger. Facts referenced
   throughout as F1, F2, ... F25+. Read for grounding.
2. **`aliro_matter_analysis.md`** — feasibility analysis and recommended
   direction. Builds on the investigation.
3. **`run_aliro_door_lock_on_nanoc6_plan.md`** — hardware bring-up
   procedure. Ready for engineering execution.
4. **`post_flash_matter_thread_pairing_plan.md`** — browser flasher →
   phone Matter commissioning flow. Contains the five-phase work plan
   whose Phase 1 depends on the bring-up plan above.

## Handoff pointers

- `../LEDGER.md` — running record of findings, questions, decisions.
- `../lab_notes/` — one file per bring-up session. Fixtures for the
  flasher's serial-log parser.
- `../installer/` — flasher source. See `installer/README.md` when it
  exists after Phase 2.
- `../firmware/` — Aliro firmware overlay (Phase 5). Stock esp-matter
  is used before Phase 5.
