# fetch_url

Purpose: fetch a web page and extract readable text from it.

Inputs:
- url: target URL.
- maxChars: maximum text to return (optional).

Notes:
- Use after `web_search` to read the page itself.
- Prefer this over guessing from snippets when accuracy matters.
- Do not fetch every result. Read a page only when the search snippets are not enough.
