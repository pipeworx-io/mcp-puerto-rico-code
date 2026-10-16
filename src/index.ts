interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * Minimal text extractor for simple, text-based PDFs — the kind a
 * mail-merge/print pipeline produces (Word or LibreOffice "export to PDF"),
 * not a scanned image. Built for Kentucky's per-statute PDFs
 * (apps.legislature.ky.gov/law/statutes/statute.aspx?id=...), which ARE
 * exactly that shape: one object tree, FlateDecode content streams, standard
 * TrueType fonts. This is the capability the state-law survey flagged as
 * "the largest single win available" (docs/state-law-probe.md) — several
 * state statute sites serve text ONLY as a per-section PDF, with no HTML
 * fallback, and until now this repo had no way to read one.
 *
 * WHAT THIS DOES NOT DO: parse a general PDF. No encryption, no cross-
 * reference recovery for a damaged file, no image/OCR, no custom
 * `/Differences` glyph encodings, no LZW or RunLength filters, no multi-byte
 * codespaces other than the 2-byte one every sampled font used. Most objects
 * this needs — Catalog, Pages, a leaf Page, its Resources/Font dict, its
 * Contents stream(s), a Type0 font's ToUnicode CMap — are found by scanning
 * for `N 0 obj ... endobj` directly in the file bytes. If a producer moves
 * one into a compressed object stream and this extractor still cannot find
 * it (see the next paragraph for what IS handled), extraction degrades to
 * `pages_found: 0` / empty text rather than silently returning garbage —
 * check `warnings` before trusting a thin result.
 *
 * COMPRESSED OBJECT STREAMS (`/Type/ObjStm`) ARE SUPPORTED (fleet #2744,
 * added for Wyoming's statute PDFs, which — unlike Kentucky's — are
 * cross-reference-STREAM files whose Catalog and Pages root are themselves
 * compressed into an ObjStm: `5205 0 obj` never appears literally in the
 * file; it exists only as entry in a decompressed `/Type/ObjStm` stream).
 * Every direct `/Type/ObjStm` object found in the file is inflated up front;
 * its header (`/N` object pairs starting at byte `/First`) is parsed into a
 * `(object number -> dict text)` map, and `getObject` falls back to that map
 * whenever the direct byte-scan finds nothing. Per the PDF spec a compressed
 * object can never itself contain a stream (Contents, ToUnicode CMaps, and
 * ObjStm/XRef streams are therefore always direct objects, found the
 * original way) — so this fallback only ever needs to resolve plain
 * dictionaries/arrays (Catalog, Pages, Font, sometimes Page), which is
 * exactly what Wyoming's shape needs. An ObjStm nested inside another
 * ObjStm via `/Extends` is NOT walked — not observed in any file tested.
 *
 * ALSO FIXED HERE: the Catalog/Pages discovery no longer requires `/Type`
 * to be the first thing found after `<<` in a Catalog's own dictionary text
 * — the original `<<[^>]*\/Type\s*\/Catalog` regex broke the moment any
 * NESTED dict (e.g. `/MarkInfo<</Marked true>>`) appeared earlier in the
 * same object, because `[^>]*` cannot cross that inner `>>`. Wyoming's real
 * Catalog objects are exactly this shape (`/Lang(...)/MarkInfo<<...>>
 * /Metadata .../Pages .../Type/Catalog/ViewerPreferences<<...>>`, `/Type`
 * nowhere near the start). Discovery now finds `/Type/Catalog` (or
 * `/Type/Pages`) as plain text anywhere — direct or inside a decompressed
 * ObjStm — and locates its OWN object number by nearest preceding
 * `N 0 obj` marker, which works regardless of what else is in the dict.
 *
 * TWO FONT SHAPES, BOTH NEEDED (confirmed against real KRS statute PDFs,
 * fleet #2734):
 *   - Simple TrueType/Type1 with `/Encoding/WinAnsiEncoding` — the common
 *     case. WinAnsiEncoding is BY DESIGN identical to Windows code page 1252
 *     (that is what "WinAnsi" means), so the raw string-literal bytes decode
 *     directly via `TextDecoder('windows-1252')` with no per-glyph table of
 *     our own to get wrong.
 *   - Type0/CIDFontType2 with `/Encoding/Identity-H` — seen even inside an
 *     otherwise-simple statute, apparently whenever the PDF producer's text
 *     shaping fell back to a subset-embedded font for one run (KRS 532.025's
 *     closing sentence, which includes a curly apostrophe, was entirely in
 *     this font while the rest of the document used WinAnsi). Each character
 *     is a 2-byte CID with NO inherent meaning; the `/ToUnicode` CMap
 *     attached to the font is the only place the real Unicode value lives
 *     (`beginbfchar`/`beginbfrange` blocks). Skipping this font shape would
 *     have truncated or corrupted exactly the statutes that happen to use a
 *     special character — not a rare edge case, a silent one.
 *
 * Verified end-to-end against two real KRS statutes during this pack's
 * build: a single-page WinAnsi-only PDF (507.020, Murder) and a four-page PDF
 * mixing both font shapes (532.025, including the CID-encoded sentence
 * naming "Kimber's Law") — both reproduced the statute's true text exactly,
 * eyeballed against the rendered PDF.
 *
 * INDIRECT /Length (fleet #2743): extended for North Dakota's Century Code
 * chapter PDFs (ndlegis.gov/cencode/t*.pdf), whose content streams all write
 * `/Length` as an indirect reference ("/Length 3 0 R") rather than inlining
 * the literal integer the way every sampled KRS PDF did. The referenced
 * object is resolved (it is always a bare integer object, never itself a
 * stream) rather than falling back to scanning for the "endstream" keyword —
 * that fallback slices in the EOL bytes between the compressed data and the
 * keyword, which this repo's own Node zlib rejects as "trailing junk" even
 * though the compressed payload is intact (Workers' DecompressionStream may
 * be more lenient, but Node is what `prepush-tests.mjs` runs, so the bug was
 * real either way). Verified against ND Century Code chapter 12.1-16
 * (Homicide, t12-1c16.pdf) — every content stream in that 9-page PDF uses
 * the indirect form.
 *
 * THREE FIXES PORTED FROM mcps/guam-code's PACK-LOCAL FORK (fleet #2904,
 * folding in #2888's src/gu-pdf-extract.ts -- nothing about them was
 * actually Guam-specific, which is why they live here now instead of only
 * in that fork):
 *   1. inflate()'s two stream writes were fire-and-forget
 *      (void writer.write(...) / void writer.close()). A malformed deflate
 *      stream (real, not hypothetical -- seen across several Guam chapter
 *      PDFs) rejects that detached promise UNHANDLED, invisible to any
 *      try/catch wrapped around this function's caller and fatal to the
 *      whole Node process; in a Worker it is an unhandled rejection on a
 *      live request. Both writes now carry a no-op .catch() -- the real
 *      failure still surfaces through reader.read() below, which every
 *      caller already handles.
 *   2. A literal (parenthesized) string run was decoded by passing its raw
 *      windows-1252-decoded bytes through unchanged, which is correct for a
 *      WinAnsi font but wrong for a mapped1/cid font whose code space only
 *      means anything via its own /ToUnicode CMap -- the same lookup a hex
 *      string run already gets. Guam's PDF producer writes several of its
 *      non-WinAnsi subset-embedded fonts' text as literal strings rather
 *      than hex, which this extractor previously decoded as line-noise
 *      control characters instead of the real text.
 *   3. decompressedStream now retries a /FlateDecode stream with its tail
 *      trimmed 1-4 bytes before giving up. Several real PDFs declare a
 *      /Length a few bytes LONGER than the true deflate stream (confirmed
 *      on Guam's 21gc033.pdf object 2: /Length says 96, the deflate stream
 *      completes at byte 95, byte 96 is one stray trailing byte). Python's
 *      zlib tolerates trailing garbage by default; the Workers/Node
 *      DecompressionStream used here does not and throws "Trailing junk
 *      found after the end of the compressed stream" -- the true stream
 *      length is always <= the declared one in every sample seen, never
 *      longer, so trimming is safe.
 */

interface PdfExtractResult {
  /** Extracted text, pages joined with a blank line. Empty string if nothing
   *  could be read — check `warnings`, not just truthiness, before deciding
   *  that means the document has no text. */
  text: string;
  /** Number of leaf /Type/Page objects found via the Pages tree (the WHOLE
   *  document's page count, even when `pageRange` restricted extraction to
   *  a subset — see `extractedPages` for how many were actually read). */
  pages: number;
  /** Number of pages actually extracted into `text`. Equal to `pages`
   *  unless a `pageRange` option restricted the run. */
  extractedPages: number;
  /** Non-fatal problems found while extracting (unknown font, missing
   *  ToUnicode, etc). A non-empty array does not mean the text is wrong, but
   *  it means something was guessed rather than read. */
  warnings: string[];
}

interface PdfExtractOptions {
  /** Restrict extraction to a slice of the document's leaf pages, bounded by
   *  PAGE OBJECT NUMBERS rather than page indexes — built for sources (e.g.
   *  New Mexico's NMOneSource chapter PDFs, fleet #2884) whose per-section
   *  bookmarks in `extractPdfOutline`'s output give a /Dest page object
   *  directly, with no indexing step of their own needed. `fromPageObj` is
   *  resolved to its position in document order and extraction starts
   *  there; `toPageObj` (also resolved to its position) is the LAST page
   *  included — pass the object a FOLLOWING bookmark points to and extract
   *  up to (not including) it by resolving that page's own PRECEDING page
   *  instead, since this is page-granularity, not byte-granularity. If
   *  `fromPageObj` is not found among the document's pages, this option is
   *  ignored and the whole document is extracted (a safe fallback, not a
   *  silent wrong answer — a warning is added). */
  pageRange?: { fromPageObj: number; toPageObj?: number };

  /** Called right after a font's own /ToUnicode CMap is parsed (for either
   *  a Type0 font's CID map or a simple font's 1-byte map), before it is
   *  used to decode any text. Return a REPLACEMENT map to override specific
   *  codes, or return nothing (undefined) to use the parsed map unchanged.
   *  Built for mcps/guam-code (fleet #2888/#2904): one embedded symbol font
   *  per chapter PDF carries a /ToUnicode CMap that is itself wrong in the
   *  SOURCE file (confirmed by eye against the rendered PDF — not a general
   *  parsing defect this shared extractor could detect), so the fix is
   *  keyed by matching `fontDict` against something only that caller's PDFs
   *  produce (there, a font name) rather than built into this file. */
  fontCMapOverride?: (fontDict: string, map: Map<number, number>) => Map<number, number> | void;
}

interface PdfOutlineEntry {
  /** The bookmark's own text, verbatim (e.g. "30-2-1. Murder." or
   *  "ARTICLE 1  General Provisions" or "ANNOTATIONS"). */
  title: string;
  /** The PDF page OBJECT NUMBER this bookmark's /Dest (or /A GoTo action)
   *  points to, or null if neither was found on this node. Pass this
   *  straight into `extractPdfText`'s `pageRange` option — no index lookup
   *  needed on the caller's side. */
  pageObjNum: number | null;
  /** Nesting depth in the outline tree, root's children = 0. A section's
   *  own "ANNOTATIONS" child (depth = section's depth + 1) is how a caller
   *  distinguishes statutory text from case annotations that start on the
   *  same page — see mcps/new-mexico-code for the worked example. */
  depth: number;
}

type FontDecoder =
  | { kind: 'winansi' }
  | { kind: 'cid'; map: Map<number, number> }
  // Simple (1-byte-code) font decoded via its own /ToUnicode CMap rather than
  // WinAnsi — see fontDecoderFor's comment on North Dakota's subsetted fonts.
  | { kind: 'mapped1'; map: Map<number, number> };

/** Inflate one `/FlateDecode` stream using the platform's own zlib — no
 *  dependency, works identically in the Workers runtime and in Node (used by
 *  this repo's prepush tests), because both implement the standard
 *  CompressionStream/DecompressionStream API over the zlib wire format PDF's
 *  FlateDecode filter already uses. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  // Fire-and-forget on purpose: the actual decompression result/error comes
  // through reader.read() below, which every caller already wraps in a
  // try/catch. Without a .catch() here, a malformed deflate stream rejects
  // this DETACHED write/close promise UNHANDLED -- invisible to that
  // try/catch and fatal to the whole process (ported from
  // mcps/guam-code's gu-pdf-extract.ts FORK FIX 3/3, fleet #2888/#2904;
  // confirmed crashing scripts/bake-sections.mjs outright on real Guam
  // chapter PDFs). The no-op .catch() here does not hide a real failure --
  // it still surfaces through reader.read() for the caller to see.
  const writeDone = writer.write(bytes).catch(() => {});
  const closeDone = writer.close().catch(() => {});
  void writeDone;
  void closeDone;
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Undo PDF string-literal escaping — `\(`, `\)`, `\\`, `\n`/`\r`/`\t`,
 * octal `\ddd`, and a trailing backslash-newline line continuation — on a
 * windows-1252-decoded slice. Safe to run on the decoded string rather than
 * raw bytes: every character this function inspects or produces (backslash,
 * parens, digits, the letters n/r/t/b/f) is plain ASCII, which windows-1252
 * never remaps, so the 1-byte-per-character alignment this relies on holds
 * throughout.
 */
function unescapePdfLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const next = s[i + 1];
    if (next === undefined) continue;
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b' || next === 'f') { i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next >= '0' && next <= '7') {
      let oct = next, j = i + 1, k = 0;
      while (k < 2 && s[j + 1] >= '0' && s[j + 1] <= '7') { j++; oct += s[j]; k++; }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j;
    } else if (next === '\n') { i++; }
    else if (next === '\r') { i++; if (s[i + 1] === '\n') i++; }
    else { out += next; i++; }
  }
  return out;
}

