const internalDirectoryCache = new Map();

export function createExtensionMetadata(extensionIds, extensionURLs, vmSource) {
  return extensionIds.map((id) => ({
    id,
    source: extensionURLs[id]
      ? "Project URL"
      : vmSource === "penguinmod"
        ? "PenguinMod VM"
        : "Scratch VM",
    name: humanizeExtensionId(id),
    color: "#2BBE8C",
    status: "loading",
  }));
}

export async function lookUpExtensionMetadata(
  extensionIds,
  extensionURLs,
  vmSource,
) {
  const internalIds = extensionIds.filter((id) => !extensionURLs[id]);
  let directories = [];
  let listingReason = "";
  if (internalIds.length) {
    try {
      directories = await getInternalExtensionDirectories(vmSource);
    } catch (exception) {
      listingReason =
        exception.message || "couldn't list internal extensions.";
    }
  }
  const sources = extensionIds.map((id) => ({
    id,
    ...getExtensionSource(
      id,
      extensionURLs,
      vmSource,
      directories,
      listingReason,
    ),
  }));
  return Promise.all(
    sources.map(
      async ({ id, url: sourceUrl, source, resolvedId, reason }) => {
        const fallback = {
          id,
          source,
          resolvedId,
          name: humanizeExtensionId(id),
          color: "#2BBE8C",
          status: "unavailable",
          reason,
        };
        try {
          if (isDataUri(sourceUrl)) {
            const source = decodeDataUri(sourceUrl, 2_000_000);
            const info = extractExtensionInfo(source, id);
            return { ...fallback, ...info, status: "loaded" };
          }
          const url = new URL(sourceUrl);
          const response = await fetch(url, {
            credentials: "omit",
            mode: "cors",
            signal: AbortSignal.timeout(12000),
          });
          if (!response.ok)
            throw new Error(`request returned ${response.status}`);
          const finalUrl = new URL(response.url);
          if (
            finalUrl.protocol !== "https:" ||
            isLocalHost(finalUrl.hostname)
          )
            throw new Error("the extension redirected to a restricted URL");
          const source = await readExtensionSource(response, 2_000_000);
          const info = extractExtensionInfo(source, id);
          return { ...fallback, ...info, status: "loaded" };
        } catch (exception) {
          return {
            ...fallback,
            status: "unavailable",
            reason: exception.message || "couldn't read the extension source",
          };
        }
      },
    ),
  );
}

export function getExtensionSourceLabel(extension) {
  if (extension.source === "PenguinMod VM") return "(PenguinMod)";
  if (extension.source === "Scratch VM") return "(Scratch)";
  return "(Custom)";
}

async function getInternalExtensionDirectories(vmSource) {
  if (internalDirectoryCache.has(vmSource))
    return internalDirectoryCache.get(vmSource);
  const repository =
    vmSource === "penguinmod"
      ? "PenguinMod/PenguinMod-Vm"
      : "scratchfoundation/scratch-vm";
  const request = (async () => {
    const url = `https://api.github.com/repos/${repository}/contents/src/extensions?ref=develop`;
    const response = await fetch(url, {
      credentials: "omit",
      headers: { Accept: "application/vnd.github+json" },
      mode: "cors",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      throw new Error(
        `couldn't list ${vmSource} extensions (${response.status}).`,
      );
    const content = await response.json();
    if (!Array.isArray(content))
      throw new Error(`couldn't read the ${vmSource} extension list.`);
    return content
      .filter(
        (entry) => entry.type === "dir" && typeof entry.name === "string",
      )
      .map((entry) => entry.name);
  })();
  internalDirectoryCache.set(vmSource, request);
  request.catch(() => internalDirectoryCache.delete(vmSource));
  return request;
}

function getExtensionSource(
  id,
  extensionURLs,
  vmSource,
  directories,
  listingReason,
) {
  if (extensionURLs[id])
    return { url: extensionURLs[id], source: "Project URL" };
  const repository =
    vmSource === "penguinmod"
      ? "PenguinMod/PenguinMod-Vm"
      : "scratchfoundation/scratch-vm";
  const matchedDirectory = findInternalExtensionDirectory(id, directories);
  const sourceId = matchedDirectory ?? id;
  return {
    url: `https://raw.githubusercontent.com/${repository}/refs/heads/develop/src/extensions/${encodeURIComponent(sourceId)}/index.js`,
    source: vmSource === "penguinmod" ? "PenguinMod VM" : "Scratch VM",
    resolvedId: sourceId,
    reason: matchedDirectory
      ? ""
      : listingReason ||
        "no matching extension directory was found, we tried the original ID as a fallback",
  };
}

function findInternalExtensionDirectory(id, directories) {
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const idKey = normalize(id);
  const exact = directories.filter((name) => normalize(name) === idKey);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const aliases = directories.filter((name) => {
    const parts = name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .split(/[_-]+/)
      .map(normalize);
    return parts.some((_, index) => parts.slice(index).join("") === idKey);
  });
  return aliases.length === 1 ? aliases[0] : null;
}

async function readExtensionSource(response, limit) {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > limit)
    throw new Error("the extension source is too large to inspect!");
  if (!response.body?.getReader) {
    const source = await response.text();
    if (source.length > limit)
      throw new Error("the extension source is too large to inspect!");
    return source;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let source = "";
  let bytesRead = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > limit) {
      await reader.cancel();
      throw new Error("the extension source is too large to inspect!");
    }
    source += decoder.decode(value, { stream: true });
  }
  return source + decoder.decode();
}

