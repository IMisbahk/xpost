/**
 * Approximate X weighted character counting.
 * URLs count as 23. Emoji and CJK weigh more than 1 in many cases;
 * we use a practical approximation aligned with Twitter Text libraries.
 */

const URL_REGEX =
  /https?:\/\/(?:[^\s<>()]+|\([^\s<>()]*\))+(?<![.,;:!?)])/gi;

const DEFAULT_SHORT_URL_LENGTH = 23;

export function extractUrls(text: string): string[] {
  return text.match(URL_REGEX) ?? [];
}

export function weightedLength(text: string): number {
  let working = text;
  const urls = extractUrls(working);
  for (const url of urls) {
    working = working.replace(url, " ".repeat(DEFAULT_SHORT_URL_LENGTH));
  }

  let weight = 0;
  for (const char of working) {
    const code = char.codePointAt(0) ?? 0;
    if (isHeavyChar(code)) {
      weight += 2;
    } else {
      weight += 1;
    }
  }
  return weight;
}

function isHeavyChar(code: number): boolean {
  // CJK Unified Ideographs and common wide ranges
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f) ||
    // emoji ranges (approximate)
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf)
  );
}

export function validateWeightedLength(
  texts: string[],
  limit: number
): { ok: boolean; lengths: number[]; messages: string[] } {
  const lengths = texts.map((t) => weightedLength(t));
  const messages: string[] = [];
  lengths.forEach((len, index) => {
    if (len > limit) {
      messages.push(
        `Text ${index + 1} is ${len} weighted characters (limit ${limit}).`
      );
    }
  });
  return { ok: messages.length === 0, lengths, messages };
}

export function collectTextWarnings(texts: string[]): string[] {
  const warnings: string[] = [];
  texts.forEach((text, index) => {
    const label = texts.length > 1 ? `Text ${index + 1}` : "Text";
    if (text.includes("\u2014") || text.includes("\u2013")) {
      warnings.push(
        `${label} contains an em dash or en dash. Prefer a plain hyphen or rephrase.`
      );
    }
    const hashtags = text.match(/(^|\s)#[\p{L}\p{N}_]+/gu);
    if (hashtags && hashtags.length > 0) {
      warnings.push(
        `${label} contains ${hashtags.length} hashtag(s). Hashtags often look spammy on X.`
      );
    }
    const urls = extractUrls(text);
    if (urls.length > 0) {
      warnings.push(
        `${label} contains ${urls.length} URL(s). Each URL counts as ${DEFAULT_SHORT_URL_LENGTH} weighted characters.`
      );
    }
  });
  return warnings;
}
