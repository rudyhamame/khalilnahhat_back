const cheerio = require("cheerio");
function textFromHtml(value) {
  const $ = cheerio.load(String(value || ""));
  $("script,style,iframe,object,svg,head").remove();
  $("a[href]").each((_index, element) => {
    const link = $(element),
      href = link.attr("href") || "";
    if (/^(https?:|mailto:)/i.test(href) && link.text().trim() !== href)
      link.append(` (${href})`);
  });
  $("br").replaceWith("\n");
  $("p,div,li,tr,blockquote").append("\n");
  return $.root()
    .text()
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const cleanHeader = (value) =>
  String(value || "")
    .replace(/[\r\n]/g, " ")
    .slice(0, 2000);
const escapeHtml = (value) =>
  String(value || "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
module.exports = { textFromHtml, cleanHeader, escapeHtml };
