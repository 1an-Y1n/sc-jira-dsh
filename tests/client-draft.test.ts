import { describe, it, expect } from 'vitest'
import { EMPTY, isDirty, toDraft } from '../src/client/draft.js'

// The card's form model: what a Host answer means, and when the form counts
// as edited. Both are pure, so they are pinned here rather than through the
// browser.

describe('toDraft', () => {
  it('reads every field the card shows', () => {
    const draft = toDraft({
      ok: true,
      server: 'https://jira.example.com',
      login: 'someone',
      displayName: 'Some One',
      proxy: 'http://127.0.0.1:8888',
    })
    expect(draft).toEqual({
      server: 'https://jira.example.com',
      login: 'someone',
      displayName: 'Some One',
      token: '',
      proxy: 'http://127.0.0.1:8888',
    })
  })

  it('never carries a token: the Host does not send one back', () => {
    const draft = toDraft({ ok: true, token: 'leaked' } as never)
    expect(draft.token).toBe('')
  })

  it('turns missing text fields into empty strings', () => {
    const draft = toDraft({ ok: true })
    expect(draft.server).toBe('')
    expect(draft.login).toBe('')
    expect(draft.displayName).toBe('')
    expect(draft.proxy).toBe('')
  })
})

describe('isDirty', () => {
  const baseline = toDraft({
    ok: true,
    server: 'https://jira.example.com',
    login: 'someone',
    displayName: 'Some One',
    proxy: '',
  })

  it('is clean before the Host has answered', () => {
    expect(isDirty(EMPTY, null)).toBe(false)
  })

  it('is clean when the draft equals the baseline', () => {
    expect(isDirty(baseline, baseline)).toBe(false)
  })

  it('is dirty when a text field changed', () => {
    expect(isDirty({ ...baseline, server: 'https://other' }, baseline)).toBe(true)
    expect(isDirty({ ...baseline, login: 'other' }, baseline)).toBe(true)
    expect(isDirty({ ...baseline, displayName: 'Other' }, baseline)).toBe(true)
    expect(isDirty({ ...baseline, proxy: 'http://127.0.0.1:8888' }, baseline)).toBe(true)
  })

  it('is dirty when a token was typed, and clean while the token field is blank', () => {
    expect(isDirty({ ...baseline, token: 'secret' }, baseline)).toBe(true)
    expect(isDirty({ ...baseline, token: '' }, baseline)).toBe(false)
  })
})
