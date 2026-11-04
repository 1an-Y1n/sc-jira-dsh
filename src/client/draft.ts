/**
 * The card's form model.
 *
 * The pure parts of the configuration card live here so they can be reasoned
 * about — and tested — without a DOM: what a Host answer means as a draft,
 * and when the draft counts as an edit.
 */

/** The fields the card edits — the writable part of the `scjira` namespace. */
export interface Draft {
  server: string
  login: string
  displayName: string
  token: string
  proxy: string
}

/** What the Host reports about the current configuration. */
export interface StatusResponse {
  ok?: boolean
  configured?: boolean
  server?: string
  login?: string
  displayName?: string
  proxy?: string
}

/** The empty draft — the shape every load starts from. */
export const EMPTY: Draft = {
  server: '',
  login: '',
  displayName: '',
  token: '',
  proxy: '',
}

/**
 * Read a configuration answer as a draft.
 * @param body - the Host's answer.
 * @returns the draft it describes.
 */
export function toDraft(body: StatusResponse): Draft {
  return {
    server: body.server ?? '',
    login: body.login ?? '',
    displayName: body.displayName ?? '',
    token: '',
    proxy: body.proxy ?? '',
  }
}

/**
 * Whether the draft differs from what the Host holds.
 *
 * The token is never read back, so a blank token field is "unchanged" by
 * itself — only a typed token counts as an edit.
 * @param draft - the edited form.
 * @param baseline - what the Host last answered.
 * @returns whether there is anything to save.
 */
export function isDirty(draft: Draft, baseline: Draft | null): boolean {
  if (baseline === null) return false
  return draft.server !== baseline.server
    || draft.login !== baseline.login
    || draft.displayName !== baseline.displayName
    || draft.proxy !== baseline.proxy
    || draft.token !== ''
}
