const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const response = await httpClient.get(`/clubs/index/${COMPETITION}`);
    const $ = cheerio.load(response.data || '');

    const clubs = [];
    const seen = new Set();

    $('a[href*="/clubs/detail/"], .club-card, .team-card, table tbody tr').each((_, el) => {
      const item = $(el);
      if (item.closest('header, nav, footer').length > 0) return;

      const link = item.is('a') ? item.attr('href') : item.find('a[href]').first().attr('href');
      const name = cleanText(
        item.find('.club-name, .team-name, h3, h4, h5, td:nth-child(2)').first().text()
      ) || cleanText(item.text());

      if (!name || name.length < 3 || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());

      const img = item
        .find('img')
        .filter((__, im) => {
          const src = $(im).attr('data-src') || $(im).attr('src') || '';
          return src && !src.includes('flagcdn.com');
        })
        .first();

      const logo = normalizeUrl(img.attr('data-src') || img.attr('src'));
      const slug = extractMatchId(link) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      clubs.push({
        id: slug,
        name,
        logo,
        profile_url: link ? normalizeUrl(link) : null
      });
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      updated_at: new Date().toISOString(),
      total: clubs.length,
      data: clubs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil daftar klub dari ileague.id',
      error: error.message
    });
  }
};
