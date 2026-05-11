import { atom, getDefaultStore } from 'jotai';

export const ACCESS_TOKEN_KEY = 'jwt_token';
export const REFRESH_TOKEN_KEY = 'refresh_token';

function readLocalStorage(key) {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage.getItem(key);
}

function writeLocalStorage(key, value) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (value) window.localStorage.setItem(key, value);
  else window.localStorage.removeItem(key);
}

export function getStoredAccessToken() {
  return readLocalStorage(ACCESS_TOKEN_KEY);
}

export function getStoredRefreshToken() {
  return readLocalStorage(REFRESH_TOKEN_KEY);
}

export const authAtom = atom({
  isAuthenticated: !!getStoredAccessToken(),
  user: null
});

const defaultStore = getDefaultStore();

export function setSession({ accessToken, refreshToken, user }) {
  writeLocalStorage(ACCESS_TOKEN_KEY, accessToken ?? null);
  writeLocalStorage(REFRESH_TOKEN_KEY, refreshToken ?? null);

  defaultStore.set(authAtom, {
    isAuthenticated: !!accessToken,
    user: user ?? null
  });
}

export function clearSession() {
  writeLocalStorage(ACCESS_TOKEN_KEY, null);
  writeLocalStorage(REFRESH_TOKEN_KEY, null);

  defaultStore.set(authAtom, {
    isAuthenticated: false,
    user: null
  });
}