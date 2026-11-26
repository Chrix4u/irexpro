import { readinessPresentation } from '../dashboard-screen.logic';

describe('dashboard readiness presentation', () => {
  it('only displays ready for current consistent evidence', () => {
    expect(readinessPresentation(true, true, true, false).label).toBe('READY');
    expect(readinessPresentation(false, true, true, false).label).toBe('SETUP_REQUIRED');
    expect(readinessPresentation(true, false, false, false).label).toBe('SETUP_REQUIRED');
  });
  it('never displays stale or incomplete evidence as ready', () => {
    expect(readinessPresentation(true, true, null, false).label).toBe('UNVERIFIED');
    expect(readinessPresentation(undefined, undefined, true, false).label).toBe('UNVERIFIED');
    expect(readinessPresentation(true, true, true, true).label).toBe('CHECKING');
  });
  it('shows conflicting broker evidence as review required', () => {
    expect(readinessPresentation(true, true, false, false).label).toBe('REVIEW_REQUIRED');
    expect(readinessPresentation(false, false, true, false).label).toBe('REVIEW_REQUIRED');
  });
});
