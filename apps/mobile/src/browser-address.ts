import { t } from "./strings";

export function browserAddress(value: string): string {
  const input = value.trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /\s/.test(input)
    )
      throw new Error(t.tools.address.invalid);
    return url.href;
  } catch {
    throw new Error(t.tools.address.hint);
  }
}

export function browserSite(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "") || t.tools.address.fallbackSite;
  } catch {
    return t.tools.address.fallbackSite;
  }
}
