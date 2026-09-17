import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { AutoRevealAlert } from './AutoRevealAlert';

describe('AutoRevealAlert', () => {
  const scrollIntoView = jest.fn();
  const focus = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, 'focus', {
      configurable: true,
      value: focus,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('smoothly reveals and focuses a newly rendered error above the viewport', () => {
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: -80,
      bottom: -30,
      left: 0,
      right: 300,
      width: 300,
      height: 50,
      x: 0,
      y: -80,
      toJSON: () => ({}),
    } as DOMRect);

    render(<AutoRevealAlert variant="error">Detailed broker error</AutoRevealAlert>);

    expect(screen.getByRole('alert')).toHaveTextContent('Detailed broker error');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does not move the page when the actionable alert is already visible', () => {
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 120,
      bottom: 170,
      left: 0,
      right: 300,
      width: 300,
      height: 50,
      x: 0,
      y: 120,
      toJSON: () => ({}),
    } as DOMRect);

    render(<AutoRevealAlert variant="warning">Visible warning</AutoRevealAlert>);

    expect(screen.getByRole('status')).toHaveTextContent('Visible warning');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not auto-scroll informational alerts even when they are above the viewport', () => {
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: -80,
      bottom: -30,
      left: 0,
      right: 300,
      width: 300,
      height: 50,
      x: 0,
      y: -80,
      toJSON: () => ({}),
    } as DOMRect);

    render(<AutoRevealAlert variant="info">Informational note</AutoRevealAlert>);

    expect(screen.getByRole('status')).toHaveTextContent('Informational note');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});