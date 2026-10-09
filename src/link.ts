export class InvalidLinkError extends Error {
  constructor(input: string) {
    super(`not a Cafe Bazaar link or package name: ${input}`);
    this.name = 'InvalidLinkError';
  }
}

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const HOSTS = new Set(['cafebazaar.ir', 'www.cafebazaar.ir']);
const BARE_HOST = /^(www\.)?cafebazaar\.ir\//i;

export function parsePackage(input: string): string {
  // Chat apps wrap pasted links in invisible direction marks.
  const text = input.replace(/\p{Cf}/gu, '').trim();
  const candidate = PACKAGE.test(text) ? text : fromUrl(BARE_HOST.test(text) ? `https://${text}` : text);
  if (candidate === null || !PACKAGE.test(candidate)) throw new InvalidLinkError(input);
  return candidate;
}

function fromUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'bazaar:') {
    return url.hostname === 'details' ? url.searchParams.get('id') : null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.has(url.hostname)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'app') return null;
  if (segments.length === 1) return url.searchParams.get('id');
  return segments.length === 2 ? segments[1] : null;
}
