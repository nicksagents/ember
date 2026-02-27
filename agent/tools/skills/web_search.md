# web_search

Purpose: search the web quickly for current information.

Inputs:
- query: search phrase.
- limit: number of results to return (optional).
- site: optional domain filter like `example.com`.

Notes:
- Use this for current events, changing docs, product pages, and anything likely to have changed.
- For simple lookup questions, do one quick search first with a small `limit`.
- Follow up with `fetch_url` only when you need the actual page text instead of snippets.
- Do not narrate that you are going to search; call `web_search` directly.