/**
 * Recover the ORIGINAL raw byte (0-255) that `new TextDecoder('latin1')`
 * produced a given codepoint for. This exists because the WHATWG Encoding
 * Standard makes "latin1" an ALIAS for "windows-1252", not true ISO-8859-1 —
 * every browser and Node's TextDecoder follow that spec. Bytes 0x00-0x7F and
 * 0xA0-0xFF decode as identity either way, but bytes 0x80-0x9F come back as
 * windows-1252's typographic symbols (0x99 -> U+2122 "™", 0x87 -> U+2021
 * "‡", …) instead of themselves — so `charCodeAt(i) & 0xff`, used everywhere
 * else in this file to recover a raw byte from a decoded string, silently
 * returns the WRONG byte for any of those 32 codepoints (U+2122 & 0xff is
 * 0x22, not the real 0x99).
 *
 * This only matters where the decoded character is being used as DATA (a
 * CID half-byte, a `mapped1` font's 1-byte code) rather than as the actual
 * text it renders (a true WinAnsi-encoded character, where the windows-1252
 * reading IS the correct glyph — see `fontDecoderFor`'s `'winansi'` kind,
 * which returns the decoded string unchanged on purpose and must NOT be
 * routed through this function). Found on mainland China's NPC/MOJ law PDFs
 * (cn-law, fleet #3136): Founder PDFGenerator (方正) writes CJK body text as
 * LITERAL strings under a Type0/Identity-H CID font, and roughly an eighth
 * of all 2-byte CIDs have at least one half-byte landing in 0x80-0x9F —
 * `合` (U+5408, CID 0x0F87) was coming back as `骨` (U+9AA8) because its low
 * byte 0x87 decoded to U+2021, and `U+2021 & 0xff` (0x21) is a different,
 * also-valid CID that happens to mean `骨` in the same font.
 */
function rawByteFromLatin1Char(code: number): number {
  const b = WIN1252_HIGH_TO_BYTE.get(code);
  return b !== undefined ? b : code & 0xff;
}
// windows-1252's 0x80-0x9F table (the WHATWG "windows-1252" index), inverted
// codepoint -> original byte. 0x81/0x8D/0x8F/0x90/0x9D are undefined in that
// table and decode as themselves (identity), so they need no entry here.
const WIN1252_HIGH_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

interface RawObject {
  dict: string;
  streamBytes: Uint8Array | null;
}

