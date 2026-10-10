# @pipeworx/puerto-rico-code

Puerto Rico statutes — "leyes" (acts) of the Puerto Rico Legislature, by
citation and by topic, including LPRA citations like "33 LPRA 5001" for the
two consolidated codes this pack has verified map cleanly to one act each.
Spanish text as published, never machine-translated. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1764+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `pr_statute(citation)` — full text of a Puerto Rico statute article/section
  by citation. Accepts an LPRA citation ("33 LPRA 5001" is the Penal Code's
  Artículo 1; "31 LPRA 5311" is the Civil Code's Artículo 1), OR a direct act
  number alone ("55-2020") or with an article ("146-2012 Art. 92", "146-2012
  Art. 93"). An act number with no article returns act-level metadata
  (title, years, "tipo", URL) rather than statute text. Returns the heading
  and full Spanish text as published, plus the source PDF URL and
  `data_as_of`.
- `pr_search(query, limit?)` — search by Spanish topic/keyword. Two tiers:
  REAL full-text search over the article bodies of the two LPRA-mapped codes
  (`result_type: "lpra_section"` — genuine body-text matches with their LPRA
  citation), plus a title/catchline search over OGP's full ~15,500-act
  catalog (`result_type: "act"`) for everything else.

## Auth

Keyless.

## What this pack covers, and what it plainly does not

The commercially-sold, consolidated **Leyes de Puerto Rico Anotadas (LPRA)**
(Westlaw/Lexis) is not free and this pack does not touch it. What IS free and
government-published: the **Oficina de Gerencia y Presupuesto's (OGP)
"Biblioteca Virtual — Leyes de Referencia"** (bvirtualogp.pr.gov), a public
SharePoint 2013 site with no login wall, serving ~15,500 acts as PDFs, each
either "Ley según enmendada" (OGP's own consolidated-with-every-amendment
text, kept current) or "Ley original" (as enacted, for acts OGP has not
consolidated).

LPRA has roughly 35 "títulos", most of which aggregate many different acts.
**This pack maps an LPRA citation to a section's text ONLY for the títulos it
has individually verified by reading that act's own PDF** — every "según
enmendada" act OGP publishes annotates each of its own articles inline with
its LPRA citation (confirmed live, e.g. "Artículo 92. — Asesinato. (33
L.P.R.A. § 5141)"), so the mapping is read off the source, never guessed.
Currently mapped (`LPRA_CODES` in `src/index.ts`):

| LPRA título | Ley | Name |
|---|---|---|
| 31 | 55-2020 | Código Civil de Puerto Rico de 2020 |
| 33 | 146-2012 | Código Penal de Puerto Rico de 2012 |

For every other título, `pr_statute` says `lpra_title_not_mapped` and names
the mapped ones rather than guessing which act(s) cover it — call `pr_statute`
with the specific act number instead if you know it (many acts, Ley 54-1989
"Ley para la Prevención e Intervención con la Violencia Doméstica" among
them, carry the same inline LPRA annotation but are NOT in `LPRA_CODES`
because a title can span several acts and this pack has not verified the
full extent of that título's coverage — only an individual act lookup is
offered for those).

Article numbers are not always a bare integer — "2.1-A", "3.10-A" are real
(Ley 54-1989) alongside plain "92" (Ley 146-2012) — `pr_statute` accepts
either shape in the `citation` argument's "Art." form.

## Two REST hops, both anonymous SharePoint, no auth token

1. `_api/web/lists/getbytitle('PDF')/items?$filter=FileLeafRef eq
   '146-2012.pdf'` resolves a bare act number (e.g. "146-2012") straight
   to its metadata (Title, Number, Years, Tipo) and PDF path in ONE query,
   regardless of which topic subfolder OGP filed it under — confirmed the
   folder layout is NOT derivable from the act number alone (`146-2012` is
   under `PDF/Justicia/146-2012/146-2012.pdf`, `55-2020` is a top-level
   `PDF/55-2020.pdf`), so this flat-list filter is the resolver rather than
   a guessed path. A handful of acts are also filed with an English
   translation under `PDF/2-ingles/` or `PDF/ingles/` — excluded; this pack
   never returns a translation.
2. A plain GET of that resolved path returns the PDF, decoded with
   `shared/src/pdf-text.ts` and sliced into per-article sections.

`$filter` on `FileSystemObjectType` is REJECTED by this list with an HTTP
500 ("Column 'FileSystemObjectType' does not exist" — confirmed live,
2026-10-09), even though the same field IS a valid `$select` — OGP's own
category folders (one is literally titled "Municipios" and otherwise
surfaces as a bare title-substring hit) are filtered out client-side instead,
by requiring a non-null `Tipo`.

## Page-footer noise, and why it matters for a long article

Every "según enmendada" PDF injects a repeating per-page footer into the
literal text flow between pages: a quoted act-title banner immediately
followed by "Rev. &lt;date&gt; www.ogp.pr.gov ... Página N de M". Confirmed
live: 126 occurrences in the Penal Code's 125-page PDF before stripping, 2
left after (both outside any article body — the cover banner before Artículo
1 and the "verify latest revision" notice after the last article). Left in
place, this noise lands mid-sentence inside any article whose text spans a
page break — `stripPageFooters` in `src/index.ts` removes it before slicing.
The quoted title and its "[Ley ..., según ...]" bracket are sometimes on the
same line and sometimes split across a line break (acts cited by enactment
date rather than "N-YYYY" shorthand, e.g. Ley 54-1989's "...Doméstica”\n[Ley
54 de 15 de agosto de 1989, según\n...") — the stripper tolerates either.

## "Nota" annotations

A small number of LPRA sections carry TWO headings in the source: a "nota"
(a note ABOUT the section, not its operative text) immediately followed by
the real text — e.g. Ley 54-1989's "Artículo 1.1 ... (8 L.P.R.A. § 601
nota)" then "Artículo 1.2 ... (8 L.P.R.A. § 601)" right after. When resolving
BY LPRA SECTION, the parser prefers the non-"nota" heading for the same
section number.

## Charset

The SharePoint REST JSON is served as
`application/json;odata=verbose;charset=utf-8` (confirmed live) and is
decoded from the response's own declared charset, not assumed — a sibling
pack in this family once turned every "§" into U+FFFD by assuming UTF-8
through a relay that actually served ISO-8859-1.

## Data sources

- `https://bvirtualogp.pr.gov/ogp/Bvirtual/leyesreferencia/_api/web/lists/getbytitle('PDF')/items`
  — SharePoint REST over OGP's "Leyes de Referencia" PDF document library
  (~15,500 acts). `$filter=FileLeafRef eq '<num>.pdf'` resolves a bare act
  number; `$filter=substringof('<query>',Title)` is the act-title search
  tier.
- `https://bvirtualogp.pr.gov/ogp/Bvirtual/leyesreferencia/PDF/...` — the
  resolved PDF itself, one per act, text-extracted and sliced by article.

Confirmed from a throwaway `wrangler dev --remote` Worker on the prod
Cloudflare account (2026-10-09) that bvirtualogp.pr.gov does NOT block
Worker egress — byte-identical response to a direct curl for both the REST
API and a PDF fetch, unlike `oscn.net`/`le.utah.gov` elsewhere in this pack
family, so no egress relay is needed here.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "puerto-rico-code": {
      "url": "https://gateway.pipeworx.io/puerto-rico-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/puerto-rico-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1764+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/pr_statute \
  -H 'Content-Type: application/json' \
  -d '{"citation":"33 LPRA 5001"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/pr_statute`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "puerto-rico-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-puerto-rico-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-puerto-rico-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Puerto Rico Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
