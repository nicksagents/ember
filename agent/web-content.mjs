const ARTICLE_TYPE_PATTERN = /(article|posting|report|liveblog|analysis)/i;
const POSITIVE_CONTAINER_PATTERN =
  /\b(article|content|entry|main|post|story|body|news|text|copy|page)\b/i;
const NEGATIVE_CONTAINER_PATTERN =
  /\b(nav|menu|footer|header|sidebar|comment|share|social|related|promo|advert|ads|newsletter|cookie|modal|popup|breadcrumb|subscribe|signup|sign-up|outbrain|taboola)\b/i;
const NOISE_TEXT_PATTERN =
  /\b(advertisement|sign up|newsletter|all rights reserved|cookie policy|privacy policy|terms of service|share this|follow us)\b/i;
const PAYWALL_PATTERN =
  /\b(subscribe|subscription|sign in to continue|register to continue|create an account|already a subscriber|log in to continue)\b/i;

export function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseAttributes(tag) {
  const attributes = {};
  const regex = /([:@\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = regex.exec(String(tag || "")))) {
    const key = String(match[1] || "").toLowerCase();
    const value = decodeHtmlEntities(match[2] || match[3] || match[4] || "");
    attributes[key] = value;
  }
  return attributes;
}

function stripCommentsAndScripts(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ");
}

function removeNoiseContainers(html) {
  let next = stripCommentsAndScripts(html);
  const tagPatterns = [
    /<(nav|footer|header|aside|form)[^>]*>[\s\S]*?<\/\1>/gi,
    /<(div|section|aside|nav|ul)[^>]*(?:id|class)=["'][^"']*(?:nav|menu|footer|header|sidebar|comment|share|social|related|promo|advert|ads|newsletter|cookie|modal|popup|breadcrumb|subscribe|outbrain|taboola)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  ];
  for (const pattern of tagPatterns) {
    next = next.replace(pattern, " ");
  }
  return next;
}

export function stripHtmlToText(html) {
  return normalizeText(
    decodeHtmlEntities(
      removeNoiseContainers(html)
        .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
        .replace(
          /<\/(p|div|article|section|main|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre|tr|td|th|figcaption)>/gi,
          "\n"
        )
        .replace(/<[^>]+>/g, " ")
    )
  );
}

export function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeText(decodeHtmlEntities(match[1])) : "";
}

function extractMetaTagContent(html, matchers) {
  const matcherList = Array.isArray(matchers) ? matchers : [matchers];
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = parseAttributes(tag);
    const keys = [attrs.property, attrs.name, attrs.itemprop, attrs["http-equiv"]]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    if (!keys.length || !attrs.content) continue;
    if (matcherList.some((matcher) => keys.includes(String(matcher).toLowerCase()))) {
      return normalizeText(attrs.content);
    }
  }
  return "";
}

function extractLinkHref(html, relName) {
  const regex = /<link\b[^>]*>/gi;
  let match;
  while ((match = regex.exec(String(html || "")))) {
    const attrs = parseAttributes(match[0]);
    const rel = String(attrs.rel || "").toLowerCase();
    if (!rel || !attrs.href) continue;
    if (rel.split(/\s+/).includes(String(relName).toLowerCase())) {
      return normalizeText(attrs.href);
    }
  }
  return "";
}

function extractHtmlLang(html) {
  const match = String(html || "").match(/<html\b[^>]*\blang=["']([^"']+)["']/i);
  return match ? normalizeText(match[1]) : "";
}

function flattenJsonLd(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return output;
  }
  if (typeof value !== "object") return output;
  output.push(value);
  if (Array.isArray(value["@graph"])) {
    flattenJsonLd(value["@graph"], output);
  }
  return output;
}

function normalizeTypeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase());
  if (typeof value === "string") return [value.toLowerCase()];
  return [];
}

function isArticleNode(node) {
  return normalizeTypeList(node?.["@type"]).some((type) => ARTICLE_TYPE_PATTERN.test(type));
}

function readAuthorName(author) {
  if (!author) return "";
  if (typeof author === "string") return normalizeText(author);
  if (Array.isArray(author)) {
    return normalizeText(
      author
        .map((item) => readAuthorName(item))
        .filter(Boolean)
        .join(", ")
    );
  }
  if (typeof author === "object") {
    return normalizeText(author.name || author.alternateName || "");
  }
  return "";
}