/** Extract readable text from a simple, non-encrypted, non-scanned PDF. */
async function extractPdfText(buf: ArrayBuffer, options?: PdfExtractOptions): Promise<PdfExtractResult> {
  const bytes = new Uint8Array(buf);
  // windows-1252 decode is total (every byte maps to exactly one UTF-16 code
  // unit) and length-preserving, so a match index found in `scan` is also a
  // valid BYTE offset into `bytes` — used below to slice stream data without
  // ever routing binary bytes through a lossy string round-trip.
  const scan = new TextDecoder('windows-1252').decode(bytes);
  const warnings: string[] = [];
  const objCache = new Map<number, RawObject | null>();

  // Byte offset of every DIRECT "N 0 obj" marker, sorted, for two uses: (1)
  // the object-lookup fallback stays regex-per-object the same as before;
  // (2) `objNumBefore` below answers "which object's text is this index
  // inside", which is how Catalog/Pages/ObjStm discovery works regardless of
  // what else that object's dictionary contains — see the file header.
  const objStarts: { index: number; num: number }[] = [];
  // Object number -> index right after its "N 0 obj" marker (i.e. where the
  // dictionary text begins), for every object found by the SAME forward
  // scan that builds objStarts — first occurrence wins, matching what a
  // one-shot `.exec` would find. This turns getDirectObject's lookup from
  // one full-document regex scan PER DISTINCT OBJECT NUMBER into one O(1)
  // map read: with a large page-tree walk (New Mexico's chapter PDFs run
  // 657-1,138+ pages, fleet #2884) the old per-call scan made even a
  // `pageRange`-restricted extraction cost nearly as much as extracting the
  // whole document, because walking the Pages tree alone touches every
  // page's object once regardless of how many are actually rendered —
  // measured 1,611ms for a 56-of-1,138-page extraction before this fix vs.
  // 1,699ms for the full document. The fallback regex scan below is kept
  // for any object this forward pass didn't catch (none observed, but
  // cheaper to keep than to prove impossible).
  const objEndByNum = new Map<number, number>();
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
      const num = parseInt(m[1], 10);
      if (!objEndByNum.has(num)) objEndByNum.set(num, m.index + m[0].length);
    }
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function getDirectObject(n: number): RawObject | null {
    if (objCache.has(n)) return objCache.get(n) ?? null;
    const fastEnd = objEndByNum.get(n);
    let objStart: number;
    if (fastEnd !== undefined) {
      objStart = fastEnd;
    } else {
      const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
      const m = re.exec(scan);
      if (!m) { objCache.set(n, null); return null; }
      objStart = m.index + m[0].length;
    }
    const endobjIdx = scan.indexOf('endobj', objStart);
    const streamIdx = scan.indexOf('stream', objStart);
    let dict: string;
    let streamBytes: Uint8Array | null = null;
    if (streamIdx !== -1 && (endobjIdx === -1 || streamIdx < endobjIdx)) {
      dict = scan.slice(objStart, streamIdx);
      let dataStart = streamIdx + 'stream'.length;
      if (bytes[dataStart] === 0x0d) dataStart++;
      if (bytes[dataStart] === 0x0a) dataStart++;
      // Matches EITHER "/Length 428" (literal) or "/Length 12 0 R"
      // (indirect) — group 2 is present only for the indirect form. Written
      // this way ON PURPOSE instead of the more obvious
      // `/\/Length\s+(\d+)(?!\s+0\s+R)/` for a literal: that negative
      // lookahead is a backtracking trap for any MULTI-DIGIT indirect
      // reference. On "/Length 12 0 R", a greedy `(\d+)` first tries "12",
      // the lookahead correctly forbids it (followed by " 0 R") — but the
      // engine then backtracks `\d+` down to "1", at which point the
      // lookahead is checked against "2 0 R", which does NOT start with
      // whitespace, so the forbidden pattern no longer matches and the
      // lookahead (wrongly) PASSES. The match silently becomes "1" instead
      // of failing, so this object's /Length reads as the literal integer 1
      // instead of as a reference to resolve — exactly the shape of North
      // Dakota's Century Code chapter PDFs (fleet #2743), whose indirect
      // Length refs are almost all two or more digits. An explicit optional
      // group has nothing to backtrack: `(\d+)` greedily keeps "12" and the
      // optional `(\s+0\s+R)?` either matches right after it or doesn't.
      const lenDictMatch = /\/Length\s+(\d+)(\s+0\s+R)?/.exec(dict);
      let dataEnd = -1;
      if (lenDictMatch) {
        if (!lenDictMatch[2]) {
          dataEnd = dataStart + parseInt(lenDictMatch[1], 10);
        } else {
          // Indirect reference. The referenced object is a bare integer
          // ("12 0 obj\n4541\nendobj"), never itself a stream, so resolving
          // it through the same getObject() is safe (no recursion risk back
          // onto object n). Falling back to scanning for the "endstream"
          // keyword instead — which the pre-fix code did unconditionally
          // here — slices in the EOL bytes PDF producers place between the
          // compressed data and that keyword, which Node's strict zlib
          // rejects as "trailing junk" even though the compressed payload
          // itself is intact.
          const lenObj = getObject(parseInt(lenDictMatch[1], 10));
          const lenVal = lenObj ? parseInt(lenObj.dict.trim(), 10) : NaN;
          if (Number.isFinite(lenVal) && lenVal >= 0) dataEnd = dataStart + lenVal;
        }
      }
      if (dataEnd === -1) dataEnd = scan.indexOf('endstream', dataStart);
      streamBytes = bytes.slice(dataStart, dataEnd);
    } else {
      dict = scan.slice(objStart, endobjIdx === -1 ? scan.length : endobjIdx);
    }
    const result = { dict, streamBytes };
    objCache.set(n, result);
    return result;
  }

  // Compressed objects (inside a /Type/ObjStm) — object number -> dict text.
  // Populated below, before any Catalog/Pages/Font lookup runs, because a
  // compressed Catalog or Pages root (Wyoming's shape) must resolve exactly
  // like a direct one from that point on. Never holds a stream: the PDF spec
  // forbids a compressed object from containing one.
  const compressedObjects = new Map<number, string>();
  {
    const objStmNums: number[] = [];
    const re = /\/Type\s*\/ObjStm\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      const n = objNumBefore(m.index);
      if (n !== null) objStmNums.push(n);
    }
    for (const n of objStmNums) {
      const obj = getDirectObject(n);
      if (!obj || !obj.streamBytes) { warnings.push(`ObjStm ${n} has no stream data`); continue; }
      let data: Uint8Array;
      if (/\/Filter\s*\/FlateDecode/.test(obj.dict)) {
        try {
          data = await inflate(obj.streamBytes);
        } catch (e) {
          warnings.push(`inflate failed for ObjStm ${n}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      } else {
        data = obj.streamBytes;
      }
      const nMatch = /\/N\s+(\d+)/.exec(obj.dict);
      const firstMatch = /\/First\s+(\d+)/.exec(obj.dict);
      if (!nMatch || !firstMatch) { warnings.push(`ObjStm ${n} missing /N or /First`); continue; }
      const count = parseInt(nMatch[1], 10);
      const first = parseInt(firstMatch[1], 10);
      const header = new TextDecoder('latin1').decode(data.slice(0, first)).trim().split(/\s+/).map((x) => parseInt(x, 10));
      const entries: { num: number; offset: number }[] = [];
      for (let i = 0; i + 1 < header.length && entries.length < count; i += 2) {
        entries.push({ num: header[i], offset: header[i + 1] });
      }
      const body = new TextDecoder('windows-1252').decode(data);
      for (let i = 0; i < entries.length; i++) {
        const start = first + entries[i].offset;
        const end = i + 1 < entries.length ? first + entries[i + 1].offset : data.length;
        if (start < 0 || end > data.length || start > end) {
          warnings.push(`ObjStm ${n} entry ${entries[i].num} has an out-of-range offset, skipped`);
          continue;
        }
        compressedObjects.set(entries[i].num, body.slice(start, end));
      }
    }
  }

  // The lookup every caller below actually uses: direct object text, falling
  // back to a compressed one. Never both — a given object number is either
  // found literally in the file or inside exactly one ObjStm, not both.
  function getObject(n: number): RawObject | null {
    const direct = getDirectObject(n);
    if (direct) return direct;
    const compressed = compressedObjects.get(n);
    if (compressed !== undefined) return { dict: compressed, streamBytes: null };
    return null;
  }

  async function decompressedStream(n: number): Promise<Uint8Array | null> {
    const obj = getObject(n);
    if (!obj || !obj.streamBytes) return null;
    if (/\/FlateDecode/.test(obj.dict)) {
      // Ported from mcps/guam-code's gu-pdf-extract.ts FORK FIX (fleet
      // #2888/#2904): several real PDFs store a /Length a small number of
      // bytes LONGER than the TRUE deflate stream length (confirmed on
      // Guam's 21gc033.pdf object 2: /Length says 96, the deflate stream is
      // complete at byte 95, and the 96th byte is one stray trailing byte).
      // Python's zlib tolerates trailing garbage by default; the
      // Workers/Node DecompressionStream used here does not and throws
      // "Trailing junk found after the end of the compressed stream".
      // Rather than fail the whole page, retry with the slice trimmed one
      // byte shorter a few times -- the true stream length is always <= the
      // declared one in every sample seen, never longer.
      for (let trim = 0; trim <= 4 && trim < obj.streamBytes.length; trim++) {
        try {
          return await inflate(trim === 0 ? obj.streamBytes : obj.streamBytes.subarray(0, obj.streamBytes.length - trim));
        } catch (e) {
          if (trim === 4) {
            warnings.push(`inflate failed for object ${n} even after trimming trailing bytes: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          }
        }
      }
      return null;
    }
    return obj.streamBytes;
  }

  // Catalog -> Pages -> Kids, walked in document order. Falls back to the
  // first /Type/Pages object if no /Type/Catalog is found. Both searches
  // look for the TYPE MARKER as plain text first (direct text, or inside any
  // decompressed ObjStm body) and then find which object that text belongs
  // to — see the file header for why this replaced a single greedy regex.
  let pagesRef: number | null = null;
  function findObjWithType(typeName: string): number | null {
    const directIdx = scan.search(new RegExp(`/Type\\s*/${typeName}\\b`));
    if (directIdx !== -1) {
      const n = objNumBefore(directIdx);
      if (n !== null) return n;
    }
    const typeRe = new RegExp(`/Type\\s*/${typeName}\\b`);
    for (const [num, text] of compressedObjects) {
      if (typeRe.test(text)) return num;
    }
    return null;
  }
  const catNum = findObjWithType('Catalog');
  if (catNum !== null) {
    const catObj = getObject(catNum);
    const pm = catObj ? /\/Pages\s+(\d+)\s+0\s+R/.exec(catObj.dict) : null;
    if (pm) pagesRef = parseInt(pm[1], 10);
  }
  if (pagesRef === null) {
    pagesRef = findObjWithType('Pages');
  }

  const leafPages: number[] = [];
  function walkPages(n: number, depth: number): void {
    if (depth > 12) { warnings.push('Pages tree exceeded depth 12, stopped walking'); return; }
    const obj = getObject(n);
    if (!obj) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(obj.dict)) { leafPages.push(n); return; }
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict);
    if (!kidsMatch) return;
    for (const km of kidsMatch[1].matchAll(/(\d+)\s+0\s+R/g)) walkPages(parseInt(km[1], 10), depth + 1);
  }
  if (pagesRef !== null) walkPages(pagesRef, 0);
  else warnings.push('no /Type/Catalog or /Type/Pages object found');

  const totalPages = leafPages.length;
  let pagesToExtract = leafPages;
  if (options?.pageRange) {
    const { fromPageObj, toPageObj } = options.pageRange;
    const fromIdx = leafPages.indexOf(fromPageObj);
    if (fromIdx === -1) {
      warnings.push(
        `pageRange.fromPageObj ${fromPageObj} is not a leaf page in this document — extracting the whole document instead of the requested range.`,
      );
    } else {
      let toIdx = leafPages.length - 1;
      if (toPageObj !== undefined) {
        const foundToIdx = leafPages.indexOf(toPageObj);
        // toPageObj not found, or found strictly BEFORE fromIdx (a bad or
        // out-of-order bookmark), falls back to end-of-document rather than
        // producing a negative-length slice. Equal to fromIdx is normal and
        // valid — a section whose first bookmarked child (e.g. its own
        // "ANNOTATIONS") starts on the SAME page is a single-page range,
        // not an error.
        if (foundToIdx >= fromIdx) toIdx = foundToIdx;
        else if (foundToIdx !== -1) {
          warnings.push(
            `pageRange.toPageObj ${toPageObj} resolves to a page before fromPageObj ${fromPageObj} — extracting through end of document instead.`,
          );
        } else {
          warnings.push(`pageRange.toPageObj ${toPageObj} is not a leaf page in this document — extracting through end of document instead.`);
        }
      }
      pagesToExtract = leafPages.slice(fromIdx, toIdx + 1);
    }
  }

  /** Parse a /ToUnicode CMap stream's `beginbfchar`/`beginbfrange` blocks into
   *  a code -> Unicode-codepoint map. Shared between Type0's 2-byte CIDs and
   *  a simple font's 1-byte codes — the CMap text format is identical either
   *  way; only how the caller SLICES its hex string differs (see decodeRun). */
  async function parseToUnicodeCMap(cmapObjNum: number): Promise<Map<number, number>> {
    const cmapBytes = await decompressedStream(cmapObjNum);
    const cmapText = cmapBytes ? new TextDecoder('latin1').decode(cmapBytes) : '';
    const map = new Map<number, number>();
    for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1], 16), parseInt(pair[2].slice(0, 4), 16));
      }
    }
    for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const triple of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(triple[1], 16), hi = parseInt(triple[2], 16), base = parseInt(triple[3].slice(0, 4), 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base + (c - lo));
      }
    }
    return map;
  }

  async function fontDecoderFor(fontObjNum: number): Promise<FontDecoder> {
    const obj = getObject(fontObjNum);
    if (!obj) return { kind: 'winansi' };
    if (/\/Subtype\s*\/Type0\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (!tuMatch) {
        warnings.push(`Type0 font object ${fontObjNum} has no /ToUnicode; its text will show as U+FFFD`);
        return { kind: 'cid', map: new Map() };
      }
      const map = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
      return { kind: 'cid', map: options?.fontCMapOverride?.(obj.dict, map) ?? map };
    }
    // Simple font. Every KRS sample used /WinAnsiEncoding, which decodes
    // directly as windows-1252 bytes below — unchanged. North Dakota's
    // Century Code PDFs (fleet #2743) use simple TrueType fonts that declare
    // NO /Encoding at all: their embedded subsets number glyphs 0, 1, 2... in
    // whatever order the subsetter emitted them, with no relationship to any
    // standard code page — reading code 0x01 as the WinAnsi byte 0x01 (a
    // control character) produces blank/garbled output, not a wrong letter.
    // Those fonts DO carry a /ToUnicode CMap (the same mechanism Type0 fonts
    // use above, just keyed by a 1-byte code instead of a 2-byte CID), which
    // is the only place the real character is recorded — use it whenever the
    // font isn't declared WinAnsi rather than guessing.
    if (!/\/Encoding\s*\/WinAnsiEncoding\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (tuMatch) {
        const parsedMap = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
        const map = options?.fontCMapOverride?.(obj.dict, parsedMap) ?? parsedMap;
        if (map.size) return { kind: 'mapped1', map };
      }
      warnings.push(`font object ${fontObjNum} has a non-WinAnsi simple encoding and no usable /ToUnicode; decoded as WinAnsi anyway`);
    }
    return { kind: 'winansi' };
  }

  const TOKEN_RE =
    /\/(\S+)\s+[\d.]+\s+Tf|\[((?:\\.|[^\]])*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^()])*)\)\s*Tj|1\s+0\s+0\s+1\s+[\d.-]+\s+([\d.-]+)\s+Tm/g;
  // Third alternative (bare number) added for Indonesia's JDIH statute PDFs
  // (jdih.setneg.go.id, fleet #3121): that producer never writes a literal
  // space byte between words — "REPUBLIK INDONESIA" is encoded as one TJ run
  // `[(…K)-269.0(I)…]`, where the -269 IS the word gap, not kerning. Every
  // sampled font's intra-word kerning tops out around +-30 (observed: 2.0,
  // -2.9, -14.0, -24.0); the real word gaps in the same document measured
  // -269, -286, -290, -692, -1396, -1400 — two clusters with nothing between
  // them, so a flat threshold cleanly separates "kerning" from "space" without
  // needing the current font size (the TJ number is already in thousandths of
  // text space, before the Tfs/Th scale-up ISO 32000 §9.4.3 applies).
  const TJ_PIECE_RE = /\(((?:\\.|[^()])*)\)|<([0-9A-Fa-f\s]*)>|(-?\d+(?:\.\d+)?)/g;
  const TJ_WORD_GAP_THRESHOLD = -100;

  function decodeRun(dec: FontDecoder, literal: string | undefined, hex: string | undefined): string {
    if (literal !== undefined) {
      const unescaped = unescapePdfLiteral(literal);
      // Ported from mcps/guam-code's gu-pdf-extract.ts FORK FIX 1/2 (fleet
      // #2888/#2904): a WinAnsi run's literal-string bytes ARE already the
      // correct windows-1252 text (unchanged below) -- but a non-WinAnsi
      // simple font ('mapped1') or a Type0 font ('cid') can ALSO show up as
      // a literal string rather than hex. Guam's PDF producer writes
      // several of its subset-embedded fonts' text this way; passing the
      // raw byte through unchanged (the old behavior here) skips that
      // font's /ToUnicode map entirely and produces line-noise control
      // characters instead of the real character -- route it through the
      // SAME decoder a hex run below already uses.
      //
      // 'cid' (Type0/Identity-H) is a 2-BYTE code space, same as the hex-
      // string path below -- a literal string's BYTES must be paired up
      // big-endian into one CID per pair, not looked up one byte at a time.
      // Found on mainland China's NPC/MOJ law PDFs (cn-law, fleet #3136):
      // Founder PDFGenerator (方正), the producer behind flk.npc.gov.cn's
      // and xzfg.moj.gov.cn's statute PDFs, writes most CJK body text as
      // literal strings like `(\000I)Tj` under a Type0 CID font rather than
      // as hex strings -- the shape this branch was missing. Decoding each
      // byte separately (the pre-fix behavior) looks up CID 0x00 and CID
      // 0x49 independently instead of the real CID 0x0049, so virtually
      // every CJK glyph misses its ToUnicode entry and comes back as
      // U+FFFD -- silently: no warning, a non-empty result, just wrong.
      // Measured against 中华人民共和国个人信息保护法 (PIPL)'s official
      // gazette PDF: 18,929 of 19,858 extracted characters were U+FFFD
      // before this fix (95%), 0 after, and `第十三条` (Article 13) and its
      // neighbors read correctly. If the literal string has an odd byte
      // count (shouldn't happen for a well-formed 2-byte-code run), the
      // trailing lone byte is silently dropped rather than guessed at.
      if (dec.kind === 'winansi') return unescaped;
      if (dec.kind === 'cid') {
        let out = '';
        for (let i = 0; i + 2 <= unescaped.length; i += 2) {
          const code =
            (rawByteFromLatin1Char(unescaped.charCodeAt(i)) << 8) | rawByteFromLatin1Char(unescaped.charCodeAt(i + 1));
          out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
        }
        return out;
      }
      let out = '';
      for (let i = 0; i < unescaped.length; i++) {
        const code = rawByteFromLatin1Char(unescaped.charCodeAt(i));
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    const cleaned = (hex ?? '').replace(/\s+/g, '');
    let out = '';
    if (dec.kind === 'mapped1') {
      // 1-byte code per glyph (a simple font's code space), unlike Type0's
      // 2-byte CIDs below — see fontDecoderFor.
      for (let i = 0; i + 2 <= cleaned.length; i += 2) {
        const code = parseInt(cleaned.slice(i, i + 2), 16);
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    for (let i = 0; i + 4 <= cleaned.length; i += 4) {
      const cid = parseInt(cleaned.slice(i, i + 4), 16);
      if (dec.kind === 'cid') out += String.fromCodePoint(dec.map.get(cid) ?? 0xfffd);
      else out += String.fromCharCode(cid & 0xff);
    }
    return out;
  }

  const pageTexts: string[] = [];
  for (const pn of pagesToExtract) {
    const page = getObject(pn);
    if (!page) continue;

    let resourcesDict = page.dict;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict);
    if (resRef) {
      const ro = getObject(parseInt(resRef[1], 10));
      if (ro) resourcesDict = ro.dict;
    }
    // /Font is usually inline in Resources, but North Dakota's Century Code
    // PDFs (fleet #2743) write it as an indirect reference ("/Font 18 0 R")
    // to a separate dict object — resolve that one hop before giving up.
    let fontDictBody: string | null = null;
    const inlineFontMatch = /\/Font\s*<<([^>]*)>>/.exec(resourcesDict);
    if (inlineFontMatch) {
      fontDictBody = inlineFontMatch[1];
    } else {
      const fontRefMatch = /\/Font\s+(\d+)\s+0\s+R/.exec(resourcesDict);
      if (fontRefMatch) {
        const fontObj = getObject(parseInt(fontRefMatch[1], 10));
        if (fontObj) fontDictBody = fontObj.dict;
      }
    }
    const fontMap = new Map<string, FontDecoder>();
    if (fontDictBody) {
      for (const fm of fontDictBody.matchAll(/\/(\S+?)\s+(\d+)\s+0\s+R/g)) {
        fontMap.set(fm[1], await fontDecoderFor(parseInt(fm[2], 10)));
      }
    }

    const contentsMatch = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(page.dict);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => parseInt(m[1], 10))
      : [];
    let raw = '';
    for (const cr of contentRefs) {
      const dec = await decompressedStream(cr);
      if (dec) raw += new TextDecoder('latin1').decode(dec) + '\n';
    }

    let out = '';
    let currentFont: string | null = null;
    let lastY: number | null = null;
    for (const m of raw.matchAll(TOKEN_RE)) {
      if (m[1] !== undefined) { currentFont = m[1]; continue; }
      if (m[5] !== undefined) {
        const y = parseFloat(m[5]);
        if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n';
        lastY = y;
        continue;
      }
      const dec = (currentFont && fontMap.get(currentFont)) || { kind: 'winansi' as const };
      if (m[2] !== undefined) {
        for (const piece of m[2].matchAll(TJ_PIECE_RE)) {
          if (piece[3] !== undefined) {
            // A big negative adjustment between two TJ pieces with no
            // literal space byte at all — see TJ_PIECE_RE's comment above.
            // Skip if `out` already ends in whitespace so a producer that
            // DOES write literal spaces never gets a doubled one.
            if (parseFloat(piece[3]) <= TJ_WORD_GAP_THRESHOLD && !/\s$/.test(out)) out += ' ';
            continue;
          }
          out += decodeRun(dec, piece[1], piece[2]);
        }
      } else if (m[3] !== undefined) {
        out += decodeRun(dec, undefined, m[3]);
      } else if (m[4] !== undefined) {
        out += decodeRun(dec, m[4], undefined);
      }
    }
    pageTexts.push(out.trim());
  }

  return { text: pageTexts.join('\n\n'), pages: totalPages, extractedPages: pagesToExtract.length, warnings };
}

/**
 * Parse a PDF's outline (bookmark) tree into a flat, document-order list of
 * {title, pageObjNum, depth} entries — WITHOUT decompressing any content
 * stream, so this is orders of magnitude cheaper than `extractPdfText` and
 * safe to run just to decide WHERE to extract from. Built for
 * mcps/new-mexico-code (fleet #2884): NMOneSource publishes each NMSA 1978
 * CHAPTER as one PDF (657-1,138+ pages observed) but bookmarks every
 * ARTICLE heading (depth 0), every SECTION citation (depth 1, e.g.
 * "30-2-1. Murder."), and that section's own "ANNOTATIONS" sub-heading
 * (depth 2) — giving a caller everything needed to resolve a bare citation
 * straight to a page RANGE via `extractPdfText`'s `pageRange` option,
 * without ever extracting pages the caller didn't ask for.
 *
 * Assumes outline objects are DIRECT (never compressed into an /ObjStm) —
 * true of every source sampled while building this. A PDF whose outline IS
 * compressed, or that has no /Outlines at all, returns an empty array
 * rather than guessing; check for that before concluding a citation isn't
 * bookmarked.
 */
function extractPdfOutline(buf: ArrayBuffer): PdfOutlineEntry[] {
  const bytes = new Uint8Array(buf);
  const scan = new TextDecoder('windows-1252').decode(bytes);

  const objStarts: { index: number; num: number }[] = [];
  // See extractPdfText's identical map for why: one O(1) lookup per object
  // instead of one full-document regex scan — an outline tree with ~1,400
  // bookmarks (New Mexico's larger chapters) made this function itself the
  // bottleneck before this fix (measured 2.8s on Chapter 30's 5.8MB PDF).
  const objEndByNum = new Map<number, number>();
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
      const num = parseInt(m[1], 10);
      if (!objEndByNum.has(num)) objEndByNum.set(num, m.index + m[0].length);
    }
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  const dictCache = new Map<number, string | null>();
  function dictOf(n: number): string | null {
    if (dictCache.has(n)) return dictCache.get(n) ?? null;
    let start: number;
    const fastEnd = objEndByNum.get(n);
    if (fastEnd !== undefined) {
      start = fastEnd;
    } else {
      const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
      const m = re.exec(scan);
      if (!m) { dictCache.set(n, null); return null; }
      start = m.index + m[0].length;
    }
    const end = scan.indexOf('endobj', start);
    const dict = end === -1 ? scan.slice(start, Math.min(scan.length, start + 4000)) : scan.slice(start, end);
    dictCache.set(n, dict);
    return dict;
  }

  // Prefer the Catalog's own /Outlines reference; fall back to the first
  // direct /Type/Outlines object found anywhere (same "search for the type
  // marker as plain text" approach extractPdfText uses for Catalog/Pages).
  let outlinesRoot: number | null = null;
  const catIdx = scan.search(/\/Type\s*\/Catalog\b/);
  if (catIdx !== -1) {
    const catNum = objNumBefore(catIdx);
    const catDict = catNum !== null ? dictOf(catNum) : null;
    const om = catDict ? /\/Outlines\s+(\d+)\s+0\s+R/.exec(catDict) : null;
    if (om) outlinesRoot = parseInt(om[1], 10);
  }
  if (outlinesRoot === null) {
    const outIdx = scan.search(/\/Type\s*\/Outlines\b/);
    if (outIdx !== -1) outlinesRoot = objNumBefore(outIdx);
  }
  if (outlinesRoot === null) return [];

  function pageObjOf(dict: string): number | null {
    const destMatch = /\/Dest\s*\[\s*(\d+)\s+0\s+R/.exec(dict);
    if (destMatch) return parseInt(destMatch[1], 10);
    const actionMatch = /\/A\s*<<[^>]*\/D\s*\[\s*(\d+)\s+0\s+R/.exec(dict);
    if (actionMatch) return parseInt(actionMatch[1], 10);
    return null;
  }

  const entries: PdfOutlineEntry[] = [];
  const seen = new Set<number>();
  function walk(n: number, depth: number): void {
    if (depth > 20 || seen.has(n)) return; // guards a malformed/cyclic tree
    seen.add(n);
    const dict = dictOf(n);
    if (!dict) return;
    const titleMatch = /\/Title\s*\(((?:\\.|[^()])*)\)/.exec(dict);
    if (titleMatch) {
      entries.push({ title: unescapePdfLiteral(titleMatch[1]).replace(/\s+/g, ' ').trim(), pageObjNum: pageObjOf(dict), depth });
    }
    const firstMatch = /\/First\s+(\d+)\s+0\s+R/.exec(dict);
    if (firstMatch) walk(parseInt(firstMatch[1], 10), titleMatch ? depth + 1 : depth);
    const nextMatch = /\/Next\s+(\d+)\s+0\s+R/.exec(dict);
    if (nextMatch) walk(parseInt(nextMatch[1], 10), depth);
  }
  const rootDict = dictOf(outlinesRoot);
  const rootFirst = rootDict ? /\/First\s+(\d+)\s+0\s+R/.exec(rootDict) : null;
  if (rootFirst) walk(parseInt(rootFirst[1], 10), 0);

  return entries;
}
/**
 * Puerto Rico statutes — "leyes" (acts) of the Puerto Rico Legislature,
 * section/article lookup and search, including the "33 LPRA 5001"-style
 * citation to Leyes de Puerto Rico Anotadas (LPRA).
 *
 * SOURCE (fleet #2889). The commercially-sold, consolidated LPRA itself
 * (Westlaw/Lexis) is not free. What IS free and government-published: the
 * Oficina de Gerencia y Presupuesto's (OGP) "Biblioteca Virtual — Leyes de
 * Referencia" (bvirtualogp.pr.gov), a public SharePoint 2013 site with NO
 * login wall, serving ~15,500 acts as PDFs — each one either the act "según
 * enmendada" (consolidated with every amendment folded in, kept current by
 * OGP) or "según original" (as originally enacted, for acts OGP has not
 * consolidated). Confirmed live from a throwaway `wrangler dev --remote`
 * Worker on the prod Cloudflare account (2026-10-09): bvirtualogp.pr.gov
 * does NOT block Worker egress — byte-identical to a direct curl, unlike
 * oscn.net/le.utah.gov in this pack family, so no egress relay is needed
 * here.
 *
 * TWO HOPS, both anonymous SharePoint REST, no auth token:
 *   1. `_api/web/lists/getbytitle('PDF')/items?$filter=FileLeafRef eq
 *      '<leyNumber>.pdf'` resolves an act number (e.g. "146-2012") straight
 *      to its metadata (Title, Number, Years, Tipo) and its file path — in
 *      ONE query, regardless of which topic subfolder OGP filed it under
 *      (`PDF/Justicia/146-2012/146-2012.pdf`, `PDF/55-2020.pdf`, etc. — the
 *      folder layout is not derivable from the act number, confirmed by
 *      sampling several acts, so this flat-list filter is the only reliable
 *      resolver). Matches can include an English translation filed
 *      separately (`PDF/2-ingles/...`) — excluded below; this pack returns
 *      the Spanish text as published, never a translation.
 *   2. A plain GET of that file path returns the PDF itself.
 *
 * THE LPRA MAPPING — STATED BY THE SOURCE, NEVER GUESSED. Every "según
 * enmendada" act PDF sampled annotates each of its own articles inline with
 * its LPRA citation, e.g. (from 146-2012.pdf, confirmed live):
 *   "Artículo 1. — Denominación y aplicabilidad de la ley. (33 L.P.R.A. § 5001)"
 * and (from 55-2020.pdf):
 *   "Artículo 1. — Título e interpretación del Código. (31 L.P.R.A. § 5311)"
 * So this pack can answer an LPRA citation ONLY for an LPRA título it has
 * confirmed, by actually reading that act's own text, maps onto ONE specific
 * act — LPRA_CODES below, currently Título 31 (Civil Code, Ley 55-2020) and
 * Título 33 (Penal Code, Ley 146-2012). LPRA has ~35 títulos; the rest
 * aggregate many acts each and have NOT been individually verified this way
 * — pr_statute says so plainly (`reason: "lpra_title_not_mapped"`) rather
 * than guessing which act(s) a título corresponds to. Add a título here only
 * after confirming the same inline-citation pattern in that act's own PDF.
 *
 * SECTION TEXT, NOT JUST THE WHOLE ACT. A citation resolves to ONE article's
 * text, sliced between its own "Artículo N. — ... (TT L.P.R.A. § SSSS)"
 * heading and the next one — mirroring mcps/kentucky-code and
 * mcps/oklahoma-code's per-section shape rather than returning an entire
 * 125-page PDF. `extractPdfText` (shared/src/pdf-text.ts) does the PDF ->
 * text decoding; `stripPageFooters` below removes OGP's own per-page banner
 * ("Rev. <date> www.ogp.pr.gov ... Página N de M" plus the repeated quoted
 * act title) that the extractor otherwise leaves inline mid-article whenever
 * a section spans a page break — confirmed live: 126 leaked footer
 * fragments in 146-2012.pdf before stripping, 2 left after (both outside
 * any article body — the cover banner before Artículo 1, and the
 * "verify latest revision" notice after the last article).
 *
 * SEARCH is two-tier and says which tier a hit came from. Tier 1 is REAL
 * full-text search over the two LPRA-mapped codes' own parsed articles
 * (`result_type: "lpra_section"`) — a genuine body-text match, not just a
 * catchline. Tier 2 falls back to (or supplements with) OGP's own catalog,
 * searched by act TITLE via the same SharePoint REST `substringof` filter
 * over all ~15,500 acts (`result_type: "act"`) — this is a title/catchline
 * match over acts, not a body-text match, and is labelled as such; most PR
 * law outside the two mapped codes is reachable only this way (by act
 * number via pr_statute), not yet by LPRA citation.
 *
 * Charset: the SharePoint REST JSON is served as
 * `application/json;odata=verbose;charset=utf-8` (confirmed live) and is
 * decoded from the declared charset explicitly below, not assumed, after
 * the 10-07 relay bug that turned "§" into U+FFFD in a sibling pack.
 *
 * Keyless, no signup, free.
 */

const UA = 'pipeworx-mcp-puerto-rico-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Oficina de Gerencia y Presupuesto — Biblioteca Virtual (bvirtualogp.pr.gov)';
const SITE = 'https://bvirtualogp.pr.gov';
const PDF_LIST_API = `${SITE}/ogp/Bvirtual/leyesreferencia/_api/web/lists/getbytitle('PDF')/items`;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

/** Decode a Response body from the bytes using the charset the server
 *  actually declared (defaulting to utf-8), rather than letting `.text()`
 *  guess — see file header on the 10-07 relay bug this repo already hit
 *  once for exactly this kind of silent corruption. */
async function decodeBody(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  const ct = res.headers.get('content-type') ?? '';
  const m = /charset=([\w-]+)/i.exec(ct);
  const charset = m ? m[1]!.toLowerCase() : 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** LPRA título -> the ONE act this pack has verified (by reading that act's
 *  own PDF) carries inline "(TT L.P.R.A. § SSSS)" citations for every
 *  article. See file header — never add an entry here from inference. */
const LPRA_CODES: Record<string, { leyNumber: string; name: string }> = {
  '31': { leyNumber: '55-2020', name: 'Código Civil de Puerto Rico de 2020 (Civil Code)' },
  '33': { leyNumber: '146-2012', name: 'Código Penal de Puerto Rico de 2012 (Penal Code)' },
};

interface ActMeta {
  title: string;
  leyNumber: string;
  years: string | null;
  tipo: string | null;
  fileRef: string;
}

interface PdfItem {
  Title: string | null;
  Number: string | null;
  Years: string | null;
  Tipo: string | null;
  FileRef: string;
  FileLeafRef: string;
}

/** Resolve a bare act number ("146-2012") to its OGP metadata and PDF path
 *  via ONE SharePoint REST filter over the flat PDF document library —
 *  works regardless of which topic subfolder the act is filed under (see
 *  file header). Excludes English-translation filings; this pack returns
 *  the Spanish text as published. */
async function resolveAct(leyNumber: string): Promise<ActMeta | null> {
  const url = new URL(PDF_LIST_API);
  url.searchParams.set('$filter', `FileLeafRef eq '${leyNumber.replace(/'/g, "''")}.pdf'`);
  url.searchParams.set('$select', 'Title,Number,Years,Tipo,FileRef,FileLeafRef');
  const res = await pwFetch(url, { headers: { Accept: 'application/json;odata=verbose' } });
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const body = await decodeBody(res);
  let parsed: { d?: { results?: PdfItem[] } };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`upstream_parse: ${UPSTREAM} returned a non-JSON body (HTTP ${res.status}) for the act lookup.`);
  }
  const results = parsed.d?.results ?? [];
  const spanish = results.find((r) => !/\/2-ingles\/|\/ingles\/|english/i.test(r.FileRef));
  const hit = spanish ?? results[0];
  if (!hit) return null;
  return {
    title: hit.Title ?? '(sin título / no title on file)',
    leyNumber,
    years: hit.Years ?? null,
    tipo: hit.Tipo ?? null,
    fileRef: hit.FileRef,
  };
}

interface Article {
  article: string;
  heading: string;
  lpraTitle: string;
  lpraSection: string;
  /** True when this heading is OGP's own "nota" annotation on an LPRA
   *  section rather than that section's operative text — see the note on
   *  ARTICLE_HEADING_RE below. */
  isNote: boolean;
  body: string;
}

/** OGP's own per-page footer, injected into the literal text flow of every
 *  "según enmendada" PDF between pages: a repeated quoted act-title banner
 *  immediately followed by "Rev. <date> www.ogp.pr.gov ... Página N de M".
 *  Confirmed live in 146-2012.pdf (126 occurrences) and 55-2020.pdf — this
 *  is not statutory text, and left in place it lands mid-sentence inside
 *  any article whose text spans a page break. */
function stripPageFooters(text: string): string {
  return text
    .replace(
      // The quoted act-title banner and the "[Ley ..., según ...]" bracket
      // that follows it are sometimes on the same line ("...Rico” [Ley
      // 146-2012, según enmendada]") and sometimes split across a line
      // break (acts cited by enactment date rather than "N-YYYY" shorthand,
      // confirmed in Ley 54-1989: "...Doméstica”\n[Ley 54 de 15 de agosto
      // de 1989, según\n...") — `[\s\S]` between them tolerates either.
      /\n[“"][\s\S]{1,200}?\[Ley[^\]]{0,160}\]?\s*(?:\n+\s*)*Rev\.\s+\d{1,2}\s+de\s+\S+\s+de\s+\d{4}\s+www\.ogp\.pr\.gov\s+P[áa]gina\s+\d+\s+de\s+\d+\s*\n/g,
      '\n',
    )
    .replace(/\n{3,}/g, '\n\n');
}

// Article numbers are not always a bare integer — "2.1-A", "3.10-A" and
// similar sub-numbered articles are common (confirmed in Ley 54-1989, the
// Domestic Violence Act), so the number group accepts an optional
// ".<digits>" and an optional "-<letter>" suffix. A `.` between the number
// and the dash is itself inconsistent in the source — "Artículo 1. —" and
// "Artículo 1.1 —" both occur — so it is optional here too. The LPRA
// section number can carry a trailing lowercase letter ("621a") and
// sometimes an explicit "nota" marker meaning this heading annotates that
// section rather than stating its operative text (seen in Ley 54-1989:
// "Artículo 1.1 ... (8 L.P.R.A. § 601 nota)" is a note, "Artículo 1.2 ...
// (8 L.P.R.A. § 601)" immediately after is the real text for the same
// section) — `isNote` lets callers resolving BY LPRA SECTION skip the note
// and prefer the operative heading.
const ARTICLE_NUM = String.raw`\d+(?:\.\d+)?(?:-[A-Za-z])?`;
const ARTICLE_HEADING_RE = new RegExp(
  String.raw`Art[íi]culo\s+(${ARTICLE_NUM})\.?\s*[—-]\s*([^(]+?)\.\s*\((\d+)\s*L\.?\s*P\.?\s*R\.?\s*A\.?\s*§\s*(\d+[a-zA-Z]?)(\s+nota)?\)`,
  'g',
);

/** Parse every "Artículo N. — Catchline. (TT L.P.R.A. § SSSS)"-headed
 *  section out of one act's full extracted text, each sliced through to the
 *  next such heading (or EOF). A handful of cross-reference mentions inside
 *  OTHER articles' bodies match the same shape (e.g. "...el Artículo 92...
 *  (33 L.P.R.A. § 5141)" quoted in passing) — the first NON-NOTE occurrence
 *  of a given article number is kept (cross-references appear only after
 *  the section they reference, so the first match is always the real
 *  heading unless it is itself a "nota" immediately preceding the real one,
 *  as in the 54-1989 example above). */
function parseArticles(text: string): Article[] {
  const stripped = stripPageFooters(text);
  const headings: { article: string; heading: string; lpraTitle: string; lpraSection: string; isNote: boolean; start: number; end: number }[] = [];
  for (const m of stripped.matchAll(ARTICLE_HEADING_RE)) {
    headings.push({
      article: m[1]!,
      heading: m[2]!.replace(/\s+/g, ' ').trim(),
      lpraTitle: m[3]!,
      lpraSection: m[4]!,
      isNote: Boolean(m[5]),
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  const seen = new Set<string>();
  const out: Article[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    if (seen.has(h.article)) continue;
    seen.add(h.article);
    const next = headings[i + 1];
    const body = stripped.slice(h.end, next ? next.start : stripped.length).trim();
    out.push({ article: h.article, heading: h.heading, lpraTitle: h.lpraTitle, lpraSection: h.lpraSection, isNote: h.isNote, body });
  }
  return out;
}

async function fetchActArticles(fileRef: string): Promise<Article[]> {
  const res = await pwFetch(`${SITE}${fileRef}`);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const buf = await res.arrayBuffer();
  const extracted = await extractPdfText(buf);
  if (!extracted.text.trim()) {
    throw new Error(
      `upstream_parse: ${UPSTREAM} returned a PDF at ${fileRef} with no extractable text (warnings: ${extracted.warnings.join('; ') || 'none'}).`,
    );
  }
  return parseArticles(extracted.text);
}

type ParsedCitation =
  | { kind: 'lpra'; lpraTitle: string; lpraSection: string }
  | { kind: 'act'; leyNumber: string; article: string | null };

/** Accepts:
 *    "33 LPRA 5001", "33 L.P.R.A. § 5001", "Título 33 LPRA 5001"      -> lpra
 *    "146-2012", "Ley 146-2012", "Ley Núm. 146-2012"                  -> act (no article)
 *    "146-2012 Art. 92", "Ley 146-2012, Artículo 2.1-A"               -> act + article
 */
function parseCitation(raw: string): ParsedCitation | null {
  const s = raw.trim();

  const lpraMatch = /^(?:T[ií]tulo\s*)?(\d+[A-Za-z]?)\s*(?:L\.?\s*P\.?\s*R\.?\s*A\.?|LPRA)\s*§?\s*(\d+[A-Za-z]?)$/i.exec(s);
  if (lpraMatch) {
    return { kind: 'lpra', lpraTitle: lpraMatch[1]!.toUpperCase(), lpraSection: lpraMatch[2]!.toUpperCase() };
  }

  const actMatch = new RegExp(
    String.raw`^(?:Ley\s*(?:N[uú]m\.?)?\s*)?(\d+)\s*-\s*(\d{4})(?:[\s,]+(?:Art(?:[íi]culo)?\.?)?\s*(${ARTICLE_NUM}))?$`,
    'i',
  ).exec(s);
  if (actMatch) {
    return { kind: 'act', leyNumber: `${actMatch[1]}-${actMatch[2]}`, article: actMatch[3] ? actMatch[3].toUpperCase() : null };
  }

  return null;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'pr_statute',
    description:
      'Get the text of a Puerto Rico "ley" (act) by citation — accepts an LPRA citation like "33 LPRA 5001" (33 L.P.R.A. § 5001, the Penal Code\'s murder-related provisions title) or "31 LPRA 5311" (the Civil Code), OR a direct act number like "146-2012" (optionally with an article, e.g. "146-2012 Art. 92"). LPRA citations resolve ONLY for the LPRA títulos this pack has verified map to one specific act by reading that act\'s own text (currently Título 31, Código Civil de Puerto Rico de 2020; and Título 33, Código Penal de Puerto Rico de 2012) — most of LPRA\'s ~35 títulos aggregate many acts and are NOT yet mapped; for those, look up the specific "ley" by its own number instead. Returns the article/section heading and FULL SPANISH TEXT AS PUBLISHED by the Oficina de Gerencia y Presupuesto (OGP) — never machine-translated — plus the source PDF URL and data_as_of. Spanish statute citations and vocabulary: artículo, ley, código, estatuto, derecho puertorriqueño, Leyes de Puerto Rico Anotadas.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description: 'An LPRA citation ("33 LPRA 5001", "31 L.P.R.A. § 5311"), or an act number alone or with an article ("146-2012", "146-2012 Art. 92", "Ley 55-2020 Artículo 1").',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'pr_search',
    description:
      'Search Puerto Rico statutes by topic or keyword in Spanish (e.g. "homicidio", "arrendamiento", "violencia doméstica", "contratos"). Searches two tiers: REAL full-text search over the article bodies of the two LPRA-mapped consolidated codes (Código Penal / Código Civil — real body-text matches, not just catchlines), plus a title/catchline search over OGP\'s full catalog of ~15,500 published "leyes" (acts) for topics outside those two codes. Each result is labelled result_type "lpra_section" (a real statute section, with its LPRA citation) or "act" (an act title match — call pr_statute with its act number for the text). Keyless, Spanish text as published.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords in Spanish, e.g. "arrendamiento" (lease) or "homicidio" (homicide).' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 30.' },
      },
      required: ['query'],
    },
  },
];

async function prStatute(args: Record<string, unknown>) {
  const raw = String(args.citation ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_citation',
      message: 'pr_statute needs a citation, e.g. "33 LPRA 5001" or "146-2012 Art. 92".',
    };
  }
  const parsed = parseCitation(raw);
  if (!parsed) {
    return {
      found: false,
      reason: 'unparsed_citation',
      citation: raw,
      message: `"${raw}" is not a recognized Puerto Rico statute citation.`,
      hint: 'Use an LPRA citation ("33 LPRA 5001") or an act number ("146-2012", optionally with "Art. N"). Call pr_search with a topic if you do not have either.',
    };
  }

  let leyNumber: string;
  let lpraLabel: { lpraTitle: string; lpraSection: string } | null = null;
  let requestedArticle: string | null;

  if (parsed.kind === 'lpra') {
    const code = LPRA_CODES[parsed.lpraTitle];
    if (!code) {
      return {
        found: false,
        reason: 'lpra_title_not_mapped',
        citation: raw,
        lpra_title: parsed.lpraTitle,
        message: `Título ${parsed.lpraTitle} of the LPRA is not yet mapped to a verified source act in this pack. Only títulos this pack has confirmed by reading the act's own text are supported.`,
        mapped_titles: Object.entries(LPRA_CODES).map(([title, c]) => ({ lpra_title: title, ley: c.leyNumber, name: c.name })),
        hint: 'If you know the underlying act number (e.g. "146-2012"), call pr_statute with that instead. Call pr_search with a topic to find it.',
      };
    }
    leyNumber = code.leyNumber;
    lpraLabel = { lpraTitle: parsed.lpraTitle, lpraSection: parsed.lpraSection };
    requestedArticle = null; // resolved by LPRA section match below, not by article number
  } else {
    leyNumber = parsed.leyNumber;
    requestedArticle = parsed.article;
  }

  const act = await resolveAct(leyNumber);
  if (!act) {
    return {
      found: false,
      reason: 'act_not_found',
      citation: raw,
      ley_number: leyNumber,
      message: `No act numbered "${leyNumber}" was found in OGP's Biblioteca Virtual.`,
      source: `${UPSTREAM}, keyless`,
    };
  }
  const url = `${SITE}${act.fileRef}`;

  // LPRA citation with no article requested yet, or an act+article citation
  // where no article was given at all -> return act-level metadata, pointing
  // the caller at the specific lookup they need next.
  if (!lpraLabel && !requestedArticle) {
    return {
      found: true,
      level: 'act',
      citation: raw,
      ley_number: leyNumber,
      title: act.title,
      years: act.years,
      tipo: act.tipo,
      url,
      message: `"${act.title}" (Ley ${leyNumber}) was found, but no article number was given — this is act-level metadata, not statute text.`,
      hint: 'Call pr_statute again with an article number (e.g. "146-2012 Art. 92") or an LPRA citation if you know one.',
      source: `${UPSTREAM}, keyless`,
      language: 'Spanish, as published',
      data_as_of: new Date().toISOString(),
    };
  }

  const articles = await fetchActArticles(act.fileRef);

  // 0 articles across an entire multi-page act almost always means this
  // act's PDF does not use the "Artículo N. — Title. (TT L.P.R.A. § S)"
  // heading shape this pack parses (plenty of PR acts don't carry inline
  // LPRA citations at all) — that is a different, louder fact than "this
  // one article number is missing", so it gets its own reason rather than
  // reading as a clean not-found on a healthy act.
  if (articles.length === 0) {
    return {
      found: false,
      reason: 'article_format_not_recognized',
      citation: raw,
      ley_number: leyNumber,
      act_title: act.title,
      message: `Ley ${leyNumber} ("${act.title}") was fetched and its text extracted, but no "Artículo N. — ... (LPRA §)"-style heading was found in it — this act likely does not carry the inline LPRA citations this pack's section-slicing depends on, so individual-article text cannot be extracted for it.`,
      url,
      source: `${UPSTREAM}, keyless`,
      data_as_of: new Date().toISOString(),
    };
  }

  const match = lpraLabel
    ? articles.find((a) => a.lpraTitle === lpraLabel!.lpraTitle && a.lpraSection.toUpperCase() === lpraLabel!.lpraSection && !a.isNote)
      ?? articles.find((a) => a.lpraTitle === lpraLabel!.lpraTitle && a.lpraSection.toUpperCase() === lpraLabel!.lpraSection)
    : articles.find((a) => a.article.toUpperCase() === requestedArticle);

  if (!match) {
    return {
      found: false,
      reason: lpraLabel ? 'lpra_section_not_found' : 'article_not_found',
      citation: raw,
      ley_number: leyNumber,
      act_title: act.title,
      message: lpraLabel
        ? `"${lpraLabel.lpraTitle} LPRA ${lpraLabel.lpraSection}" was not found among the ${articles.length} articles parsed from Ley ${leyNumber} ("${act.title}") — the section may have been renumbered, repealed, or this pack's LPRA-to-act mapping for this título may need re-verifying against the current text.`
        : `Article "${requestedArticle}" was not found among the ${articles.length} articles parsed from Ley ${leyNumber} ("${act.title}").`,
      near: articles.slice(0, 5).map((a) => ({ article: a.article, heading: a.heading, lpra: `${a.lpraTitle} LPRA ${a.lpraSection}` })),
      url,
      source: `${UPSTREAM}, keyless`,
      data_as_of: new Date().toISOString(),
    };
  }

  return {
    found: true,
    level: 'article',
    citation: raw,
    ley_number: leyNumber,
    act_title: act.title,
    article: match.article,
    heading: match.heading,
    lpra_citation: `${match.lpraTitle} LPRA § ${match.lpraSection}`,
    text: match.body,
    text_chars: match.body.length,
    tipo: act.tipo,
    url,
    language: 'Spanish, as published — not machine-translated',
    source: `${UPSTREAM}, keyless`,
    data_as_of: new Date().toISOString(),
  };
}

async function prSearch(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'pr_search needs a "query" — a Spanish topic or keywords, e.g. "arrendamiento" or "homicidio".',
    };
  }
  const limit = Math.max(1, Math.min(30, Number(args.limit) || 10));
  const needle = query.toLowerCase();

  const sectionResults: Array<Record<string, unknown>> = [];
  for (const [lpraTitle, code] of Object.entries(LPRA_CODES)) {
    if (sectionResults.length >= limit) break;
    try {
      const act = await resolveAct(code.leyNumber);
      if (!act) continue;
      const articles = await fetchActArticles(act.fileRef);
      for (const a of articles) {
        if (sectionResults.length >= limit) break;
        if (a.heading.toLowerCase().includes(needle) || a.body.toLowerCase().includes(needle)) {
          sectionResults.push({
            result_type: 'lpra_section',
            lpra_citation: `${lpraTitle} LPRA § ${a.lpraSection}`,
            article: a.article,
            heading: a.heading,
            act_title: act.title,
            ley_number: code.leyNumber,
            url: `${SITE}${act.fileRef}`,
          });
        }
      }
    } catch {
      // One mapped code failing to fetch/parse should not fail the whole
      // search — the catalog-title tier below still runs.
      continue;
    }
  }

  const catalogResults: Array<Record<string, unknown>> = [];
  if (sectionResults.length < limit) {
    const url = new URL(PDF_LIST_API);
    // $filter on FileSystemObjectType is REJECTED by this list with a 500
    // ("Column 'FileSystemObjectType' does not exist" — confirmed live,
    // 2026-10-09) even though the same field is a valid $select; OGP's own
    // category FOLDERS (e.g. one literally titled "Municipios") are
    // filtered out client-side below instead, by requiring a non-null Tipo
    // — every real act item carries "Ley según enmendada"/"Ley original",
    // folders carry null.
    url.searchParams.set('$filter', `substringof('${query.replace(/'/g, "''")}',Title)`);
    url.searchParams.set('$select', 'Title,Number,Years,Tipo,FileRef');
    url.searchParams.set('$top', String(3 * (limit - sectionResults.length) + 5));
    const res = await pwFetch(url, { headers: { Accept: 'application/json;odata=verbose' } });
    if (!res.ok) throw await httpError(res, UPSTREAM);
    const body = await decodeBody(res);
    let parsed: { d?: { results?: PdfItem[] } };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`upstream_parse: ${UPSTREAM} returned a non-JSON body (HTTP ${res.status}) for the act-title search.`);
    }
    for (const r of parsed.d?.results ?? []) {
      if (catalogResults.length >= limit - sectionResults.length) break;
      if (!r.Tipo) continue; // a category folder, not an act
      if (/\/2-ingles\/|\/ingles\/|english/i.test(r.FileRef)) continue;
      catalogResults.push({
        result_type: 'act',
        title: r.Title,
        ley_number: r.Number && r.Years ? `${Number(r.Number)}-${r.Years.replace(/,/g, '')}` : null,
        years: r.Years,
        tipo: r.Tipo,
        url: `${SITE}${r.FileRef}`,
      });
    }
  }

  const results = [...sectionResults, ...catalogResults].slice(0, limit);
  return {
    found: results.length > 0,
    query,
    returned: results.length,
    results,
    hint: results.length
      ? 'result_type "lpra_section" is a real statute section with full text (call pr_statute with its lpra_citation or ley_number + article). result_type "act" is an act-title match (call pr_statute with its ley_number for metadata and article-level text).'
      : 'No match. The full-text tier only covers the Civil and Penal Codes (see LPRA_CODES) — try a more literal term, or a different topic for the act-title catalog search.',
    source: `${UPSTREAM} — full-text over the Civil/Penal Codes, title search over the full catalog, keyless`,
    data_as_of: new Date().toISOString(),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'pr_statute':
      return prStatute(args);
    case 'pr_search':
      return prSearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
