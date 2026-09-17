# @ian/sc-jira

DSH plugin adding a Jira sidebar tab with 3 sub-panels:
- **我的未完成** — list of issues assigned to the configured user
- **Worklog 周报** — weekly worklog totals (Mon-Sun chart + details)
- **绑定 Session** — bind current DSH session to a Jira issue

## Setup

1. Install dependencies: `pnpm install`
2. Build: `pnpm run build`
3. Add to profile: `dsh plugin --profile web add "$(pwd)"`
4. Open Settings → sc-jira card → fill server / login / token / displayName
5. Open right sidebar → click `+` → choose sc-jira

## Tools exposed to agent

- `jira_list_my_open`
- `jira_list_worklog_week(startDate?)`
- `jira_get_binding(sessionId)`
- `jira_bind(sessionId, taskKey)`

## Tests

```bash
pnpm run typecheck
pnpm run test
node scripts/probe.mjs   # requires dsh web running
```

## Known bug fixes (from scjira v2 spec §6)

See `tests/bugs.test.ts` for regression coverage of all 6 known bugs.