const fs = require('fs/promises');
const path = require('path');
const fetch = require('node-fetch');
const { load } = require('cheerio');

const FEED_URL = 'https://www.unrealengine.com/en-US/feed?tags=interviews';
const OUTPUT_FILE = path.join(__dirname, 'articles.json');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36';

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    return new URL(url, FEED_URL).toString();
  } catch (err) {
    return '';
  }
}

async function fetchHtml(url) {
  try {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const html = await response.text();
    return { html };
  } catch (error) {
    return { error: error.message };
  }
}

function textOrNull(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = textOrNull(value);
    if (normalized) return normalized;
  }
  return '';
}

function extractThumbnail($el) {
  const img = $el.find('img').first();
  const source = img.attr('src') || img.attr('data-src') || img.attr('data-lazy');
  if (source) return normalizeUrl(source);

  const srcset = img.attr('srcset');
  if (srcset) {
    const firstEntry = srcset.split(',')[0];
    const [url] = firstEntry.trim().split(' ');
    return normalizeUrl(url);
  }
  return '';
}

function extractFromNextData($) {
  const script = $('#__NEXT_DATA__').first();
  if (!script.length) return [];
  try {
    const raw = script.contents().text();
    const data = JSON.parse(raw);
    const items = [];

    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }

      const candidateUrl = node.url || node.href || node.slug;
      const candidateTitle = node.title || node.name || node.heading;
      const candidateExcerpt = node.excerpt || node.description || node.summary;
      const candidateDate = node.date || node.published || node.publishDate || node.publishedAt;
      const candidateImage = node.image?.url || node.image || node.thumbnail;

      if (candidateUrl && candidateTitle) {
        items.push({
          url: normalizeUrl(candidateUrl),
          title: textOrNull(candidateTitle),
          excerpt: textOrNull(candidateExcerpt),
          date: textOrNull(candidateDate),
          thumbnail: normalizeUrl(candidateImage),
        });
      }

      Object.values(node).forEach(visit);
    };

    visit(data);
    return items.filter((item) => item.url);
  } catch (err) {
    return [];
  }
}

function extractFeedCards(html) {
  const $ = load(html);
  const cards = [];

  $('article, li, .card, .feed-card, .ue-card').each((_, element) => {
    const $el = $(element);
    const anchor = $el.is('a') ? $el : $el.find('a[href]').first();
    const url = normalizeUrl(anchor.attr('href'));
    if (!url) return;

    const title = firstNonEmpty(
      $el.find('h3').first().text(),
      $el.find('h2').first().text(),
      anchor.attr('title'),
      anchor.attr('aria-label'),
      anchor.text()
    );

    const date = firstNonEmpty(
      $el.find('time').first().attr('datetime'),
      $el.find('time').first().text()
    );

    const excerpt = firstNonEmpty(
      $el.find('p').first().text(),
      $el.find('.excerpt').first().text(),
      $el.find('.summary').first().text()
    );

    const thumbnail = extractThumbnail($el);

    cards.push({ title, date, excerpt, url, thumbnail });
  });

  if (cards.length === 0) {
    return extractFromNextData($);
  }
  return cards;
}

function extractTags($) {
  const tags = new Set();
  $('a[href*="/feed?tags"], a[href*="/tags/"], a[rel="tag"], [data-tag]').each((_, element) => {
    const tagText = textOrNull($(element).text());
    if (tagText) tags.add(tagText);
  });
  return Array.from(tags);
}

function extractArticleMeta(html) {
  const $ = load(html);
  const tags = extractTags($);

  const ogTitle = firstNonEmpty(
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="twitter:title"]').attr('content'),
    $('title').text()
  );

  const ogDescription = firstNonEmpty(
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="description"]').attr('content'),
    $('meta[name="twitter:description"]').attr('content')
  );

  const ogImage = normalizeUrl(
    firstNonEmpty(
      $('meta[property="og:image"]').attr('content'),
      $('meta[name="twitter:image"]').attr('content'),
      $('meta[name="twitter:image:src"]').attr('content')
    )
  );

  return { tags, ogTitle, ogDescription, ogImage };
}

async function main() {
  const feedResult = await fetchHtml(FEED_URL);
  if (feedResult.error) {
    console.error('Failed to fetch feed:', feedResult.error);
    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify([{ url: FEED_URL, error: feedResult.error }], null, 2)
    );
    return;
  }

  const feedCards = extractFeedCards(feedResult.html);
  const seen = new Set();
  const uniqueCards = feedCards.filter((card) => {
    if (!card.url || seen.has(card.url)) return false;
    seen.add(card.url);
    return true;
  });

  const articles = [];

  for (const card of uniqueCards) {
    const article = { ...card, url: card.url };
    const { html, error } = await fetchHtml(card.url);

    if (error) {
      article.error = error;
      articles.push(article);
      await sleep(randomDelay());
      continue;
    }

    try {
      const meta = extractArticleMeta(html);
      Object.assign(article, meta);
    } catch (metaError) {
      article.error = metaError.message;
    }
    articles.push(article);
    await sleep(randomDelay());
  }

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(articles, null, 2));
  console.log(`Saved ${articles.length} articles to ${OUTPUT_FILE}`);
}

main().catch(async (err) => {
  console.error('Unexpected error:', err);
  try {
    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify([{ error: err.message }], null, 2)
    );
  } catch (writeErr) {
    console.error('Failed to write error file:', writeErr);
  }
});
