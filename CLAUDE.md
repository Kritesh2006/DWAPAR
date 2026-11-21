# Instructions for AI development sessions

- **Source of truth:** https://github.com/Kritesh2006/dwapar, branch `main`. Every change is
  committed and pushed there. Never force-push, never rewrite published history.
- **Phase gate:** Phase 1.5 and **life + WITNESS** (owner authorisation 2026-11-21, D-035) are in
  progress. The roadmap phases for animals, humanity, civilization and the autonomous universe are
  being built under that authorisation.
  - Every creature, structure or intervention must come from a validated, logged divine command
    (CONSTITUTION Art. VI).
  - Never hardcode technology trees (Art. IV).
  - Lifeless worlds must stay bit-identical to laws 1.6.
- **Laws versions:** any change that alters simulation outcomes must bump `LAWS_VERSION` in
  `engine/dwapar/laws.py` (with a changelog line). Changes to animal or human behaviour bump
  `LIFE_VERSION` in `engine/dwapar/prana/life.py` instead, since they alter only worlds that contain life. Performance work must be proven bit-identical
  instead (see `tests/test_performance.py`). Never mix results from different laws versions.
- **Long experiments:** resume with `python -m dwapar experiment --budget-minutes N` (never restart
  them); record only real results in EXPERIMENTS.md (`python -m dwapar.report` prints the tables,
  per laws version). Experiments live in `experiments/laws-<version>/` (results, status, and the
  latest portable checkpoint per run, committed); local working stores in
  `data/experiments/laws-<version>/` (not committed). Older laws directories are frozen, never
  continued in place; use a `start_from` continuation experiment instead.
- **Read first:** CONSTITUTION.md (rules), TASKS.md (status, open items), JOURNAL.md (history),
  WORLD_LAWS.md (physics), ARCHITECTURE.md, DECISIONS.md, ROADMAP.md.
- **Before committing:** run `cd engine && pytest`, `cd dashboard && npm run build && npm run test:unit`
  (and `npm run test:e2e` for UI changes; set `PW_CHROMIUM_PATH` if Playwright's browser is not installed).
  CI (GitHub Actions) must stay green. Only
  report results you actually ran. Update TASKS.md, JOURNAL.md (and DECISIONS.md for design
  changes) in the same push.
- **Never commit:** credentials, `.env`, `data/`, `*.sqlite`, `node_modules/`, `dist/`, virtual
  environments, caches (`.gitignore` covers these).
