/**
 * The small amount of XML handling CalDAV requires.
 *
 * WebDAV responses are `multistatus` documents whose useful content is a flat
 * list of per-resource results. This module flattens them into plain objects so
 * the adapter never touches a parse tree.
 *
 * Namespace prefixes are stripped rather than resolved. Real servers disagree
 * about prefixes for the same namespaces — `d:`/`D:`/`dav:` for DAV, `c:`/`cal:`
 * for CalDAV — and every element name we care about is unambiguous without
 * them.
 */
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  // Values stay strings. An ETag of "12345" coerced to a number would no longer
  // match the header the server expects back in If-Match.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

type Node = Record<string, unknown>;

/** fast-xml-parser collapses single children; normalize so callers can iterate. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text content of a node, whether it parsed as a string or as an object. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text'];
  return undefined;
}

export interface PropStat {
  /** `HTTP/1.1 200 OK` — only 2xx propstats carry real values. */
  status: string;
  props: Node;
}

export interface DavResponse {
  href: string;
  /** Response-level status. Present instead of a propstat on 404 tombstones. */
  status?: string;
  propstats: PropStat[];
}

export interface MultiStatus {
  responses: DavResponse[];
  /** Collection-level sync token, from a sync-collection REPORT. */
  syncToken?: string;
  /** Precondition element names, e.g. `valid-sync-token`, from an error body. */
  errors: string[];
}

/**
 * Parse a `multistatus` (or `error`) body.
 *
 * Tolerant by design: a server that omits an element we expected produces empty
 * results rather than a thrown parse error, because a malformed response must
 * degrade to "no changes" and never to "everything was deleted".
 */
export function parseMultiStatus(xml: string): MultiStatus {
  let root: Node;
  try {
    root = parser.parse(xml) as Node;
  } catch {
    return { responses: [], errors: [] };
  }

  const errorNode = isNode(root['error']) ? (root['error'] as Node) : undefined;
  const errors = errorNode ? Object.keys(errorNode).filter((key) => !key.startsWith('@')) : [];

  const multistatus = isNode(root['multistatus']) ? (root['multistatus'] as Node) : undefined;
  if (!multistatus) return { responses: [], errors };

  const responses: DavResponse[] = [];

  for (const entry of asArray(multistatus['response'])) {
    if (!isNode(entry)) continue;

    const href = text(entry['href']);
    if (!href) continue;

    const propstats: PropStat[] = [];
    for (const propstat of asArray(entry['propstat'])) {
      if (!isNode(propstat)) continue;
      propstats.push({
        status: text(propstat['status']) ?? '',
        props: isNode(propstat['prop']) ? (propstat['prop'] as Node) : {},
      });
    }

    const status = text(entry['status']);
    responses.push({ href, ...(status ? { status } : {}), propstats });
  }

  const syncToken = text(multistatus['sync-token']);

  return { responses, ...(syncToken ? { syncToken } : {}), errors };
}

/** Read a property from the first successful propstat of a response. */
export function prop(response: DavResponse, name: string): unknown {
  for (const propstat of response.propstats) {
    if (!/\s2\d\d\s/.test(propstat.status) && propstat.status !== '') continue;
    if (name in propstat.props) return propstat.props[name];
  }
  return undefined;
}

export function propText(response: DavResponse, name: string): string | undefined {
  return text(prop(response, name));
}

/** Does a property node contain the named child? Used for resourcetype tests. */
export function propHasChild(response: DavResponse, name: string, child: string): boolean {
  const value = prop(response, name);
  return isNode(value) && child in value;
}

/** Child element names of a property, e.g. the granted privileges. */
export function propChildNames(response: DavResponse, name: string): string[] {
  const value = prop(response, name);
  if (!isNode(value)) return [];

  const names = new Set<string>();
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith('@') || key === '#text') continue;
    names.add(key);
    // Privileges nest one level: <privilege><write-content/></privilege>.
    for (const item of asArray(nested)) {
      if (isNode(item)) {
        for (const inner of Object.keys(item)) {
          if (!inner.startsWith('@') && inner !== '#text') names.add(inner);
        }
      }
    }
  }
  return [...names];
}

/** HTTP status code out of a `HTTP/1.1 404 Not Found` status line. */
export function statusCode(line: string | undefined): number | undefined {
  const match = /\s(\d{3})\s/.exec(` ${line ?? ''} `);
  return match ? Number(match[1]) : undefined;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape a value being placed into a request body — hrefs, sync tokens. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}
