import { useState, useEffect } from 'react';

export const AUTH_EXPIRED_EVENT = 'plankton:auth-expired';

export function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

export function getUser() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function setSession(token, user) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  window.dispatchEvent(new Event('plankton:auth-changed'));
}

export function clearSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.dispatchEvent(new Event('plankton:auth-changed'));
}

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    // Full response body: handlers like the 402 upgrade-wall need
    // code/plans/free, which a message string cannot carry.
    this.data = data;
  }
}

/**
 * Shared fetch wrapper: attaches the bearer token, parses JSON once and turns
 * 401 into a session-expiry event so every page reacts the same way instead of
 * silently rendering empty state.
 */
export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  if (res.status === 401 && !path.startsWith('/api/auth')) {
    clearSession();
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }

  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data);
  }

  return data;
}

/**
 * Client-side auth guard for protected pages.
 * Returns { ready, user, expired } and never touches the DOM during render —
 * redirects happen inside useEffect (safe for SSR/hydration).
 */
export function useAuth(required = true) {
  const [state, setState] = useState({ ready: false, user: null, expired: false });

  useEffect(() => {
    const read = () => setState({ ready: true, user: getUser(), expired: false });
    read();

    const onExpired = () => setState({ ready: true, user: null, expired: true });
    const onChanged = read;

    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    window.addEventListener('plankton:auth-changed', onChanged);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
      window.removeEventListener('plankton:auth-changed', onChanged);
    };
  }, []);

  useEffect(() => {
    if (required && state.ready && !state.user) {
      // Remember where the user was headed so the login form can send them
      // there after setSession, instead of dumping them on '/'.
      const here = window.location.pathname + window.location.search;
      window.location.replace(here === '/' ? '/' : `/?next=${encodeURIComponent(here)}`);
    }
  }, [required, state.ready, state.user]);

  return state;
}
