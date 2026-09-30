const GUEST_MODE_KEY = 'yso.workbench.guest.mode.v1';
const GUEST_USER_ID_KEY = 'yso.workbench.guest.user.v1';
export const GUEST_DATA_STORAGE_PREFIX = 'yso.workbench.guest.data.v1.';

// Reserve the extremely unlikely ffffffff UUID prefix so ordinary user UUIDs
// can never be mistaken for guest sessions by the offline layer.
const GUEST_ID_PATTERN = /^ffffffff-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let memoryGuestId: string | null = null;

function sessionStorageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function createGuestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (!random) throw new Error('此浏览器无法建立临时游客会话，请使用支持安全随机数的浏览器。');
  const hex = random.replaceAll('-', '');
  return `ffffffff-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isGuestUserId(value: string): boolean {
  return GUEST_ID_PATTERN.test(value);
}

export function isGuestMode(): boolean {
  const storage = sessionStorageOrNull();
  try {
    return (storage?.getItem(GUEST_MODE_KEY) === 'true') || memoryGuestId !== null;
  } catch {
    return memoryGuestId !== null;
  }
}

export function currentGuestUserId(): string | null {
  const storage = sessionStorageOrNull();
  let value: string | null;
  try {
    value = storage?.getItem(GUEST_USER_ID_KEY) ?? memoryGuestId;
  } catch {
    value = memoryGuestId;
  }
  return value && isGuestUserId(value) ? value : null;
}

/** Starts or resumes the current tab's ephemeral guest session. */
export function startGuestMode(): string {
  const existing = currentGuestUserId();
  const userId = existing ?? createGuestId();
  memoryGuestId = userId;
  const storage = sessionStorageOrNull();
  try {
    storage?.setItem(GUEST_MODE_KEY, 'true');
    storage?.setItem(GUEST_USER_ID_KEY, userId);
  } catch {
    // In restricted browser modes the session remains in memory for this page.
  }
  return userId;
}

/** Removes all synchronous guest state; sessionStorage also clears when its tab closes. */
export function stopGuestMode(): string | null {
  const userId = currentGuestUserId();
  memoryGuestId = null;
  const storage = sessionStorageOrNull();
  try {
    if (userId) storage?.removeItem(`${GUEST_DATA_STORAGE_PREFIX}${userId}`);
    storage?.removeItem(GUEST_MODE_KEY);
    storage?.removeItem(GUEST_USER_ID_KEY);
  } catch {
    // The current page still stops using the guest transport.
  }
  return userId;
}