function extractJsonLdData(html) {
  const scripts =
    String(html || "").match(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ) || [];
  const nodes = [];
  for (const scriptTag of scripts) {
    const match = scriptTag.match(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      flattenJsonLd(parsed, nodes);
    } catch {
      continue;
    }
  }
  const articles = nodes.filter(isArticleNode);
  const bestArticle = articles
    .slice()
    .sort((a, b) => String(b?.articleBody || "").length - String(a?.articleBody || "").length)[0];
  if (!bestArticle) {
    return { headline: "", description: "", articleBody: "", byline: "", publishedTime: "", url: "" };
  }
  return {
    headline: normalizeText(bestArticle.headline || bestArticle.name || ""),
    description: normalizeText(bestArticle.description || ""),
    articleBody: normalizeText(bestArticle.articleBody || bestArticle.text || ""),
    byline: readAuthorName(bestArticle.author),
    publishedTime: normalizeText(
      bestArticle.datePublished || bestArticle.dateCreated || bestArticle.uploadDate || ""
    ),
    url: normalizeText(bestArticle.url || bestArticle.mainEntityOfPage?.["@id"] || ""),
  };
}

function extractEmbeddedJsonString(html, key) {
  const regex = new RegExp(
    `"${String(key).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
    "i"
  );
  const match = String(html || "").match(regex);
  if (!match) return "";
  try {
    return normalizeText(JSON.parse(`"${match[1]}"`));
  } catch {
    return normalizeText(match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
  }
}

function extractEmbeddedArticleData(html) {
  return {
    headline:
      extractEmbeddedJsonString(html, "headline") ||
      extractEmbeddedJsonString(html, "title") ||
      "",
    description: extractEmbeddedJsonString(html, "description") || "",
    articleBody: extractEmbeddedJsonString(html, "articleBody") || "",
  };
}

function splitIntoParagraphs(text) {
  return normalizeText(text)
    .split(/\n{2,}/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function dedupeBlocks(blocks) {
  const seen = new Set();
  const output = [];
  for (const block of blocks) {
    const key = block.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(block);
  }
  return output;
}

function looksLikeNoiseBlock(text) {
  const cleaned = normalizeText(text);
  if (!cleaned) return true;
  if (NOISE_TEXT_PATTERN.test(cleaned)) return true;
  if (cleaned.length < 25 && !/[.!?]/.test(cleaned)) return true;
  return false;
}

function extractStructuredBlocks(fragmentHtml) {
  const cleaned = removeNoiseContainers(fragmentHtml);
  const blocks = [];
  const regex = /<(h[1-6]|p|blockquote|li|figcaption|pre)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = regex.exec(cleaned))) {
    const tag = String(match[1] || "").toLowerCase();
    const text = normalizeText(stripHtmlToText(match[2]));
    if (!text) continue;
    if (tag.startsWith("h")) {
      if (text.length >= 8 && text.length <= 180) blocks.push(text);
      continue;
    }
    if (!looksLikeNoiseBlock(text)) blocks.push(text);
  }
  if (blocks.length > 0) return dedupeBlocks(blocks);
  return dedupeBlocks(splitIntoParagraphs(stripHtmlToText(cleaned)).filter((block) => !looksLikeNoiseBlock(block)));
}

function computeLinkDensity(fragmentHtml) {
  const totalText = stripHtmlToText(fragmentHtml);
  if (!totalText) return 0;
  let anchorTextLength = 0;
  const regex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(String(fragmentHtml || "")))) {
    anchorTextLength += stripHtmlToText(match[1]).length;
  }
  return anchorTextLength / Math.max(totalText.length, 1);
}

function scoreCandidate(candidate) {
  const text = String(candidate.text || "");
  const blocks = Array.isArray(candidate.blocks) ? candidate.blocks : [];
  const textLength = text.length;
  const punctuationCount = (text.match(/[.!?]/g) || []).length;
  const linkDensity = computeLinkDensity(candidate.html || "");
  let score = 0;
  if (candidate.kind === "jsonld") score += 90;
  if (candidate.kind === "embedded") score += 75;
  if (candidate.kind === "article") score += 60;
  if (candidate.kind === "main") score += 35;
  if (candidate.kind === "positive-container") score += 20;
  score += Math.min(textLength, 8000) / 45;
  score += Math.min(blocks.length, 20) * 6;
  score += Math.min(punctuationCount, 40);
  if (textLength < 250) score -= 60;
  if (textLength < 600) score -= 25;
  if (linkDensity > 0.35) score -= 80;
  if (linkDensity > 0.2) score -= 25;
  if (NEGATIVE_CONTAINER_PATTERN.test(String(candidate.context || ""))) score -= 40;
  if (POSITIVE_CONTAINER_PATTERN.test(String(candidate.context || ""))) score += 20;
  if (PAYWALL_PATTERN.test(text) && textLength < 1600) score -= 30;
  return score;
}

function makeCandidate(kind, context, fragmentHtml) {
  const blocks = extractStructuredBlocks(fragmentHtml);
  const text = normalizeText(blocks.join("\n\n"));
  return {
    kind,
    context,
    html: fragmentHtml,
    blocks,
    text,
    score: scoreCandidate({ kind, context, html: fragmentHtml, blocks, text }),
  };
}

function collectCandidates(html, metadata) {
  const candidates = [];
  if (metadata.jsonLd.articleBody) {
    const blocks = dedupeBlocks(splitIntoParagraphs(metadata.jsonLd.articleBody));
    const text = normalizeText(blocks.join("\n\n"));
    candidates.push({
      kind: "jsonld",
      context: "jsonld articleBody",
      html: "",
      blocks,
      text,
      score: scoreCandidate({ kind: "jsonld", context: "jsonld articleBody", html: "", blocks, text }),
    });
  }
  if (metadata.embedded.articleBody) {
    const blocks = dedupeBlocks(splitIntoParagraphs(metadata.embedded.articleBody));
    const text = normalizeText(blocks.join("\n\n"));
    candidates.push({
      kind: "embedded",
      context: "embedded articleBody",
      html: "",
      blocks,
      text,
      score: scoreCandidate({ kind: "embedded", context: "embedded articleBody", html: "", blocks, text }),
    });
  }

  const containerPatterns = [
    { kind: "article", regex: /<article\b([^>]*)>([\s\S]*?)<\/article>/gi },
    { kind: "main", regex: /<main\b([^>]*)>([\s\S]*?)<\/main>/gi },
    {
      kind: "positive-container",
      regex:
        /<(section|div)\b([^>]*)\b(?:class|id)=["'][^"']*(article|content|entry|main|post|story|body|news|text|copy|page)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
    },
  ];

  for (const pattern of containerPatterns) {
    let match;
    while ((match = pattern.regex.exec(String(html || "")))) {
      const attrs = pattern.kind === "positive-container" ? match[2] || "" : match[1] || "";
      const innerHtml = pattern.kind === "positive-container" ? match[4] || "" : match[2] || "";
      if (!innerHtml) continue;
      candidates.push(makeCandidate(pattern.kind, attrs, innerHtml));
      if (candidates.length >= 12) break;
    }
  }

  candidates.push(makeCandidate("body", "document fallback", html));
  return candidates
    .filter((candidate) => candidate.text)
    .sort((a, b) => b.score - a.score);
}

function firstNonEmpty(...values) {
  return values.map((value) => normalizeText(value)).find(Boolean) || "";
}

function firstParagraph(text) {
  return splitIntoParagraphs(text)[0] || "";
}

export function extractReadableContent(html) {
  const pageHtml = String(html || "");
  const jsonLd = extractJsonLdData(pageHtml);
  const embedded = extractEmbeddedArticleData(pageHtml);
  const metadata = {
    jsonLd,
    embedded,
    metaTitle: firstNonEmpty(
      extractMetaTagContent(pageHtml, ["og:title", "twitter:title"]),
      extractHtmlTitle(pageHtml)
    ),
    description: firstNonEmpty(
      extractMetaTagContent(pageHtml, ["og:description", "description", "twitter:description"]),
      jsonLd.description,
      embedded.description
    ),
    byline: firstNonEmpty(
      jsonLd.byline,
      extractMetaTagContent(pageHtml, ["author", "article:author"])
    ),
    publishedTime: firstNonEmpty(
      jsonLd.publishedTime,
      extractMetaTagContent(pageHtml, [
        "article:published_time",
        "og:article:published_time",
        "datepublished",
        "date",
        "pubdate",
      ])
    ),
    siteName: extractMetaTagContent(pageHtml, ["og:site_name", "application-name"]),
    canonicalUrl: firstNonEmpty(jsonLd.url, extractLinkHref(pageHtml, "canonical")),
    lang: extractHtmlLang(pageHtml),
  };

  const candidates = collectCandidates(pageHtml, metadata);
  const best = candidates[0] || { kind: "fallback", text: stripHtmlToText(pageHtml), blocks: [] };
  const title = firstNonEmpty(
    jsonLd.headline,
    embedded.headline,
    extractMetaTagContent(pageHtml, ["og:title", "twitter:title"]),
    extractHtmlTitle(pageHtml),
    firstParagraph(best.text)
  );
  const text = best.text || metadata.description;
  const excerpt = firstNonEmpty(metadata.description, firstParagraph(text));
  const paywallLikely =
    PAYWALL_PATTERN.test(pageHtml) && text.length < 1400 && !metadata.jsonLd.articleBody;

  return {
    title,
    text,
    excerpt,
    byline: metadata.byline,
    publishedTime: metadata.publishedTime,
    siteName: metadata.siteName,
    canonicalUrl: metadata.canonicalUrl,
    lang: metadata.lang,
    extraction: best.kind,
    paywallLikely,
  };
}
