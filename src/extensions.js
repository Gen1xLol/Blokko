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

function extractExtensionInfo(source, id) {
  const method = /\bgetInfo\s*\(\s*\)\s*\{/.exec(source);
  if (!method) return { name: humanizeExtensionId(id), color: "#2BBE8C" };
  const open = method.index + method[0].lastIndexOf("{");
  const close = findMatchingDelimiter(source, open);
  if (close < 0) return { name: humanizeExtensionId(id), color: "#2BBE8C" };
  const methodBody = source.slice(open + 1, close);
  const returnedObject = /\breturn\s*\{/.exec(methodBody);
  if (!returnedObject)
    return { name: humanizeExtensionId(id), color: "#2BBE8C" };
  const objectOpen =
    open + 1 + returnedObject.index + returnedObject[0].lastIndexOf("{");
  const objectClose = findMatchingDelimiter(source, objectOpen);
  if (objectClose < 0)
    return { name: humanizeExtensionId(id), color: "#2BBE8C" };
  const fields = readObjectFields(source.slice(objectOpen + 1, objectClose));
  const name = resolveStaticString(fields.get("name"), source);
  const color = resolveStaticString(
    fields.get("color1") ?? fields.get("color"),
    source,
  );
  return {
    name:
      typeof name === "string" && name.trim()
        ? name.trim()
        : humanizeExtensionId(id),
    color: typeof color === "string" && isCssColor(color) ? color : "#2BBE8C",
  };
}

function readObjectFields(body) {
  const fields = new Map();
  for (const item of splitTopLevel(body, ",")) {
    const colon = findTopLevelDelimiter(item, ":");
    const key = (colon < 0 ? item : item.slice(0, colon))
      .trim()
      .replace(/^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)\s*/, "")
      .replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    fields.set(key, colon < 0 ? key : item.slice(colon + 1).trim());
  }
  return fields;
}

function resolveStaticString(expression, source, seen = new Set(), depth = 0) {
  if (typeof expression !== "string" || depth > 12) return null;
  let value = expression.trim().replace(/;$/, "").trim();
  if (!value) return null;
  if (
    value[0] === "(" &&
    findMatchingDelimiter(value, 0) === value.length - 1
  )
    return resolveStaticString(value.slice(1, -1), source, seen, depth + 1);
  if (
    (value[0] === '"' || value[0] === "'" || value[0] === "`") &&
    value.at(-1) === value[0]
  )
    return decodeStringLiteral(value);
  const translateCall = value.match(/^Scratch\.translate\s*\(/);
  if (translateCall) {
    const open = value.indexOf("(", translateCall.index);
    const close = findMatchingDelimiter(value, open);
    if (close > open) {
      const firstArgument = splitTopLevel(
        value.slice(open + 1, close),
        ",",
      )[0];
      return resolveStaticString(firstArgument, source, seen, depth + 1);
    }
  }
  const formatMessageCall = value.match(
    /^(?:(?:this|Scratch)\.)?[A-Za-z_$][\w$]*\s*\(/,
  );
  if (formatMessageCall) {
    const open = value.indexOf("(", formatMessageCall.index);
    const close = findMatchingDelimiter(value, open);
    if (close > open) {
      const callName = value.slice(0, open).trim();
      if (/(?:^|\.)(?:formatMessage|formatMessageWithLanguage)$/.test(callName)) {
        const firstArgument = splitTopLevel(
          value.slice(open + 1, close),
          ",",
        )[0];
        const objectFields = readStaticObjectFields(firstArgument);
        return resolveStaticString(
          objectFields.get("default"),
          source,
          seen,
          depth + 1,
        );
      }
    }
  }
  for (const operator of ["??", "||", "+"]) {
    const parts = splitTopLevel(value, operator);
    if (parts.length < 2) continue;
    const left = resolveStaticString(parts[0], source, seen, depth + 1);
    if (operator !== "+" && left) return left;
    const right = resolveStaticString(
      parts.slice(1).join(operator),
      source,
      seen,
      depth + 1,
    );
    if (operator === "+")
      return typeof left === "string" && typeof right === "string"
        ? left + right
        : null;
    return right;
  }
  const member = value.match(
    /^((?:this\.)?[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/,
  );
  if (member) {
    const objectExpression = findStaticAssignment(source, member[1]);
    const objectFields = objectExpression
      ? readStaticObjectFields(objectExpression)
      : new Map();
    return resolveStaticString(
      objectFields.get(member[2]),
      source,
      seen,
      depth + 1,
    );
  }
  const name = value.match(/^(?:this\.)?([A-Za-z_$][\w$]*)$/)?.[1];
  if (!name || seen.has(name)) return null;
  seen.add(name);
  const assignment = findStaticAssignment(source, value);
  return assignment
    ? resolveStaticString(assignment, source, seen, depth + 1)
    : null;
}

function readStaticObjectFields(expression) {
  const value = expression.trim();
  if (value[0] !== "{") return new Map();
  const close = findMatchingDelimiter(value, 0);
  return close === value.length - 1
    ? readObjectFields(value.slice(1, -1))
    : new Map();
}

function decodeStringLiteral(literal) {
  const content = literal.slice(1, -1);
  if (literal[0] === '"') {
    try {
      return JSON.parse(literal);
    } catch {
      return null;
    }
  }
  return content.replace(
    /\\([\\'"`nrt])/g,
    (_, character) => ({ n: "\n", r: "\r", t: "\t" })[character] ?? character,
  );
}

function findStaticAssignment(source, reference) {
  const name = reference.startsWith("this.") ? reference.slice(5) : reference;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = reference.startsWith("this.")
    ? [new RegExp(`this\\.${escaped}\\s*=`, "g")]
    : [
        new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`, "g"),
        new RegExp(`(?<![\\w$.])${escaped}\\s*=`, "g"),
      ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    return readSimpleExpression(source, match.index + match[0].length);
  }
  return null;
}

function readSimpleExpression(source, start) {
  const tail = source.slice(start);
  const parts = splitTopLevel(tail, ";");
  const line = parts[0].split(/\r?\n/)[0].trim();
  return line;
}

function findMatchingDelimiter(source, start) {
  const open = source[start];
  const close = { "{": "}", "[": "]", "(": ")" }[open];
  if (!close) return -1;
  let depth = 0;
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) return -1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) return -1;
      index++;
      continue;
    }
    if (character === open) depth++;
    if (character === close && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(source, delimiter) {
  const parts = [];
  const stack = [];
  let quote = "";
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) break;
      index++;
      continue;
    }
    if ("{[(".includes(character))
      stack.push({ "{": "}", "[": "]", "(": ")" }[character]);
    else if ("}])".includes(character) && stack.at(-1) === character)
      stack.pop();
    if (!stack.length && source.startsWith(delimiter, index)) {
      parts.push(source.slice(start, index).trim());
      index += delimiter.length - 1;
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function findTopLevelDelimiter(source, delimiter) {
  const parts = splitTopLevel(source, delimiter);
  if (parts.length < 2) return -1;
  return source.indexOf(delimiter);
}

function isCssColor(value) {
  return (
    /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ||
    /^(?:rgb|hsl)a?\([\d.%\s,/-]+\)$/i.test(value) ||
    /^[a-z]{3,20}$/i.test(value)
  );
}
