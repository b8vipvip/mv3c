import { shouldAutoEnterGuest } from '../mv3cGuestLanding';

describe('mv3c public guest entry', () => {
  it.each(['/', '/c/new', '/c/abcd1234-56', '/c/chat_123'])(
    'permits automatic guest session at %s',
    (pathname) => expect(shouldAutoEnterGuest(pathname)).toBe(true),
  );
  it.each([
    '/login', '/login/2fa', '/login/2fa/setup', '/register',
    '/forgot-password', '/admin', '/share/123', '/oauth/success',
    '/search', '/projects', '/c/new/other',
  ])('never silently provisions a guest at %s', (pathname) => {
    expect(shouldAutoEnterGuest(pathname)).toBe(false);
  });
});
