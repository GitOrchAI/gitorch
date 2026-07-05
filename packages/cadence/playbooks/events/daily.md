# Event: Daily (virtual stand-up)

Every wake, as the Scrum Master, run the daily loop over the board:

1. PRs open: CI state, reviews pending, QA verdicts outstanding.
2. Delegated tasks (`jules` label / human assignees) without progress for too
   long: comment on the issue, mark Blocked on the board if stuck.
3. Dependencies: tasks whose "blocked by" just closed → now delegable (validate
   DoD first, as always).
4. Delegate up to the per-cycle cap of ready tasks.
5. Deliverable: SPRINT_HEALTH: green|yellow|red + one line per action taken,
   grounded in real board/PR data (issue and PR numbers).
