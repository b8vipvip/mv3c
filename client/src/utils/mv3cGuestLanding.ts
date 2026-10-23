/** Only public chat entry points may silently provision a guest session.
 *  Sign-in, registration, enrollment, admin, shared links and OAuth are explicit workflows. */
export function shouldAutoEnterGuest(pathname: string): boolean {
  return pathname === '/' || pathname === '/c/new' ||
    /^\/c\/[A-Za-z0-9_-]+$/.test(pathname);
}
