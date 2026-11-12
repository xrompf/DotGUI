"use strict";

/**
 * Searches or normalizes input into a fully qualified URL
 * @param {string} input
 * @param {string} template
 * @returns {string}
 */
function search(input, template) {
  template = template || "https://html.duckduckgo.com/html/?q=%s";
  try {
    return new URL(input).toString();
  } catch (err) {}
  try {
    const url = new URL(`https://${input}`);
    if (url.hostname.includes(".")) return url.toString();
  } catch (err) {}
  return template.replace("%s", encodeURIComponent(input));
}
