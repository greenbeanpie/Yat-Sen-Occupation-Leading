import { fingerprintOf } from "./db/helpers";

/** 96 random bits (16 base64url characters); the plaintext is returned once and never stored. */
export function invitationToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, "-").replace(/\//g, "_");
}
export const invitationHash = (token: string) => fingerprintOf(["invitation-v1", token]);
export const canonicalUsername = (username: string) => username.trim().toLowerCase();
