import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { extractLinks, isSafeHttpUrl, type ParsedLink } from "@archive/shared";

/**
 * Markdown -> sanitised HTML, done once on write.
 *
 * Reads are the hot path for an archive, so the rendered HTML is stored
 * alongside the source. The sanitiser runs *after* markdown-it because
 * scraped bodies routinely contain raw HTML fragments copied out of a
 * moderation panel, and that HTML is untrusted input.
 */

const md = new MarkdownIt("default", {
  html: true, // allowed, then sanitised below
  linkify: true,
  breaks: true,
  typographer: false,
});

// Bare URLs become links, but only schemes we trust.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "s", "del", "ins", "mark", "sup", "sub",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "span", "div", "details", "summary",
];

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    // rel/target must be allowlisted here as well: sanitize-html applies
    // allowedAttributes *after* transformTags, so attributes the transform
    // adds are stripped again unless they appear in this list.
    a: ["href", "title", "rel", "target"],
    img: ["src", "alt", "title", "width", "height", "loading", "decoding"],
    code: ["class"],
    pre: ["class"],
    span: ["class"],
    div: ["class"],
    th: ["colspan", "rowspan", "align"],
    td: ["colspan", "rowspan", "align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  // class is the only styling hook; no inline style, so no CSS-based
  // exfiltration or layout breakage from scraped content.
  allowedClasses: {
    code: ["language-*", "hljs*"],
    pre: ["language-*"],
    span: ["archive-*"],
    div: ["archive-*"],
  },
  disallowedTagsMode: "discard",
  enforceHtmlBoundary: true,
  transformTags: {
    // Every outbound link is isolated from the archive window.
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      if (href && !href.startsWith("/") && !href.startsWith("#") && !isSafeHttpUrl(href)) {
        return { tagName: "span", attribs: {} };
      }
      const external = /^https?:/i.test(href);
      return {
        tagName,
        attribs: external
          ? { ...attribs, rel: "noopener noreferrer nofollow ugc", target: "_blank" }
          : attribs,
      };
    },
    img: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, loading: "lazy", decoding: "async" },
    }),
  },
};

export interface RenderedBody {
  html: string;
  links: ParsedLink[];
  /** Plain-text excerpt for list views and meta descriptions. */
  excerpt: string;
}

export function renderBody(markdown: string): RenderedBody {
  const source = markdown ?? "";
  const html = source.trim() ? sanitizeHtml(md.render(source), sanitizeOptions) : "";
  return {
    html,
    links: extractLinks(source),
    excerpt: toExcerpt(source),
  };
}

/** Strip markdown noise down to a single readable line. */
export function toExcerpt(markdown: string, max = 280): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