function isDataUri(value) {
  return typeof value === "string" && /^data:/i.test(value.trim());
}

function decodeDataUri(value, limit) {
  const uri = value.trim();
  const commaIndex = uri.indexOf(",");
  if (commaIndex < 0) throw new Error("invalid data URI");

  const metadata = uri.slice(5, commaIndex);
  const payload = uri.slice(commaIndex + 1);
  let source;
  if (/(?:^|;)base64(?:;|$)/i.test(metadata)) {
    let binary;
    try {
      binary = atob(payload.replace(/\s/g, ""));
    } catch {
      throw new Error("invalid base64 data URI");
    }
    if (binary.length > limit)
      throw new Error("the extension source is too large to inspect!");
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    source = new TextDecoder().decode(bytes);
  } else {
    try {
      source = decodeURIComponent(payload);
    } catch {
      throw new Error("invalid encoded data URI");
    }
  }
  if (source.length > limit)
    throw new Error("the extension source is too large to inspect!");
  return source;
}

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host) ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function humanizeExtensionId(id) {
  return id
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

const unknown = Symbol("unknown");

// storing these like this is a bit of a hack, but otherwise they become very long and unreadable in the code
const regexAfter = new Set(
  "return typeof instanceof in of new delete void throw case do else yield await".split(
    " ",
  ),
);

const puncts = [
  ">>>= ... === !== **= <<= >>= >>> &&= ||= ??=",
  "=> == != <= >= && || ?? ?. ++ -- += -= *= /= %= &= |= ^= << >> **",
  "{ } ( ) [ ] ; , < > + - * / % & | ^ ! ~ ? : = . @ #",
]
  .join(" ")
  .split(" ");

const assignOps = new Set(
  "= += -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??=".split(" "),
);

const levels = new Map(
  [
    "??",
    "||",
    "&&",
    "|",
    "^",
    "&",
    "== != === !==",
    "< > <= >= instanceof in",
    "<< >> >>>",
    "+ -",
    "* / %",
    "**",
  ].flatMap((group, level) => group.split(" ").map((op) => [op, level + 1])),
);

const translators = new Set([
  "formatMessage",
  "formatMessageWithLanguage",
  "translate",
]);

const binaryOps = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "**": (a, b) => a ** b,
  "==": (a, b) => a == b,
  "!=": (a, b) => a != b,
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b,
};

const unaryOps = {
  "!": (a) => !a,
  "-": (a) => -a,
  "+": (a) => +a,
  "~": (a) => ~a,
  typeof: (a) => typeof a,
  void: () => undefined,
};

const escapes = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

const numPattern =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;
const idPattern = /[A-Za-z_$\u0080-\uFFFF][\w$\u0080-\uFFFF]*/y;

function fromCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function readEscape(source, index) {
  const char = source[index];
  if (char in escapes) return [escapes[char], index + 1];
  switch (char) {
    case "x":
      return [
        fromCode(parseInt(source.slice(index + 1, index + 3), 16)),
        index + 3,
      ];
    case "u": {
      if (source[index + 1] === "{") {
        const close = source.indexOf("}", index);
        if (close < 0) return ["", index + 1];
        return [
          fromCode(parseInt(source.slice(index + 2, close), 16)),
          close + 1,
        ];
      }
      return [
        fromCode(parseInt(source.slice(index + 1, index + 5), 16)),
        index + 5,
      ];
    }
    case "\r":
      return ["", source[index + 1] === "\n" ? index + 2 : index + 1];
    case "\n":
      return ["", index + 1];
    default:
      return [char ?? "", index + 1];
  }
}

function regexOk(previous) {
  if (!previous) return true;
  if (previous.type === "id") return regexAfter.has(previous.value);
  if (previous.type === "p")
    return ![")", "]", "}", "++", "--"].includes(previous.value);
  return false;
}

