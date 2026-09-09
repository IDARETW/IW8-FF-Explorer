const keywords = new Set(
  "if else for foreach while do switch case default break continue return wait waittill waittillframeend waittillmatch endon notify thread function true false undefined self level game anim const new delete in".split(
    " ",
  ),
);

// Text nodes only: source strings and comments can never become HTML.
export function gscTokens(source) {
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|#[a-zA-Z_]\w*|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\b|[a-zA-Z_]\w*|\s+|./gy;
  const tokens = [];
  for (const match of source.matchAll(pattern)) {
    const text = match[0];
    let kind = "";
    if (text.startsWith("//") || text.startsWith("/*")) kind = "comment";
    else if (/^["']/.test(text)) kind = "string";
    else if (text.startsWith("#")) kind = "directive";
    else if (/^\d/.test(text)) kind = "number";
    else if (keywords.has(text)) kind = "keyword";
    else if (
      /^[a-zA-Z_]\w*$/.test(text) &&
      /^\s*\(/.test(
        source.slice(
          match.index + text.length,
          match.index + text.length + 100,
        ),
      )
    )
      kind = "function";
    tokens.push({ text, kind });
    if (tokens.length >= 50000) {
      tokens.push({ text: source.slice(match.index + text.length), kind: "" });
      break;
    }
  }
  return tokens;
}
