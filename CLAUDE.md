# Instructions for AI development sessions

- **Source of truth:** https://github.com/Kritesh2006/dwapar, branch `main`. Every change is
  committed and pushed there. Never force-push, never rewrite published history.
- **Phase gate:** Phase 1 (the world) is complete. Do NOT begin Phase 2 or add inhabitants,
  agents, animals or population data without explicit authorisation from the project owner.
  `engine/dwapar/prana` and `engine/dwapar/buddhi` must stay empty (a test enforces this).
- **Read first:** CONSTITUTION.md (rules), TASKS.md (status, open items), JOURNAL.md (history),
  WORLD_LAWS.md (physics), ARCHITECTURE.md, DECISIONS.md, ROADMAP.md.
- **Before committing:** run `cd engine && pytest` and `cd dashboard && npm run build`. Only
  report results you actually ran. Update TASKS.md, JOURNAL.md (and DECISIONS.md for design
  changes) in the same push.
- **Never commit:** credentials, `.env`, `data/`, `*.sqlite`, `node_modules/`, `dist/`, virtual
  environments, caches (`.gitignore` covers these).