function tokenize(source, start, nested) {
  const tokens = [];
  const length = source.length;
  let index = start;
  let depth = 0;
  while (index < length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < length && source[index] !== "\n" && source[index] !== "\r")
        index++;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? length : close + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      let cursor = index + 1;
      let value = "";
      while (
        cursor < length &&
        source[cursor] !== character &&
        source[cursor] !== "\n"
      ) {
        if (source[cursor] === "\\") {
          const [text, next] = readEscape(source, cursor + 1);
          value += text;
          cursor = next;
        } else {
          value += source[cursor];
          cursor++;
        }
      }
      tokens.push({ type: "str", value });
      index = cursor + 1;
      continue;
    }
    if (character === "`") {
      const quasis = [];
      const exprs = [];
      let cursor = index + 1;
      let current = "";
      while (cursor < length && source[cursor] !== "`") {
        if (source[cursor] === "\\") {
          const [text, next] = readEscape(source, cursor + 1);
          current += text;
          cursor = next;
        } else if (source[cursor] === "$" && source[cursor + 1] === "{") {
          quasis.push(current);
          current = "";
          const inner = tokenize(source, cursor + 2, true);
          exprs.push(inner.tokens);
          cursor = inner.end;
        } else {
          current += source[cursor];
          cursor++;
        }
      }
      quasis.push(current);
      tokens.push({ type: "tpl", quasis, exprs });
      index = cursor + 1;
      continue;
    }
    if (
      /[0-9]/.test(character) ||
      (character === "." && /[0-9]/.test(source[index + 1] ?? ""))
    ) {
      numPattern.lastIndex = index;
      const match = numPattern.exec(source);
      if (match) {
        const text = match[0].replace(/_/g, "").replace(/n$/, "");
        tokens.push({ type: "num", value: Number(text) });
        index += match[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$\u0080-\uFFFF]/.test(character)) {
      idPattern.lastIndex = index;
      const match = idPattern.exec(source);
      tokens.push({ type: "id", value: match[0] });
      index += match[0].length;
      continue;
    }
    if (character === "/" && regexOk(tokens[tokens.length - 1])) {
      let cursor = index + 1;
      let inClass = false;
      while (cursor < length && source[cursor] !== "\n") {
        const current = source[cursor];
        if (current === "\\") {
          cursor += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        cursor++;
      }
      cursor++;
      while (cursor < length && /[A-Za-z]/.test(source[cursor])) cursor++;
      tokens.push({ type: "regex" });
      index = cursor;
      continue;
    }
    const punctuator = puncts.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (!punctuator) {
      index++;
      continue;
    }
    if (nested && punctuator === "{") depth++;
    if (nested && punctuator === "}") {
      if (depth === 0) return { tokens, end: index + 1 };
      depth--;
    }
    tokens.push({ type: "p", value: punctuator });
    index += punctuator.length;
  }
  return { tokens, end: length };
}

function isRecord(value) {
  return value !== null && typeof value === "object";
}

