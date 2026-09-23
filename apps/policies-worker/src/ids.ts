import { uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function parseOrgPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "org");
}

export function policyPublicId(uuid: string): string {
  return `pol_${uuidToHex(uuid)}`;
}

export function parsePolicyPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "pol");
}

export function versionPublicId(uuid: string): string {
  return `pov_${uuidToHex(uuid)}`;
}

export function parseVersionPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "pov");
}

export function staffPublicId(uuid: string): string {
  return `stf_${uuidToHex(uuid)}`;
}

export function parseStaffPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "stf");
}
