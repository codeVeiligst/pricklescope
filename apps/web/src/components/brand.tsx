export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="PrickleScope">
      <span className="brand__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {!compact ? (
        <span className="brand__wordmark">
          Prickle<span>Scope</span>
        </span>
      ) : null}
    </div>
  )
}