function isPrim(value) {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

class Parser {
  constructor(source, tokens = tokenize(source, 0, false).tokens) {
    this.source = source;
    this.tokens = tokens;
    this.position = 0;
    this.pairs = new Map();
    const stack = [];
    tokens.forEach((token, index) => {
      if (token.type !== "p") return;
      if (token.value === "(" || token.value === "[" || token.value === "{") {
        stack.push(index);
      } else if (
        (token.value === ")" || token.value === "]" || token.value === "}") &&
        stack.length
      ) {
        const open = stack.pop();
        this.pairs.set(open, index);
        this.pairs.set(index, open);
      }
    });
  }

  at(index, type, value) {
    const token = this.tokens[index];
    return (
      Boolean(token) &&
      token.type === type &&
      (value === undefined || token.value === value)
    );
  }

  isPunct(value, offset = 0) {
    return this.at(this.position + offset, "p", value);
  }

  isWord(value, offset = 0) {
    return this.at(this.position + offset, "id", value);
  }

  expect(value) {
    if (!this.isPunct(value)) throw new Error(`expected ${value}`);
    this.position++;
  }

  skipGroup() {
    const close = this.pairs.get(this.position);
    if (close === undefined || close < this.position)
      throw new Error("unbalanced group");
    this.position = close + 1;
  }

  parseExpr() {
    let node = this.parseAssign();
    while (this.isPunct(",")) {
      this.position++;
      node = this.parseAssign();
    }
    return node;
  }

  isArrow(index) {
    let cursor = index;
    if (
      this.at(cursor, "id", "async") &&
      !this.at(cursor + 1, "p", "=>") &&
      (this.at(cursor + 1, "id") || this.at(cursor + 1, "p", "("))
    )
      cursor++;
    if (this.at(cursor, "id")) return this.at(cursor + 1, "p", "=>");
    if (this.at(cursor, "p", "(")) {
      const close = this.pairs.get(cursor);
      return close !== undefined && this.at(close + 1, "p", "=>");
    }
    return false;
  }

  parseArrow() {
    if (this.isWord("async") && !this.isPunct("=>", 1)) this.position++;
    if (this.at(this.position, "id")) this.position++;
    else this.skipGroup();
    this.expect("=>");
    if (this.isPunct("{")) this.skipGroup();
    else this.parseAssign();
    return { t: "fn" };
  }

  parseAssign() {
    if (this.isArrow(this.position)) return this.parseArrow();
    const test = this.parseBinary(0);
    if (this.isPunct("?")) {
      this.position++;
      const yes = this.parseAssign();
      this.expect(":");
      const no = this.parseAssign();
      return { t: "cond", test, yes, no };
    }
    const token = this.tokens[this.position];
    if (token && token.type === "p" && assignOps.has(token.value)) {
      this.position++;
      return { t: "assign", op: token.value, value: this.parseAssign() };
    }
    return test;
  }

  parseBinary(minimum) {
    let left = this.parseUnary();
    for (;;) {
      const token = this.tokens[this.position];
      if (!token) return left;
      const isOperator =
        token.type === "p" ||
        (token.type === "id" &&
          (token.value === "instanceof" || token.value === "in"));
      const precedence = isOperator
        ? levels.get(token.value)
        : undefined;
      if (precedence === undefined || precedence < minimum) return left;
      this.position++;
      const right = this.parseBinary(
        token.value === "**" ? precedence : precedence + 1,
      );
      left = { t: "bin", op: token.value, left, right };
    }
  }

  parseUnary() {
    const token = this.tokens[this.position];
    const symbolOp =
      token &&
      token.type === "p" &&
      ["!", "-", "+", "~", "++", "--"].includes(token.value);
    const wordOp =
      token &&
      token.type === "id" &&
      ["typeof", "void", "delete", "await"].includes(token.value);
    if (symbolOp || wordOp) {
      this.position++;
      return { t: "un", op: token.value, arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      const token = this.tokens[this.position];
      if (!token) return node;
      if (token.type === "tpl") {
        this.position++;
        node = { t: "raw" };
        continue;
      }
      if (token.type !== "p") return node;
      if (token.value === "." || token.value === "?.") {
        this.position++;
        if (
          token.value === "?." &&
          (this.isPunct("[") || this.isPunct("("))
        )
          continue;
        let prefix = "";
        if (this.isPunct("#")) {
          prefix = "#";
          this.position++;
        }
        const word = this.tokens[this.position];
        if (!word || word.type !== "id") throw new Error("expected property");
        this.position++;
        node = { t: "member", obj: node, prop: prefix + word.value };
        continue;
      }
      if (token.value === "[") {
        this.position++;
        const index = this.parseExpr();
        this.expect("]");
        node = { t: "index", obj: node, index };
        continue;
      }
      if (token.value === "(") {
        node = { t: "call", callee: node, args: this.parseArgs() };
        continue;
      }
      if (token.value === "++" || token.value === "--") {
        this.position++;
        node = { t: "raw" };
        continue;
      }
      return node;
    }
  }

  parsePrimary() {
    const token = this.tokens[this.position];
    if (!token) throw new Error("unexpected end of source");
    if (token.type === "num" || token.type === "str") {
      this.position++;
      return { t: "lit", value: token.value };
    }
    if (token.type === "regex") {
      this.position++;
      return { t: "raw" };
    }
    if (token.type === "tpl") {
      this.position++;
      const exprs = token.exprs.map((tokens) =>
        new Parser(this.source, tokens).parseExpr(),
      );
      return { t: "tpl", quasis: token.quasis, exprs };
    }
    if (token.type === "id") return this.parseWord(token);
    if (token.value === "(") {
      this.position++;
      const expr = this.parseExpr();
      this.expect(")");
      return { t: "paren", expr };
    }
    if (token.value === "[") return this.parseArray();
    if (token.value === "{") return this.parseObject();
    throw new Error("unexpected token");
  }

  parseWord(token) {
    const word = token.value;
    if (word === "async" && this.isWord("function", 1)) {
      this.position++;
      return this.parseWord(this.tokens[this.position]);
    }
    this.position++;
    switch (word) {
      case "true":
        return { t: "lit", value: true };
      case "false":
        return { t: "lit", value: false };
      case "null":
        return { t: "lit", value: null };
      case "function":
        if (this.isPunct("*")) this.position++;
        if (this.at(this.position, "id")) this.position++;
        this.skipGroup();
        this.skipGroup();
        return { t: "fn" };
      case "class":
        if (this.at(this.position, "id") && !this.isWord("extends"))
          this.position++;
        while (this.position < this.tokens.length && !this.isPunct("{")) {
          if (this.isPunct("(") || this.isPunct("[")) this.skipGroup();
          else this.position++;
        }
        this.skipGroup();
        return { t: "fn" };
      case "new":
        this.parsePrimary();
        while (this.isPunct(".") || this.isPunct("[")) {
          if (this.isPunct(".")) this.position += 2;
          else this.skipGroup();
        }
        if (this.isPunct("(")) this.skipGroup();
        return { t: "raw" };
      default:
        return { t: "id", name: word };
    }
  }

  parseArgs() {
    this.expect("(");
    const args = [];
    while (!this.isPunct(")")) {
      if (this.isPunct("...")) {
        this.position++;
        args.push({ t: "spread", arg: this.parseAssign() });
      } else {
        args.push(this.parseAssign());
      }
      if (this.isPunct(",")) this.position++;
      else break;
    }
    this.expect(")");
    return args;
  }

  parseArray() {
    this.expect("[");
    const items = [];
    while (!this.isPunct("]")) {
      if (this.isPunct(",")) {
        this.position++;
        items.push({ t: "lit", value: undefined });
        continue;
      }
      if (this.isPunct("...")) {
        this.position++;
        items.push({ t: "spread", arg: this.parseAssign() });
      } else {
        items.push(this.parseAssign());
      }
      if (this.isPunct(",")) this.position++;
      else break;
    }
    this.expect("]");
    return { t: "arr", items };
  }

  parseObject() {
    this.expect("{");
    const props = [];
    while (!this.isPunct("}")) {
      props.push(this.parseProp());
      if (this.isPunct(",")) this.position++;
      else break;
    }
    this.expect("}");
    return { t: "obj", props };
  }

  parseProp() {
    if (this.isPunct("...")) {
      this.position++;
      return { spread: this.parseAssign() };
    }
    let token = this.tokens[this.position];
    if (
      token &&
      token.type === "id" &&
      ["get", "set", "async"].includes(token.value)
    ) {
      const next = this.tokens[this.position + 1];
      const endsKey =
        !next ||
        (next.type === "p" && [",", ":", "(", "}"].includes(next.value));
      if (!endsKey) {
        this.position++;
        token = this.tokens[this.position];
      }
    }
    if (this.isPunct("*")) {
      this.position++;
      token = this.tokens[this.position];
    }
    let key = null;
    let keyNode = null;
    if (this.isPunct("[")) {
      this.position++;
      keyNode = this.parseAssign();
      this.expect("]");
    } else if (token && (token.type === "id" || token.type === "str")) {
      key = token.value;
      this.position++;
    } else if (token && token.type === "num") {
      key = String(token.value);
      this.position++;
    } else {
      throw new Error("unexpected property key");
    }
    if (this.isPunct(":")) {
      this.position++;
      return { key, keyNode, value: this.parseAssign() };
    }
    if (this.isPunct("(")) {
      this.skipGroup();
      this.skipGroup();
      return { key, keyNode, value: { t: "fn" } };
    }
    if (keyNode === null && token.type === "id")
      return { key, keyNode, value: { t: "id", name: key } };
    throw new Error("unexpected property");
  }

  parseDecls(decls) {
    for (;;) {
      const token = this.tokens[this.position];
      if (!token) return;
      if (token.type === "id") {
        this.position++;
        if (this.isPunct("=")) {
          this.position++;
          const init = this.parseAssign();
          if (!decls.has(token.value))
            decls.set(token.value, init);
        }
      } else if (token.type === "p" && ["{", "["].includes(token.value)) {
        this.skipGroup();
        if (this.isPunct("=")) {
          this.position++;
          this.parseAssign();
        }
      } else {
        return;
      }
      if (this.isPunct(",")) this.position++;
      else return;
    }
  }

  scanDecls(from, to) {
    const decls = new Map();
    let returned = null;
    let index = from;
    while (index < to) {
      const token = this.tokens[index];
      if (
        token.type === "p" &&
        (token.value === "{" || token.value === "(" || token.value === "[")
      ) {
        const close = this.pairs.get(index);
        index = close === undefined ? index + 1 : close + 1;
        continue;
      }
      const afterDot = index > from && this.at(index - 1, "p", ".");
      const isDecl =
        token.type === "id" &&
        !afterDot &&
        ["const", "let", "var"].includes(token.value);
      const isReturn =
        token.type === "id" &&
        !afterDot &&
        token.value === "return" &&
        returned === null;
      if (isDecl || isReturn) {
        this.position = index + 1;
        try {
          if (isDecl) this.parseDecls(decls);
          else returned = this.parseExpr();
          index = Math.max(this.position, index + 1);
        } catch {
          returned = null;
          index++;
        }
        continue;
      }
      index++;
    }
    return { decls, returned };
  }

  ancestors(index) {
    const stack = [];
    for (let cursor = 0; cursor < index; cursor++) {
      const token = this.tokens[cursor];
      if (token.type !== "p") continue;
      if (token.value === "(" || token.value === "[" || token.value === "{")
        stack.push(cursor);
      else if (
        token.value === ")" ||
        token.value === "]" ||
        token.value === "}"
      )
        stack.pop();
    }
    return stack;
  }

  buildScope(index, topLevel) {
    let scope = topLevel;
    for (const open of this.ancestors(index)) {
      const close = this.pairs.get(open);
      const end = close === undefined ? this.tokens.length : close;
      scope = {
        decls: this.scanDecls(open + 1, end).decls,
        parent: scope,
      };
    }
    return scope;
  }

  findClasses() {
    const classes = [];
    this.tokens.forEach((token, index) => {
      if (token.type !== "id" || token.value !== "class") return;
      if (this.at(index - 1, "p", ".")) return;
      let cursor = index + 1;
      while (cursor < this.tokens.length && !this.at(cursor, "p", "{")) {
        if (this.at(cursor, "p", "(") || this.at(cursor, "p", "[")) {
          const close = this.pairs.get(cursor);
          cursor = close === undefined ? cursor + 1 : close + 1;
        } else {
          cursor++;
        }
      }
      const close = this.pairs.get(cursor);
      if (close === undefined) return;
      let name = null;
      if (this.at(index + 1, "id") && !this.at(index + 1, "id", "extends"))
        name = this.tokens[index + 1].value;
      else if (this.at(index - 1, "p", "=") && this.at(index - 2, "id"))
        name = this.tokens[index - 2].value;
      classes.push({ name, open: cursor, close });
    });
    return classes;
  }

  addField(fields, name, start, scope) {
    if (fields.has(name)) return;
    this.position = start;
    try {
      fields.set(name, { node: this.parseAssign(), scope });
    } catch {
      return;
    }
  }

  addGetter(fields, name, parenIndex, scope) {
    if (fields.has(name)) return;
    const paramsEnd = this.pairs.get(parenIndex);
    if (paramsEnd === undefined || !this.at(paramsEnd + 1, "p", "{")) return;
    const bodyEnd = this.pairs.get(paramsEnd + 1);
    if (bodyEnd === undefined) return;
    const body = this.scanDecls(paramsEnd + 2, bodyEnd);
    if (!body.returned) return;
    fields.set(name, {
      node: body.returned,
      scope: { decls: body.decls, parent: scope },
    });
  }

  classMembers(open, close, scope) {
    const fields = new Map();
    let index = open + 1;
    while (index < close) {
      const token = this.tokens[index];
      if (
        token.type === "p" &&
        (token.value === "{" || token.value === "(" || token.value === "[")
      ) {
        const end = this.pairs.get(index);
        index = end === undefined ? index + 1 : end + 1;
        continue;
      }
      if (
        token.type === "id" &&
        token.value === "get" &&
        this.at(index + 1, "id") &&
        this.at(index + 2, "p", "(")
      )
        this.addGetter(
          fields,
          this.tokens[index + 1].value,
          index + 2,
          scope,
        );
      if (
        token.type === "id" &&
        this.at(index + 1, "p", "=") &&
        !this.at(index - 1, "p", ".")
      )
        this.addField(fields, token.value, index + 2, scope);
      index++;
    }
    for (let cursor = open + 1; cursor < close; cursor++) {
      if (
        this.at(cursor, "id", "this") &&
        this.at(cursor + 1, "p", ".") &&
        this.at(cursor + 2, "id") &&
        this.at(cursor + 3, "p", "=")
      )
        this.addField(
          fields,
          this.tokens[cursor + 2].value,
          cursor + 4,
          scope,
        );
    }
    return fields;
  }

  findInfos() {
    const methods = [];
    for (let index = 0; index < this.tokens.length; index++) {
      if (!this.at(index, "id", "getInfo")) continue;
      if (this.at(index + 1, "p", "(")) {
        const close = this.pairs.get(index + 1);
        if (close !== undefined && this.at(close + 1, "p", "{")) {
          methods.push({
            index,
            from: close + 2,
            to: this.pairs.get(close + 1) ?? this.tokens.length,
          });
        }
        continue;
      }
      if (!this.at(index + 1, "p", ":") && !this.at(index + 1, "p", "="))
        continue;
      let cursor = index + 2;
      if (this.at(cursor, "id", "async") && !this.at(cursor + 1, "p", "=>"))
        cursor++;
      if (this.at(cursor, "id", "function")) {
        cursor++;
        if (this.at(cursor, "id")) cursor++;
        const close = this.pairs.get(cursor);
        if (close !== undefined && this.at(close + 1, "p", "{")) {
          methods.push({
            index,
            from: close + 2,
            to: this.pairs.get(close + 1) ?? this.tokens.length,
          });
        }
        continue;
      }
      if (!this.isArrow(index + 2)) continue;
      const arrow = this.at(cursor, "id")
        ? cursor + 1
        : (this.pairs.get(cursor) ?? cursor) + 1;
      const body = arrow + 1;
      if (this.at(body, "p", "{")) {
        methods.push({
          index,
          from: body + 1,
          to: this.pairs.get(body) ?? this.tokens.length,
        });
      } else {
        methods.push({ index, expression: body });
      }
    }
    return methods;
  }
}

class Evaluator {
  constructor(members, byName) {
    this.members = members;
    this.byName = byName;
    this.cache = new Map();
    this.active = new Set();
  }

  evaluate(node, scope) {
    if (!node) return unknown;
    if (this.cache.has(node)) return this.cache.get(node);
    if (this.active.has(node)) return unknown;
    this.active.add(node);
    let value;
    try {
      value = this.compute(node, scope);
    } catch {
      value = unknown;
    }
    this.active.delete(node);
    this.cache.set(node, value);
    return value;
  }

  compute(node, scope) {
    switch (node.t) {
      case "lit":
        return node.value;
      case "paren":
        return this.evaluate(node.expr, scope);
      case "id":
        return this.identifier(node.name, scope);
      case "tpl":
        return this.template(node, scope);
      case "arr":
        return this.array(node, scope);
      case "obj":
        return this.object(node, scope);
      case "member":
        return this.member(node.obj, node.prop, scope);
      case "index": {
        const key = this.evaluate(node.index, scope);
        return typeof key === "string" || typeof key === "number"
          ? this.member(node.obj, String(key), scope)
          : unknown;
      }
      case "call":
        return this.call(node, scope);
      case "bin":
        return this.binary(node, scope);
      case "un":
        return this.unary(node, scope);
      case "cond": {
        const test = this.evaluate(node.test, scope);
        if (test === unknown) return unknown;
        return this.evaluate(test ? node.yes : node.no, scope);
      }
      case "assign":
        return node.op === "="
          ? this.evaluate(node.value, scope)
          : unknown;
      default:
        return unknown;
    }
  }

  identifier(name, scope) {
    for (let current = scope; current; current = current.parent) {
      if (current.decls.has(name))
        return this.evaluate(current.decls.get(name), current);
    }
    return name === "undefined" ? undefined : unknown;
  }

  member(objectNode, key, scope) {
    const path = this.path(objectNode);
    let fields =
      path === "this" || path === "this.constructor" ? this.members : null;
    const object = fields ? unknown : this.evaluate(objectNode, scope);
    if (!fields && object === unknown && objectNode.t === "id")
      fields = this.byName(objectNode.name);
    if (fields) {
      const field = fields.get(key);
      return field ? this.evaluate(field.node, field.scope) : unknown;
    }
    if (typeof object === "string")
      return key === "length" ? object.length : unknown;
    if (!isRecord(object)) return unknown;
    return Object.prototype.hasOwnProperty.call(object, key)
      ? object[key]
      : unknown;
  }

  template(node, scope) {
    let text = node.quasis[0];
    for (let index = 0; index < node.exprs.length; index++) {
      const value = this.evaluate(node.exprs[index], scope);
      if (!isPrim(value)) return unknown;
      text += String(value) + node.quasis[index + 1];
    }
    return text;
  }

  array(node, scope) {
    const items = [];
    for (const item of node.items) {
      if (item.t === "spread") {
        const value = this.evaluate(item.arg, scope);
        if (Array.isArray(value)) items.push(...value);
      } else {
        items.push(this.evaluate(item, scope));
      }
    }
    return items;
  }

  object(node, scope) {
    const result = Object.create(null);
    for (const prop of node.props) {
      if (prop.spread) {
        const value = this.evaluate(prop.spread, scope);
        if (isRecord(value)) Object.assign(result, value);
        continue;
      }
      const key = prop.keyNode
        ? this.evaluate(prop.keyNode, scope)
        : prop.key;
      if (typeof key === "string" || typeof key === "number")
        result[String(key)] = this.evaluate(prop.value, scope);
    }
    return result;
  }

  readProp(node, key, scope) {
    let target = node;
    while (target && target.t === "paren") target = target.expr;
    if (!target) return unknown;
    if (target.t !== "obj") {
      const value = this.evaluate(target, scope);
      return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
        ? value[key]
        : unknown;
    }
    let result = unknown;
    for (const prop of target.props) {
      if (prop.spread) {
        const value = this.evaluate(prop.spread, scope);
        if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, key))
          result = value[key];
        continue;
      }
      const propKey = prop.keyNode
        ? this.evaluate(prop.keyNode, scope)
        : prop.key;
      if (propKey === key) result = this.evaluate(prop.value, scope);
    }
    return result;
  }

  path(node) {
    if (node.t === "id") return node.name;
    if (node.t === "member") {
      const base = this.path(node.obj);
      return base === null ? null : `${base}.${node.prop}`;
    }
    return null;
  }

  isTranslator(path, scope, depth) {
    if (translators.has(path.slice(path.lastIndexOf(".") + 1))) return true;
    if (depth > 4 || path.includes(".")) return false;
    for (let current = scope; current; current = current.parent) {
      if (!current.decls.has(path)) continue;
      const init = current.decls.get(path);
      const target = this.path(init);
      if (target !== null && target !== path)
        return this.isTranslator(target, current, depth + 1);
      if (init.t === "call" && this.path(init.callee) === "require") {
        const argument = init.args[0];
        return Boolean(argument) && argument.value === "format-message";
      }
      return false;
    }
    return false;
  }

  translate(node, scope) {
    const first = node.args[0];
    if (!first || first.t === "spread") return unknown;
    const value = this.evaluate(first, scope);
    if (typeof value === "string") return value;
    if (
      isRecord(value) &&
      !Array.isArray(value) &&
      typeof value.default === "string"
    )
      return value.default;
    return unknown;
  }

  evalArgs(args, scope) {
    const values = [];
    for (const arg of args) {
      if (arg.t === "spread") {
        const value = this.evaluate(arg.arg, scope);
        if (!Array.isArray(value)) return null;
        values.push(...value);
      } else {
        values.push(this.evaluate(arg, scope));
      }
    }
    return values;
  }

  call(node, scope) {
    const path = this.path(node.callee);
    if (path !== null && this.isTranslator(path, scope, 0))
      return this.translate(node, scope);
    const args = this.evalArgs(node.args, scope);
    if (!args || args.includes(unknown)) return unknown;
    if (path === "String")
      return isPrim(args[0]) ? String(args[0]) : unknown;
    if (node.callee.t !== "member") return unknown;
    const receiver = this.evaluate(node.callee.obj, scope);
    const method = node.callee.prop;
    if (typeof receiver === "string") {
      if (["toLowerCase", "toUpperCase", "trim", "toString"].includes(method))
        return receiver[method]();
      if (method === "concat" && args.every(isPrim))
        return receiver.concat(...args.map(String));
    }
    if (Array.isArray(receiver) && receiver.every(isPrim)) {
      if (method === "join" && args.every(isPrim))
        return receiver.join(args.length ? String(args[0]) : ",");
      if (method === "concat") return receiver.concat(...args);
    }
    return unknown;
  }

  binary(node, scope) {
    const left = this.evaluate(node.left, scope);
    if (node.op === "||")
      return left === unknown
        ? unknown
        : left || this.evaluate(node.right, scope);
    if (node.op === "&&")
      return left === unknown
        ? unknown
        : left && this.evaluate(node.right, scope);
    if (node.op === "??")
      return left === unknown
        ? unknown
        : (left ?? this.evaluate(node.right, scope));
    const right = this.evaluate(node.right, scope);
    if (!isPrim(left) || !isPrim(right)) return unknown;
    const apply = binaryOps[node.op];
    return apply ? apply(left, right) : unknown;
  }

  unary(node, scope) {
    const value = this.evaluate(node.arg, scope);
    if (!isPrim(value)) return unknown;
    const apply = unaryOps[node.op];
    return apply ? apply(value) : unknown;
  }
}

