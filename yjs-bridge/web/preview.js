import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false });

// Remote images would tell a third party that (and when) a file is open. Only data: and blob:
// sources render; anything else becomes its alt text.
const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = String(tokens[idx].attrGet('src') ?? '');
  if (/^(data:image\/|blob:)/i.test(src)) return defaultImage(tokens, idx, options, env, self);
  return `<span class="blocked-image">[image not loaded: ${md.utils.escapeHtml(tokens[idx].content)}]</span>`;
};

export function renderPreview(text) {
  return DOMPurify.sanitize(md.render(text), { USE_PROFILES: { html: true } });
}
