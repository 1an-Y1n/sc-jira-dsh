import * as React from 'react'
import { ListMyOpenPanel } from './ListMyOpenPanel.js'
import { WorklogWeekPanel } from './WorklogWeekPanel.js'
import { BindPanel } from './BindPanel.js'

interface PropsRuntime {
  t: (key: string) => string
}

export type ScjiraTabProps = PropsRuntime

export function ScjiraTab({ t }: ScjiraTabProps): React.ReactElement {
  const [active, setActive] = React.useState<'open' | 'worklog' | 'bind'>('open')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', color: 'var(--dsh-fg, #fff)' }}>
      <nav style={{ display: 'flex', borderBottom: '1px solid var(--dsh-border, #333)' }}>
        {(['open', 'worklog', 'bind'] as const).map(k => (
          <button
            key={k}
            data-active={active === k}
            onClick={() => setActive(k)}
            style={{
              flex: 1,
              padding: '8px 4px',
              background: active === k ? 'var(--dsh-bg-active, #1a4)' : 'transparent',
              color: active === k ? 'var(--dsh-fg-active, #fff)' : 'var(--dsh-fg, #aaa)',
              border: 'none',
              cursor: 'pointer',
              borderBottom: active === k ? '2px solid var(--dsh-accent, #4af)' : '2px solid transparent',
            }}
          >
            {t(`tab.${k}`)}
          </button>
        ))}
      </nav>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
        {active === 'open' && <ListMyOpenPanel t={t} />}
        {active === 'worklog' && <WorklogWeekPanel t={t} />}
        {active === 'bind' && <BindPanel t={t} />}
      </div>
    </div>
  )
}
