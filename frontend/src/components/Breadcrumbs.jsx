import { formatDimensionValue } from '../lib/format';

/**
 * Drill breadcrumb trail -- the drill-UP mechanism.
 *
 * Clicking any crumb truncates the drill stack at that depth, so the user can
 * jump up several levels at once rather than stepping back one at a time.
 */
export function Breadcrumbs({ crumbs, currentDimensionLabel, onNavigate }) {
  const atTop = crumbs.length === 0;

  return (
    <nav className="breadcrumbs" aria-label="Drill path">
      <button
        type="button"
        className={`crumb${atTop ? ' current' : ''}`}
        onClick={atTop ? undefined : () => onNavigate(0)}
        aria-current={atTop ? 'page' : undefined}
        disabled={atTop}
      >
        All data
      </button>

      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={`${crumb.dimension}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              className={`crumb${isLast ? ' current' : ''}`}
              // Navigating to a crumb keeps the crumbs *before* it, so index+1.
              onClick={isLast ? undefined : () => onNavigate(index + 1)}
              aria-current={isLast ? 'page' : undefined}
              disabled={isLast}
            >
              <span style={{ opacity: 0.7 }}>{crumb.label}:</span>{' '}
              {formatDimensionValue(crumb.value)}
            </button>
          </span>
        );
      })}

      {currentDimensionLabel ? (
        <>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="card-hint">by {currentDimensionLabel}</span>
        </>
      ) : null}
    </nav>
  );
}
