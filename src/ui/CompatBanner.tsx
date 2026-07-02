import type { CompatIssue } from '../lib/capabilities'

/** Shows the browser-compatibility status for the current settings. */
export function CompatBanner({ issues }: { issues: CompatIssue[] }) {
  if (issues.length === 0) {
    return <div className="compat ok">✓ This browser can run Understudy.</div>
  }
  return (
    <div className="compat">
      {issues.map((i, k) => (
        <div key={k} className={`compat-line ${i.level}`}>
          <span className="compat-icon">{i.level === 'error' ? '✕' : '!'}</span>
          {i.message}
        </div>
      ))}
    </div>
  )
}
