import { render, screen } from '@testing-library/react';
import WorkspaceSidebar, { workspaceRouteTitle } from './workspace-sidebar';

describe('workspace report navigation', () => {
  it('exposes Reports as the active desktop destination for closed-trade reporting', () => {
    render(
      <WorkspaceSidebar
        user={{ email: 'trader@example.com' }}
        onLogout={jest.fn()}
        activeRoute="/trade/history"
      />,
    );

    const reports = screen.getByRole('link', { name: 'Reports' });
    expect(reports.getAttribute('href')).toBe('/trade/history');
    expect(reports.classList.contains('active')).toBe(true);
    expect(reports.getAttribute('aria-current')).toBe('page');
    expect(workspaceRouteTitle('/trade/history')).toBe('Reports');
  });
});
