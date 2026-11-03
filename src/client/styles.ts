/**
 * The settings card's stylesheet.
 *
 * DSH's own plugin-config cards are styled with CSS Modules and hashed class
 * names. A plugin outside the DSH repository has no such pipeline, so the same
 * rules are shipped as one stylesheet with namespaced class names and
 * injected once — the `scjira-` prefix keeps them clear of the harness's own
 * rules, and the tag is marked with the plugin id so a reload does not stack
 * a second copy.
 *
 * Every rule resolves through a `--dsw-alias-*` token: a bare colour name
 * would keep its light-mode literal under the dark theme.
 */

/** The style tag's identity — also the key that keeps the injection single. */
const STYLE_ID = '@ian/sc-jira/scjira-card.css'

/** The plugin id, stamped on the tag for provenance. */
const PLUGIN_ID = '@ian/sc-jira'

const CSS = `
.scjira-card {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 12px;
  list-style: none;
  transition: border-color .16s, background .16s;
}
.scjira-card:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
.scjira-cardOpen {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.scjira-header {
  appearance: none;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: 0 0;
  border: 0;
  border-radius: 12px;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  display: flex;
}
.scjira-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.scjira-mark {
  flex: none;
  display: inline-flex;
  align-items: center;
}
.scjira-headText {
  flex-direction: column;
  flex: 1;
  gap: 4px;
  min-width: 0;
  display: flex;
}
.scjira-name {
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.scjira-description {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.5;
}
.scjira-chevron {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  transition: transform .16s;
}
.scjira-chevronOpen {
  transform: rotate(180deg);
}
.scjira-body {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}
.scjira-field {
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
  display: flex;
}
.scjira-field + .scjira-field {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.scjira-head {
  align-items: center;
  gap: 8px;
  display: flex;
}
.scjira-label {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.scjira-badge {
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
}
.scjira-badgeMuted {
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
}
.scjira-input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 0 12px;
  font-size: 13px;
  line-height: 1.5;
}
.scjira-input:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  outline: none;
}
.scjira-input::placeholder {
  color: var(--dsw-alias-label-dimmed);
}
.scjira-hint {
  color: var(--dsw-alias-label-tertiary);
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.scjira-select {
  cursor: pointer;
  appearance: none;
  padding-right: 32px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px 12px;
}
.scjira-footer {
  border-top: 1px solid var(--dsw-alias-border-l2);
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 12px 0 4px;
  display: flex;
}
.scjira-status {
  min-width: 0;
  flex: 1;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.scjira-statusOk {
  color: var(--dsw-alias-state-success-primary);
}
.scjira-statusFailed {
  color: var(--dsw-alias-label-error);
}
.scjira-discard,
.scjira-save {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font-size: 13px;
  line-height: 1.5;
}
.scjira-discard {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: 0 0;
}
.scjira-discard:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.scjira-save {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.scjira-discard:disabled,
.scjira-save:disabled {
  opacity: 0.4;
  cursor: default;
}
.scjira-discard:focus-visible,
.scjira-save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
`

/**
 * Put the card's rules in the document, once.
 *
 * The tag carries the plugin id and the sheet's own name, so a second call —
 * a re-registration, a hot reload — finds the existing tag instead of
 * stacking another copy of the same rules.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
