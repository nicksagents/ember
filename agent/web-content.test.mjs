import test from "node:test";
import assert from "node:assert/strict";
import {
  extractReadableContent,
  stripHtmlToText,
} from "./web-content.mjs";

test("extractReadableContent prefers article body over page chrome", () => {
  const html = `
    <html lang="en">
      <head>
        <title>Example News - Site Name</title>
        <meta property="og:title" content="Major Storm Moves East" />
        <meta property="og:description" content="A major storm is moving across the region." />
        <meta property="og:site_name" content="Example News" />
        <meta name="author" content="Jordan Lee" />
        <meta property="article:published_time" content="2026-02-28T10:30:00Z" />
      </head>
      <body>
        <header>
          <nav>
            <a href="/home">Home</a>
            <a href="/world">World</a>
          </nav>
        </header>
        <article class="story-body">
          <h1>Major Storm Moves East</h1>
          <p>A powerful winter storm moved east on Saturday, disrupting travel across several states.</p>
          <p>Officials warned residents to avoid unnecessary travel as snow and ice accumulated through the morning.</p>
        </article>
        <section class="related-links">
          <a href="/foo">Read more</a>
        </section>
        <footer>Privacy Policy</footer>
      </body>
    </html>
  `;

  const result = extractReadableContent(html);

  assert.equal(result.title, "Major Storm Moves East");
  assert.equal(result.byline, "Jordan Lee");
  assert.equal(result.publishedTime, "2026-02-28T10:30:00Z");
  assert.equal(result.siteName, "Example News");
  assert.match(result.text, /powerful winter storm moved east/i);
  assert.match(result.text, /Officials warned residents/i);
  assert.doesNotMatch(result.text, /Privacy Policy/i);
  assert.equal(result.paywallLikely, false);
});

test("extractReadableContent can pull articleBody from embedded JSON", () => {
  const html = `
    <html>
      <head>
        <title>Fallback Title</title>
      </head>
      <body>
        <script>
          window.__DATA__ = {
            "headline":"Embedded Headline",
            "articleBody":"Paragraph one from embedded data.\\n\\nParagraph two continues the story with more detail."
          };
        </script>
        <div id="app">Loading article...</div>
      </body>
    </html>
  `;

  const result = extractReadableContent(html);

  assert.equal(result.title, "Embedded Headline");
  assert.match(result.text, /Paragraph one from embedded data/i);
  assert.match(result.text, /Paragraph two continues the story/i);
  assert.equal(result.extraction, "embedded");
});

test("stripHtmlToText decodes entities and keeps readable breaks", () => {
  const text = stripHtmlToText("<div><p>A &amp; B</p><p>Line two</p></div>");
  assert.equal(text, "A & B\nLine two");
});