function readDefs(source) {
  const parser = new Parser(source);
  const topLevel = {
    decls: parser.scanDecls(0, parser.tokens.length)
      .decls,
    parent: null,
  };
  const classes = parser.findClasses();
  const memo = new Map();
  const membersOf = (entry) => {
    if (!entry) return new Map();
    if (!memo.has(entry))
      memo.set(
        entry,
        parser.classMembers(
          entry.open,
          entry.close,
          parser.buildScope(entry.open, topLevel),
        ),
      );
    return memo.get(entry);
  };
  const byName = (name) => {
    const entry = classes.find((candidate) => candidate.name === name);
    return entry ? membersOf(entry) : null;
  };
  return parser.findInfos().map((method) => {
    let scope = parser.buildScope(method.index, topLevel);
    const owner = classes
      .filter((entry) => entry.open < method.index && entry.close > method.index)
      .sort((a, b) => b.open - a.open)[0];
    const members = membersOf(owner);
    let node = null;
    if (method.expression !== undefined) {
      parser.position = method.expression;
      try {
        node = parser.parseAssign();
      } catch {
        node = null;
      }
    } else {
      const body = parser.scanDecls(method.from, method.to);
      scope = { decls: body.decls, parent: scope };
      node = body.returned;
    }
    const evaluator = new Evaluator(members, byName);
    return {
      id: evaluator.readProp(node, "id", scope),
      name: evaluator.readProp(node, "name", scope),
      colors: ["color1", "color"].map((key) =>
        evaluator.readProp(node, key, scope),
      ),
    };
  });
}

function normalizeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractExtensionInfo(source, id) {
  const fallback = { name: humanizeExtensionId(id), color: "#2BBE8C" };
  let defs;
  try {
    defs = readDefs(source);
  } catch {
    return fallback;
  }
  const idKey = normalizeId(id);
  const definition =
    defs.find(
      (entry) =>
        typeof entry.id === "string" &&
        normalizeId(entry.id) === idKey,
    ) ??
    defs.find(
      (entry) => typeof entry.name === "string" && entry.name.trim(),
    ) ??
    defs[0];
  if (!definition) return fallback;
  const name =
    typeof definition.name === "string" ? definition.name.trim() : "";
  const color = definition.colors.find(
    (entry) => typeof entry === "string" && isCssColor(entry.trim()),
  );
  return {
    name: name || fallback.name,
    color: color ? color.trim() : fallback.color,
  };
}

function isCssColor(value) {
  return (
    /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ||
    /^(?:rgb|hsl)a?\([\d.%\s,/-]+\)$/i.test(value) ||
    /^[a-z]{3,20}$/i.test(value)
  );
}