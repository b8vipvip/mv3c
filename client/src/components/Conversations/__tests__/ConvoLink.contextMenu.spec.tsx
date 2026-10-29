import { render, screen, fireEvent } from '@testing-library/react';
import ConvoLink from '../ConvoLink';

describe('native browser chat-history link actions', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockReturnValue({
        matches: true,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }),
    });
    Object.defineProperty(global, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    });
  });

  const renderTitle = () =>
    render(
      <ConvoLink
        conversationId="chat-abc 123"
        isActiveConvo={false}
        isPopoverActive={false}
        isHovered={false}
        isSharedBadgeVisible={false}
        isUnseen={false}
        title="Conversation title"
        onRename={jest.fn()}
        isSmallScreen={false}
        localize={(key) => key}
      >
        <span aria-hidden="true">icon</span>
      </ConvoLink>,
    );

  it('renders an actual conversation anchor so native Open Link choices are available', () => {
    renderTitle();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/c/chat-abc%20123');
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    const allowed = link.dispatchEvent(event);
    expect(allowed).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it('delegates regular left-click to SPA row navigation without native reload', () => {
    renderTitle();
    const link = screen.getByRole('link');
    expect(fireEvent.click(link, { button: 0 })).toBe(false);
    const middleClick = new MouseEvent('auxclick', {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    expect(link.dispatchEvent(middleClick)).toBe(true);
    expect(middleClick.defaultPrevented).toBe(false);
  });
});
